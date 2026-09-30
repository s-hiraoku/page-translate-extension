import type { Page } from "@playwright/test";
import { expect, test } from "./support/extension";
import { tooltipText } from "./support/tooltip";

// Lets context.route() see the service worker's requests, so DeepL can be answered locally.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = "1";

const PARAGRAPH = "main article > p";
const SETTINGS_KEY = "pageTranslateSettings";
const CONSENT_KEY = "pageTranslateDataUseConsentVersion";

async function selectWithMouse(page: Page): Promise<void> {
  const box = (await page.locator(PARAGRAPH).first().boundingBox())!;
  await page.mouse.move(box.x + 4, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + 260, box.y + 8, { steps: 6 });
  await page.mouse.up();
}

// "Translate as I select" works with the side panel closed: the page reports the selection to the
// service worker, which translates it and sends the answer back to the tooltip. These tests run the
// real service worker; without an API key it fails at DeepL, which is what shows the path is wired.
test.describe("translating as text is selected, with the panel closed", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 640 });
  });

  const setAuto = (driver: Page, enabled: boolean, consent: boolean) => driver.evaluate(async ({ enabled, consent, SETTINGS_KEY, CONSENT_KEY }) => {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    await chrome.storage.local.set({ [SETTINGS_KEY]: { ...(stored[SETTINGS_KEY] ?? {}), selectionAutoTranslate: enabled } });
    if (consent) await chrome.storage.local.set({ [CONSENT_KEY]: 2 });
  }, { enabled, consent, SETTINGS_KEY, CONSENT_KEY });

  test("without consent, the tooltip says what to do and nothing is sent", async ({ page, driver, send }) => {
    await page.goto("/fixtures/article.html");
    await send({ type: "UPDATE_FOCUS_ANCHOR", anchor: { screenY: 0 } });
    await setAuto(driver, true, false);
    // The service worker tells open pages about the change.
    await page.waitForTimeout(500);

    await selectWithMouse(page);

    await expect.poll(() => tooltipText(page)).toContain("同意");
  });

  test("with consent, the selection reaches DeepL (here refused for lack of a key) and the tooltip shows the outcome", async ({ page, driver, send }) => {
    await page.goto("/fixtures/article.html");
    await send({ type: "UPDATE_FOCUS_ANCHOR", anchor: { screenY: 0 } });
    await setAuto(driver, true, true);
    await page.waitForTimeout(500);

    await selectWithMouse(page);

    await expect.poll(async () => (await tooltipText(page)) ?? "").toMatch(/DeepL/);
    expect(await tooltipText(page)).not.toContain("翻訳しています");
  });

  test("a page opened while the setting is on translates selections too", async ({ page, driver }) => {
    await setAuto(driver, true, false);
    await page.goto("/fixtures/article.html");
    await page.waitForTimeout(800);

    await selectWithMouse(page);

    await expect.poll(() => tooltipText(page)).toContain("同意");
  });

  test("does nothing while the setting is off", async ({ page, send }) => {
    await page.goto("/fixtures/article.html");
    await send({ type: "UPDATE_FOCUS_ANCHOR", anchor: { screenY: 0 } });

    await selectWithMouse(page);
    await page.waitForTimeout(800);

    expect(await tooltipText(page)).toBeNull();
  });

  test("stops when the setting is turned off, and closes its tooltip", async ({ page, driver, send }) => {
    await page.goto("/fixtures/article.html");
    await send({ type: "UPDATE_FOCUS_ANCHOR", anchor: { screenY: 0 } });
    await setAuto(driver, true, false);
    await page.waitForTimeout(500);
    await selectWithMouse(page);
    await expect.poll(() => tooltipText(page)).toContain("同意");

    await setAuto(driver, false, false);

    await expect.poll(() => tooltipText(page)).toBeNull();
    await page.evaluate(() => getSelection()?.removeAllRanges());
    await selectWithMouse(page);
    await page.waitForTimeout(800);
    expect(await tooltipText(page)).toBeNull();
  });

  test("leaves selections to the panel while its selection mode holds the port", async ({ page, driver, evaluateInExtension, send }) => {
    await page.goto("/fixtures/article.html");
    await send({ type: "UPDATE_FOCUS_ANCHOR", anchor: { screenY: 0 } });
    await setAuto(driver, true, false);
    await page.waitForTimeout(500);
    await evaluateInExtension((tabId) => {
      const holder = window as unknown as { events: unknown[]; selectionPort: chrome.runtime.Port };
      holder.events = [];
      holder.selectionPort = chrome.tabs.connect(tabId, { name: "selection-translate" });
      holder.selectionPort.onMessage.addListener((message) => holder.events.push(message));
    });

    await selectWithMouse(page);

    await expect.poll(() => driver.evaluate(() => (window as unknown as { events: unknown[] }).events.length)).toBe(1);
    await page.waitForTimeout(800);
    // The panel has not answered, so the tooltip still waits; the service worker was not asked.
    expect(await tooltipText(page)).toContain("翻訳しています");
  });

  test("translates for real: key and consent on record, DeepL answering, the tooltip shows the translation", async ({ page, context, driver, send }) => {
    await context.route("https://api-free.deepl.com/**", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ translations: [{ text: "潮汐とは、海面の規則的な上昇と下降です。" }] }),
    }));
    await page.goto("/fixtures/article.html");
    await send({ type: "UPDATE_FOCUS_ANCHOR", anchor: { screenY: 0 } });
    await driver.evaluate(() => chrome.runtime.sendMessage({ type: "SAVE_PROVIDER_KEYS", typesafeApiKey: "", deeplApiKey: "test-key:fx" }));
    await setAuto(driver, true, true);
    await page.waitForTimeout(500);

    await selectWithMouse(page);

    await expect.poll(async () => (await tooltipText(page)) ?? "").toContain("潮汐とは、海面の規則的な上昇と下降です。");
  });

  test("does not leave \"translating…\" up when the page thinks the setting is on but it is off", async ({ page, send }) => {
    await page.goto("/fixtures/article.html");
    await send({ type: "UPDATE_FOCUS_ANCHOR", anchor: { screenY: 0 } });
    // The page missed the change back to off.
    await send({ type: "SELECTION_AUTO_CHANGED", enabled: true });

    await selectWithMouse(page);

    await expect.poll(() => tooltipText(page)).toContain("オフ");
  });

  test("picks up a change it missed when the window gets focus again", async ({ page, driver, send }) => {
    await page.goto("/fixtures/article.html");
    await send({ type: "UPDATE_FOCUS_ANCHOR", anchor: { screenY: 0 } });
    await setAuto(driver, true, false);
    await page.waitForTimeout(500);
    // The page missed the change and believes the setting is off.
    await send({ type: "SELECTION_AUTO_CHANGED", enabled: false });
    await page.waitForTimeout(300);

    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForTimeout(500);
    await selectWithMouse(page);

    await expect.poll(() => tooltipText(page)).toContain("同意");
  });
});

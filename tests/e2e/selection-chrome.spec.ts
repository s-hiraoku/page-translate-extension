import type { Page } from "@playwright/test";
import { expect, test } from "./support/extension";
import { contentTranslateCalls, mockTranslatorInContentScript } from "./support/content-world";
import { tooltipText } from "./support/tooltip";

// Lets context.route() see the service worker's requests, so a call to DeepL would be caught.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = "1";

const PARAGRAPH = "main article > p";
const SETTINGS_KEY = "pageTranslateSettings";

async function selectWithMouse(page: Page, selector = PARAGRAPH): Promise<void> {
  const box = (await page.locator(selector).first().boundingBox())!;
  await page.mouse.move(box.x + 4, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + 260, box.y + 8, { steps: 6 });
  await page.mouse.up();
}

// With Chrome's built-in translator (the default for new installs), the page translates selections
// itself: no side panel, no consent, nothing sent to DeepL.
test.describe("selection translation with Chrome's translator, in the page", () => {
  let deeplCalls = 0;

  test.beforeEach(async ({ page, context, send }) => {
    deeplCalls = 0;
    await context.route(/api(-free)?\.deepl\.com/, (route) => { deeplCalls += 1; return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ translations: [{ text: "DeepLの訳" }] }) }); });
    await page.setViewportSize({ width: 1000, height: 640 });
    await page.goto("/fixtures/article.html");
    // The content script is there once it answers.
    await send({ type: "UPDATE_FOCUS_ANCHOR", anchor: { screenY: 0 } });
  });

  const settings = (driver: Page, values: Record<string, unknown>) => driver.evaluate(async ({ key, values }) => {
    const stored = await chrome.storage.local.get(key);
    await chrome.storage.local.set({ [key]: { ...(stored[key] ?? {}), ...values } });
  }, { key: SETTINGS_KEY, values });

  test("a new install uses Chrome's translator", async ({ driver }) => {
    expect(await driver.evaluate(async (key) => ((await chrome.storage.local.get(key))[key] as { translationProvider?: string }).translationProvider, SETTINGS_KEY)).toBe("chrome");
  });

  test("translate as I select: the page translates it, without consent and without DeepL", async ({ page, driver }) => {
    await mockTranslatorInContentScript(page, "available");
    await settings(driver, { selectionAutoTranslate: true });

    await selectWithMouse(page);

    await expect.poll(async () => (await tooltipText(page)) ?? "").toContain("[Chrome ja] Tides are the regular rise");
    expect(await tooltipText(page)).toContain("Chrome");
    expect(await tooltipText(page)).not.toContain("DeepL");
    expect(deeplCalls).toBe(0);
  });

  test("into English when that is the target", async ({ page, driver }) => {
    await mockTranslatorInContentScript(page, "available");
    await settings(driver, { selectionAutoTranslate: true, targetLanguage: "EN" });

    await selectWithMouse(page, 'p:has-text("日本語の段落")');

    await expect.poll(async () => (await tooltipText(page)) ?? "").toContain("[Chrome en]");
  });

  test("text already in the target language is not translated", async ({ page, driver }) => {
    await mockTranslatorInContentScript(page, "available");
    await settings(driver, { selectionAutoTranslate: true });

    await selectWithMouse(page, 'p:has-text("日本語の段落")');

    await expect.poll(async () => (await tooltipText(page)) ?? "").toContain("すでに日本語です");
  });

  test("the shortcut and the menu: the page translates what is selected", async ({ page, send }) => {
    await mockTranslatorInContentScript(page, "available");
    await selectWithMouse(page);

    expect(await send({ type: "TRANSLATE_SELECTION_LOCALLY", targetLanguage: "JA" })).toEqual({ handled: true });

    await expect.poll(async () => (await tooltipText(page)) ?? "").toContain("[Chrome ja]");
    expect(deeplCalls).toBe(0);
  });

  test("the shortcut with nothing selected says so", async ({ page, send }) => {
    await mockTranslatorInContentScript(page, "available");
    expect(await send({ type: "TRANSLATE_SELECTION_LOCALLY", targetLanguage: "JA" })).toEqual({ handled: true });
    await expect.poll(async () => (await tooltipText(page)) ?? "").toContain("翻訳する文章を選択してから");
  });

  test("where Chrome has no translator, the page hands the shortcut back for DeepL", async ({ page, send }) => {
    await mockTranslatorInContentScript(page, "none");
    await selectWithMouse(page);
    expect(await send({ type: "TRANSLATE_SELECTION_LOCALLY", targetLanguage: "JA" })).toEqual({ handled: false });
  });

  test("where Chrome has no translator, translate as I select falls back to DeepL (which asks for consent first)", async ({ page, driver }) => {
    await mockTranslatorInContentScript(page, "none");
    await settings(driver, { selectionAutoTranslate: true });

    await selectWithMouse(page);

    await expect.poll(async () => (await tooltipText(page)) ?? "").toContain("同意");
    expect(deeplCalls).toBe(0);
  });

  test("says how to start when the model needs downloading and Chrome wants a click", async ({ page, driver }) => {
    await mockTranslatorInContentScript(page, "downloadable-needs-click");
    await settings(driver, { selectionAutoTranslate: true });

    await selectWithMouse(page);

    await expect.poll(async () => (await tooltipText(page)) ?? "").toContain("翻訳モデルのダウンロードが必要です");
  });

  test("says so when this Chrome cannot translate English and Japanese", async ({ page, driver }) => {
    await mockTranslatorInContentScript(page, "unavailable");
    await settings(driver, { selectionAutoTranslate: true });

    await selectWithMouse(page);

    await expect.poll(async () => (await tooltipText(page)) ?? "").toContain("DeepLに切り替えてください");
  });

  test("selecting the same text again does not translate it again", async ({ page, driver }) => {
    await mockTranslatorInContentScript(page, "available");
    await settings(driver, { selectionAutoTranslate: true });
    await selectWithMouse(page);
    await expect.poll(async () => (await tooltipText(page)) ?? "").toContain("[Chrome ja]");

    await page.keyboard.press("Escape");
    await page.evaluate(() => getSelection()?.removeAllRanges());
    await selectWithMouse(page);
    await expect.poll(async () => (await tooltipText(page)) ?? "").toContain("[Chrome ja]");
    expect(await contentTranslateCalls(page)).toBe(1);
  });

  test("does nothing while the setting is off", async ({ page }) => {
    await mockTranslatorInContentScript(page, "available");
    await selectWithMouse(page);
    await page.waitForTimeout(800);
    expect(await tooltipText(page)).toBeNull();
    expect(await contentTranslateCalls(page)).toBe(0);
  });
});

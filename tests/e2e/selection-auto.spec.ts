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

  const setAuto = (driver: Page, enabled: boolean, consent: boolean, provider = "deepl", claudeModel = "claude-haiku-5-5") => driver.evaluate(async ({ enabled, consent, provider, claudeModel, SETTINGS_KEY, CONSENT_KEY }) => {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    await chrome.storage.local.set({ [SETTINGS_KEY]: { ...(stored[SETTINGS_KEY] ?? {}), selectionAutoTranslate: enabled, translationProvider: provider, claudeModel } });
    if (consent) await chrome.storage.local.set({ [CONSENT_KEY]: 3 });
  }, { enabled, consent, provider, claudeModel, SETTINGS_KEY, CONSENT_KEY });

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
    await driver.evaluate(() => chrome.runtime.sendMessage({ type: "SAVE_PROVIDER_KEYS", keys: { deeplApiKey: "test-key:fx" } }));
    await setAuto(driver, true, true);
    await page.waitForTimeout(500);

    await selectWithMouse(page);

    await expect.poll(async () => (await tooltipText(page)) ?? "").toContain("潮汐とは、海面の規則的な上昇と下降です。");
  });

  test("translates with Claude when Claude is chosen: the request carries the key and the tooltip shows the answer", async ({ page, context, driver, send }) => {
    const requests: Array<{ headers: Record<string, string>; body: { model?: string; fallbacks?: unknown; messages?: Array<{ content: string }> } }> = [];
    await context.route("https://api.anthropic.com/**", (route) => {
      requests.push({ headers: route.request().headers(), body: route.request().postDataJSON() });
      route.fulfill({ status: 200, contentType: "text/event-stream", body: claudeStream(JSON.stringify({ text: "潮汐とは、海面の規則的な上昇と下降です。" })) });
    });
    await page.goto("/fixtures/article.html");
    await send({ type: "UPDATE_FOCUS_ANCHOR", anchor: { screenY: 0 } });
    await driver.evaluate(() => chrome.runtime.sendMessage({ type: "SAVE_PROVIDER_KEYS", keys: { anthropicApiKey: "sk-ant-test" } }));
    await setAuto(driver, true, true, "claude");
    await page.waitForTimeout(500);

    await selectWithMouse(page);

    await expect.poll(async () => (await tooltipText(page)) ?? "").toContain("潮汐とは、海面の規則的な上昇と下降です。");
    expect(requests[0]?.headers["x-api-key"]).toBe("sk-ant-test");
    expect(requests[0]?.body.model).toBe("claude-haiku-5-5");
    // Haiku has no server-side fallback, so none is asked for.
    expect(requests[0]?.body.fallbacks).toBeUndefined();
  });

  test("uses the Claude model chosen in Settings, with the refusal fallback on Sonnet and Opus", async ({ page, context, driver, send }) => {
    const bodies: Array<{ model?: string; fallbacks?: unknown }> = [];
    await context.route("https://api.anthropic.com/**", (route) => {
      bodies.push(route.request().postDataJSON());
      route.fulfill({ status: 200, contentType: "text/event-stream", body: claudeStream(JSON.stringify({ text: "潮汐とは、海面の規則的な上昇と下降です。" })) });
    });
    await page.goto("/fixtures/article.html");
    await send({ type: "UPDATE_FOCUS_ANCHOR", anchor: { screenY: 0 } });
    await driver.evaluate(() => chrome.runtime.sendMessage({ type: "SAVE_PROVIDER_KEYS", keys: { anthropicApiKey: "sk-ant-test" } }));
    await setAuto(driver, true, true, "claude", "claude-sonnet-5-5");
    await page.waitForTimeout(500);

    await selectWithMouse(page);

    await expect.poll(async () => (await tooltipText(page)) ?? "").toContain("潮汐とは、海面の規則的な上昇と下降です。");
    expect(bodies[0]?.model).toBe("claude-sonnet-5-5");
    expect(bodies[0]?.fallbacks).toBe("default");
  });

  test("shows nothing when the setting is off, even if the page was told it was on", async ({ page, send }) => {
    await page.goto("/fixtures/article.html");
    await send({ type: "UPDATE_FOCUS_ANCHOR", anchor: { screenY: 0 } });
    await send({ type: "SELECTION_AUTO_CHANGED", enabled: true });

    await selectWithMouse(page);
    await page.waitForTimeout(800);

    expect(await tooltipText(page)).toBeNull();
  });

  // Regression (v1.6.4): right after the setting was turned on, an open page kept ignoring selections
  // until it was reloaded or got focus again, because it had missed the change.
  test("works right after the setting is turned on, even if the page missed the change", async ({ page, driver, send }) => {
    await page.goto("/fixtures/article.html");
    await send({ type: "UPDATE_FOCUS_ANCHOR", anchor: { screenY: 0 } });
    await setAuto(driver, true, false);
    // The page missed the change and believes the setting is off.
    await send({ type: "SELECTION_AUTO_CHANGED", enabled: false });

    await selectWithMouse(page);

    await expect.poll(() => tooltipText(page)).toContain("同意");
  });
});

/** A Messages API stream (server-sent events) whose only text is `text`. */
function claudeStream(text: string): string {
  const events: Array<[string, object]> = [
    ["message_start", { type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } }],
    ["message_stop", { type: "message_stop" }],
  ];
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

import type { Page } from "@playwright/test";
import type { SelectionEvent } from "../../src/shared/types";
import { expect, test } from "./support/extension";
import { tooltipBox, tooltipText } from "./support/tooltip";

const PARAGRAPH = "main article > p";

/** Drags the mouse across the first line of a paragraph, like a reader selecting text. */
async function selectWithMouse(page: Page, selector = PARAGRAPH, width = 260): Promise<void> {
  const box = (await page.locator(selector).first().boundingBox())!;
  await page.mouse.move(box.x + 4, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + width, box.y + 8, { steps: 6 });
  await page.mouse.up();
}

test.describe("selection translation in the page", () => {
  test.beforeEach(async ({ page, driver, evaluateInExtension, send }) => {
    void driver;
    await page.setViewportSize({ width: 1000, height: 640 });
    await page.goto("/fixtures/article.html");
    // The content script arrives a moment after load, and a port opened before it is dropped at once:
    // a message (which `send` retries until the script answers) tells us it is there.
    await send({ type: "UPDATE_FOCUS_ANCHOR", anchor: { screenY: 0 } });
    // The panel holds this port while the mode is on; here the driver plays the panel.
    await evaluateInExtension((tabId) => {
      const holder = window as unknown as { events: unknown[]; selectionPort: chrome.runtime.Port };
      holder.events = [];
      holder.selectionPort = chrome.tabs.connect(tabId, { name: "selection-translate" });
      holder.selectionPort.onMessage.addListener((message) => holder.events.push(message));
    });
  });

  const events = (driver: Page) => driver.evaluate(() => (window as unknown as { events: SelectionEvent[] }).events);

  test("selecting text reports it and shows a tooltip that says it is translating", async ({ page, driver }) => {
    await selectWithMouse(page);

    await expect.poll(async () => (await events(driver)).length).toBe(1);
    const [event] = await events(driver);
    expect(event).toMatchObject({ type: "selected" });
    expect(event!.text).toMatch(/^Tides are the regular rise/);
    expect(await tooltipText(page)).toContain("翻訳しています");
  });

  test("shows the translation below the selection", async ({ page, driver, send }) => {
    await selectWithMouse(page);
    await expect.poll(async () => (await events(driver)).length).toBe(1);
    const [event] = await events(driver);

    expect(await send({ type: "SELECTION_RESULT", id: event!.id, text: "潮汐とは、月と太陽の引力による海面の規則的な上昇と下降です。" })).toEqual({ shown: true });

    expect(await tooltipText(page)).toContain("潮汐とは、月と太陽の引力による海面の規則的な上昇と下降です。");
    expect(await tooltipText(page)).toContain("DeepL");
    const selected = await page.locator(PARAGRAPH).first().boundingBox();
    const tooltip = await tooltipBox(page);
    expect(tooltip!.y).toBeGreaterThan(selected!.y);
    expect(tooltip!.x).toBeGreaterThanOrEqual(0);
    expect(tooltip!.x + tooltip!.width).toBeLessThanOrEqual(1000);
  });

  test("a note or an error goes into the same tooltip", async ({ page, driver, send }) => {
    await selectWithMouse(page);
    await expect.poll(async () => (await events(driver)).length).toBe(1);
    const [event] = await events(driver);

    await send({ type: "SELECTION_RESULT", id: event!.id, note: "選択した文章は、すでに日本語です。" });
    expect(await tooltipText(page)).toContain("すでに日本語です");
    await send({ type: "SELECTION_RESULT", id: event!.id, error: "DeepLに接続できませんでした。" });
    expect(await tooltipText(page)).toContain("DeepLに接続できませんでした");
  });

  test("ignores an answer meant for a tooltip that is gone", async ({ page, driver, send }) => {
    await selectWithMouse(page);
    await expect.poll(async () => (await events(driver)).length).toBe(1);
    const [first] = await events(driver);

    await selectWithMouse(page, "main article > p:nth-of-type(2)");
    await expect.poll(async () => (await events(driver)).length).toBe(2);

    expect(await send({ type: "SELECTION_RESULT", id: first!.id, text: "古い答え" })).toEqual({ shown: false });
    expect(await tooltipText(page)).not.toContain("古い答え");
  });

  test("selecting something else replaces the tooltip", async ({ page, driver }) => {
    await selectWithMouse(page);
    await expect.poll(async () => (await events(driver)).length).toBe(1);
    await selectWithMouse(page, "main article > p:nth-of-type(2)");

    await expect.poll(async () => (await events(driver)).length).toBe(2);
    const [first, second] = await events(driver);
    expect(second!.id).toBeGreaterThan(first!.id);
    expect(second!.text).toMatch(/^The Moon's gravity/);
    await expect(page.locator("[data-page-translate-tooltip]")).toHaveCount(1);
  });

  test("closes on Esc and when the reader clicks elsewhere", async ({ page, driver }) => {
    await selectWithMouse(page);
    await expect.poll(async () => (await events(driver)).length).toBe(1);
    await expect(page.locator("[data-page-translate-tooltip]")).toHaveCount(1);

    await page.keyboard.press("Escape");
    await expect(page.locator("[data-page-translate-tooltip]")).toHaveCount(0);

    await selectWithMouse(page, "main article > p:nth-of-type(2)");
    await expect(page.locator("[data-page-translate-tooltip]")).toHaveCount(1);
    await page.mouse.click(900, 600);
    await expect(page.locator("[data-page-translate-tooltip]")).toHaveCount(0);
  });

  test("clicking inside the tooltip keeps it", async ({ page, driver, send }) => {
    await selectWithMouse(page);
    await expect.poll(async () => (await events(driver)).length).toBe(1);
    const [event] = await events(driver);
    await send({ type: "SELECTION_RESULT", id: event!.id, text: "訳文" });

    const box = (await tooltipBox(page))!;
    await page.mouse.click(box.x + 20, box.y + 12);
    await page.waitForTimeout(300);

    await expect(page.locator("[data-page-translate-tooltip]")).toHaveCount(1);
    expect((await events(driver)).length).toBe(1);
  });

  test("follows the selection when the page scrolls", async ({ page, driver }) => {
    await selectWithMouse(page);
    await expect.poll(async () => (await events(driver)).length).toBe(1);
    const before = (await tooltipBox(page))!.y;

    await page.evaluate(() => window.scrollBy(0, 60));
    await expect.poll(async () => (await tooltipBox(page))!.y).toBeLessThan(before - 40);
  });

  test("a stray click or a one-letter selection does not translate anything", async ({ page, driver }) => {
    await page.mouse.click(300, 300);
    await selectWithMouse(page, PARAGRAPH, 8);
    await page.waitForTimeout(400);

    expect(await events(driver)).toEqual([]);
    await expect(page.locator("[data-page-translate-tooltip]")).toHaveCount(0);
  });

  test("goes away when the panel closes the port", async ({ page, driver }) => {
    await selectWithMouse(page);
    await expect.poll(async () => (await events(driver)).length).toBe(1);

    await driver.evaluate(() => (window as unknown as { selectionPort: chrome.runtime.Port }).selectionPort.disconnect());

    await expect(page.locator("[data-page-translate-tooltip]")).toHaveCount(0);
    await selectWithMouse(page, "main article > p:nth-of-type(2)");
    await page.waitForTimeout(400);
    expect(await events(driver)).toHaveLength(1);
  });

  test("the page's scan and page-click mode do not treat the tooltip as page text", async ({ page, driver, send }) => {
    await selectWithMouse(page);
    await expect.poll(async () => (await events(driver)).length).toBe(1);

    const scan = await send<{ segments: Array<{ sourceText: string }> }>({ type: "SCAN_PAGE" });
    expect(scan.segments.map((segment) => segment.sourceText).join("\n")).not.toContain("翻訳しています");
  });
});

test.describe("selection translation on demand (the shortcut)", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 640 });
    await page.goto("/fixtures/article.html");
  });

  test("reads the current selection and shows the translating tooltip", async ({ page, send }) => {
    await selectWithMouse(page);
    const read = await send<{ id: number; text: string }>({ type: "READ_SELECTION" });

    expect(read.text).toMatch(/^Tides are the regular rise/);
    expect(read.id).toBeGreaterThan(0);
    expect(await tooltipText(page)).toContain("翻訳しています");
    expect(await send({ type: "SELECTION_RESULT", id: read.id, text: "潮汐" })).toEqual({ shown: true });
    expect(await tooltipText(page)).toContain("潮汐");
  });

  test("with nothing selected it says so instead of staying silent", async ({ page, send }) => {
    expect(await send({ type: "READ_SELECTION" })).toEqual({ empty: true });
    expect(await tooltipText(page)).toContain("翻訳する文章を選択してから");
  });

  test("its tooltip goes away by itself", async ({ page, send }) => {
    await send({ type: "READ_SELECTION" });
    await expect(page.locator("[data-page-translate-tooltip]")).toHaveCount(1);
    await expect(page.locator("[data-page-translate-tooltip]")).toHaveCount(0, { timeout: 6000 });
  });

  test("text inside a form field is not read", async ({ page, send }) => {
    await page.evaluate(() => {
      document.body.insertAdjacentHTML("beforeend", '<input id="field" value="Hello there, general Kenobi">');
      (document.getElementById("field") as HTMLInputElement).select();
    });
    expect(await send({ type: "READ_SELECTION" })).toEqual({ empty: true });
  });
});

import type { Page } from "@playwright/test";
import { expect, test } from "./support/extension";
import { tooltipText } from "./support/tooltip";

test.describe("watching the page for navigation", () => {
  test.beforeEach(async ({ page, driver, evaluateInExtension, send }) => {
    void driver;
    await page.goto("/fixtures/article.html");
    await send({ type: "UPDATE_FOCUS_ANCHOR", anchor: { screenY: 0 } });
    await evaluateInExtension((tabId) => {
      const holder = window as unknown as { watched: unknown[]; watchDropped: boolean; watch: chrome.runtime.Port };
      holder.watched = [];
      holder.watchDropped = false;
      holder.watch = chrome.tabs.connect(tabId, { name: "page-watch" });
      holder.watch.onMessage.addListener((message) => holder.watched.push(message));
      holder.watch.onDisconnect.addListener(() => { holder.watchDropped = true; });
    });
  });

  const watched = (driver: Page) => driver.evaluate(() => (window as unknown as { watched: unknown[] }).watched);
  const navigate = (page: Page, url: string) => page.evaluate((next) => history.pushState({}, "", next), url);

  test("reports a route change made without loading a new page", async ({ page, driver }) => {
    await navigate(page, "/fixtures/other-article");
    await expect.poll(() => watched(driver)).toEqual([{ type: "navigated" }]);
  });

  test("ignores changes that are the same page: a fragment or tracking parameters", async ({ page, driver }) => {
    await navigate(page, "/fixtures/article.html#section-2");
    await navigate(page, "/fixtures/article.html?utm_source=news&fbclid=abc");
    await page.waitForTimeout(1500);
    expect(await watched(driver)).toEqual([]);
  });

  test("the port is dropped when the page loads a new document", async ({ page, driver }) => {
    await page.goto("/fixtures/article.html?page=2");
    await expect.poll(() => driver.evaluate(() => (window as unknown as { watchDropped: boolean }).watchDropped)).toBe(true);
  });
});

test.describe("closing the panel", () => {
  test("ends page-click mode: the page stops reporting clicks once its port is dropped", async ({ page, driver, evaluateInExtension, send }) => {
    await page.goto("/fixtures/article.html");
    await send({ type: "SCAN_PAGE" });
    await evaluateInExtension((tabId) => {
      const holder = window as unknown as { pick: chrome.runtime.Port; events: unknown[] };
      holder.events = [];
      holder.pick = chrome.tabs.connect(tabId, { name: "page-pick" });
      holder.pick.onMessage.addListener((message) => holder.events.push(message));
    });
    await page.waitForTimeout(300);
    await driver.evaluate(() => (window as unknown as { pick: chrome.runtime.Port }).pick.disconnect());
    await page.waitForTimeout(300);
    await page.locator("main article > p").first().click({ position: { x: 10, y: 10 } });
    await page.waitForTimeout(300);
    expect(await driver.evaluate(() => (window as unknown as { events: unknown[] }).events)).toEqual([]);
  });

  test("removes the selection tooltip when the last panel goes away", async ({ page, driver, evaluateInExtension, send }) => {
    await page.setViewportSize({ width: 1000, height: 640 });
    await page.goto("/fixtures/article.html");
    await send({ type: "UPDATE_FOCUS_ANCHOR", anchor: { screenY: 0 } });
    await evaluateInExtension((tabId) => {
      const holder = window as unknown as Record<string, chrome.runtime.Port>;
      holder.presence = chrome.tabs.connect(tabId, { name: "panel-presence" });
      holder.selection = chrome.tabs.connect(tabId, { name: "selection-translate" });
    });
    const box = (await page.locator("main article > p").first().boundingBox())!;
    await page.mouse.move(box.x + 4, box.y + 8);
    await page.mouse.down();
    await page.mouse.move(box.x + 260, box.y + 8, { steps: 6 });
    await page.mouse.up();
    await expect.poll(() => tooltipText(page)).toContain("翻訳しています");

    await driver.evaluate(() => (window as unknown as Record<string, chrome.runtime.Port>).presence.disconnect());
    await expect.poll(() => tooltipText(page)).toBeNull();
  });
});

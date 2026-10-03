import { expect, test, type Page } from "@playwright/test";
import { installChromeMock, PANEL_WINDOW_ID } from "./support/chrome-mock";

const PANEL = "/src/sidepanel/index.html";
const PAGE_CLICK = ".pick-toggle:not(.selection-toggle)";
const SELECTION = ".selection-toggle";
const START_TEXT = "ページを開いて「このページを翻訳」を押してください。";

async function openPanel(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 380, height: 800 });
  await installChromeMock(page, {});
  await page.goto(PANEL);
  await expect(page.locator(".translate-button")).toBeVisible();
  return errors;
}

async function translate(page: Page): Promise<void> {
  await page.locator(".translate-button").click();
  await expect(page.locator(".entry-card").first()).toBeVisible();
  await expect(page.locator(".translate-button")).toBeEnabled();
  // The panel starts watching the page once the scan is done.
  await expect.poll(() => page.evaluate(() => (window as unknown as { __watching?: number }).__watching)).toBe(1);
}

const call = (page: Page, name: "__emitWatch" | "__dropWatch") =>
  page.evaluate((fn) => (window as unknown as Record<string, (message?: unknown) => void>)[fn]({ type: "navigated" }), name);

test.describe("closing the panel", () => {
  for (const [label, selector] of [["page-click", PAGE_CLICK], ["selection", SELECTION]] as const) {
    test(`turns ${label} mode off and disconnects from the page`, async ({ page }) => {
      const errors = await openPanel(page);
      await translate(page);
      await page.locator(selector).click();
      await expect(page.locator(selector)).toHaveAttribute("aria-pressed", "true");
      const before = await page.evaluate(() => (window as unknown as { __disconnected?: number }).__disconnected ?? 0);

      await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));

      await expect(page.locator(selector)).toHaveAttribute("aria-pressed", "false");
      await expect.poll(() => page.evaluate(() => (window as unknown as { __disconnected?: number }).__disconnected ?? 0)).toBeGreaterThan(before);
      expect(errors).toEqual([]);
    });
  }
});

test.describe("page-click and selection modes", () => {
  test("are never on at the same time, whichever is switched on last", async ({ page }) => {
    await openPanel(page);
    await translate(page);
    for (const [on, off] of [[PAGE_CLICK, SELECTION], [SELECTION, PAGE_CLICK], [PAGE_CLICK, SELECTION]]) {
      await page.locator(on).click();
      await expect(page.locator(on)).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator(off)).toHaveAttribute("aria-pressed", "false");
    }
  });
});

test.describe("navigating the page", () => {
  test("returns the panel to its start screen when the page reports a navigation", async ({ page }) => {
    const errors = await openPanel(page);
    await translate(page);
    await page.locator(PAGE_CLICK).click();
    await expect(page.locator(PAGE_CLICK)).toHaveAttribute("aria-pressed", "true");

    await call(page, "__emitWatch");

    await expect(page.locator(".entry-card")).toHaveCount(0);
    await expect(page.locator(PAGE_CLICK)).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator(PAGE_CLICK)).toBeDisabled();
    await expect(page.locator("body")).toContainText(START_TEXT);
    await expect(page.locator(".error-banner")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("does the same when the connection drops (full navigation or reload) and shows no error", async ({ page }) => {
    await openPanel(page);
    await translate(page);
    await page.locator(SELECTION).click();
    await expect(page.locator(SELECTION)).toHaveAttribute("aria-pressed", "true");

    await call(page, "__dropWatch");

    await expect(page.locator(".entry-card")).toHaveCount(0);
    await expect(page.locator(SELECTION)).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("body")).toContainText(START_TEXT);
    // Give a deferred "connection lost" message time to appear; it must not.
    await page.waitForTimeout(500);
    await expect(page.locator(".error-banner")).toHaveCount(0);
  });

  test("translating again turns selection mode off, since the results it works on are cleared", async ({ page }) => {
    await openPanel(page);
    await translate(page);
    await page.locator(SELECTION).click();
    await expect(page.locator(SELECTION)).toHaveAttribute("aria-pressed", "true");

    await page.locator(".translate-button").click();

    await expect(page.locator(SELECTION)).toHaveAttribute("aria-pressed", "false");
  });

  test("translating again turns page-click mode off and lets the page take its connector away", async ({ page }) => {
    await openPanel(page);
    await translate(page);
    await page.locator(PAGE_CLICK).click();
    await expect(page.locator(PAGE_CLICK)).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => page.evaluate(() => typeof (window as unknown as { __emit?: unknown }).__emit)).toBe("function");
    await page.evaluate(() => (window as unknown as { __emit: (event: unknown) => void }).__emit({ type: "picked", segmentId: "segment-1" }));
    const count = (name: "__presenceOpened" | "__presenceClosed") => page.evaluate((key) => (window as unknown as Record<string, number | undefined>)[key] ?? 0, name);
    await expect.poll(() => count("__presenceOpened")).toBe(1);

    await page.locator(".translate-button").click();

    await expect(page.locator(PAGE_CLICK)).toHaveAttribute("aria-pressed", "false");
    await expect.poll(() => count("__presenceClosed")).toBe(1);
  });

  test("can translate again after returning to the start", async ({ page }) => {
    await openPanel(page);
    await translate(page);
    await call(page, "__emitWatch");
    await expect(page.locator(".entry-card")).toHaveCount(0);

    await page.locator(".translate-button").click();
    await expect(page.locator(".entry-card").first()).toBeVisible();
  });

  test("drops a translation that finishes after the page navigated away", async ({ page }) => {
    await openPanel(page);
    await page.evaluate(() => {
      const w = window as unknown as { __override: (type: string, handler: () => unknown) => void; __release?: () => void };
      w.__override("TRANSLATE_SEGMENTS", () => new Promise((resolve) => { w.__release = () => resolve({ translations: [] }); }));
    });
    await page.locator(".translate-button").click();
    // The scan is done (the panel watches the page) while DeepL is still working.
    await expect.poll(() => page.evaluate(() => (window as unknown as { __watching?: number }).__watching)).toBe(1);
    await expect.poll(() => page.evaluate(() => typeof (window as unknown as { __release?: unknown }).__release)).toBe("function");

    await call(page, "__emitWatch");
    await page.evaluate(() => (window as unknown as { __release: () => void }).__release());

    await expect(page.locator(".translate-button")).toBeEnabled();
    await page.waitForTimeout(300);
    await expect(page.locator(".entry-card")).toHaveCount(0);
    await expect(page.locator("body")).toContainText(START_TEXT);
    await expect(page.locator(".error-banner")).toHaveCount(0);
  });
});

test.describe("switching tabs", () => {
  const activate = (page: Page, tabId: number, windowId: number) =>
    page.evaluate((info) => (window as unknown as { __activateTab: (info: object) => void }).__activateTab(info), { tabId, windowId });
  const PANEL_WINDOW = PANEL_WINDOW_ID;

  test("clears the translation and turns the modes off", async ({ page }) => {
    const errors = await openPanel(page);
    await translate(page);
    await page.locator(PAGE_CLICK).click();
    await expect(page.locator(PAGE_CLICK)).toHaveAttribute("aria-pressed", "true");

    await activate(page, 99, PANEL_WINDOW);

    await expect(page.locator(".entry-card")).toHaveCount(0);
    await expect(page.locator(PAGE_CLICK)).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("body")).toContainText(START_TEXT);
    expect(errors).toEqual([]);
  });

  test("lets the old page take its connector away", async ({ page }) => {
    await openPanel(page);
    await translate(page);
    await page.locator(".entry-card").first().click();
    const count = (name: "__presenceOpened" | "__presenceClosed") => page.evaluate((key) => (window as unknown as Record<string, number | undefined>)[key] ?? 0, name);
    await expect.poll(() => count("__presenceOpened")).toBe(1);

    await activate(page, 99, PANEL_WINDOW);

    await expect.poll(() => count("__presenceClosed")).toBe(1);
  });

  test("lets the old page take its connector away after a source was picked on the page", async ({ page }) => {
    await openPanel(page);
    await translate(page);
    await page.locator(PAGE_CLICK).click();
    await expect.poll(() => page.evaluate(() => typeof (window as unknown as { __emit?: unknown }).__emit)).toBe("function");
    await page.evaluate(() => (window as unknown as { __emit: (event: unknown) => void }).__emit({ type: "picked", segmentId: "segment-1" }));
    const count = (name: "__presenceOpened" | "__presenceClosed") => page.evaluate((key) => (window as unknown as Record<string, number | undefined>)[key] ?? 0, name);
    await expect.poll(() => count("__presenceOpened")).toBe(1);

    await activate(page, 99, PANEL_WINDOW);

    await expect.poll(() => count("__presenceClosed")).toBe(1);
    await expect(page.locator(PAGE_CLICK)).toHaveAttribute("aria-pressed", "false");
  });

  test("turns selection mode off when the tab changes, even without a translation", async ({ page }) => {
    await openPanel(page);
    await page.locator(SELECTION).click();
    await expect(page.locator(SELECTION)).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => page.evaluate(() => typeof (window as unknown as { __emitSelection?: unknown }).__emitSelection)).toBe("function");

    await activate(page, 99, PANEL_WINDOW);

    await expect(page.locator(SELECTION)).toHaveAttribute("aria-pressed", "false");
  });

  test("keeps everything when the same tab is activated again or another window changes tab", async ({ page }) => {
    await openPanel(page);
    await translate(page);

    await activate(page, 7, PANEL_WINDOW);
    await activate(page, 99, PANEL_WINDOW + 1);

    await expect(page.locator(".entry-card").first()).toBeVisible();
  });
});

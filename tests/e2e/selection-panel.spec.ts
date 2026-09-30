import { expect, test, type Page } from "@playwright/test";
import { installChromeMock, pressShortcut, type MockOptions } from "./support/chrome-mock";

const PANEL = "/src/sidepanel/index.html";

async function openPanel(page: Page, options: MockOptions = {}): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 380, height: 800 });
  await installChromeMock(page, options);
  await page.goto(PANEL);
  await expect(page.locator(".translate-button")).toBeVisible();
  return errors;
}

type Sent = Array<{ type: string; id?: number; text?: string; note?: string; error?: string; targetLang?: string }>;
const sent = (page: Page, type: string) => page.evaluate((wanted) => (window as unknown as { __sent: Sent }).__sent.filter((message) => message.type === wanted), type);
const selectionToggle = (page: Page) => page.locator(".selection-toggle");
const overrideMessage = (page: Page, type: string, reply: unknown) => page.evaluate(({ type, reply }) => {
  (window as unknown as { __override: (type: string, handler: () => unknown) => void }).__override(type, () => reply);
}, { type, reply });

test.describe("selection translation buttons", () => {
  test("both mode buttons are always there, and only page-click waits for a translation", async ({ page }) => {
    await openPanel(page);
    await expect(page.locator(".pick-toggle")).toHaveCount(2);
    await expect(page.locator(".pick-toggle").first()).toBeDisabled();
    await expect(selectionToggle(page)).toBeEnabled();

    await page.locator(".translate-button").click();
    await expect(page.locator(".translate-button")).toBeEnabled();
    await expect(page.locator(".pick-toggle").first()).toBeEnabled();
  });

  test("shows the shortcut on the button", async ({ page }) => {
    await openPanel(page, { shortcuts: { "translate-selection": "Alt+Shift+S" } });
    await expect(selectionToggle(page).locator(".button-kbd")).toHaveText("Alt+Shift+S");
    await expect(selectionToggle(page)).toHaveAttribute("title", /Alt\+Shift\+S/);
  });

  const storedAuto = (page: Page) => page.evaluate(async () => {
    const chromeApi = (window as unknown as { chrome: { storage: { local: { get: (key: string) => Promise<Record<string, { selectionAutoTranslate?: boolean }>> } } } }).chrome;
    return (await chromeApi.storage.local.get("pageTranslateSettings")).pageTranslateSettings?.selectionAutoTranslate;
  });

  test("turning it on saves the setting that also works with the panel closed, turning it off clears it", async ({ page }) => {
    const errors = await openPanel(page);
    await selectionToggle(page).click();

    await expect(selectionToggle(page)).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => storedAuto(page)).toBe(true);
    await expect(page.locator(".pick-note")).toContainText("パネルを閉じても続きます");

    await selectionToggle(page).click();
    await expect(selectionToggle(page)).toHaveAttribute("aria-pressed", "false");
    await expect.poll(() => storedAuto(page)).toBe(false);
    expect(errors).toEqual([]);
  });

  test("stays on when the panel is closed", async ({ page }) => {
    await openPanel(page);
    await selectionToggle(page).click();
    await expect.poll(() => storedAuto(page)).toBe(true);

    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));

    await expect(selectionToggle(page)).toHaveAttribute("aria-pressed", "true");
    expect(await storedAuto(page)).toBe(true);
  });

  test("asks for consent before the first use and stays off if the reader declines", async ({ page }) => {
    await openPanel(page, { consent: null });
    await selectionToggle(page).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    await dialog.getByRole("button", { name: "キャンセル" }).click();
    await expect(selectionToggle(page)).toHaveAttribute("aria-pressed", "false");

    await selectionToggle(page).click();
    await dialog.getByRole("button", { name: "同意して続ける" }).click();
    await expect(selectionToggle(page)).toHaveAttribute("aria-pressed", "true");
  });

  test("cannot be on together with page-click mode", async ({ page }) => {
    await openPanel(page);
    await page.locator(".translate-button").click();
    await expect(page.locator(".pick-toggle").first()).toBeEnabled();

    await selectionToggle(page).click();
    await expect(selectionToggle(page)).toHaveAttribute("aria-pressed", "true");
    await page.locator(".pick-toggle").first().click();
    await expect(page.locator(".pick-toggle").first()).toHaveAttribute("aria-pressed", "true");
    await expect(selectionToggle(page)).toHaveAttribute("aria-pressed", "false");

    await selectionToggle(page).click();
    await expect(selectionToggle(page)).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".pick-toggle").first()).toHaveAttribute("aria-pressed", "false");
  });
});

test.describe("the shortcut", () => {
  test("translates what is selected right now, once, without turning the mode on", async ({ page }) => {
    await openPanel(page);
    await overrideMessage(page, "READ_SELECTION", { id: 9, text: "Translate exactly this sentence." });
    await pressShortcut(page, "translate-selection");

    await expect.poll(async () => (await sent(page, "SELECTION_RESULT")).length).toBe(1);
    expect(await sent(page, "TRANSLATE_SELECTION")).toMatchObject([{ text: "Translate exactly this sentence." }]);
    expect(await sent(page, "SELECTION_RESULT")).toMatchObject([{ id: 9, text: "訳:Translate exactly this sentence." }]);
    await expect(selectionToggle(page)).toHaveAttribute("aria-pressed", "false");
  });

  test("does nothing more when nothing is selected (the page says so itself)", async ({ page }) => {
    await openPanel(page);
    await overrideMessage(page, "READ_SELECTION", { empty: true });
    await pressShortcut(page, "translate-selection");

    await expect.poll(async () => (await sent(page, "READ_SELECTION")).length).toBe(1);
    await page.waitForTimeout(300);
    expect(await sent(page, "TRANSLATE_SELECTION")).toEqual([]);
    expect(await sent(page, "SELECTION_RESULT")).toEqual([]);
  });

  test("asks for consent first and tells the tooltip if the reader declines", async ({ page }) => {
    await openPanel(page, { consent: null });
    await overrideMessage(page, "READ_SELECTION", { id: 5, text: "Needs consent first." });
    await pressShortcut(page, "translate-selection");

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    expect(await sent(page, "TRANSLATE_SELECTION")).toEqual([]);
    await dialog.getByRole("button", { name: "キャンセル" }).click();

    await expect.poll(async () => (await sent(page, "SELECTION_RESULT")).length).toBe(1);
    expect(await sent(page, "SELECTION_RESULT")).toMatchObject([{ id: 5, note: expect.stringContaining("同意されなかった") }]);
    expect(await sent(page, "TRANSLATE_SELECTION")).toEqual([]);
  });

  test("works while the page is being translated", async ({ page }) => {
    await openPanel(page);
    await page.evaluate(() => {
      (window as unknown as { __override: (type: string, handler: () => Promise<unknown>) => void }).__override("TRANSLATE_SEGMENTS", async () => {
        await new Promise((resolve) => setTimeout(resolve, 600));
        return { translations: [] };
      });
    });
    await overrideMessage(page, "READ_SELECTION", { id: 6, text: "Selected during a page translation." });
    await page.locator(".translate-button").click();
    await expect(page.locator(".translate-button")).toBeDisabled();
    await pressShortcut(page, "translate-selection");

    await expect.poll(async () => (await sent(page, "SELECTION_RESULT")).length).toBe(1);
    expect(await sent(page, "SELECTION_RESULT")).toMatchObject([{ id: 6, text: expect.stringContaining("Selected during") }]);
  });
});

test.describe("translate as I select (works with the panel closed)", () => {
  const SETTINGS_KEY = "pageTranslateSettings";
  const auto = (page: Page) => page.getByRole("radiogroup", { name: "選択したら自動で翻訳" });
  const storedAuto = (page: Page) => page.evaluate(async (key) => {
    const chromeApi = (window as unknown as { chrome: { storage: { local: { get: (key: string) => Promise<Record<string, { selectionAutoTranslate?: boolean }>> } } } }).chrome;
    return (await chromeApi.storage.local.get(key))[key]?.selectionAutoTranslate;
  }, SETTINGS_KEY);

  test("is off by default and can be turned on in Settings", async ({ page }) => {
    await openPanel(page);
    await page.getByRole("button", { name: "設定を開く" }).click();
    await expect(auto(page).getByRole("radio", { name: "オフ" })).toHaveAttribute("aria-checked", "true");

    await auto(page).getByRole("radio", { name: "オン" }).click();

    await expect(auto(page).getByRole("radio", { name: "オン" })).toHaveAttribute("aria-checked", "true");
    await expect.poll(() => storedAuto(page)).toBe(true);
  });

  test("asks for consent first, and stays off if the reader declines", async ({ page }) => {
    await openPanel(page, { consent: null });
    await page.getByRole("button", { name: "設定を開く" }).click();
    await auto(page).getByRole("radio", { name: "オン" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    await dialog.getByRole("button", { name: "キャンセル" }).click();

    await expect(auto(page).getByRole("radio", { name: "オフ" })).toHaveAttribute("aria-checked", "true");
    expect(await storedAuto(page)).not.toBe(true);
  });

  test("follows the context menu, which changes the setting from outside the panel", async ({ page }) => {
    await openPanel(page);
    await page.getByRole("button", { name: "設定を開く" }).click();

    await page.evaluate(async (key) => {
      const chromeApi = (window as unknown as { chrome: { storage: { local: { set: (values: object) => Promise<void> } } } }).chrome;
      await chromeApi.storage.local.set({ [key]: { selectionAutoTranslate: true } });
    }, SETTINGS_KEY);

    await expect(auto(page).getByRole("radio", { name: "オン" })).toHaveAttribute("aria-checked", "true");
  });
});

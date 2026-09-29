import { expect, test as panelTest, type Page } from "@playwright/test";
import { installChromeMock, pressShortcut, sentTypes, type MockOptions } from "./support/chrome-mock";
import { test as extensionTest } from "./support/extension";

extensionTest("the built extension registers its shortcuts with their default keys", async ({ driver }) => {
  const commands = await driver.evaluate(() => chrome.commands.getAll());
  const byName = Object.fromEntries(commands.map((command) => [command.name, command.shortcut]));

  // Linux and Windows keys; Mac uses Control+Shift instead of Alt+Shift.
  expect(byName["translate-page"]).toBe("Alt+Shift+Y");
  expect(byName["toggle-page-pick"]).toBe("Alt+Shift+K");
  expect(byName["translate-selection"]).toBe("Alt+Shift+S");
});

async function openPanel(page: Page, options: MockOptions = {}): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 380, height: 800 });
  await installChromeMock(page, options);
  await page.goto("/src/sidepanel/index.html");
  await expect(page.locator(".translate-button")).toBeVisible();
  return errors;
}

panelTest.describe("keyboard shortcuts in the side panel", () => {
  panelTest("the translate shortcut translates the page", async ({ page }) => {
    const errors = await openPanel(page);
    await pressShortcut(page, "translate-page");

    await expect(page.locator(".entry-card").first()).toBeVisible();
    expect(await sentTypes(page)).toContain("TRANSLATE_SEGMENTS");
    // The request is consumed, so reopening the panel does not translate again.
    expect(await page.evaluate(() => (window as unknown as { __session: Record<string, unknown> }).__session.pageTranslatePanelCommand)).toBeUndefined();
    expect(errors).toEqual([]);
  });

  panelTest("a shortcut pressed before the panel opened is carried out once it opens", async ({ page }) => {
    await page.setViewportSize({ width: 380, height: 800 });
    await installChromeMock(page);
    await page.addInitScript(() => {
      const w = window as unknown as { __session: Record<string, unknown> };
      w.__session.pageTranslatePanelCommand = { id: "pressed-while-closed", command: "translate-page", windowId: 3, at: Date.now() };
    });
    await page.goto("/src/sidepanel/index.html");

    await expect(page.locator(".entry-card").first()).toBeVisible();
  });

  panelTest("ignores shortcuts meant for another window or pressed long ago", async ({ page }) => {
    await openPanel(page);
    await pressShortcut(page, "translate-page", 99);
    await page.evaluate(() => (window as unknown as { chrome: { storage: { session: { set: (values: object) => Promise<void> } } } }).chrome.storage.session.set({
      pageTranslatePanelCommand: { id: "old", command: "translate-page", windowId: 3, at: Date.now() - 60_000 },
    }));
    await page.waitForTimeout(300);

    expect(await sentTypes(page)).not.toContain("SCAN_ACTIVE_TAB");
  });

  panelTest("the page-click shortcut translates first, then toggles the mode", async ({ page }) => {
    await openPanel(page);
    const toggle = page.locator(".pick-toggle").first();

    await pressShortcut(page, "toggle-page-pick");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(await sentTypes(page)).toContain("TRANSLATE_SEGMENTS");

    await pressShortcut(page, "toggle-page-pick");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await pressShortcut(page, "toggle-page-pick");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect((await sentTypes(page)).filter((type) => type === "SCAN_ACTIVE_TAB")).toHaveLength(1);
  });

  panelTest("does not turn page-click mode on when the reader declines to send data", async ({ page }) => {
    await openPanel(page, { consent: null });
    await pressShortcut(page, "toggle-page-pick");
    await page.getByRole("dialog").getByRole("button", { name: "キャンセル" }).click();

    // Nothing was scanned, so page-click mode stays unavailable.
    await expect(page.locator(".pick-toggle").first()).toBeDisabled();
    await expect(page.locator(".pick-toggle").first()).toHaveAttribute("aria-pressed", "false");
    expect(await sentTypes(page)).not.toContain("SCAN_ACTIVE_TAB");
  });

  panelTest("leaves the settings or writing tab to carry out a shortcut", async ({ page }) => {
    await openPanel(page);
    await page.getByRole("tab", { name: "英作文" }).click();
    await pressShortcut(page, "translate-page");

    await expect(page.getByRole("tab", { name: "ページ翻訳" })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".entry-card").first()).toBeVisible();
  });

  panelTest("shows the current keys and links to Chrome's shortcut settings", async ({ page }) => {
    await openPanel(page, { shortcuts: { "translate-page": "Alt+Shift+Y", "toggle-page-pick": "" } });
    await expect(page.locator(".translate-button")).toHaveAttribute("title", "このページを翻訳（Alt+Shift+Y）");
    await expect(page.locator(".shortcut-hint")).toContainText("Alt+Shift+Y");

    await page.getByRole("button", { name: "設定を開く" }).click();
    const list = page.locator(".shortcut-list");
    await expect(list.locator("div").nth(0)).toContainText("Alt+Shift+Y");
    await expect(list.locator("div").nth(1)).toContainText("未設定");
    await page.getByRole("button", { name: "ショートカットを変更" }).click();
    expect(await page.evaluate(() => (window as unknown as { __createdTab: unknown }).__createdTab)).toEqual({ url: "chrome://extensions/shortcuts" });
  });
});

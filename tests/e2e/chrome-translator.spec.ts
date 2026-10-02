import { expect, test, type Page } from "@playwright/test";
import { installChromeMock, sentTypes, type MockOptions } from "./support/chrome-mock";

const PANEL = "/src/sidepanel/index.html";

async function openPanel(page: Page, options: MockOptions = {}): Promise<void> {
  await page.setViewportSize({ width: 380, height: 900 });
  await installChromeMock(page, options);
  await page.goto(PANEL);
  await expect(page.locator(".translate-button")).toBeVisible();
}

const providerSwitch = (page: Page) => page.getByRole("radiogroup", { name: "翻訳に使うサービス" });

test.describe("choosing the translation service", () => {
  test("falls back to DeepL, and Chrome cannot be chosen, where Chrome has no translator", async ({ page }) => {
    await openPanel(page);
    await page.getByRole("button", { name: "設定を開く" }).click();
    await expect(providerSwitch(page).getByRole("radio", { name: "DeepL" })).toHaveAttribute("aria-checked", "true");
    await expect(providerSwitch(page).getByRole("radio", { name: "Chrome内蔵" })).toBeDisabled();
    await expect(page.getByText("このChromeでは内蔵の翻訳を使えない")).toBeVisible();
  });

  test("Chrome's translator can be chosen where Chrome has one", async ({ page }) => {
    await openPanel(page, { translator: "available" });
    await page.getByRole("button", { name: "設定を開く" }).click();
    await providerSwitch(page).getByRole("radio", { name: "Chrome内蔵" }).click();
    await expect(providerSwitch(page).getByRole("radio", { name: "Chrome内蔵" })).toHaveAttribute("aria-checked", "true");
    // The explanation is folded until asked for, and there is nothing to warn about.
    await expect(page.locator(".setting-alert")).toHaveCount(0);
    await page.getByRole("button", { name: "翻訳に使うサービスの説明" }).click();
    await expect(page.getByText("この端末の中で翻訳します")).toBeVisible();
  });
});

test.describe("translating a page with Chrome's translator", () => {
  test("translates on this device: nothing goes to DeepL, and without Jev nothing leaves at all", async ({ page }) => {
    await openPanel(page, { translator: "available", consent: null, settings: { translationProvider: "chrome", useJev: false } });
    await expect(page.locator(".panel-footer")).toContainText("外部へは送信しません");

    await page.locator(".translate-button").click();

    await expect(page.locator('[data-entry-id="segment-2"] .entry-translation')).toContainText("[Chrome ja] Most dashboards fail");
    // No consent dialog: nothing is sent anywhere.
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const types = await sentTypes(page);
    expect(types).not.toContain("TRANSLATE_SEGMENTS");
    expect(types).not.toContain("CLASSIFY_CANDIDATES");
  });

  test("still asks Jev, with consent, when Jev is on", async ({ page }) => {
    await openPanel(page, { translator: "available", settings: { translationProvider: "chrome", useJev: true } });
    await page.locator(".translate-button").click();
    await expect(page.locator(".entry-card").first()).toBeVisible();
    const types = await sentTypes(page);
    expect(types).toContain("CLASSIFY_CANDIDATES");
    expect(types).not.toContain("TRANSLATE_SEGMENTS");
  });

  test("translates into English the other way round", async ({ page }) => {
    await openPanel(page, { translator: "available", settings: { translationProvider: "chrome", useJev: false, targetLanguage: "EN" } });
    await page.locator(".translate-button").click();
    await expect(page.locator(".entry-translation").first()).toContainText("[Chrome en]");
  });

  test("shows the model download on first use", async ({ page }) => {
    await openPanel(page, { translator: "downloadable", settings: { translationProvider: "chrome", useJev: false } });
    await page.locator(".translate-button").click();
    await expect(page.locator(".status-text")).toContainText("翻訳モデルをダウンロードしています… ");
    await expect(page.locator(".entry-card").first()).toBeVisible();
  });

  test("creates the translator once for the whole panel", async ({ page }) => {
    await openPanel(page, { translator: "available", settings: { translationProvider: "chrome", useJev: false } });
    await page.locator(".translate-button").click();
    await expect(page.locator(".entry-card").first()).toBeVisible();
    await page.locator(".translate-button").click();
    await expect(page.locator(".translate-button")).toBeEnabled();
    expect(await page.evaluate(() => (window as unknown as { __translatorCreates: number }).__translatorCreates)).toBe(1);
  });

  test("does not hint at a missing DeepL key", async ({ page }) => {
    await openPanel(page, { translator: "available", providers: { jev: false, deepl: false }, settings: { translationProvider: "chrome", useJev: false } });
    await expect(page.locator(".setup-hint")).toHaveCount(0);
  });
});

test.describe("selection translation with Chrome's translator", () => {
  test("translates what the page reports without DeepL and without asking for consent", async ({ page }) => {
    await openPanel(page, { translator: "available", consent: null, settings: { translationProvider: "chrome" } });
    await page.locator(".selection-toggle").click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => typeof (window as unknown as { __emitSelection?: unknown }).__emitSelection)).toBe("function");

    await page.evaluate(() => (window as unknown as { __emitSelection: (event: unknown) => void }).__emitSelection({ type: "selected", id: 3, text: "The tide rises." }));

    await expect.poll(() => page.evaluate(() => (window as unknown as { __sent: Array<{ type: string; id?: number; text?: string }> }).__sent.filter((m) => m.type === "SELECTION_RESULT"))).toMatchObject([{ id: 3, text: "[Chrome ja] The tide rises." }]);
    expect(await sentTypes(page)).not.toContain("TRANSLATE_SELECTION");
  });
});

test.describe("Jev is used only with its key", () => {
  test("translates without Jev, and says so in Settings, when only Jev's key is missing", async ({ page }) => {
    await openPanel(page, { providers: { jev: false, deepl: true }, settings: { translationProvider: "deepl", useJev: true } });
    await page.locator(".translate-button").click();
    await expect(page.locator(".entry-card").first()).toBeVisible();
    expect(await sentTypes(page)).not.toContain("CLASSIFY_CANDIDATES");

    await page.getByRole("button", { name: "設定を開く" }).click();
    await expect(page.getByText("JevのAPIキーが未登録のため、いまはJevを使わずに翻訳します")).toBeVisible();
  });

  test("with no key at all and Chrome's translator, translates on this device without asking anything", async ({ page }) => {
    await openPanel(page, { translator: "available", consent: null, providers: { jev: false, deepl: false } });
    await page.locator(".translate-button").click();
    await expect(page.locator(".entry-translation").first()).toContainText("[Chrome ja]");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await sentTypes(page)).not.toContain("CLASSIFY_CANDIDATES");
  });
});

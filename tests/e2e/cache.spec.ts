import { expect, test, type Page } from "@playwright/test";
import { SEGMENTS, installChromeMock, sentTypes, type MockOptions } from "./support/chrome-mock";

const PANEL = "/src/sidepanel/index.html";
const CACHE_KEY = "pageTranslateCache";
const HOUR = 3_600_000;

async function openPanel(page: Page, options: MockOptions = {}): Promise<void> {
  await page.setViewportSize({ width: 380, height: 800 });
  await installChromeMock(page, options);
  await page.goto(PANEL);
  await expect(page.locator(".translate-button")).toBeVisible();
}

async function translate(page: Page): Promise<void> {
  await page.locator(".translate-button").click();
  await expect(page.locator(".translate-button")).toBeEnabled();
}

type Call = { type: string; segments?: Array<{ id: string }> };
const calls = (page: Page, type: string) => page.evaluate((wanted) =>
  (window as unknown as { __sent: Call[] }).__sent.filter((message) => message.type === wanted).map((message) => (message.segments ?? []).map((segment) => segment.id)), type);
const clearSent = (page: Page) => page.evaluate(() => { (window as unknown as { __sent: unknown[] }).__sent.length = 0; });
const cachedPages = (page: Page) => page.evaluate(async (key) => {
  const stored = await (window as unknown as { chrome: { storage: { local: { get: (key: string) => Promise<Record<string, { pages?: Record<string, unknown> }>> } } } }).chrome.storage.local.get(key);
  return Object.keys(stored[key]?.pages ?? {});
}, CACHE_KEY);
const translationOf = (page: Page, id: string) => page.locator(`[data-entry-id="${id}"] .entry-translation`).textContent();

/** Makes the next scans report these segments (and optionally another URL). */
const scanAs = (page: Page, segments: unknown[], url = "https://journal.example.com/calm") => page.evaluate(({ segments, url }) => {
  (window as unknown as { __override: (type: string, handler: () => unknown) => void }).__override("SCAN_ACTIVE_TAB", () => ({ title: "Designing calm interfaces", url, segments, mainContentDetected: true, excludedCount: 14 }));
}, { segments, url });

/** Translations that name their text, so a reused translation is told apart from a fresh one. */
const translateAs = (page: Page, prefix: string) => page.evaluate((label) => {
  (window as unknown as { __override: (type: string, handler: (m: { segments: Array<{ id: string }> }) => unknown) => void }).__override("TRANSLATE_SEGMENTS", (m) => ({
    translations: m.segments.map((segment) => ({ id: segment.id, translatedText: `${label}:${segment.id}`, translatedHtml: `${label}:${segment.id}` })),
  }));
}, prefix);

test.describe("translation cache", () => {
  test("a page translated a moment ago is shown again without calling Jev or DeepL", async ({ page }) => {
    await openPanel(page);
    await translate(page);
    expect(await calls(page, "CLASSIFY_CANDIDATES")).toHaveLength(1);
    expect(await calls(page, "TRANSLATE_SEGMENTS")).toHaveLength(1);
    const before = await page.locator(".entry-card").evaluateAll((cards) => cards.map((card) => `${card.getAttribute("data-entry-id")}:${card.querySelector(".entry-translation")?.textContent}`));
    expect(await cachedPages(page)).toHaveLength(1);

    await clearSent(page);
    await translate(page);

    expect(await calls(page, "CLASSIFY_CANDIDATES")).toEqual([]);
    expect(await calls(page, "TRANSLATE_SEGMENTS")).toEqual([]);
    const after = await page.locator(".entry-card").evaluateAll((cards) => cards.map((card) => `${card.getAttribute("data-entry-id")}:${card.querySelector(".entry-translation")?.textContent}`));
    expect(after).toEqual(before);
    await expect(page.locator(".cache-note")).toContainText("たった今の翻訳を再利用しました");
    await expect(page.locator(".cache-note")).toContainText("翻訳サービスは呼んでいません");
  });

  test("keeps the reader's Jev verdicts: text Jev skipped stays hidden and text it doubted stays flagged", async ({ page }) => {
    await openPanel(page);
    await translate(page);
    await translate(page);
    expect(await page.locator(".entry-card").evaluateAll((cards) => cards.map((card) => card.getAttribute("data-entry-id")))).toEqual(["segment-1", "segment-2", "segment-4", "segment-5"]);
    await expect(page.locator('[data-entry-id="segment-5"] .badge')).toBeVisible();
  });

  test("\"再翻訳\" ignores the cache and translates the page again", async ({ page }) => {
    await openPanel(page);
    await translate(page);
    await translate(page);
    await clearSent(page);
    await translateAs(page, "FRESH");

    await page.locator(".cache-note").getByRole("button", { name: "再翻訳" }).click();
    await expect(page.locator(".translate-button")).toBeEnabled();

    expect(await calls(page, "CLASSIFY_CANDIDATES")).toHaveLength(1);
    expect(await calls(page, "TRANSLATE_SEGMENTS")).toHaveLength(1);
    expect(await translationOf(page, "segment-2")).toBe("FRESH:segment-2");
    await expect(page.locator(".cache-note")).toHaveCount(0);
  });

  test("when the page changed, Jev looks at the whole page again but only the changed text is translated", async ({ page }) => {
    await openPanel(page);
    await translate(page);
    const unchangedBefore = await translationOf(page, "segment-2");
    await clearSent(page);

    const updated = SEGMENTS.map((segment) => segment.id === "segment-4" ? { ...segment, sourceText: "Start by grouping related controls, then remove anything the reader does not need at this moment.", sourceHtml: "updated" } : segment);
    await scanAs(page, updated);
    await translateAs(page, "NEW");
    await translate(page);

    const classified = await calls(page, "CLASSIFY_CANDIDATES");
    expect(classified).toHaveLength(1);
    expect(classified[0]).toHaveLength(5);
    expect(await calls(page, "TRANSLATE_SEGMENTS")).toEqual([["segment-4"]]);
    expect(await translationOf(page, "segment-4")).toBe("NEW:segment-4");
    expect(await translationOf(page, "segment-2")).toBe(unchangedBefore);
    await expect(page.locator(".cache-note")).toContainText("ページが更新されていました");
    await expect(page.locator(".cache-note")).toContainText("変わっていない3件");
    await expect(page.locator(".cache-note")).toContainText("1件を翻訳しました");
  });

  test("a new paragraph is translated and the others are reused", async ({ page }) => {
    await openPanel(page);
    await translate(page);
    await clearSent(page);

    const extra = { ...SEGMENTS[1]!, id: "segment-9", order: 9, sourceText: "A brand new paragraph was added to the article after it was first translated.", sourceHtml: "new" };
    await scanAs(page, [...SEGMENTS, extra]);
    await translate(page);

    expect(await calls(page, "TRANSLATE_SEGMENTS")).toEqual([["segment-9"]]);
    await expect(page.locator('[data-entry-id="segment-9"]')).toBeVisible();
  });

  test("the same article under another fragment or tracking parameter is the same page", async ({ page }) => {
    await openPanel(page);
    await translate(page);
    await clearSent(page);

    await scanAs(page, SEGMENTS, "https://journal.example.com/calm?utm_source=newsletter&fbclid=abc#comments");
    await translate(page);

    expect(await calls(page, "CLASSIFY_CANDIDATES")).toEqual([]);
    expect(await calls(page, "TRANSLATE_SEGMENTS")).toEqual([]);
  });

  test("another article is not mixed up with it", async ({ page }) => {
    await openPanel(page);
    await translate(page);
    await clearSent(page);

    await scanAs(page, SEGMENTS, "https://journal.example.com/other");
    await translate(page);

    expect(await calls(page, "TRANSLATE_SEGMENTS")).toHaveLength(1);
    expect(await cachedPages(page)).toHaveLength(2);
  });

  test("each target language has its own entry", async ({ page }) => {
    await openPanel(page);
    await translate(page);
    await page.locator(".language-control select").selectOption("EN");
    await clearSent(page);
    await translate(page);
    expect(await calls(page, "TRANSLATE_SEGMENTS")).toHaveLength(1);

    await page.locator(".language-control select").selectOption("JA");
    await clearSent(page);
    await translate(page);
    expect(await calls(page, "TRANSLATE_SEGMENTS")).toEqual([]);
  });

  test("an entry older than the chosen lifetime is not used", async ({ page }) => {
    await openPanel(page);
    await translate(page);
    await page.evaluate(async (key) => {
      const chromeApi = (window as unknown as { chrome: { storage: { local: { get: (key: string) => Promise<Record<string, { pages: Record<string, { savedAt: number }> }>>; set: (values: object) => Promise<void> } } } }).chrome;
      const stored = (await chromeApi.storage.local.get(key))[key]!;
      for (const entry of Object.values(stored.pages)) entry.savedAt -= 4 * 3_600_000;
      await chromeApi.storage.local.set({ [key]: stored });
    }, CACHE_KEY);
    await clearSent(page);
    await translate(page);

    expect(await calls(page, "CLASSIFY_CANDIDATES")).toHaveLength(1);
    expect(await calls(page, "TRANSLATE_SEGMENTS")).toHaveLength(1);
    await expect(page.locator(".cache-note")).toHaveCount(0);
  });

  test("a longer lifetime keeps the same entry usable", async ({ page }) => {
    const saved = Date.now() - 5 * HOUR;
    await openPanel(page, { settings: { cacheTtlHours: 24 } });
    await translate(page);
    await page.evaluate(async ({ key, saved }) => {
      const chromeApi = (window as unknown as { chrome: { storage: { local: { get: (key: string) => Promise<Record<string, { pages: Record<string, { savedAt: number }> }>>; set: (values: object) => Promise<void> } } } }).chrome;
      const stored = (await chromeApi.storage.local.get(key))[key]!;
      for (const entry of Object.values(stored.pages)) entry.savedAt = saved;
      await chromeApi.storage.local.set({ [key]: stored });
    }, { key: CACHE_KEY, saved });
    await clearSent(page);
    await translate(page);

    expect(await calls(page, "TRANSLATE_SEGMENTS")).toEqual([]);
    await expect(page.locator(".cache-note")).toContainText("5時間");
  });

  test("with the cache off nothing is saved or reused", async ({ page }) => {
    await openPanel(page, { settings: { cacheEnabled: false } });
    await translate(page);
    await translate(page);

    expect(await calls(page, "TRANSLATE_SEGMENTS")).toHaveLength(2);
    expect(await cachedPages(page)).toEqual([]);
    await expect(page.locator(".cache-note")).toHaveCount(0);
  });

  test("turning the cache off deletes what was saved", async ({ page }) => {
    await openPanel(page);
    await translate(page);
    expect(await cachedPages(page)).toHaveLength(1);

    await page.getByRole("button", { name: "設定を開く" }).click();
    await page.getByRole("radio", { name: "保存しない" }).click();

    await expect.poll(() => cachedPages(page)).toEqual([]);
  });

  test("the reader can delete the cache from Settings", async ({ page }) => {
    await openPanel(page);
    await translate(page);
    await page.getByRole("button", { name: "設定を開く" }).click();

    const clear = page.getByRole("button", { name: /キャッシュを削除/ });
    await expect(clear).toContainText("1ページ");
    await clear.click();

    await expect(clear).toContainText("0ページ");
    await expect(clear).toBeDisabled();
    expect(await cachedPages(page)).toEqual([]);
  });

  test("entries past their lifetime are removed when the panel opens", async ({ page }) => {
    await openPanel(page, { stored: {
      [CACHE_KEY]: { version: 1, pages: {
        stale: { savedAt: Date.now() - 10 * HOUR, usedAt: Date.now() - 10 * HOUR, hashes: [], decisions: {}, translations: {} },
        fresh: { savedAt: Date.now() - HOUR, usedAt: Date.now() - HOUR, hashes: [], decisions: {}, translations: {} },
      } },
    } });
    await expect.poll(() => cachedPages(page)).toEqual(["fresh"]);
  });

  test("a translation that failed is retried next time while the rest comes from the cache", async ({ page }) => {
    await openPanel(page);
    await page.evaluate(() => {
      (window as unknown as { __override: (type: string, handler: () => unknown) => void }).__override("TRANSLATE_SEGMENTS", () => ({ error: "DeepLに接続できませんでした。" }));
    });
    await translate(page);
    await expect(page.locator(".error-banner")).toBeVisible();
    await clearSent(page);

    await translateAs(page, "OK");
    await translate(page);

    // Jev's verdicts were kept, so only the translation is requested again.
    expect(await calls(page, "CLASSIFY_CANDIDATES")).toEqual([]);
    expect(await calls(page, "TRANSLATE_SEGMENTS")).toHaveLength(1);
    expect(await translationOf(page, "segment-2")).toBe("OK:segment-2");
  });

  test("without Jev the cache works the same", async ({ page }) => {
    await openPanel(page, { settings: { contentJudge: "off" } });
    await translate(page);
    await clearSent(page);
    await translate(page);

    expect(await sentTypes(page)).not.toContain("TRANSLATE_SEGMENTS");
    await expect(page.locator(".cache-note")).toBeVisible();
  });
});

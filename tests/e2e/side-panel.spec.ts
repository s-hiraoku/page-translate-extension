import { expect, test, type Page } from "@playwright/test";
import { installChromeMock, sentTypes, type MockOptions } from "./support/chrome-mock";

const PANEL = "/src/sidepanel/index.html";

async function openPanel(page: Page, options: MockOptions = {}): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 380, height: 800 });
  await installChromeMock(page, options);
  await page.goto(PANEL);
  return errors;
}

const cardIds = (page: Page) => page.locator(".entry-card").evaluateAll((cards) => cards.map((card) => card.getAttribute("data-entry-id")));

async function translate(page: Page): Promise<void> {
  await page.locator(".translate-button").click();
  await expect(page.locator(".translate-button")).toBeEnabled();
}

test.describe("page translation", () => {
  test("shows body text as cards and hides what Jev skipped", async ({ page }) => {
    const errors = await openPanel(page);
    await translate(page);

    expect(await cardIds(page)).toEqual(["segment-1", "segment-2", "segment-4", "segment-5"]);
    await expect(page.locator('[data-entry-id="segment-2"] .entry-translation')).toContainText("ダッシュボード");
    await expect(page.locator('[data-entry-id="segment-5"] .badge')).toBeVisible();
    await expect(page.locator(".hidden-note")).toContainText("表示していません");
    // Text already in Japanese is dropped before it is sent anywhere.
    const classify = await page.evaluate(() => (window as unknown as { __sent: Array<{ type: string; segments?: Array<{ id: string }> }> }).__sent.find((m) => m.type === "CLASSIFY_CANDIDATES"));
    expect(classify?.segments?.map((segment) => segment.id)).not.toContain("segment-6");
    expect(errors).toEqual([]);
  });

  // Regression (v1.3.0): "Cannot read properties of null (reading 'closest')" on card click.
  test("clicking a card focuses its source on the page without errors", async ({ page }) => {
    const errors = await openPanel(page);
    await translate(page);
    await page.locator('[data-entry-id="segment-2"] .entry-main').click();

    await expect.poll(async () => (await sentTypes(page)).includes("FOCUS_SEGMENT")).toBe(true);
    const focus = await page.evaluate(() => (window as unknown as { __sent: Array<{ type: string; segmentId?: string; anchor?: unknown }> }).__sent.find((m) => m.type === "FOCUS_SEGMENT"));
    expect(focus).toMatchObject({ segmentId: "segment-2" });
    expect(focus?.anchor).toBeTruthy();
    await expect(page.locator(".error-banner")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("keeps main prose that Jev skipped, flagged for review, but not code", async ({ page }) => {
    await openPanel(page);
    await page.evaluate(() => (window as unknown as { __override: (type: string, handler: (m: { segments: Array<{ id: string }> }) => unknown) => void }).__override("CLASSIFY_CANDIDATES", (m) => ({
      decisions: m.segments.map((segment) => ({ id: segment.id, decision: "skip", confidence: 0.95 })),
    })));
    await translate(page);

    expect(await cardIds(page)).toEqual(["segment-2", "segment-4"]);
    await expect(page.locator('[data-entry-id="segment-2"] .badge.review')).toBeVisible();
  });

  test("translates without Jev when it is turned off", async ({ page }) => {
    await openPanel(page, { settings: { useJev: false } });
    await translate(page);

    const types = await sentTypes(page);
    expect(types).not.toContain("CLASSIFY_CANDIDATES");
    expect(types).toContain("TRANSLATE_SEGMENTS");
    // Everything the local filters kept is translated; only text already in Japanese is left out.
    expect(await cardIds(page)).toEqual(["segment-1", "segment-2", "segment-3", "segment-4", "segment-5"]);
    await expect(page.locator(".status-text")).toContainText("Jevなし");
  });
});

test.describe("consent", () => {
  test("sends nothing until the reader agrees", async ({ page }) => {
    await openPanel(page, { consent: 1 });
    await page.locator(".translate-button").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    await dialog.getByRole("button", { name: "キャンセル" }).click();
    await expect(dialog).toBeHidden();
    expect(await sentTypes(page)).not.toEqual(expect.arrayContaining(["CLASSIFY_CANDIDATES"]));
    expect(await sentTypes(page)).not.toContain("TRANSLATE_SEGMENTS");

    await page.locator(".translate-button").click();
    await dialog.getByRole("button", { name: "同意して続ける" }).click();
    await expect(page.locator(".entry-card").first()).toBeVisible();
    expect(await sentTypes(page)).toContain("TRANSLATE_SEGMENTS");
  });
});

test.describe("page-click mode", () => {
  const added = (id: string, text: string, followingIds: string[] = []) => ({
    type: "added",
    segment: { id, order: -1, location: "追加 · p", tagName: "p", sourceText: text, sourceHtml: text, region: "outside", kind: "paragraph", linkDensity: 0, isArticleTitle: false, manual: true, partial: false },
    followingIds,
    anchor: null,
  });

  test("is available when no card is shown and adds picked text as a card", async ({ page }) => {
    await openPanel(page);
    await page.evaluate(() => (window as unknown as { __override: (type: string, handler: (m: { segments: Array<{ id: string }> }) => unknown) => void }).__override("CLASSIFY_CANDIDATES", (m) => ({
      decisions: m.segments.map((segment) => ({ id: segment.id, decision: "skip", confidence: 0.95 })),
    })));
    await page.evaluate(() => (window as unknown as { __override: (type: string, handler: () => unknown) => void }).__override("SCAN_ACTIVE_TAB", () => ({ title: "Empty", url: "https://example.com", segments: [], mainContentDetected: false, excludedCount: 3 })));
    await translate(page);
    expect(await cardIds(page)).toEqual([]);

    await page.locator(".pick-toggle").click();
    await expect(page.locator(".pick-toggle")).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => page.evaluate(() => typeof (window as unknown as { __emit?: unknown }).__emit)).toBe("function");
    await page.evaluate((event) => (window as unknown as { __emit: (event: unknown) => void }).__emit(event), added("manual-1", "Added by hand from the footer."));

    await expect(page.locator('[data-entry-id="manual-1"]')).toBeVisible();
    await expect(page.locator('[data-entry-id="manual-1"] .entry-translation')).toHaveText("訳:manual-1");
  });

  test("drops a slow result from an earlier scan", async ({ page }) => {
    await openPanel(page);
    await page.evaluate(() => {
      const w = window as unknown as { __override: (type: string, handler: (m: { segments: Array<{ id: string }> }) => unknown) => void; __second?: boolean };
      w.__override("TRANSLATE_SEGMENTS", async (m) => {
        if (m.segments.length === 1 && m.segments[0].id === "segment-3" && !w.__second) {
          await new Promise((resolve) => setTimeout(resolve, 1200));
          return { translations: [{ id: "segment-3", translatedText: "STALE RESULT", translatedHtml: "STALE RESULT" }] };
        }
        return { translations: m.segments.map((segment) => ({ id: segment.id, translatedText: `訳:${segment.id}`, translatedHtml: `訳:${segment.id}` })) };
      });
    });
    await translate(page);
    await page.locator(".pick-toggle").click();
    await expect.poll(() => page.evaluate(() => typeof (window as unknown as { __emit?: unknown }).__emit)).toBe("function");
    await page.evaluate((event) => (window as unknown as { __emit: (event: unknown) => void }).__emit(event), added("segment-3", "Subscribe to our newsletter", ["segment-4"]));

    // Translate again before the slow result arrives; this scan translates segment-3 itself.
    await page.evaluate(() => {
      const w = window as unknown as { __second: boolean; __override: (type: string, handler: (m: { segments: Array<{ id: string }> }) => unknown) => void };
      w.__second = true;
      w.__override("CLASSIFY_CANDIDATES", (m) => ({ decisions: m.segments.map((segment) => ({ id: segment.id, decision: "translate", confidence: 0.95 })) }));
    });
    await translate(page);
    await page.waitForTimeout(1500);
    await expect(page.locator('[data-entry-id="segment-3"] .entry-translation')).toHaveText("訳:segment-3");
  });
});

test.describe("scrolling to a card", () => {
  const many = (page: Page) => page.evaluate(() => {
    const w = window as unknown as { __override: (type: string, handler: () => unknown) => void };
    const segments = Array.from({ length: 14 }, (_, index) => ({
      id: `segment-${index + 1}`, order: index, location: `本文 ${index + 1}`, tagName: "p", region: "main", kind: "paragraph", linkDensity: 0, isArticleTitle: false,
      sourceText: `Paragraph ${index + 1} explains one more part of the article in a full English sentence.`,
      sourceHtml: `Paragraph ${index + 1}`,
    }));
    w.__override("SCAN_ACTIVE_TAB", () => ({ title: "Long article", url: "https://example.com/long", segments, mainContentDetected: true, excludedCount: 0 }));
  });

  /** Where the card sits relative to the list area between the sticky heading and the footer. */
  const placement = (page: Page, id: string) => page.evaluate((segmentId) => {
    const card = document.querySelector(`[data-entry-id="${segmentId}"]`)!.getBoundingClientRect();
    const heading = document.querySelector(".results-heading")!.getBoundingClientRect();
    const footer = document.querySelector(".panel-footer")!.getBoundingClientRect();
    return { visible: card.top >= heading.bottom && card.bottom <= footer.top, offCenter: Math.abs((card.top + card.bottom) / 2 - (heading.bottom + footer.top) / 2) };
  }, id);

  test("a source picked on the page glides its card to the middle of the list", async ({ page }) => {
    await openPanel(page);
    await page.setViewportSize({ width: 380, height: 640 });
    await many(page);
    await translate(page);
    await page.locator(".pick-toggle").click();
    await expect.poll(() => page.evaluate(() => typeof (window as unknown as { __emit?: unknown }).__emit)).toBe("function");

    const scrollPositions: number[] = [];
    await page.evaluate(() => window.addEventListener("scroll", () => ((window as unknown as { __scrolls: number[] }).__scrolls ??= []).push(window.scrollY)));
    await page.evaluate(() => (window as unknown as { __emit: (event: unknown) => void }).__emit({ type: "picked", segmentId: "segment-11" }));

    await expect.poll(async () => (await placement(page, "segment-11")).offCenter, { timeout: 3000 }).toBeLessThan(12);
    expect((await placement(page, "segment-11")).visible).toBe(true);
    await expect(page.locator('[data-entry-id="segment-11"]')).toHaveClass(/selected/);
    // Smooth, not a jump: the panel passed through intermediate positions.
    scrollPositions.push(...await page.evaluate(() => (window as unknown as { __scrolls: number[] }).__scrolls));
    expect(new Set(scrollPositions).size).toBeGreaterThan(2);
  });

  test("clicking a card cut off at the bottom brings it into the middle; a card in full view stays put", async ({ page }) => {
    await openPanel(page);
    await page.setViewportSize({ width: 380, height: 640 });
    await many(page);
    await translate(page);

    await page.locator('[data-entry-id="segment-1"] .entry-main').click();
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);

    const cutOff = await page.evaluate(() => {
      const footer = document.querySelector(".panel-footer")!.getBoundingClientRect().top;
      return [...document.querySelectorAll<HTMLElement>(".entry-card")].find((card) => {
        const rect = card.getBoundingClientRect();
        return rect.top < footer && rect.bottom > footer;
      })?.dataset.entryId;
    });
    expect(cutOff).toBeTruthy();
    await page.locator(`[data-entry-id="${cutOff}"] .entry-main`).click({ position: { x: 40, y: 12 } });
    await expect.poll(async () => (await placement(page, cutOff!)).offCenter, { timeout: 3000 }).toBeLessThan(12);
  });
});

test.describe("writing check", () => {
  async function check(page: Page): Promise<void> {
    await page.getByRole("tab", { name: "英作文" }).click();
    await page.locator("#compose-english").fill("I want to ask about the release schedule of next version.");
    await page.locator("#compose-japanese").fill("次のバージョンのリリース予定について質問したいです。");
    await page.getByRole("button", { name: "英文をチェック" }).click();
    await expect(page.locator(".compose-results")).toBeVisible();
  }

  test("with a free DeepL key, shows meaning and model answer but no DeepL Write", async ({ page }) => {
    const errors = await openPanel(page, { deeplPlan: "free" });
    await check(page);

    const types = await sentTypes(page);
    expect(types.filter((type) => type === "COMPOSE_TRANSLATE")).toHaveLength(2);
    expect(types).not.toContain("COMPOSE_REPHRASE");
    await expect(page.locator(".compose-results")).toContainText("次のバージョンのリリース予定について尋ねたいです。");
    await expect(page.locator(".compose-results")).toContainText("無料プラン用");
    await expect(page.locator(".compose-results ins").first()).toBeVisible();
    await expect(page.locator(".compose-results del").first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("with a paid DeepL key, also asks DeepL Write in the chosen style", async ({ page }) => {
    await openPanel(page, { deeplPlan: "pro" });
    await page.getByRole("tab", { name: "英作文" }).click();
    await page.locator(".compose-option select").nth(1).selectOption("business");
    await check(page);

    const rephrase = await page.evaluate(() => (window as unknown as { __sent: Array<{ type: string; style?: string; targetLang?: string }> }).__sent.find((m) => m.type === "COMPOSE_REPHRASE"));
    expect(rephrase).toMatchObject({ style: "business", targetLang: "EN-US" });
    await expect(page.locator(".compose-results")).not.toContainText("無料プラン用");
  });
});

import { expect, test, type Page } from "@playwright/test";
import { installChromeMock, sentTypes, type MockOptions } from "./support/chrome-mock";

const PANEL = "/src/sidepanel/index.html";
/** The page-click button; the selection-translation button shares its class. */
const PAGE_CLICK = ".pick-toggle:not(.selection-toggle)";

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

    await page.locator(PAGE_CLICK).click();
    await expect(page.locator(PAGE_CLICK)).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => page.evaluate(() => typeof (window as unknown as { __emit?: unknown }).__emit)).toBe("function");
    await page.evaluate((event) => (window as unknown as { __emit: (event: unknown) => void }).__emit(event), added("manual-1", "Added by hand from the footer."));

    await expect(page.locator('[data-entry-id="manual-1"]')).toBeVisible();
    await expect(page.locator('[data-entry-id="manual-1"] .entry-translation')).toHaveText("訳:manual-1");
  });

  test("tells the page to pick by click, or by hover once the setting says so, and explains it", async ({ page }) => {
    const sent = () => page.evaluate(() => (window as unknown as { __pickTargets?: { trigger?: string } }).__pickTargets?.trigger);
    await openPanel(page);
    await translate(page);
    await page.locator(PAGE_CLICK).click();
    await expect.poll(sent).toBe("click");
    await expect(page.locator(".pick-note")).toContainText("本文をクリックで訳文を表示");

    await page.getByRole("button", { name: "設定を開く" }).click();
    await page.getByRole("radiogroup", { name: "ページ選択の操作" }).getByRole("radio", { name: "マウスを乗せる" }).click();
    await expect(page.getByRole("radio", { name: "マウスを乗せる" })).toHaveAttribute("aria-checked", "true");
    await expect.poll(sent).toBe("hover");
  });

  test("drops a slow result from an earlier scan", async ({ page }) => {
    // The second scan must reach Jev and DeepL again (its verdicts differ), so the cache stays out of it.
    await openPanel(page, { settings: { cacheEnabled: false } });
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
    await page.locator(PAGE_CLICK).click();
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

test.describe("connector follows the card after returning to Chrome", () => {
  type Sent = Array<{ type: string; anchor?: { screenY: number } }>;
  const anchors = (page: Page) => page.evaluate(() =>
    (window as unknown as { __sent: Sent }).__sent.filter((m) => m.type === "UPDATE_FOCUS_ANCHOR").map((m) => m.anchor?.screenY));
  const clearSent = (page: Page) => page.evaluate(() => { (window as unknown as { __sent: unknown[] }).__sent.length = 0; });

  /** Translates and selects a card with a real click, which also tells the panel where it is on screen. */
  async function select(page: Page): Promise<void> {
    await openPanel(page);
    await translate(page);
    await page.locator('[data-entry-id="segment-2"] .entry-main').click();
    await expect.poll(async () => (await sentTypes(page)).includes("FOCUS_SEGMENT")).toBe(true);
    await clearSent(page);
  }

  // Regression: scroll updates sent while Chrome was in the background, or while another tab was in
  // front, never reached this page's connector, and nothing lined it up again on return.
  for (const [name, comeBack] of [
    ["the window gets focus", (page: Page) => page.evaluate(() => window.dispatchEvent(new Event("focus")))],
    ["the panel becomes visible", (page: Page) => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")))],
    ["the reader returns to the tab", (page: Page) => page.evaluate(() => (window as unknown as { __activateTab: () => void }).__activateTab())],
  ] as const) {
    test(`re-sends the selected card's position when ${name}`, async ({ page }) => {
      await select(page);
      await comeBack(page);
      await expect.poll(async () => (await anchors(page)).length).toBe(1);
      expect((await anchors(page))[0]).toBeGreaterThan(0);
    });
  }

  test("sends nothing when no card is selected", async ({ page }) => {
    await openPanel(page);
    await translate(page);
    await clearSent(page);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForTimeout(200);
    expect(await anchors(page)).toEqual([]);
  });

  // Regression: the panel remembered its top edge on screen from the last pointer event, so after the
  // window moved it reported the card's height from before the move.
  test("follows the window when it moves", async ({ page }) => {
    await select(page);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(async () => (await anchors(page)).length).toBe(1);
    const [before] = await anchors(page);

    await page.evaluate(() => {
      const start = window.screenY;
      Object.defineProperty(window, "screenY", { configurable: true, get: () => start + 80 });
    });
    await clearSent(page);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(async () => (await anchors(page)).length).toBe(1);
    expect((await anchors(page))[0]).toBeCloseTo(before! + 80, 0);
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

  test("the controls stay at the top while the status and results scroll", async ({ page }) => {
    await openPanel(page);
    await page.setViewportSize({ width: 380, height: 640 });
    await many(page);
    await translate(page);
    await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(200);

    const layout = await page.evaluate(() => {
      const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      return { top: box(".panel-top"), button: box(".translate-button"), tools: box(".tool-row"), status: box(".status-area"), heading: box(".results-heading") };
    });
    // The header, tabs, page, display mode, translate button and both toggles never move.
    expect(layout.top.top).toBe(0);
    expect(layout.button.top).toBeGreaterThan(0);
    expect(layout.tools.bottom).toBeLessThanOrEqual(layout.top.bottom);
    // "ページ内に○件…" scrolls away under the controls; the list heading sticks right below them.
    expect(layout.status.bottom).toBeLessThanOrEqual(layout.top.bottom);
    expect(layout.heading.top).toBeCloseTo(layout.top.bottom, 0);
    await expect(page.locator(".translate-button")).toBeInViewport();
  });

  test("a source picked on the page glides its card to the middle of the list", async ({ page }) => {
    await openPanel(page);
    await page.setViewportSize({ width: 380, height: 640 });
    await many(page);
    await translate(page);
    await page.locator(PAGE_CLICK).click();
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

  type Sent = Array<{ type: string; text?: string; targetLang?: string; context?: string; style?: string }>;
  const composeRequests = (page: Page) => page.evaluate(() => (window as unknown as { __sent: Sent }).__sent.filter((m) => m.type.startsWith("COMPOSE_")));

  // Regression (v1.4.1): the page was sent as context for the back-translation too, which bent
  // "Perform the following tasks" into 「以下の業務を担当します」 on a job-related page.
  test("never uses the page as context for the back-translation, and uses it for the model answer only when turned on", async ({ page }) => {
    await openPanel(page, { deeplPlan: "free" });
    await check(page);
    let requests = await composeRequests(page);
    expect(requests.every((request) => !request.context)).toBe(true);
    expect(await sentTypes(page)).not.toContain("PAGE_TEXT");

    await page.getByRole("checkbox", { name: /開いているページを文脈として使う/ }).check();
    await page.evaluate(() => { (window as unknown as { __sent: unknown[] }).__sent.length = 0; });
    await page.getByRole("button", { name: "英文をチェック" }).click();
    await expect.poll(async () => (await composeRequests(page)).length).toBe(2);
    requests = await composeRequests(page);
    expect(requests.find((request) => request.targetLang === "JA")?.context).toBeFalsy();
    expect(requests.find((request) => request.targetLang === "EN-US")?.context).toContain("We plan to ship version 2.0");
  });

  test("shows what the reader meant next to what their English conveys", async ({ page }) => {
    await openPanel(page, { deeplPlan: "free" });
    await check(page);
    const meaning = page.locator(".compose-card").first();
    await expect(meaning.locator(".compose-intended")).toContainText("次のバージョンのリリース予定について質問したいです。");
    await expect(meaning).toContainText("次のバージョンのリリース予定について尋ねたいです。");
  });

  test("turns Japanese into English and translates it back, with a free key", async ({ page }) => {
    const errors = await openPanel(page, { deeplPlan: "free" });
    await page.getByRole("tab", { name: "英作文" }).click();
    await page.getByRole("radio", { name: "日本語から英訳" }).click();
    await expect(page.locator("#compose-english")).toHaveCount(0);
    await page.locator("#compose-japanese").fill("次のバージョンのリリース予定について質問したいです。");
    await page.getByRole("button", { name: "英語にする" }).click();

    const cards = page.locator(".compose-card");
    await expect(cards.nth(0)).toContainText("I would like to ask about the release schedule for the next version.");
    await expect(cards.nth(0).getByRole("button", { name: "コピー" })).toBeVisible();
    await expect(cards.nth(1)).toContainText("訳し戻し");
    await expect(cards.nth(1).locator(".compose-intended")).toContainText("次のバージョンのリリース予定について質問したいです。");
    await expect(page.locator(".compose-results")).toContainText("無料プラン用");

    const requests = await composeRequests(page);
    expect(requests.map((request) => `${request.type}:${request.targetLang}`)).toEqual(["COMPOSE_TRANSLATE:EN-US", "COMPOSE_TRANSLATE:JA"]);
    // The back-translation translates DeepL's English, without the page as context.
    expect(requests[1]).toMatchObject({ text: "I would like to ask about the release schedule for the next version." });
    expect(requests[1].context).toBeFalsy();
    expect(errors).toEqual([]);
  });

  test("asks for Japanese before translating", async ({ page }) => {
    await openPanel(page);
    await page.getByRole("tab", { name: "英作文" }).click();
    await page.getByRole("radio", { name: "日本語から英訳" }).click();
    await page.getByRole("button", { name: "英語にする" }).click();
    await expect(page.locator(".compose-error")).toContainText("英語にしたい日本語を入力してください");
    expect(await composeRequests(page)).toEqual([]);
  });

  test("with a paid key, also polishes the translation with DeepL Write", async ({ page }) => {
    await openPanel(page, { deeplPlan: "pro" });
    await page.getByRole("tab", { name: "英作文" }).click();
    await page.getByRole("radio", { name: "日本語から英訳" }).click();
    await page.locator(".compose-option select").nth(1).selectOption("business");
    await page.locator("#compose-japanese").fill("次のバージョンのリリース予定について質問したいです。");
    await page.getByRole("button", { name: "英語にする" }).click();

    await expect(page.locator(".compose-card")).toHaveCount(3);
    const rephrase = (await composeRequests(page)).find((request) => request.type === "COMPOSE_REPHRASE");
    expect(rephrase).toMatchObject({ text: "I would like to ask about the release schedule for the next version.", style: "business", targetLang: "EN-US" });
    await expect(page.locator(".compose-card").nth(2).locator("del, ins").first()).toBeVisible();
  });
});

test.describe("first run", () => {
  test("points to the settings when no DeepL key is registered", async ({ page }) => {
    await openPanel(page, { providers: { jev: false, deepl: false } });

    await expect(page.locator(".setup-hint")).toContainText("DeepLのAPIキーを登録");
    await page.locator(".setup-hint").getByRole("button", { name: "設定でAPIキーを登録" }).click();
    await expect(page.getByRole("heading", { name: "設定" })).toBeVisible();
  });

  test("shows no such hint once a key is registered", async ({ page }) => {
    await openPanel(page);
    await expect(page.locator(".translate-button")).toBeVisible();
    await expect(page.locator(".setup-hint")).toHaveCount(0);
  });

  test("links to the user guide from the panel", async ({ page }) => {
    await openPanel(page);
    await expect(page.getByRole("link", { name: "使い方" })).toHaveAttribute("href", "https://s-hiraoku.github.io/page-translate-extension/");
  });
});

test.describe("the writing tab needs a DeepL key", () => {
  const composeTab = (page: Page) => page.getByRole("tab", { name: "英作文" });
  const overrideMessage = (page: Page, type: string, reply: unknown) => page.evaluate(({ type, reply }) => {
    (window as unknown as { __override: (type: string, handler: () => unknown) => void }).__override(type, () => reply);
  }, { type, reply });

  test("is open with a DeepL key", async ({ page }) => {
    await openPanel(page);
    await composeTab(page).click();
    await expect(composeTab(page)).toHaveAttribute("aria-selected", "true");
    await expect(composeTab(page)).not.toHaveAttribute("aria-disabled", "true");
  });

  test("is locked without one, says why on hover and on click, and leads to the settings", async ({ page }) => {
    await openPanel(page, { providers: { jev: true, deepl: false } });
    await expect(composeTab(page)).toHaveAttribute("aria-disabled", "true");
    await expect(composeTab(page)).toHaveAttribute("title", "英作文機能を使うには、設定でDeepLのAPIキーを登録してください。");

    // aria-disabled (not disabled): it stays focusable and clickable, so the click can explain.
    await composeTab(page).click({ force: true });

    await expect(composeTab(page)).toHaveAttribute("aria-selected", "false");
    await expect(page.locator(".compose-lock-note")).toContainText("DeepLのAPIキーを登録してください");
    await page.locator(".compose-lock-note").getByRole("button", { name: "設定を開く" }).click();
    await expect(page.getByRole("heading", { name: "設定" })).toBeVisible();
  });

  test("goes back to page translation when the key is removed while writing", async ({ page }) => {
    await openPanel(page);
    await composeTab(page).click();
    await expect(composeTab(page)).toHaveAttribute("aria-selected", "true");
    await overrideMessage(page, "CLEAR_PROVIDER_KEYS", { providers: { jev: false, deepl: false }, deeplPlan: null });

    await page.getByRole("button", { name: "設定を開く" }).click();
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "保存中のAPIキーを削除" }).click();
    await page.getByLabel("翻訳画面に戻る").click();

    await expect(page.getByRole("tab", { name: "ページ翻訳" })).toHaveAttribute("aria-selected", "true");
    await expect(composeTab(page)).toHaveAttribute("aria-disabled", "true");
  });
});

test.describe("settings explanations", () => {
  const openSettings = (page: Page) => page.getByRole("button", { name: "設定を開く" }).click();
  const helpButton = (page: Page, label: string) => page.getByRole("button", { name: `${label}の説明` });

  test("stay folded until the ⓘ button is pressed, and fold again when the settings reopen", async ({ page }) => {
    await openPanel(page);
    await openSettings(page);
    const labels = ["キーボードショートカット", "翻訳に使うサービス", "翻訳する本文の判定", "選択したら自動で翻訳", "翻訳のキャッシュ"];
    for (const label of labels) {
      await expect(helpButton(page, label)).toHaveAttribute("aria-expanded", "false");
    }
    await expect(page.locator(".help-text:visible")).toHaveCount(0);

    await helpButton(page, "選択したら自動で翻訳").click();
    await expect(helpButton(page, "選択したら自動で翻訳")).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#selection-auto-label-help")).toBeVisible();
    await expect(page.locator("#selection-auto-label-help")).toContainText("パネルを閉じていても");
    // Only the one asked for opens.
    await expect(page.locator(".help-text:visible")).toHaveCount(1);

    await helpButton(page, "選択したら自動で翻訳").click();
    await expect(page.locator("#selection-auto-label-help")).toBeHidden();

    await helpButton(page, "翻訳のキャッシュ").click();
    await page.getByLabel("翻訳画面に戻る").click();
    await openSettings(page);
    await expect(page.locator(".help-text:visible")).toHaveCount(0);
  });

  test("explain both choices whichever is selected, and no longer say selection translation is DeepL only", async ({ page }) => {
    await openPanel(page);
    await openSettings(page);
    await helpButton(page, "翻訳に使うサービス").click();
    await expect(page.locator("#provider-label-help")).toContainText("Chrome内蔵");
    await expect(page.locator("#provider-label-help")).toContainText("DeepLのAPIキーが必要です");
    await helpButton(page, "選択したら自動で翻訳").click();
    await expect(page.locator("#selection-auto-label-help")).not.toContainText("DeepLだけ");
    await expect(page.locator(".settings-page")).not.toContainText("翻訳にはDeepLを使います");
  });

  test("a warning about the current state shows without opening anything", async ({ page }) => {
    await openPanel(page, { providers: { jev: false, deepl: true }, settings: { useJev: true } });
    await openSettings(page);
    await expect(page.locator(".setting-alert", { hasText: "JevのAPIキーが未登録のため、いまはJevを使わずに翻訳します" })).toBeVisible();
    await expect(page.locator(".help-text:visible")).toHaveCount(0);
  });
});

test.describe("the list with translations shown in the page", () => {
  const list = (page: Page) => page.locator(".entry-list");
  const toggle = (page: Page) => page.locator(".list-toggle");
  const mode = (page: Page, name: string) => page.getByRole("group", { name: "翻訳の表示方法" }).getByRole("button", { name });

  test("starts folded when translated in the page from an empty panel, and opens on request", async ({ page }) => {
    await openPanel(page, { settings: { displayMode: "inline" } });
    await translate(page);

    await expect(page.locator(".status-text")).toHaveText("ページ内に4件を表示しています。");
    await expect(list(page)).toBeHidden();
    await expect(page.locator(".folded-note")).toContainText("訳文はページ内に表示しています");
    await expect(page.locator(".results-heading .count")).toHaveText("4");
    await expect(toggle(page)).toHaveText("一覧を表示");
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");

    await toggle(page).click();
    await expect(list(page)).toBeVisible();
    await expect(page.locator(".folded-note")).toHaveCount(0);
    await expect(toggle(page)).toHaveText("一覧を畳む");

    await toggle(page).click();
    await expect(list(page)).toBeHidden();
  });

  test("a list already shown with the source stays open when switching to the page, and after translating again", async ({ page }) => {
    await openPanel(page);
    await translate(page);
    await expect(list(page)).toBeVisible();
    await expect(toggle(page)).toHaveCount(0);

    await mode(page, "ページ内").click();
    await expect(page.locator(".status-text")).toHaveText("ページ内に4件を表示しています。");
    await expect(list(page)).toBeVisible();
    await expect(toggle(page)).toHaveText("一覧を畳む");

    await translate(page);
    await expect(page.locator(".status-text")).toHaveText("ページ内に4件を表示しています。");
    await expect(list(page)).toBeVisible();
  });

  test("a folded list stays folded when translating again in the page, and opens when switching back to the source", async ({ page }) => {
    await openPanel(page, { settings: { displayMode: "inline" } });
    await translate(page);
    await translate(page);
    await expect(page.locator(".status-text")).toHaveText("ページ内に4件を表示しています。");
    await expect(list(page)).toBeHidden();

    await mode(page, "原文＋訳文").click();
    await expect(list(page)).toBeVisible();
    await expect(toggle(page)).toHaveCount(0);
  });

  test("cards lead with the source in the page, and with the translation with the source", async ({ page }) => {
    const card = (page: Page) => page.locator('[data-entry-id="segment-2"]');
    await openPanel(page, { settings: { displayMode: "inline" } });
    await translate(page);
    await toggle(page).click();
    await expect(card(page).locator(".entry-lead")).toHaveClass(/entry-source/);
    await expect(card(page).locator(".entry-sub")).toHaveClass(/entry-translation/);

    await mode(page, "原文＋訳文").click();
    await expect(card(page).locator(".entry-lead")).toHaveClass(/entry-translation/);
    await expect(card(page).locator(".entry-sub")).toHaveClass(/entry-source/);
  });

  test("clicking translated text on the page opens the folded list at its card", async ({ page }) => {
    await openPanel(page, { settings: { displayMode: "inline" } });
    await translate(page);
    await expect(list(page)).toBeHidden();

    await page.locator(PAGE_CLICK).click();
    await expect.poll(() => page.evaluate(() => typeof (window as unknown as { __emit?: unknown }).__emit)).toBe("function");
    await page.evaluate(() => (window as unknown as { __emit: (event: unknown) => void }).__emit({ type: "picked", segmentId: "segment-4" }));

    await expect(list(page)).toBeVisible();
    await expect(page.locator('[data-entry-id="segment-4"]')).toHaveClass(/selected/);
    await expect(page.locator('[data-entry-id="segment-4"]')).toBeInViewport();
  });
});

test.describe("translating with Claude", () => {
  type Sent = Array<{ type: string; pageTitle?: string; pageText?: string; segments?: Array<{ sourceText: string }>; keys?: Record<string, string> }>;
  const sent = (page: Page) => page.evaluate(() => (window as unknown as { __sent: Sent }).__sent);

  test("sends the page title and the page's text along with the passages", async ({ page }) => {
    const errors = await openPanel(page, { settings: { translationProvider: "claude" } });
    await expect(page.locator(".steps")).toContainText("Claudeで翻訳");
    await translate(page);

    expect(await cardIds(page)).toEqual(["segment-1", "segment-2", "segment-4", "segment-5"]);
    const request = (await sent(page)).find((message) => message.type === "TRANSLATE_SEGMENTS");
    expect(request?.pageTitle).toBe("Designing calm interfaces");
    for (const segment of request?.segments ?? []) expect(request?.pageText).toContain(segment.sourceText);
    expect(errors).toEqual([]);
  });

  test("points to the settings when no Claude key is registered, and saves one there", async ({ page }) => {
    await openPanel(page, { providers: { jev: true, deepl: true, claude: false }, settings: { translationProvider: "claude" } });

    await expect(page.locator(".setup-hint")).toContainText("ClaudeのAPIキーを登録");
    await page.locator(".setup-hint").getByRole("button", { name: "設定でAPIキーを登録" }).click();
    await page.locator("#anthropic-api-key").fill("sk-ant-test");
    await page.getByRole("button", { name: "APIキーを保存" }).click();

    const save = (await sent(page)).find((message) => message.type === "SAVE_PROVIDER_KEYS");
    expect(save?.keys).toMatchObject({ anthropicApiKey: "sk-ant-test" });
  });

  test("translates with Haiku by default and saves another model chosen in the settings", async ({ page }) => {
    await openPanel(page, { settings: { translationProvider: "claude" } });
    await page.getByRole("button", { name: "設定を開く" }).click();
    await expect(page.locator("#claude-model")).toHaveValue("claude-haiku-5-5");

    await page.locator("#claude-model").selectOption("claude-sonnet-5-5");

    const stored = () => page.evaluate(async () => {
      const values = await chrome.storage.local.get("pageTranslateSettings");
      return (values.pageTranslateSettings as { claudeModel?: string } | undefined)?.claudeModel;
    });
    await expect.poll(stored).toBe("claude-sonnet-5-5");
  });

  test("adds the programming terms to the glossary and saves it, dropping Claude's cached pages", async ({ page }) => {
    const claudePage = { savedAt: Date.now(), usedAt: Date.now(), hashes: [], decisions: {}, translations: {} };
    await openPanel(page, { stored: {
      pageTranslateGlossary: "deploy = 配置\n",
      pageTranslateCache: { version: 1, pages: { "https://example.com/|JA|jev|claude": claudePage, "https://example.com/|JA|jev": claudePage } },
    } });
    await page.getByRole("button", { name: "設定を開く" }).click();
    await page.getByRole("button", { name: /^用語集（Claude）.*上級者向け$/ }).click();

    const glossary = page.getByRole("textbox", { name: "用語集の中身" });
    await expect(glossary).toHaveValue("deploy = 配置\n");
    await page.getByRole("button", { name: "プログラミング用語を追加" }).click();
    await expect(glossary).toHaveValue(/pull request = プルリクエスト/);
    await expect(glossary).not.toHaveValue(/deploy = デプロイ/);
    await page.getByRole("button", { name: "用語集を保存" }).click();
    await expect(page.getByText(/語を保存しました/)).toBeVisible();

    const read = (key: string) => page.evaluate(async (name) => (await (window as unknown as { chrome: { storage: { local: { get: (key: string) => Promise<Record<string, unknown>> } } } }).chrome.storage.local.get(name))[name], key);
    const stored = { pageTranslateGlossary: await read("pageTranslateGlossary"), pageTranslateCache: await read("pageTranslateCache") };
    expect(stored.pageTranslateGlossary).toMatch(/^deploy = 配置\n\n# プログラミング\npull request = プルリクエスト/);
    expect(Object.keys((stored.pageTranslateCache as { pages: object }).pages)).toEqual(["https://example.com/|JA|jev"]);
  });

  test("keeps the glossary folded as an advanced setting, with its explanations behind info buttons", async ({ page }) => {
    await openPanel(page);
    await page.getByRole("button", { name: "設定を開く" }).click();

    const toggle = page.getByRole("button", { name: /^用語集（Claude）.*上級者向け$/ });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("textbox", { name: "用語集の中身" })).toBeHidden();
    await expect(page.getByText("翻訳する文章に出てくる用語だけをClaudeに送ります")).toBeHidden();

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("textbox", { name: "用語集の中身" })).toBeVisible();
    await expect(page.getByText("1行に「用語 = 訳語」の形です")).toBeHidden();
    await page.getByRole("button", { name: "用語集の中身の説明" }).click();
    await expect(page.getByText("1行に「用語 = 訳語」の形です")).toBeVisible();
    await page.getByRole("button", { name: "用語集（Claude）の説明" }).click();
    await expect(page.getByText("翻訳する文章に出てくる用語だけをClaudeに送ります")).toBeVisible();
  });

  test("builds glossary entries with Claude from the reader's wishes and the open page, keeping the reader's own lines", async ({ page }) => {
    await openPanel(page, { stored: { pageTranslateGlossary: "deploy = 配置\n" } });
    await page.getByRole("button", { name: "設定を開く" }).click();
    await page.getByRole("button", { name: /^用語集（Claude）.*上級者向け$/ }).click();

    await page.getByRole("textbox", { name: "AIで作る" }).fill("Webアプリの技術記事。用語はカタカナ");
    await page.getByText("開いているページの専門用語も拾う").click();
    await page.getByRole("button", { name: "AIで用語集を作る" }).click();

    await expect(page.getByText("AIが1語を追加して保存しました。")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "用語集の中身" })).toHaveValue("deploy = 配置\n\n# AIが作成：Webアプリの技術記事。用語はカタカナ\ndashboard = ダッシュボード\n");
    const build = (await sent(page)).find((message) => message.type === "BUILD_GLOSSARY") as { request?: string; pageText?: string } | undefined;
    expect(build?.request).toBe("Webアプリの技術記事。用語はカタカナ");
    expect(build?.pageText).toBe("We plan to ship version 2.0 next month.");
  });

  test("fixes the glossary from a card the reader disliked and translates that passage again", async ({ page }) => {
    await openPanel(page, { settings: { translationProvider: "claude" }, stored: { pageTranslateGlossary: "dashboard = ダッシュボード\n" } });
    await translate(page);
    await page.locator('[data-entry-id="segment-2"] .entry-main').click();
    await page.getByRole("button", { name: "この訳を直す" }).click();
    await page.getByRole("textbox", { name: "どう直したいか" }).fill("dashboardは「管理画面」に");
    await page.getByRole("button", { name: "用語集を直して訳し直す" }).click();

    await expect(page.getByText("用語集を直して訳し直しました：dashboard = 管理画面")).toBeVisible();
    const messages = await sent(page);
    const fix = messages.find((message) => message.type === "FIX_GLOSSARY") as { sourceText?: string; feedback?: string } | undefined;
    expect(fix?.feedback).toBe("dashboardは「管理画面」に");
    expect(fix?.sourceText).toContain("dashboards");
    const again = messages.filter((message) => message.type === "TRANSLATE_SEGMENTS").at(-1);
    expect(again?.segments?.map((segment) => segment.sourceText)).toEqual([fix?.sourceText]);
    const glossary = await page.evaluate(async () => (await (window as unknown as { chrome: { storage: { local: { get: (key: string) => Promise<Record<string, unknown>> } } } }).chrome.storage.local.get("pageTranslateGlossary")).pageTranslateGlossary);
    expect(glossary).toBe("dashboard = 管理画面\n");
  });
});

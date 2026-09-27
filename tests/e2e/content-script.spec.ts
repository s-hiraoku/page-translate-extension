import type { CandidateSegment } from "../../src/shared/types";
import { classifyPage } from "../../src/background/providers";
import { expect, test } from "./support/extension";

interface ScanResult {
  segments: CandidateSegment[];
  mainContentDetected: boolean;
  excludedCount: number;
}

const texts = (scan: ScanResult) => scan.segments.map((segment) => segment.sourceText);

test.describe("scan", () => {
  test("keeps the article body and leaves out site chrome and metadata", async ({ page, send }) => {
    await page.goto("/fixtures/article.html");
    const scan = await send<ScanResult>({ type: "SCAN_PAGE" });

    expect(scan.mainContentDetected).toBe(true);
    expect(scan.segments[0]).toMatchObject({ sourceText: "How tides work", kind: "heading", isArticleTitle: true });
    expect(texts(scan)).toContainEqual(expect.stringContaining("Tides are the regular rise and fall of sea level"));
    expect(texts(scan)).toContainEqual(expect.stringContaining("Neap tides happen"));
    for (const noise of ["Ocean Notes", "We use cookies", "By Jane Doe", "6 min read", "Skip to main content", "Share on X", "oceanography",
      "Continue reading", "Great article", "Popular posts", "Advertisement", "coral reefs", "All rights reserved"]) {
      expect(texts(scan).join("\n"), `should not include "${noise}"`).not.toContain(noise);
    }
  });

  // Regression (v1.3.0): CSS inside <style> of site-builder embeds was scanned and translated.
  test("does not pick up <style> or <script> contents", async ({ page, send }) => {
    await page.goto("/fixtures/embed.html");
    const scan = await send<ScanResult>({ type: "SCAN_PAGE" });

    expect(scan.segments.length).toBeGreaterThan(0);
    for (const segment of scan.segments) {
      expect(segment.sourceText).not.toMatch(/--site--|letter-spacing|font-size|\{/);
      expect(segment.sourceHtml).not.toMatch(/<style|<script/i);
    }
    expect(texts(scan)).toContain("Claude Opus 5.5 is our most capable model, faster and cheaper to run than before.");
  });

  // Regression: the Wikipedia main page was treated as a landing page and its sections dropped.
  test("keeps every section of a portal page and classifies it as a portal", async ({ page, send }) => {
    await page.goto("/fixtures/wiki-main.html");
    const scan = await send<ScanResult>({ type: "SCAN_PAGE" });
    const headings = scan.segments.filter((segment) => segment.kind === "heading").map((segment) => segment.sourceText);

    expect(headings).toEqual(expect.arrayContaining(["From today's featured article", "Did you know ...", "In the news", "On this day"]));
    expect(scan.segments.filter((segment) => segment.sourceText.startsWith("... that")).length).toBeGreaterThanOrEqual(5);
    expect(texts(scan).join("\n")).not.toMatch(/Create account|Search Wikipedia|Main menu/);
    expect(classifyPage(scan.segments)).toBe("portal");
  });
});

test.describe("in-page translation", () => {
  // Regression (v1.3.0): replacing an element that held <style> removed the site's CSS.
  test("keeps the page's styles when translations are applied", async ({ page, send }) => {
    await page.goto("/fixtures/embed.html");
    const styleState = () => page.evaluate(() => ({ styles: document.querySelectorAll("style").length, h1: getComputedStyle(document.querySelector("h1")!).color }));
    const before = await styleState();
    const scan = await send<ScanResult>({ type: "SCAN_PAGE" });

    await send({ type: "APPLY_TRANSLATIONS", entries: scan.segments.map((segment) => ({ ...segment, state: "translated", translatedText: `訳:${segment.sourceText}`, translatedHtml: `訳:${segment.sourceHtml}<style>h1{color:red}</style><script>window.__pwned=1</script>` })) });

    expect(await styleState()).toEqual(before);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    await expect(page.locator("body")).not.toContainText("--site--max-width");
    await expect(page.locator("body")).toContainText("訳:We build AI systems");

    await send({ type: "RESTORE_PAGE" });
    await expect(page.locator("body")).not.toContainText("訳:");
    expect(await styleState()).toEqual(before);
  });

  test("answers with an error instead of throwing on a malformed message", async ({ page, send }) => {
    await page.goto("/fixtures/article.html");
    const reply = await send<{ error?: string }>({ type: "APPLY_TRANSLATIONS", entries: null });

    expect(reply.error).toContain("ページの処理中にエラーが発生しました");
    const scan = await send<ScanResult>({ type: "SCAN_PAGE" });
    expect(scan.segments.length).toBeGreaterThan(0);
  });
});

test("page text for the writing check leaves out the footer and keeps the scan", async ({ page, send }) => {
  await page.goto("/fixtures/article.html");
  await send({ type: "SCAN_PAGE" });
  const text = await send<{ title: string; text: string }>({ type: "PAGE_TEXT" });

  expect(text.title).toContain("How tides work");
  expect(text.text).toContain("Tides are the regular rise and fall");
  expect(text.text).not.toContain("All rights reserved");
  expect(await send({ type: "FOCUS_SEGMENT", segmentId: "segment-2" })).toMatchObject({ focused: true });
});

test.describe("connector", () => {
  const connectorShown = (page: import("@playwright/test").Page) =>
    page.evaluate(() => [...document.querySelectorAll("[data-page-translate-ui]")].some((element) => element.querySelector("svg")));

  test("stays while a panel is open and disappears when the last panel closes", async ({ page, driver, evaluateInExtension, send }) => {
    await page.goto("/fixtures/article.html");
    await send({ type: "SCAN_PAGE" });
    await evaluateInExtension(async (tabId) => {
      const holder = window as unknown as Record<string, chrome.runtime.Port>;
      holder.first = chrome.tabs.connect(tabId, { name: "panel-presence" });
      holder.second = chrome.tabs.connect(tabId, { name: "panel-presence" });
      await chrome.tabs.sendMessage(tabId, { type: "FOCUS_SEGMENT", segmentId: "segment-2", anchor: { screenY: 300 }, label: "2", color: "#0f8a6c" });
    });
    await expect.poll(() => connectorShown(page)).toBe(true);

    // Connectors used to time out; they must stay until the reader moves on.
    await page.waitForTimeout(3000);
    expect(await connectorShown(page)).toBe(true);

    await driver.evaluate(() => (window as unknown as Record<string, chrome.runtime.Port>).first.disconnect());
    await page.waitForTimeout(200);
    expect(await connectorShown(page)).toBe(true);

    await driver.evaluate(() => (window as unknown as Record<string, chrome.runtime.Port>).second.disconnect());
    await expect.poll(() => connectorShown(page)).toBe(false);
  });
});

test.describe("page-click mode", () => {
  type PickEvent = { type: string; segmentId?: string; segment?: CandidateSegment & { manual?: boolean; partial?: boolean } };

  test("reports clicks on cards, adds untranslated text and never follows links", async ({ page, driver, evaluateInExtension, send }) => {
    await page.goto("/fixtures/article.html");
    const scan = await send<ScanResult>({ type: "SCAN_PAGE" });
    const targets = scan.segments.slice(0, 3).map((segment, index) => ({ id: segment.id, label: String(index + 1), color: "#2c5cf0" }));
    await evaluateInExtension((tabId, list) => {
      const holder = window as unknown as { events: unknown[]; pick: chrome.runtime.Port };
      holder.events = [];
      holder.pick = chrome.tabs.connect(tabId, { name: "page-pick" });
      holder.pick.onMessage.addListener((event) => holder.events.push(event));
      holder.pick.postMessage({ type: "targets", targets: list, zoom: 1 });
    }, targets);
    const events = () => driver.evaluate(() => (window as unknown as { events: PickEvent[] }).events);
    const clickText = async (selector: string) => {
      const target = page.locator(selector).first();
      await target.scrollIntoViewIfNeeded();
      const box = (await target.boundingBox())!;
      await page.mouse.click(box.x + 10, box.y + box.height / 2);
    };

    await clickText("main article > p");
    await expect.poll(async () => (await events()).at(-1)).toMatchObject({ type: "picked", segmentId: "segment-2" });

    await clickText("footer p");
    await expect.poll(async () => (await events()).at(-1)?.segment?.sourceText).toContain("All rights reserved");
    expect((await events()).at(-1)).toMatchObject({ type: "added", segment: { manual: true } });

    const url = page.url();
    await clickText("aside li a");
    await page.waitForTimeout(300);
    expect(page.url()).toBe(url);

    await page.keyboard.press("Escape");
    await expect.poll(async () => (await events()).at(-1)?.type).toBe("exit");
  });
});

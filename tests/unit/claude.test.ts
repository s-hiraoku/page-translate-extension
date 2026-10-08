import { describe, expect, it } from "vitest";
import { batchSegments, buildPageMessage, readTranslations } from "../../src/background/claude";
import type { CandidateSegment } from "../../src/shared/types";

function segment(id: number, sourceHtml: string): CandidateSegment {
  return {
    id: `s${id}`, order: id, location: "", tagName: "p", sourceText: sourceHtml.replace(/<[^>]*>/g, ""), sourceHtml,
    region: "main", kind: "paragraph", linkDensity: 0, isArticleTitle: false,
  };
}

describe("readTranslations", () => {
  it("returns translations in passage order, whatever order Claude answers in", () => {
    const answer = JSON.stringify({ translations: [{ n: 2, html: "二" }, { n: 1, html: "<b>一</b>" }] });
    expect(readTranslations(2, answer)).toEqual(["<b>一</b>", "二"]);
  });

  it("fails when a passage is missing", () => {
    expect(() => readTranslations(2, JSON.stringify({ translations: [{ n: 1, html: "一" }] }))).toThrow("翻訳数が一致しません");
  });

  it("fails on an answer that is not JSON", () => {
    expect(() => readTranslations(1, "not json")).toThrow("読み取れない");
  });
});

describe("batchSegments", () => {
  it("splits by size and keeps the order", () => {
    const segments = Array.from({ length: 5 }, (_, index) => segment(index + 1, "x".repeat(5_000)));
    const batches = batchSegments(segments);
    expect(batches.map((batch) => batch.length)).toEqual([2, 2, 1]);
    expect(batches.flat().map((item) => item.id)).toEqual(segments.map((item) => item.id));
  });

  it("splits long lists of short passages", () => {
    expect(batchSegments(Array.from({ length: 90 }, (_, index) => segment(index + 1, "Short."))).map((batch) => batch.length)).toEqual([40, 40, 10]);
  });
});

describe("buildPageMessage", () => {
  it("numbers the passages from 1 and sends their HTML with the page as context", () => {
    const message = JSON.parse(buildPageMessage([segment(7, "<a href=\"/x\">Hello</a>"), segment(8, "World")], "JA", { pageTitle: "Title", pageText: "Hello\nWorld" }));
    expect(message.target_language).toBe("Japanese");
    expect(message.page_title).toBe("Title");
    expect(message.page_context).toBe("Hello\nWorld");
    expect(message.passages).toEqual([{ n: 1, html: "<a href=\"/x\">Hello</a>" }, { n: 2, html: "World" }]);
  });
});

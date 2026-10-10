import { describe, expect, it } from "vitest";
import { batchSegments, buildPageMessage, readEntries, readTranslations, sameTags } from "../../src/background/claude";
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
    expect(readTranslations(["<b>one</b>", "two"], answer)).toEqual(["<b>一</b>", "二"]);
  });

  it("fails when a passage is missing", () => {
    expect(() => readTranslations(["one", "two"], JSON.stringify({ translations: [{ n: 1, html: "一" }] }))).toThrow("翻訳数が一致しません");
  });

  it("fails on a repeated, extra or out-of-range number", () => {
    const sources = ["one", "two"];
    const answer = (numbers: number[]) => JSON.stringify({ translations: numbers.map((n) => ({ n, html: String(n) })) });
    expect(() => readTranslations(sources, answer([1, 1, 2]))).toThrow("翻訳数が一致しません");
    expect(() => readTranslations(sources, answer([1, 2, 3]))).toThrow("翻訳数が一致しません");
    expect(() => readTranslations(sources, answer([1, 3]))).toThrow("翻訳数が一致しません");
    expect(() => readTranslations(sources, answer([1, 1.5]))).toThrow("翻訳数が一致しません");
  });

  it("keeps only the text of a translation whose tags changed", () => {
    const sources = ['See <a href="https://example.com/a">the guide</a>.', 'Run <code>npm test</code> now.'];
    const answer = JSON.stringify({ translations: [
      { n: 1, html: '<a href="https://evil.example/">ガイド</a>を参照してください。' },
      { n: 2, html: '今すぐ<code>npm test</code>を実行します。' },
    ] });
    expect(readTranslations(sources, answer)).toEqual(["ガイドを参照してください。", "今すぐ<code>npm test</code>を実行します。"]);
  });

  it("fails on an answer that is not JSON", () => {
    expect(() => readTranslations(["one"], "not json")).toThrow("読み取れない");
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

describe("sameTags", () => {
  it("allows a link to move within the sentence", () => {
    expect(sameTags('Read <a href="/x">this</a> first, <em>then</em> that.', '<em>次に</em>、まず<a href="/x">これ</a>を読みます。')).toBe(true);
  });

  it("rejects an added element or a changed attribute", () => {
    expect(sameTags("Plain text.", '<img src="x">テキスト。')).toBe(false);
    expect(sameTags('<a href="/x">x</a>', '<a href="/y">x</a>')).toBe(false);
    expect(sameTags('<a href="/a b">x</a>', '<a href="/a  b">x</a>')).toBe(false);
  });
});

describe("buildPageMessage glossary", () => {
  it("sends only the glossary terms the batch uses", () => {
    const glossary = [{ term: "deploy", translation: "デプロイ" }, { term: "merge", translation: "マージ" }];
    const message = JSON.parse(buildPageMessage([segment(1, "Deploy the app.")], "JA", { pageTitle: "", pageText: "" }, glossary));
    expect(message.glossary).toEqual([{ term: "deploy", translation: "デプロイ" }]);
    expect(JSON.parse(buildPageMessage([segment(1, "Hello.")], "JA", { pageTitle: "", pageText: "" }, glossary)).glossary).toBeUndefined();
  });
});

describe("readEntries", () => {
  it("keeps each entry on one line and drops incomplete ones", () => {
    const answer = JSON.stringify({ entries: [{ term: "pull\nrequest", translation: "プル=リクエスト" }, { term: "x", translation: "" }] });
    expect(readEntries(answer)).toEqual([{ term: "pull request", translation: "プル リクエスト" }]);
  });

  it("fails on an answer without entries", () => {
    expect(() => readEntries("{}")).toThrow("辞書を受け取れません");
  });
});

import { describe, expect, it } from "vitest";
import type { CandidateSegment } from "../../src/shared/types";
import { isInTargetLanguage, isMainProse } from "../../src/sidepanel/rules";

function segment(sourceText: string, overrides: Partial<CandidateSegment> = {}): CandidateSegment {
  return {
    id: "segment-1",
    order: 0,
    location: "本文 1",
    tagName: "p",
    sourceText,
    sourceHtml: sourceText,
    region: "main",
    kind: "paragraph",
    linkDensity: 0,
    isArticleTitle: false,
    ...overrides,
  };
}

const englishSentence = "Kevin O'Halloran was an Australian freestyle swimmer who won a gold medal at the 1956 Summer Olympics.";

describe("isInTargetLanguage", () => {
  it("treats Japanese text as already in Japanese", () => {
    expect(isInTargetLanguage("日本語の段落はすでに翻訳先の言語なので、一覧には表示されません。", "JA")).toBe(true);
  });

  it("keeps Japanese text that quotes a few English words", () => {
    expect(isInTargetLanguage("Anthropicは、信頼できるAIシステムを研究し、開発している安全性重視の公益法人です。", "JA")).toBe(true);
  });

  it("does not treat English as Japanese", () => {
    expect(isInTargetLanguage(englishSentence, "JA")).toBe(false);
  });

  it("never drops text locally when the target is English", () => {
    expect(isInTargetLanguage(englishSentence, "EN")).toBe(false);
  });
});

describe("isMainProse", () => {
  it("accepts an English sentence in the main content", () => {
    expect(isMainProse(segment(englishSentence), "JA")).toBe(true);
  });

  it("accepts prose with a parenthetical remark", () => {
    const text = "Claude Opus 5.5 is our most capable model (it is faster and cheaper to run), and it is available today.";
    expect(isMainProse(segment(text), "JA")).toBe(true);
  });

  // Regression: CSS embedded by site builders was rescued as prose and translated (v1.3.0).
  it("rejects CSS even when it is long and in the main content", () => {
    const css = ":root { --site--max-width: min(var(--site--width), 100vw); --container--main: calc(var(--site--max-width) - var(--site--margin) * 2); }";
    expect(isMainProse(segment(css), "JA")).toBe(false);
  });

  it("rejects JavaScript", () => {
    const js = "document.addEventListener('DOMContentLoaded', () => { const year = new Date().getFullYear(); el.textContent = year; });";
    expect(isMainProse(segment(js), "JA")).toBe(false);
  });

  it("rejects headings, controls, short text and link lists", () => {
    expect(isMainProse(segment(englishSentence, { kind: "heading" }), "JA")).toBe(false);
    expect(isMainProse(segment(englishSentence, { kind: "control" }), "JA")).toBe(false);
    expect(isMainProse(segment("Read more about it."), "JA")).toBe(false);
    expect(isMainProse(segment(englishSentence, { linkDensity: 0.8 }), "JA")).toBe(false);
  });

  it("only rescues text outside the target language", () => {
    expect(isMainProse(segment(englishSentence, { region: "outside" }), "JA")).toBe(false);
    expect(isMainProse(segment(englishSentence), "EN")).toBe(false);
  });
});

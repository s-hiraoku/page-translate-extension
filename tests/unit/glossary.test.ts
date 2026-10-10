import { describe, expect, it } from "vitest";
import { PROGRAMMING_GLOSSARY, glossaryFor, parseGlossary } from "../../src/shared/glossary";

describe("parseGlossary", () => {
  it("reads 'term = translation' and tab-separated lines, skipping notes and incomplete lines", () => {
    expect(parseGlossary("# note\npull request = プルリクエスト\ndeploy\tデプロイ\n\nbroken line\n= 訳だけ")).toEqual([
      { term: "pull request", translation: "プルリクエスト" },
      { term: "deploy", translation: "デプロイ" },
    ]);
  });

  it("reads the programming glossary without dropping a line", () => {
    const lines = PROGRAMMING_GLOSSARY.split("\n").filter((line) => line.trim() && !line.startsWith("#"));
    expect(parseGlossary(PROGRAMMING_GLOSSARY)).toHaveLength(lines.length);
  });
});

describe("glossaryFor", () => {
  const entries = parseGlossary("type = 型\npull request = プルリクエスト\ndeploy = デプロイ");

  it("keeps only the terms the text uses, as whole words, ignoring case", () => {
    expect(glossaryFor(entries, "Open a Pull Request. The prototype works.")).toEqual([{ term: "pull request", translation: "プルリクエスト" }]);
  });

  it("does not match a katakana term inside a longer katakana word", () => {
    const katakana = parseGlossary("class = クラス");
    expect(glossaryFor(katakana, "クラスターを作ります。")).toEqual([]);
    expect(glossaryFor(katakana, "クラスを作ります。")).toEqual([{ term: "クラス", translation: "class" }]);
  });

  it("matches in the translation's direction first when asked, for text with both sides", () => {
    expect(glossaryFor(entries, "deploy（デプロイ）します。", true)).toEqual([{ term: "デプロイ", translation: "deploy" }]);
    expect(glossaryFor(entries, "deploy（デプロイ）します。")).toEqual([{ term: "deploy", translation: "デプロイ" }]);
  });

  it("works the other way for text in the translation's language", () => {
    expect(glossaryFor(entries, "本番環境にデプロイします。")).toEqual([{ term: "デプロイ", translation: "deploy" }]);
  });
});


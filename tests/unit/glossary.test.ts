import { describe, expect, it } from "vitest";
import { PROGRAMMING_GLOSSARY, applyGlossaryEntries, glossaryFor, mergeGlossary, parseGlossary } from "../../src/shared/glossary";

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

describe("mergeGlossary", () => {
  it("adds only the terms not there yet", () => {
    expect(mergeGlossary("deploy = 配置\n", "# add\ndeploy = デプロイ\nbuild = ビルド")).toBe("deploy = 配置\n\n# add\nbuild = ビルド\n");
  });

  it("leaves the glossary as it is when every term is there", () => {
    expect(mergeGlossary("deploy = 配置", "# add\ndeploy = デプロイ")).toBe("deploy = 配置");
  });
});

describe("applyGlossaryEntries", () => {
  const text = "deploy = 配置\nbuild = ビルド\n";
  const entries = [{ term: "Deploy", translation: "デプロイ" }, { term: "commit", translation: "コミット" }];

  it("keeps the reader's lines and appends new terms under a heading", () => {
    expect(applyGlossaryEntries(text, entries, false, "AI")).toEqual({ text: "deploy = 配置\nbuild = ビルド\n\n# AI\ncommit = コミット\n", changed: 1 });
  });

  it("replaces a term's translation when fixing", () => {
    expect(applyGlossaryEntries(text, entries, true, "AI")).toEqual({ text: "deploy = デプロイ\nbuild = ビルド\n\n# AI\ncommit = コミット\n", changed: 2 });
  });
});

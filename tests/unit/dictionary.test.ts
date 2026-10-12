import { describe, expect, it } from "vitest";
import { applyDictionaryChanges, describeDictionary, dictionaryFor, parseDictionary, relevantExamples } from "../../src/shared/dictionary";

const TEXT = `## 訳し方の方針
- です・ます調
- コードは英語のまま

## 用語
# メモ
deploy = デプロイ
merge = マージ

## 例文
原文: Deploy the app to production.
訳文: アプリを本番環境にデプロイします。

原文: Merge the branch
after the review.
訳文: レビューのあとでブランチをマージします。
`;

describe("parseDictionary", () => {
  it("reads the style, the terms and the examples", () => {
    expect(parseDictionary(TEXT)).toEqual({
      style: ["です・ます調", "コードは英語のまま"],
      terms: [{ term: "deploy", translation: "デプロイ" }, { term: "merge", translation: "マージ" }],
      examples: [
        { source: "Deploy the app to production.", translation: "アプリを本番環境にデプロイします。" },
        { source: "Merge the branch\nafter the review.", translation: "レビューのあとでブランチをマージします。" },
      ],
    });
  });

  it("reads a glossary without sections as terms", () => {
    expect(parseDictionary("# プログラミング\ndeploy = デプロイ\n")).toEqual({ style: [], terms: [{ term: "deploy", translation: "デプロイ" }], examples: [] });
  });

  it("does not read an example with an = as a term", () => {
    expect(parseDictionary("## 例文\n原文: a = b\n訳文: a は b\n").terms).toEqual([]);
  });

  it("drops an example without a translation", () => {
    expect(parseDictionary("## 例文\n原文: Hello.\n").examples).toEqual([]);
  });
});

describe("describeDictionary", () => {
  it("counts each part", () => {
    expect(describeDictionary(parseDictionary(TEXT))).toBe("方針 2件・用語 2語・例文 2件");
    expect(describeDictionary(parseDictionary(""))).toBe("");
  });
});

describe("relevantExamples", () => {
  const examples = parseDictionary(TEXT).examples;

  it("puts the closest example first", () => {
    expect(relevantExamples(examples, "Merge the pull request after the review.")[0]?.source).toContain("Merge the branch");
  });

  it("falls back to the first examples when none is close", () => {
    expect(relevantExamples(examples, "Hello world")).toHaveLength(2);
  });

  it("matches Japanese text by pairs of characters", () => {
    expect(relevantExamples(examples, "本番環境に公開します。", 1)[0]?.source).toBe("Deploy the app to production.");
  });

  it("keeps within the size limit", () => {
    expect(relevantExamples(examples, "Deploy and merge the app.", 6, 10)).toHaveLength(1);
  });
});

describe("dictionaryFor", () => {
  it("returns null for an empty dictionary", () => {
    expect(dictionaryFor(parseDictionary(""), "Deploy it.")).toBeNull();
  });
});

describe("applyDictionaryChanges", () => {
  it("adds each part to its section and keeps the reader's terms", () => {
    const { text, changed } = applyDictionaryChanges(TEXT, {
      style: ["です・ます調", "見出しは体言止め"],
      terms: [{ term: "deploy", translation: "配置" }, { term: "commit", translation: "コミット" }],
      examples: [{ source: "Commit your changes.", translation: "変更をコミットします。" }],
    }, false, "AI");
    expect(changed).toBe(3);
    const dictionary = parseDictionary(text);
    expect(dictionary.style).toEqual(["です・ます調", "コードは英語のまま", "見出しは体言止め"]);
    expect(dictionary.terms).toEqual([{ term: "deploy", translation: "デプロイ" }, { term: "merge", translation: "マージ" }, { term: "commit", translation: "コミット" }]);
    expect(dictionary.examples.map((example) => example.source)).toEqual(["Deploy the app to production.", "Merge the branch\nafter the review.", "Commit your changes."]);
    expect(text).toContain("merge = マージ\n\n# AI\ncommit = コミット\n\n## 例文");
  });

  it("replaces a term and an example's translation on a fix", () => {
    const { text, changed } = applyDictionaryChanges(TEXT, {
      style: [],
      terms: [{ term: "deploy", translation: "配置" }],
      examples: [{ source: "Deploy the app to production.", translation: "アプリを本番環境に配置します。" }],
    }, true, "AI");
    expect(changed).toBe(2);
    const dictionary = parseDictionary(text);
    expect(dictionary.terms[0]).toEqual({ term: "deploy", translation: "配置" });
    expect(dictionary.examples[0]).toEqual({ source: "Deploy the app to production.", translation: "アプリを本番環境に配置します。" });
    expect(dictionary.examples).toHaveLength(2);
  });

  it("creates the sections in an empty dictionary", () => {
    const changes = { style: ["です・ます調"], terms: [{ term: "deploy", translation: "デプロイ" }], examples: [{ source: "Run it.", translation: "実行します。" }] };
    expect(parseDictionary(applyDictionaryChanges("", changes, false, "AI").text)).toEqual(changes);
  });

  it("adds terms after a glossary without sections", () => {
    const { text } = applyDictionaryChanges("deploy = デプロイ\n", { style: ["です・ます調"], terms: [{ term: "merge", translation: "マージ" }], examples: [] }, false, "AI");
    expect(text).toBe("deploy = デプロイ\n\n# AI\nmerge = マージ\n\n## 訳し方の方針\n- です・ます調\n");
  });

  it("changes nothing when everything is already there", () => {
    expect(applyDictionaryChanges(TEXT, parseDictionary(TEXT), false, "AI")).toEqual({ text: TEXT, changed: 0 });
  });
});

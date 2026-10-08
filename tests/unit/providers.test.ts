import { describe, expect, it } from "vitest";
import { classifyPage, missingKeyMessage } from "../../src/background/providers";
import { resolveDeepLPlan, type CandidateSegment } from "../../src/shared/types";

let next = 0;
function segment(kind: CandidateSegment["kind"], sourceText: string, overrides: Partial<CandidateSegment> = {}): CandidateSegment {
  next += 1;
  return {
    id: `segment-${next}`,
    order: next,
    location: "",
    tagName: kind === "heading" ? "h2" : kind === "list-item" ? "li" : "p",
    sourceText,
    sourceHtml: sourceText,
    region: "main",
    kind,
    linkDensity: 0,
    isArticleTitle: false,
    ...overrides,
  };
}

const paragraph = "A long paragraph of article text that explains the subject in detail, with enough words to count as prose. ".repeat(2);
const item = "... that a short fact about something is listed here as a news item or a did-you-know entry?";

describe("classifyPage", () => {
  it("classifies a page of long paragraphs as an article", () => {
    const segments = [segment("heading", "Title", { isArticleTitle: true }), ...Array.from({ length: 6 }, () => segment("paragraph", paragraph))];
    expect(classifyPage(segments)).toBe("article");
  });

  it("classifies many sections of short items as a portal", () => {
    const segments = [
      ...["Featured", "Did you know", "In the news", "On this day"].map((title) => segment("heading", title)),
      segment("paragraph", paragraph),
      ...Array.from({ length: 12 }, () => segment("list-item", item)),
    ];
    expect(classifyPage(segments)).toBe("portal");
  });

  it("classifies a page with little prose as a landing page", () => {
    const segments = [segment("heading", "Full Self-Driving"), segment("paragraph", "Fewer Collisions"), segment("paragraph", "Miles Driven")];
    expect(classifyPage(segments)).toBe("landing");
  });
});

describe("resolveDeepLPlan", () => {
  it("detects free-plan keys by their :fx suffix", () => {
    expect(resolveDeepLPlan("auto", "0123-abcd:fx")).toBe("free");
    expect(resolveDeepLPlan("auto", "  0123-abcd:fx  ")).toBe("free");
  });

  it("uses the paid server for other keys", () => {
    expect(resolveDeepLPlan("auto", "0123-abcd")).toBe("pro");
  });

  it("lets a manual choice override the key", () => {
    expect(resolveDeepLPlan("free", "0123-abcd")).toBe("free");
    expect(resolveDeepLPlan("pro", "0123-abcd:fx")).toBe("pro");
  });
});

describe("missingKeyMessage", () => {
  it("asks for the DeepL key first when no key is registered, and mentions translating without Jev", () => {
    const message = missingKeyMessage({ jev: false, deepl: false })!;
    expect(message.startsWith("設定画面でDeepLのAPIキーを登録してください。")).toBe(true);
    expect(message).toContain("Jevを使わない");
  });

  it("asks for the DeepL key when only Jev's is registered", () => {
    expect(missingKeyMessage({ jev: true, deepl: false })).toMatch(/^設定画面でDeepLのAPIキーを登録/);
  });

  it("offers turning Jev off when only Jev's key is missing", () => {
    const message = missingKeyMessage({ jev: false, deepl: true })!;
    expect(message).toContain("TypeSafe JevのAPIキーが未登録");
    expect(message).toContain("Jevを使わない");
  });

  it("says nothing when both keys are registered", () => {
    expect(missingKeyMessage({ jev: true, deepl: true })).toBeNull();
  });

  it("with Chrome's translator, asks only for Jev's key", () => {
    expect(missingKeyMessage({ jev: true, deepl: false }, null)).toBeNull();
    const message = missingKeyMessage({ jev: false, deepl: false }, null)!;
    expect(message).toContain("TypeSafe JevのAPIキーが未登録");
    expect(message).not.toContain("DeepL");
  });
});

describe("missingKeyMessage with Claude", () => {
  it("asks for Claude's key when Claude translates", () => {
    expect(missingKeyMessage({ jev: true, deepl: false, claude: false }, "claude")).toContain("ClaudeのAPIキー");
  });

  it("does not ask for DeepL's key when Claude translates", () => {
    expect(missingKeyMessage({ jev: true, deepl: false, claude: true }, "claude")).toBeNull();
    expect(missingKeyMessage({ jev: false, deepl: false, claude: true }, "claude")).toContain("TypeSafe JevのAPIキーが未登録");
  });
});

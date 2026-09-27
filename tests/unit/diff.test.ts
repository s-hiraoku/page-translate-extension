import { describe, expect, it } from "vitest";
import { diffWords, hasChanges } from "../../src/sidepanel/diff";

function render(before: string, after: string): string {
  return diffWords(before, after)
    .map((part) => (part.kind === "same" ? part.text : part.kind === "removed" ? `[-${part.text}-]` : `{+${part.text}+}`))
    .join("");
}

describe("diffWords", () => {
  it("marks replaced and added words", () => {
    expect(render(
      "I want to ask about the release schedule of next version.",
      "I would like to ask about the release schedule for the next version.",
    )).toBe("I [-want-]{+would+} {+like +}to ask about the release schedule [-of-]{+for+} {+the +}next version.");
  });

  it("rebuilds the suggestion from unchanged and added parts", () => {
    const before = "She go to school yesterday.";
    const after = "She went to school yesterday.";
    const rebuilt = diffWords(before, after).filter((part) => part.kind !== "removed").map((part) => part.text).join("");
    expect(rebuilt).toBe(after);
  });

  it("ignores whitespace-only differences", () => {
    const parts = diffWords("Hello   world.", "Hello world.");
    expect(hasChanges(parts)).toBe(false);
  });

  it("reports identical text as unchanged", () => {
    expect(hasChanges(diffWords("Same text.", "Same text."))).toBe(false);
  });

  it("falls back to a whole replacement for very long texts", () => {
    const long = Array.from({ length: 3000 }, (_, index) => `word${index}`).join(" ");
    const parts = diffWords(long, `${long} extra`);
    expect(parts).toEqual([{ kind: "removed", text: long }, { kind: "added", text: `${long} extra` }]);
  });
});

import { describe, expect, it } from "vitest";
import { isTranslatableSelection, normalizeSelectionText } from "../../src/content/selection";
import { placeTooltip } from "../../src/content/tooltip-layout";

describe("normalizeSelectionText", () => {
  it("collapses blanks and no-break spaces", () => {
    expect(normalizeSelectionText("  Hello    world\t!  ")).toBe("Hello world !");
  });

  it("keeps line breaks between blocks but not runs of blank lines", () => {
    expect(normalizeSelectionText("First paragraph.\n\n\n\nSecond   one.\n  Third.")).toBe("First paragraph.\n\nSecond one.\nThird.");
  });

  it("removes zero-width spaces", () => {
    expect(normalizeSelectionText("a​ b")).toBe("a b");
  });
});

describe("isTranslatableSelection", () => {
  it("accepts a word or a sentence", () => {
    expect(isTranslatableSelection("tide")).toBe(true);
    expect(isTranslatableSelection("こんにちは")).toBe(true);
  });

  it("rejects a stray character, digits or symbols only, and empty text", () => {
    expect(isTranslatableSelection("a")).toBe(false);
    expect(isTranslatableSelection("2026")).toBe(false);
    expect(isTranslatableSelection("--- ***")).toBe(false);
    expect(isTranslatableSelection("")).toBe(false);
  });

  it("rejects text longer than the limit", () => {
    expect(isTranslatableSelection("a".repeat(5000))).toBe(true);
    expect(isTranslatableSelection("a".repeat(5001))).toBe(false);
  });
});

describe("placeTooltip", () => {
  const viewport = { width: 1000, height: 700 };
  const size = { width: 300, height: 100 };
  const anchor = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });

  it("goes below the selection when there is room, centered on it", () => {
    const placed = placeTooltip(anchor(400, 200, 500, 220), size, viewport);
    expect(placed.placement).toBe("below");
    expect(placed.top).toBe(230);
    expect(placed.left).toBe(300);
    expect(placed.arrowLeft).toBe(150);
  });

  it("goes above when the selection is near the bottom", () => {
    const placed = placeTooltip(anchor(400, 640, 500, 660), size, viewport);
    expect(placed.placement).toBe("above");
    expect(placed.top).toBe(640 - 10 - 100);
  });

  it("stays inside the viewport at the left and right edges and points the arrow at the selection", () => {
    const left = placeTooltip(anchor(0, 200, 30, 220), size, viewport);
    expect(left.left).toBe(8);
    expect(left.arrowLeft).toBe(16);
    const right = placeTooltip(anchor(970, 200, 1000, 220), size, viewport);
    expect(right.left).toBe(1000 - 300 - 8);
    expect(right.arrowLeft).toBe(300 - 16);
  });

  it("uses the side with more room and clamps when neither side fits", () => {
    const tall = { width: 300, height: 500 };
    const placed = placeTooltip(anchor(400, 300, 500, 320), tall, viewport);
    expect(placed.top).toBeGreaterThanOrEqual(8);
    expect(placed.top + tall.height).toBeLessThanOrEqual(viewport.height - 8);
  });
});

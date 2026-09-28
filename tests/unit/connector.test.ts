import { describe, expect, it } from "vitest";
import { connectorPath } from "../../src/content/connector";

function points(path: string) {
  const match = /^M ([\d.-]+) ([\d.-]+) C ([\d.-]+) ([\d.-]+), ([\d.-]+) ([\d.-]+), ([\d.-]+) ([\d.-]+)$/.exec(path);
  if (!match) throw new Error(`not a cubic path: ${path}`);
  const [x1, y1, c1x, c1y, c2x, c2y, x2, y2] = match.slice(1).map(Number);
  return { x1, y1, c1x, c1y, c2x, c2y, x2, y2 };
}

describe("connectorPath", () => {
  it("starts at the source and ends at the panel edge", () => {
    const p = points(connectorPath(100, 300, 900, 320));
    expect([p.x1, p.y1, p.x2, p.y2]).toEqual([100, 300, 900, 320]);
  });

  it("bows visibly even when both ends are level", () => {
    const p = points(connectorPath(100, 300, 900, 300));
    expect(300 - p.c1y).toBeGreaterThanOrEqual(28);
  });

  it("arrives at the panel horizontally", () => {
    const p = points(connectorPath(100, 200, 900, 560));
    expect(p.c2y).toBe(p.y2);
    expect(p.c2x).toBeLessThan(p.x2);
  });

  it("does not add a hump when the card is far below the source", () => {
    const p = points(connectorPath(740, 380, 1000, 600));
    expect(p.c1y).toBe(380);
  });

  it("keeps the bow moderate for long lines", () => {
    const p = points(connectorPath(0, 400, 3000, 400));
    expect(400 - p.c1y).toBeLessThanOrEqual(120);
  });

  it("bows downward when the arc would leave the top of the viewport", () => {
    const p = points(connectorPath(100, 20, 900, 30));
    expect(p.c1y).toBeGreaterThan(20);
  });
});

import { describe, expect, it } from "vitest";
import { createScreenTopTracker, geometryTop, type WindowGeometry } from "../../src/shared/screen-top";

/** The tracker only reads the geometry; tests move the window by writing to it. */
type MovableWindow = { -readonly [K in keyof WindowGeometry]: WindowGeometry[K] };

function windowAt(screenY: number, outerHeight = 900, innerHeight = 800): MovableWindow {
  return { screenY, outerHeight, innerHeight };
}

describe("geometryTop", () => {
  it("puts the viewport below the toolbar at the bottom of the window", () => {
    expect(geometryTop(1, windowAt(100))).toBe(200);
  });

  it("scales the viewport height by the page zoom", () => {
    expect(geometryTop(1.5, windowAt(100, 900, 800))).toBe(100 + 900 - 1200);
  });
});

describe("createScreenTopTracker", () => {
  it("knows nothing before a pointer event", () => {
    expect(createScreenTopTracker(windowAt(100)).top()).toBeNull();
  });

  it("returns the exact top of the last pointer event, even when the estimate is off", () => {
    const tracker = createScreenTopTracker(windowAt(100));
    // The estimate says 200, but a side panel header pushes the viewport to 240.
    tracker.learn({ screenY: 540, clientY: 300 });
    expect(tracker.top()).toBe(240);
  });

  it("moves with the window after the last pointer event", () => {
    const geometry = windowAt(100);
    const tracker = createScreenTopTracker(geometry);
    tracker.learn({ screenY: 540, clientY: 300 });
    geometry.screenY = 180;
    expect(tracker.top()).toBe(320);
  });

  it("follows a change in the viewport's size", () => {
    const geometry = windowAt(100);
    const tracker = createScreenTopTracker(geometry);
    tracker.learn({ screenY: 540, clientY: 300 });
    // An infobar appears above the page: the viewport gets 40 shorter and its top 40 lower.
    geometry.innerHeight = 760;
    expect(tracker.top()).toBe(280);
  });

  it("accounts for zoom when learning", () => {
    const tracker = createScreenTopTracker(windowAt(100));
    tracker.learn({ screenY: 500, clientY: 200 }, 1.25);
    expect(tracker.top(1.25)).toBe(250);
  });

  it("ignores events without usable coordinates", () => {
    const tracker = createScreenTopTracker(windowAt(100));
    tracker.learn({ screenY: Number.NaN, clientY: 10 });
    expect(tracker.top()).toBeNull();
  });
});

/** The window geometry the tracker reads; `window` itself by default, replaceable in tests. */
export type WindowGeometry = Pick<Window, "screenY" | "outerHeight" | "innerHeight">;

/**
 * Where the top of this document's viewport probably is on screen, from the window's own
 * geometry. Exact only when nothing but the browser toolbar sits above the viewport, so it
 * serves as a starting point and as the way to tell how far things have moved since.
 */
export function geometryTop(zoom = 1, geometry: WindowGeometry = window): number {
  return geometry.screenY + (geometry.outerHeight - geometry.innerHeight * zoom);
}

/**
 * Remembers where the viewport's top edge is on screen (screen Y minus client Y of a real
 * pointer event) and keeps that value right when the window moves or resizes afterwards.
 *
 * The side panel and the page each learn their own top from their own pointer events, and
 * align the connector by comparing the two. A remembered number alone goes stale as soon
 * as the window moves, e.g. while Chrome was in the background, and the connector then ends
 * beside the wrong card until the pointer crosses that side again. So what is stored is the
 * difference between the exact reading and the geometry estimate at that moment, and the
 * estimate is recomputed on every use.
 */
export function createScreenTopTracker(geometry: WindowGeometry = window) {
  let offset: number | null = null;
  return {
    learn(event: { screenY: number; clientY: number }, zoom = 1): void {
      const learned = event.screenY - event.clientY * zoom;
      if (Number.isFinite(learned)) offset = learned - geometryTop(zoom, geometry);
    },
    /** The viewport top now, or null before any pointer event has been seen. */
    top(zoom = 1): number | null {
      return offset === null ? null : geometryTop(zoom, geometry) + offset;
    },
  };
}

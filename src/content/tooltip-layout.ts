export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface TooltipPlacement {
  left: number;
  top: number;
  placement: "above" | "below";
  /** Where the arrow points, measured from the tooltip's left edge. */
  arrowLeft: number;
}

/**
 * Puts a tooltip next to the selection: below it when there is room, otherwise above, and
 * on whichever side has more space when neither fits (then clamped into the viewport).
 * The tooltip is centered on the selection and kept `margin` away from the viewport's edges.
 */
export function placeTooltip(
  anchor: Box,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = 10,
  margin = 8,
): TooltipPlacement {
  const roomBelow = viewport.height - anchor.bottom - gap - margin;
  const roomAbove = anchor.top - gap - margin;
  const placement: "above" | "below" = roomBelow >= size.height || roomBelow >= roomAbove ? "below" : "above";

  const centerX = (anchor.left + anchor.right) / 2;
  const maxLeft = Math.max(margin, viewport.width - size.width - margin);
  const left = Math.min(Math.max(centerX - size.width / 2, margin), maxLeft);
  const wantedTop = placement === "below" ? anchor.bottom + gap : anchor.top - gap - size.height;
  const maxTop = Math.max(margin, viewport.height - size.height - margin);
  const top = Math.min(Math.max(wantedTop, margin), maxTop);

  const arrowInset = 16;
  const arrowLeft = Math.min(Math.max(centerX - left, arrowInset), Math.max(arrowInset, size.width - arrowInset));
  return { left, top, placement, arrowLeft };
}

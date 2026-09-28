/**
 * The connector from the source (x1, y1) to the panel edge (x2, y2). It leaves and enters
 * horizontally, and when the ends are nearly level it rises in an arc so it still reads
 * as a curve. Near the top of the viewport the arc bows downward instead.
 */
export function connectorPath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.max(x2 - x1, 1);
  const length = Math.hypot(x2 - x1, y2 - y1);
  // Level ends get the full bow; as the ends move apart vertically the horizontal ends
  // alone curve the line, so the bow fades out instead of adding a hump.
  const level = Math.max(0, 1 - Math.abs(y2 - y1) / (dx * 0.6));
  const lift = Math.min(Math.max(length * 0.2, 28), 120) * level;
  const up = Math.min(y1, y2) - lift >= 12;
  const c1x = x1 + dx * 0.45;
  const c1y = up ? y1 - lift : y1 + lift;
  const c2x = x2 - dx * 0.4;
  const round = (value: number) => Math.round(value * 10) / 10;
  return `M ${round(x1)} ${round(y1)} C ${round(c1x)} ${round(c1y)}, ${round(c2x)} ${round(y2)}, ${round(x2)} ${round(y2)}`;
}

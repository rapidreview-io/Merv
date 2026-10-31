/** A place on the board, in its own coordinates. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
/** How far apart what is added stands from what is already there. */
const GAP = 40;
/** How many steps below a taken place are tried before the place is taken anyway. */
const TRIES = 100;

export const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Whether all of this stands within what is in view. */
export const inView = (rect: Rect, view: Rect) =>
  rect.x >= view.x &&
  rect.y >= view.y &&
  rect.x + rect.width <= view.x + view.width &&
  rect.y + rect.height <= view.y + view.height;

/**
 * Where something of this size lands: to the right of what is chosen, level with its top, or with
 * nothing chosen in the middle of the view; and where that is taken, the first free place below it.
 */
export function landing(
  size: Pick<Rect, 'width' | 'height'>,
  standing: readonly Rect[],
  chosen: Rect | undefined,
  view: Rect,
): [x: number, y: number] {
  const x = chosen ? chosen.x + chosen.width + GAP : view.x + view.width / 2 - size.width / 2;
  const y = chosen ? chosen.y : view.y + view.height / 2 - size.height / 2;
  for (let step = 0; step <= TRIES; step++) {
    const at = y + step * (size.height + GAP);
    if (!standing.some((rect) => overlaps(rect, { ...size, x, y: at })))
      return [Math.round(x), Math.round(at)];
  }
  return [Math.round(x), Math.round(y)];
}

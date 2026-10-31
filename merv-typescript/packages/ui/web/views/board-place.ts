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

/** A camera as Excalidraw keeps it: the board's offset in the view, and the zoom. */
export interface Camera {
  scrollX: number;
  scrollY: number;
  zoom: number;
}
/** How far inside the clear part of the view a followed shape stands, on the screen. */
const MARGIN = 48;
/** The zoom at which a place just fits the clear part of the view. */
export const zoomToFit = (place: Rect, clear: Rect) =>
  Math.min(
    (clear.width - 2 * MARGIN) / (place.width || 1),
    (clear.height - 2 * MARGIN) / (place.height || 1),
  );
/**
 * Where the camera stands to show all of a place in the clear part of the view (in screen pixels):
 * this one if it already does, as near as `near` allows or half that; otherwise on it, at the nearest
 * zoom that shows it. Centred, so what comes next is likely still in view and no second move is due.
 */
export function framing(place: Rect, clear: Rect, now: Camera, near = now.zoom): Camera {
  const fit = zoomToFit(place, clear);
  const keeps = now.zoom <= fit && now.zoom * 2 >= Math.min(near, fit);
  const zoom = keeps ? now.zoom : Math.max(0.1, Math.min(near, fit));
  const view = {
    x: (clear.x + MARGIN) / zoom - now.scrollX,
    y: (clear.y + MARGIN) / zoom - now.scrollY,
    width: (clear.width - 2 * MARGIN) / zoom,
    height: (clear.height - 2 * MARGIN) / zoom,
  };
  if (keeps && inView(place, view)) return now;
  return {
    zoom,
    scrollX: (clear.x + clear.width / 2) / zoom - place.x - place.width / 2,
    scrollY: (clear.y + clear.height / 2) / zoom - place.y - place.height / 2,
  };
}

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

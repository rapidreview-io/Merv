/**
 * The view following what agents draw: while the person's hand is off the board, the view changes
 * to take in what is on its way, in one dissolve and only when that would be out of view, and the
 * moment they pan, zoom, draw or select it stops and stays stopped until they ask (the line in
 * board-talk.tsx, or saying something to Pi).
 */
import { CaptureUpdateAction, getCommonBounds, restoreElements } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { BoardElement } from '@merv/board/models';
import { framing, zoomToFit, type Rect } from './board-place';
import { clearView, dissolve } from './board-player';

/** How long a pause still counts as the same drawing, so all of it stays in view together. */
const BURST_MS = 20_000;
/** How far out following zooms to keep a drawing together. */
const LEAST_ZOOM = 0.3;

const rectOf = (shapes: readonly BoardElement[]): Rect => {
  const [x, y, right, bottom] = getCommonBounds(restoreElements(shapes as never, null));
  return { x, y, width: right - x, height: bottom - y };
};

/** The place that holds all of these. */
const union = (rects: Rect[]): Rect => {
  const [x, y] = [Math.min(...rects.map((r) => r.x)), Math.min(...rects.map((r) => r.y))];
  return {
    x,
    y,
    width: Math.max(...rects.map((r) => r.x + r.width)) - x,
    height: Math.max(...rects.map((r) => r.y + r.height)) - y,
  };
};

export class BoardFollow {
  following = true;
  /** The drawing being followed: where what came stands, and when it last did. */
  private burst?: { rects: Rect[]; at: number };
  constructor(
    private api: ExcalidrawImperativeAPI,
    private board: Element,
  ) {}
  /** An agent's shapes are on their way. */
  expect(shapes: readonly BoardElement[]) {
    const coming = shapes.filter((el) => !el.isDeleted);
    if (coming.length) this.take(rectOf(coming));
  }
  /**
   * What the person pointed at or marked: the answer is read beside it, so the view keeps both
   * together, and a mark on an agent's drawing is asking to watch what it does there.
   */
  anchor(place: Rect) {
    this.following = true;
    this.take(place);
  }
  private take(rect: Rect) {
    const now = Date.now();
    const whole = [...this.recent(now), rect];
    // A leap too far to read both ends of together starts a drawing of its own.
    const together = zoomToFit(union(whole), clearView(this.api)) >= LEAST_ZOOM;
    this.burst = { rects: together ? whole : [rect], at: now };
    if (this.following) this.show(union(this.burst.rects));
  }
  /** The person's hand is on the board. */
  release = () => {
    this.following = false;
  };
  /** The person asks to follow again, from what was drawn lately or else from `place`. */
  resume(place?: Rect) {
    this.following = true;
    const recent = this.recent(Date.now());
    const rect = recent.length ? union(recent) : place;
    if (rect) this.show(rect);
  }
  private recent(now: number) {
    return this.burst && now - this.burst.at < BURST_MS ? this.burst.rects : [];
  }
  private show(rect: Rect) {
    const { scrollX, scrollY, zoom } = this.api.getAppState();
    const camera = framing(rect, clearView(this.api), { scrollX, scrollY, zoom: zoom.value });
    if (camera.scrollX === scrollX && camera.scrollY === scrollY && camera.zoom === zoom.value)
      return;
    dissolve(this.board);
    this.api.updateScene({
      appState: { ...camera, zoom: { value: camera.zoom as never } },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }
}

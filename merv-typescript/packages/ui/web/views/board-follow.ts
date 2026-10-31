/**
 * The view following what agents draw: while the person's hand is off the board, the camera eases
 * to take in what is on its way, and the moment they pan, zoom, draw or select it stops and stays
 * stopped until they ask (the line in board-talk.tsx, or saying something to Pi).
 */
import { CaptureUpdateAction, getCommonBounds, restoreElements } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { BoardElement } from '@merv/board/models';
import { cameraFor, zoomToFit, type Camera, type Rect } from './board-place';
import { clearView } from './board-player';

/** How long a pause still counts as the same drawing, so all of it stays in view together. */
const BURST_MS = 20_000;
/** How far out following zooms to keep a drawing together. */
const LEAST_ZOOM = 0.3;
/** How quickly the camera closes on where it is going. */
const EASE_MS = 220;

const cameraOf = (api: ExcalidrawImperativeAPI): Camera => {
  const { scrollX, scrollY, zoom } = api.getAppState();
  return { scrollX, scrollY, zoom: zoom.value };
};

const rectOf = (shapes: readonly BoardElement[]): Rect => {
  const [x, y, right, bottom] = getCommonBounds(restoreElements(shapes as never, null));
  return { x, y, width: right - x, height: bottom - y };
};

export class BoardFollow {
  following = true;
  private frame = 0;
  private goal?: Camera;
  /** The drawing being followed: what came, and when it last did. */
  private burst?: { shapes: BoardElement[]; at: number };
  constructor(private api: ExcalidrawImperativeAPI) {}
  /** An agent's shapes are on their way. */
  expect(shapes: readonly BoardElement[]) {
    const coming = shapes.filter((el) => !el.isDeleted);
    if (!coming.length) return;
    const now = Date.now();
    const whole = [...this.recent(now), ...coming];
    // A leap too far to read both ends of together starts a drawing of its own.
    const together = zoomToFit(rectOf(whole), clearView(this.api)) >= LEAST_ZOOM;
    this.burst = { shapes: together ? whole : coming, at: now };
    if (this.following) this.ease(rectOf(this.burst.shapes));
  }
  /** The person's hand is on the board. */
  release = () => {
    this.following = false;
    this.goal = undefined;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  };
  /** The person asks to follow again, from what was drawn lately or else from `place`. */
  resume(place?: Rect) {
    this.following = true;
    const recent = this.recent(Date.now());
    const rect = recent.length ? rectOf(recent) : place;
    if (rect) this.ease(rect);
  }
  private recent(now: number) {
    return this.burst && now - this.burst.at < BURST_MS ? this.burst.shapes : [];
  }
  private ease(rect: Rect) {
    this.goal = cameraFor(rect, clearView(this.api), cameraOf(this.api));
    if (this.frame) return;
    let last = performance.now();
    const step = (at: number) => {
      const goal = this.goal;
      if (!goal) return;
      const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
      const share = calm ? 1 : 1 - Math.exp(-(at - last) / EASE_MS);
      last = at;
      const now = cameraOf(this.api);
      const near =
        Math.abs(goal.scrollX - now.scrollX) * now.zoom < 0.5 &&
        Math.abs(goal.scrollY - now.scrollY) * now.zoom < 0.5 &&
        Math.abs(goal.zoom - now.zoom) < 0.001;
      const go = (from: number, to: number) => (near ? to : from + (to - from) * share);
      this.api.updateScene({
        appState: {
          scrollX: go(now.scrollX, goal.scrollX),
          scrollY: go(now.scrollY, goal.scrollY),
          zoom: { value: go(now.zoom, goal.zoom) as never },
        },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      this.frame = near || calm ? 0 : requestAnimationFrame(step);
    };
    this.frame = requestAnimationFrame(step);
  }
}

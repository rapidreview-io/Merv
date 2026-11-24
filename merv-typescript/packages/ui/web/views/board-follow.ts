/**
 * The view following what agents draw: while the person's hand is off the board, the view changes
 * to take in what is on its way, in one dissolve and only when that would be out of view, and the
 * moment they pan, zoom, draw or select it waits for their hand to leave the board.
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
  private held = false;
  private touched = false;
  private pending = false;
  private unseen?: Rect;
  private timer?: ReturnType<typeof setTimeout>;
  /** The drawing being followed: where what came stands, and when it last did. */
  private burst?: { rects: Rect[]; at: number };
  /** What was pointed at or marked, kept until the answer's first drawing, however long it takes. */
  private anchored?: Rect;
  constructor(
    private api: ExcalidrawImperativeAPI,
    private board: Element,
    private busy: () => boolean = () => false,
  ) {}
  /** An agent's shapes are on their way. */
  expect(shapes: readonly BoardElement[], standing: readonly Pick<BoardElement, 'id'>[] = []) {
    const known = new Set(standing.map((el) => el.id));
    const coming = shapes.filter(
      (el) => !el.isDeleted && !known.has(el.id) && !known.has(el.containerId as string),
    );
    if (!coming.length) return;
    const { anchored } = this;
    this.anchored = undefined;
    this.take(rectOf(coming), anchored);
  }
  /**
   * What the person pointed at or marked: the answer is read beside it, so the view keeps both
   * together, and a mark on an agent's drawing is asking to watch what it does there.
   */
  anchor(place: Rect) {
    this.following = true;
    this.anchored = place;
  }
  private take(rect: Rect, held?: Rect) {
    const now = Date.now();
    const whole = [...this.recent(now), ...(held ? [held] : []), rect];
    // A leap too far to read both ends of together starts a drawing of its own.
    const together = zoomToFit(union(whole), clearView(this.api)) >= LEAST_ZOOM;
    this.burst = { rects: together ? whole : [rect], at: now };
    if (this.following && !this.held && !this.busy()) this.show(union(this.burst.rects));
    else this.pending = true;
  }
  /** The person's hand is on the board. */
  release = (event?: Event) => {
    this.following = false;
    clearTimeout(this.timer);
    this.touched = !!event;
    if (!event) return;
    if (['pointerdown', 'gesturestart', 'keydown'].includes(event.type)) this.held = true;
    else if (!this.held) this.rest();
  };
  /** A short pause keeps a wheel gesture or a slow pan from fighting the camera. */
  rest = () => {
    if (!this.touched) return;
    this.held = false;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.held) return;
      if (this.busy()) return this.rest();
      this.following = true;
      this.touched = false;
      if (this.pending) this.resume();
      this.pending = false;
    }, 1200);
  };
  /** The person asks to follow again, from what was drawn lately or else from `place`. */
  resume(place?: Rect) {
    this.following = true;
    const recent = this.recent(Date.now());
    const rect = recent.length ? union(recent) : (this.unseen ?? place);
    if (rect) this.show(rect);
  }
  private recent(now: number) {
    return this.burst && now - this.burst.at < BURST_MS ? this.burst.rects : [];
  }
  /** Hidden views keep their destination even after the drawing's burst has ended. */
  visible() {
    if (document.hidden || !this.following || this.held || this.busy() || !this.unseen) return;
    this.show(this.unseen);
  }
  private show(rect: Rect) {
    if (document.hidden) {
      this.unseen = rect;
      return;
    }
    this.unseen = undefined;
    const { scrollX, scrollY, zoom } = this.api.getAppState();
    const clear = clearView(this.api);
    let camera = framing(rect, clear, { scrollX, scrollY, zoom: zoom.value }, zoom.value);
    // The person's zoom is theirs: what will not fit at it is centred, never zoomed out to.
    if (camera.zoom !== zoom.value)
      camera = {
        zoom: zoom.value,
        scrollX: (clear.x + clear.width / 2) / zoom.value - rect.x - rect.width / 2,
        scrollY: (clear.y + clear.height / 2) / zoom.value - rect.y - rect.height / 2,
      };
    if (camera.scrollX === scrollX && camera.scrollY === scrollY && camera.zoom === zoom.value)
      return;
    dissolve(this.board);
    this.api.updateScene({
      appState: { ...camera, zoom: { value: camera.zoom as never } },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }
}

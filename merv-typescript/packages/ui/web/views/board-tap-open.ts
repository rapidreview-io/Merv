/**
 * A phone starts with the palm in hand, so a finger moves the board: then a card a finger only taps (a page card, a
 * link card) still opens, as a click opens it with the cursor. The tap borrows the cursor for as long as the card is
 * open. While it is open, a touch on the board only closes it (it never drags the card), and once it is closed, by its
 * ✕, Escape or that touch, the palm is back in hand, nothing selected. A drag, a pinch or a long press stays the palm's.
 */
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';

/** A tap moves less than this far, in screen pixels, and lifts within this long. */
export const TAP_SLOP = 10;
const TAP_MS = 450;
/** On the page while a tap has a card open: board-app.css hides the selection's own tools then. */
const READING_CLASS = 'board-tap-reading';

type Shape = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle?: number;
  link?: string | null;
  isDeleted?: boolean;
  locked?: boolean;
};
type View = {
  scrollX: number;
  scrollY: number;
  zoom: { value: number };
  offsetLeft: number;
  offsetTop: number;
};
type State = {
  activeTool: { type: string };
  selectedElementIds: Record<string, unknown>;
  showHyperlinkPopup?: false | 'info' | 'editor';
};

/** The topmost matching card (links by default) under a point on the screen: the last drawn wins, as it lies on top. */
export function cardAt(
  shapes: readonly Shape[],
  view: View,
  clientX: number,
  clientY: number,
  accepts = (shape: Shape) => !!shape.link,
): Shape | undefined {
  const x = (clientX - view.offsetLeft) / view.zoom.value - view.scrollX;
  const y = (clientY - view.offsetTop) / view.zoom.value - view.scrollY;
  for (let at = shapes.length - 1; at >= 0; at--) {
    const shape = shapes[at]!;
    if (shape.isDeleted || !accepts(shape)) continue;
    const left = Math.min(shape.x, shape.x + shape.width),
      top = Math.min(shape.y, shape.y + shape.height);
    if (
      x >= left &&
      x <= left + Math.abs(shape.width) &&
      y >= top &&
      y <= top + Math.abs(shape.height)
    )
      return shape;
  }
  return undefined;
}

/** Whether a press was a tap: one finger, barely moved, quickly lifted. */
export const isTap = (
  down: { x: number; y: number; at: number },
  up: { x: number; y: number; at: number },
) => Math.hypot(up.x - down.x, up.y - down.y) < TAP_SLOP && up.at - down.at < TAP_MS;

export function tapOpens(
  api: ExcalidrawImperativeAPI,
  surface: HTMLElement,
  page: HTMLElement = document.documentElement,
): () => void {
  let down: { id: number; x: number; y: number; at: number } | undefined;
  let fingers = 0;
  /** A tap has the cursor; `shown` once its card's reader is open, so only then does a closed reader mean "give it back". */
  let lent = false,
    shown = false;
  /** The finger that closed a card: its release is swallowed too. */
  let closing: number | undefined;
  const onCanvas = (event: Event) => (event.target as Element | null)?.tagName === 'CANVAS';
  const giveBack = () => {
    lent = false;
    shown = false;
    page.classList.remove(READING_CLASS);
    api.updateScene({ appState: { selectedElementIds: {}, showHyperlinkPopup: false } as never });
    api.setActiveTool({ type: 'hand' });
  };
  const press = (event: PointerEvent) => {
    if (event.pointerType === 'mouse') return;
    fingers++;
    // A card is open: this whole touch, down to its release, only closes it. The board never has it, so it can never
    // drag the card, and its release is no tap that opens the card again.
    if (lent && onCanvas(event)) {
      event.stopPropagation();
      giveBack();
      closing = event.pointerId;
      down = undefined;
      return;
    }
    down =
      fingers === 1 && api.getAppState().activeTool.type === 'hand'
        ? { id: event.pointerId, x: event.clientX, y: event.clientY, at: event.timeStamp }
        : undefined;
  };
  const lift = (event: PointerEvent) => {
    if (event.pointerType === 'mouse') return;
    fingers = Math.max(0, fingers - 1);
    if (closing === event.pointerId) {
      closing = undefined;
      down = undefined;
      event.stopPropagation();
      return;
    }
    const was = down;
    down = undefined;
    if (
      !was ||
      was.id !== event.pointerId ||
      !isTap(was, { x: event.clientX, y: event.clientY, at: event.timeStamp })
    )
      return;
    // Only a tap on the canvas itself: never one on a toolbar, a page or the open reader.
    if (!onCanvas(event)) return;
    const card = cardAt(
      api.getSceneElements() as unknown as Shape[],
      api.getAppState() as unknown as View,
      event.clientX,
      event.clientY,
    );
    if (!card) return;
    lent = true;
    shown = false;
    page.classList.add(READING_CLASS);
    api.setActiveTool({ type: 'selection' });
    api.updateScene({
      appState: { selectedElementIds: { [card.id]: true }, showHyperlinkPopup: 'info' } as never,
    });
  };
  // Closed (its reader gone, or nothing selected), the palm is back in hand; the person taking a tool keeps it.
  const off = api.onChange((_, next) => {
    const state = next as unknown as State;
    if (!lent) return;
    if (state.activeTool.type !== 'selection') {
      lent = false;
      shown = false;
      page.classList.remove(READING_CLASS);
      return;
    }
    const open = Object.keys(state.selectedElementIds).length > 0 && !!state.showHyperlinkPopup;
    if (open) shown = true;
    else if (shown) giveBack();
  });
  const cancel = () => {
    fingers = 0;
    down = undefined;
    closing = undefined;
  };
  surface.addEventListener('pointerdown', press, true);
  surface.addEventListener('pointerup', lift, true);
  surface.addEventListener('pointercancel', cancel, true);
  return () => {
    off();
    page.classList.remove(READING_CLASS);
    surface.removeEventListener('pointerdown', press, true);
    surface.removeEventListener('pointerup', lift, true);
    surface.removeEventListener('pointercancel', cancel, true);
  };
}

/**
 * Where agents are on a board, shown as Excalidraw shows a collaborator: a small named cursor that
 * slides to the middle of what an agent last looked at or drew, rides the pen's tip while a stroke
 * of its own is traced, dims and goes when nothing has been heard of it for a while. A collaborator
 * is the page's own view state, so a cursor is never saved, changes no version and enters no undo.
 */
import { CaptureUpdateAction } from '@excalidraw/excalidraw';
import type { Collaborator, ExcalidrawImperativeAPI, SocketId } from '@excalidraw/excalidraw/types';
import type { BoardLooking } from '@merv/board/models';

/** How long a cursor stands after the last it was heard of, and when in that it dims. */
const [GONE_MS, DIM_MS] = [20_000, 16_000];
const TICK_MS = 50;
/** The share of the way a sliding cursor moves each tick. */
const SLIDE = 0.25;
/**
 * Excalidraw colours a collaborator by a hash of this id and nothing else; this one comes out the
 * pale blue of the board's own palette, whichever agent it is.
 */
const BLUE = 'agent22';
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

interface Cursor extends BoardLooking {
  x: number;
  y: number;
  toX: number;
  toY: number;
  /** When it was last heard of, on this page's clock. */
  heardAt: number;
}

export class BoardPresence {
  private cursors = new Map<string, Cursor>();
  private ticking?: ReturnType<typeof setInterval>;
  private shown = '';
  constructor(private api: ExcalidrawImperativeAPI) {}
  /** What the page was just told of where agents are. */
  heard(looking: BoardLooking[]) {
    for (const where of looking) {
      const key = `${where.actor}:${where.name}`;
      const held = this.cursors.get(key);
      if (held?.at === where.at) continue;
      const toX = where.region.x + where.region.width / 2;
      const toY = where.region.y + where.region.height / 2;
      this.cursors.set(key, {
        ...where,
        toX,
        toY,
        x: held?.x ?? toX,
        y: held?.y ?? toY,
        heardAt: Date.now(),
      });
    }
    this.ticking ??= setInterval(this.tick, TICK_MS);
    this.tick();
  }
  /** The pen's tip: the cursor of the agent last drawing around it rides it. */
  pen = (tip: [number, number] | null) => {
    if (!tip) return;
    const [x, y] = tip;
    const rider = [...this.cursors.values()]
      .filter(({ drew, region: r }) => {
        const room = 40;
        return (
          drew &&
          x > r.x - room &&
          x < r.x + r.width + room &&
          y > r.y - room &&
          y < r.y + r.height + room
        );
      })
      .sort((a, b) => b.at - a.at)[0];
    if (rider) Object.assign(rider, { x, y, toX: x, toY: y, heardAt: Date.now() });
  };
  private tick = () => {
    const now = Date.now();
    const shown = new Map<SocketId, Collaborator>();
    for (const [key, cursor] of this.cursors) {
      if (now - cursor.heardAt > GONE_MS) {
        this.cursors.delete(key);
        continue;
      }
      const step = calm() ? 1 : SLIDE;
      cursor.x += (cursor.toX - cursor.x) * step;
      cursor.y += (cursor.toY - cursor.y) * step;
      shown.set(key as SocketId, {
        id: BLUE,
        username: cursor.name,
        button: 'up',
        pointer: { x: cursor.x, y: cursor.y, tool: 'pointer' },
        // The one fainter state Excalidraw draws a cursor in.
        userState: (now - cursor.heardAt > DIM_MS ? 'idle' : 'active') as never,
      });
    }
    const state = JSON.stringify(
      [...shown].map(([, { pointer, username, userState }]) => [
        Math.round(pointer!.x),
        Math.round(pointer!.y),
        username,
        userState,
      ]),
    );
    if (state !== this.shown) {
      this.shown = state;
      this.api.updateScene({ collaborators: shown, captureUpdate: CaptureUpdateAction.NEVER });
    }
    if (!this.cursors.size) {
      clearInterval(this.ticking);
      this.ticking = undefined;
    }
  };
  stop() {
    clearInterval(this.ticking);
    this.ticking = undefined;
    this.cursors.clear();
  }
}

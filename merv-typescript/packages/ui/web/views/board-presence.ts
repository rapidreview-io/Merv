/**
 * Where agents are on a board, shown as Excalidraw shows a collaborator: a small named cursor that
 * slides to the middle of what an agent last looked at or drew, rides the pen's tip while a stroke
 * of its own is drawn and across its lifts, dims and goes when nothing has been heard of it for a while. A collaborator
 * is the page's own view state, so a cursor is never saved, changes no version and enters no undo.
 * It also keeps who last drew, for the line that says so (board-talk.tsx).
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
/** How long after it was heard of an agent is still looking, or what comes is still what it drew. */
const LOOK_MS = 5_000;
/** How long a line stands as what the one drawing is saying, about as long as it takes to say. */
const LINE_MS = 8_000;
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
  private drawn = { at: 0, name: '' };
  private line = { at: 0, words: '' };
  constructor(private api: ExcalidrawImperativeAPI) {}
  private latest() {
    return [...this.cursors.values()].sort((a, b) => b.at - a.at)[0];
  }
  /**
   * Shapes came: an agent heard of just now is named for them, and it answers true. Whether that
   * agent's last word was a look says nothing, since agents look at what they just drew.
   */
  drew() {
    const now = Date.now();
    const cursor = this.latest();
    if (!cursor || now - cursor.heardAt > LOOK_MS) return false;
    this.drawn = { at: now, name: cursor.name };
    return true;
  }
  /** The pen reached a line an agent said with what it drew. */
  said(words: string) {
    this.line = { at: Date.now(), words };
  }
  /** Who is at the board and how long ago they drew; where the one last heard of is. */
  doing(now = Date.now()) {
    const cursor = this.latest();
    return {
      name: this.drawn.at ? this.drawn.name : (cursor?.name ?? ''),
      drewMs: this.drawn.at ? now - this.drawn.at : Infinity,
      looking: !!cursor && !cursor.drew && now - cursor.heardAt < LOOK_MS ? cursor.name : '',
      region: cursor?.region,
      saying: now - this.line.at < LINE_MS ? this.line.words : undefined,
    };
  }
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
  /** The pen's tip: the cursor of the agent last drawing around it, else of the last to draw, rides it. */
  pen = (tip: [number, number] | null) => {
    if (!tip) return;
    const [x, y] = tip;
    const room = 40;
    const drawing = [...this.cursors.values()]
      .filter(({ drew }) => drew)
      .sort((a, b) => b.at - a.at);
    const rider =
      drawing.find(
        ({ region: r }) =>
          x > r.x - room && x < r.x + r.width + room && y > r.y - room && y < r.y + r.height + room,
      ) ?? drawing[0];
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

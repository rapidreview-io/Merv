/**
 * What the person is pointing at on a board, to go with what they say to Pi: what is selected,
 * where the pointer last rested and the shape nearest it, and the shapes inside any closed stroke
 * they just drew. It rides beside their words as a note in ids and numbers (pi-transport), never in
 * them, and a circle is a guess, which the guide tells the agent.
 */
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';

type Shape = {
  id: string;
  type: string;
  isDeleted?: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  points?: readonly (readonly [number, number])[];
  groupIds?: readonly string[];
  containerId?: string | null;
  customData?: { card?: boolean; target?: unknown };
  updated?: number;
  angle?: number;
};
type Spot = { x: number; y: number };

/** How long a just-drawn circle counts, and a resting pointer; a rest is this long a stop. */
const [CIRCLE_MS, POINTER_MS, REST_MS] = [20_000, 120_000, 300];
/** How far from a shape the pointer is still near it, on the screen. */
const NEAR_PX = 120;
/** The most shapes a list names, and what an id must be to be named: the note is ids, not words. */
const MOST = 12;
const NAMEABLE = /^[\w-]{1,40}$/;

const boxOf = (el: Shape) => {
  if (!el.points?.length) return { x: el.x, y: el.y, width: el.width, height: el.height };
  const [xs, ys] = [el.points.map((p) => el.x + p[0]), el.points.map((p) => el.y + p[1])];
  const [x, y] = [Math.min(...xs), Math.min(...ys)];
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
};
/** Where a spot on the board falls in a shape's own frame, the shape turned back about its middle. */
const unturned = (spot: Spot, box: ReturnType<typeof boxOf>, angle = 0): Spot => {
  const [cx, cy] = [box.x + box.width / 2, box.y + box.height / 2];
  const [dx, dy, cos, sin] = [spot.x - cx, spot.y - cy, Math.cos(angle), Math.sin(angle)];
  return { x: cx + dx * cos + dy * sin, y: cy - dx * sin + dy * cos };
};
/** A freehand stroke that comes back near where it began, around something of a size. */
const closed = ({ type, points }: Shape) => {
  if (type !== 'freedraw' || !points || points.length < 8) return false;
  const [xs, ys] = [points.map((p) => p[0]), points.map((p) => p[1])];
  const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const [first, last] = [points[0]!, points.at(-1)!];
  return size >= 30 && Math.hypot(last[0] - first[0], last[1] - first[1]) <= size * 0.3;
};
/** Whether a spot on the board is inside a stroke's outline. */
const within = (at: Spot, stroke: Shape) => {
  const { x, y, points } = stroke;
  const spot = unturned(at, boxOf(stroke), stroke.angle);
  let inside = false;
  for (const [i, a] of points!.entries()) {
    const b = points!.at(i - 1)!;
    const [ax, ay, bx, by] = [x + a[0], y + a[1], x + b[0], y + b[1]];
    if (ay > spot.y !== by > spot.y && spot.x < ax + ((spot.y - ay) / (by - ay)) * (bx - ax))
      inside = !inside;
  }
  return inside;
};

/** The note for this moment of a board: `[board b: selected …; pointer at (x,y) near …; circled …]`. */
export function pointingNote(input: {
  board: string;
  shapes: readonly Shape[];
  selected: Readonly<Record<string, boolean>>;
  pointer?: Spot;
  /** Board units within which the pointer is near a shape. */
  reach: number;
  /** Shapes whose closed strokes are not this person's new circles. */
  others: ReadonlySet<string>;
  now: number;
  /** The passage selected in an outcome: `outcome o chars a-b`. */
  passage?: string;
}) {
  const live = input.shapes.filter((el) => !el.isDeleted);
  const byId = new Map(live.map((el) => [el.id, el]));
  const cards = new Map(
    live.flatMap((el) =>
      el.customData?.target !== undefined && el.groupIds?.[0] ? [[el.groupIds[0], el.id]] : [],
    ) as [string, string][],
  );
  /** What board.read calls a shape: a label is its box, a card's part its card, a grouped one its group. */
  const named = (el: Shape): string => {
    if (el.containerId && byId.has(el.containerId)) return named(byId.get(el.containerId)!);
    const group = el.groupIds?.at(-1);
    return group ? (cards.get(group) ?? group) : el.id;
  };
  const list = (shapes: Shape[]) => {
    const names = [...new Set(shapes.map(named))].filter((name) => NAMEABLE.test(name));
    const rest = names.length - MOST;
    return names.slice(0, MOST).join(',') + (rest > 0 ? `,+${rest} more` : '');
  };
  const said: string[] = [];
  const selected = list(live.filter((el) => input.selected[el.id]));
  if (selected) said.push(`selected ${selected}`);
  const circles = live.filter(
    (el) => !input.others.has(el.id) && input.now - (el.updated ?? 0) < CIRCLE_MS && closed(el),
  );
  const others = live.filter((el) => !circles.includes(el));
  // Past this a number is no longer written in plain digits, which the note must be.
  if (input.pointer && Math.max(Math.abs(input.pointer.x), Math.abs(input.pointer.y)) < 1e15) {
    const { x, y } = input.pointer;
    const near = others
      .map((el) => {
        const box = boxOf(el);
        const spot = unturned(input.pointer!, box, el.angle);
        const away = Math.hypot(
          Math.max(box.x - spot.x, 0, spot.x - box.x - box.width),
          Math.max(box.y - spot.y, 0, spot.y - box.y - box.height),
        );
        return { el, away, area: box.width * box.height };
      })
      .filter(({ away }) => away <= input.reach)
      .sort((a, b) => a.away - b.away || a.area - b.area)[0]?.el;
    const name = near && list([near]);
    said.push(`pointer at (${Math.round(x)},${Math.round(y)})${name ? ` near ${name}` : ''}`);
  }
  const circled = others.filter((el) =>
    circles.some((circle) => {
      const box = boxOf(el);
      return within({ x: box.x + box.width / 2, y: box.y + box.height / 2 }, circle);
    }),
  );
  const inside = list(circled);
  if (inside) said.push(`circled ${inside}`);
  if (input.passage) said.push(input.passage);
  return `[board ${input.board}${said.length ? `: ${said.join('; ')}` : ''}]`;
}

/** The passage selected in the outcome open beside the board, which goes along in the same note. */
type Passage = { note(): string | undefined; said(): void };
let passage: Passage | undefined;
export const pointPassage = (hand: Passage | undefined) => {
  passage = hand;
};

/** Excalidraw hears nothing of a pointer that has left its canvas, so it is asked. */
const onCanvas = () => !!document.querySelector('.excalidraw__canvas.interactive:hover');

/** A board page's hand: where its pointer rests, and what it has already said or others drew. */
export class BoardPointing {
  private rest?: Spot & { at: number };
  private resting?: ReturnType<typeof setTimeout>;
  /** Strokes that are nobody's fresh circle: others drew them, or a message already went after. */
  private others = new Set<string>();
  /** The shapes the last note was made from. */
  private noted: readonly Shape[] = [];
  constructor(
    private api: ExcalidrawImperativeAPI,
    private board: string,
  ) {}
  /** A stop, not a pass: on the way to the composer the pointer crosses the board without one. */
  moved({ x, y }: Spot, button: 'up' | 'down') {
    clearTimeout(this.resting);
    const stop = () => (this.rest = { x, y, at: Date.now() });
    if (button === 'down') return stop();
    this.resting = setTimeout(() => onCanvas() && stop(), REST_MS);
  }
  landed(shapes: readonly { id: string; type: string }[]) {
    for (const { id, type } of shapes) if (type === 'freedraw') this.others.add(id);
  }
  note = () => {
    const { selectedElementIds, zoom } = this.api.getAppState();
    const now = Date.now();
    this.noted = this.api.getSceneElements() as readonly Shape[];
    return pointingNote({
      board: this.board,
      shapes: this.noted,
      selected: selectedElementIds,
      ...(this.rest && now - this.rest.at < POINTER_MS && { pointer: this.rest }),
      reach: NEAR_PX / zoom.value,
      others: this.others,
      now,
      ...(passage?.note() && { passage: passage.note() }),
    });
  };
  /** Said once: a circle goes with one message, and so does a pointer the hand has since left. */
  said = () => {
    const standing = new Set(this.api.getSceneElements().map((el) => el.id));
    this.others = new Set([...this.others].filter((id) => standing.has(id)));
    this.landed(this.noted);
    if (!onCanvas()) this.rest = undefined;
    passage?.said();
  };
  stop() {
    clearTimeout(this.resting);
  }
}

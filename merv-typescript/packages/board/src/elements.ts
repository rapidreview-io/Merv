/**
 * An agent's operations as Excalidraw shapes. The agent names what to draw and where it goes
 * relative to what is there (beside a shape, inside a frame, or the next free place); Board works
 * out every coordinate, binds arrows to the shapes they join and sizes text roughly, which the
 * page measures exactly when it draws. Nothing here reads outside the board.
 */
import { randomBytes } from 'node:crypto';
import { clip, MervError } from '@merv/contracts';
import { COLORS, INKS, PAINTS, paint, type DrawOp } from './input.js';
import { strokesOf } from './path.js';
import type { BoardElement } from './types.js';

type El = BoardElement & Record<string, any>;
type Rect = { x: number; y: number; width: number; height: number };
const GAP = 40;
/** The most places tried inside a frame before it grows to take a shape. */
const SPOTS = 10_000;
const FONT = 20;
const LINE = 1.25;
/** Roughly how wide a character of the hand-drawn font is, for a font size of one. */
const CHAR = 0.65;
/** What Excalidraw binds an arrow's end to. */
const BINDABLE = new Set(['rectangle', 'ellipse', 'diamond', 'text', 'frame']);
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** The whole fractional index after `key`'s, as Excalidraw steps one: … Zz, a0 … az, b00 … */
function after(key: string): string | undefined {
  if (/^[A-Z]/.test(key)) return 'a0';
  const size = key.charCodeAt(0) - 95;
  const digits = [...key.slice(1, size)].map((digit) => DIGITS.indexOf(digit));
  if (!/^[a-z]/.test(key) || digits.length !== size - 1 || digits.includes(-1)) return undefined;
  for (let i = digits.length - 1; i >= 0; i--)
    if (digits[i]! < DIGITS.length - 1)
      return key[0] + digits.map((d, j) => DIGITS[j < i ? d : j === i ? d + 1 : 0]).join('');
  return key[0] === 'z' ? undefined : String.fromCharCode(key.charCodeAt(0) + 1) + '0'.repeat(size);
}

const elementId = () => randomBytes(15).toString('base64url');
const nonce = () => randomBytes(4).readUInt32BE() >>> 1;

/** Text broken into lines of at most `chars` (at least 8) characters, at spaces where it can be. */
function wrap(text: string, chars: number): string {
  chars = Math.max(8, chars);
  return text
    .split('\n')
    .flatMap((paragraph) => {
      const lines: string[] = [];
      let line = '';
      for (const word of paragraph.split(/\s+/)) {
        for (let rest = word; rest;) {
          const room = chars - (line ? line.length + 1 : 0);
          if (rest.length <= room) {
            line = line ? `${line} ${rest}` : rest;
            rest = '';
          } else if (line) {
            lines.push(line);
            line = '';
          } else {
            // Cut on a whole character: half an emoji is text no page can save back.
            const head = clip(rest, chars);
            lines.push(head);
            rest = rest.slice(head.length);
          }
        }
      }
      return [...lines, line];
    })
    .join('\n');
}
const measure = (text: string, size: number) => {
  const lines = text.split('\n');
  return {
    width: Math.ceil(Math.max(...lines.map((line) => line.length), 1) * size * CHAR),
    height: Math.ceil(lines.length * size * LINE),
  };
};
const overlaps = (a: Rect, b: Rect, margin = 20) =>
  a.x < b.x + b.width + margin &&
  b.x < a.x + a.width + margin &&
  a.y < b.y + b.height + margin &&
  b.y < a.y + a.height + margin;
const center = (r: Rect) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
/** Where the line from a shape's centre toward `to` leaves its box. */
export function shapeEdge(r: Rect & { type?: string }, to: { x: number; y: number }) {
  const c = center(r);
  const dx = to.x - c.x;
  const dy = to.y - c.y;
  const nx = Math.abs(dx) / Math.max(0.5, r.width / 2),
    ny = Math.abs(dy) / Math.max(0.5, r.height / 2);
  const t =
    r.type === 'diamond'
      ? 1 / (nx + ny)
      : r.type === 'ellipse'
        ? 1 / Math.hypot(nx, ny)
        : 1 / Math.max(nx, ny);
  return Number.isFinite(t) ? { x: c.x + dx * t, y: c.y + dy * t } : c;
}

/** One call's drawing: the shapes it is handed (now its own), what it changed, the keys it gave. */
export class Drawing {
  readonly elements = new Map<string, El>();
  readonly changed = new Set<string>();
  readonly created: Record<string, string> = {};
  /** Where shapes stand, frames apart: a shape goes beside another inside a frame. */
  private occupied: Rect[] = [];
  private frames: Rect[] = [];
  private cursor: { x: number; y: number; startX: number; rowBottom: number; inRow: number };
  /** The last fractional index given out ('' when no shape has one). */
  private top: string | undefined;

  constructor(
    existing: BoardElement[],
    private readonly agent: boolean,
  ) {
    for (const element of existing) this.elements.set(element.id, element as El);
    this.survey();
    this.rebind();
    const box = bounds([...this.occupied, ...this.frames]);
    const x = box ? box.x + box.width + 120 : 0;
    const y = box ? box.y : 0;
    this.cursor = { x, y, startX: x, rowBottom: y, inRow: 0 };
  }
  /**
   * Text that names a shape as its container the shape no longer lists is a label that came loose
   * (a page that merged half a change): it is bound again, or, where the shape has text of its
   * own, taken away, so no box shows nothing while its words lie elsewhere.
   */
  private rebind() {
    for (const text of this.live().filter((el) => el.type === 'text' && el.containerId)) {
      const box = this.elements.get(text.containerId);
      const bound: { type: string; id: string }[] = box?.boundElements ?? [];
      // A label stacked under its own box (a page that took another order) is hidden by it.
      if (box && !box.isDeleted && String(text.index ?? '') <= String(box.index ?? '')) {
        text.index = this.index();
        this.touch(text);
      }
      if (bound.some((b) => b.id === text.id)) continue;
      if (!box || box.isDeleted) {
        text.containerId = null;
        this.touch(text);
      } else if (bound.some((b) => b.type === 'text' && !this.elements.get(b.id)?.isDeleted))
        this.remove(text);
      else {
        box.boundElements = [...bound, { type: 'text', id: text.id }];
        centre(text, box);
        this.touch(box);
        this.touch(text);
      }
    }
  }
  private live() {
    return [...this.elements.values()].filter((el) => !el.isDeleted);
  }
  private survey(except: ReadonlySet<El> = new Set()) {
    const standing = this.live().filter(
      (el) => !el.containerId && el.type !== 'arrow' && !except.has(el),
    );
    this.occupied = standing.filter((el) => el.type !== 'frame').map(rectOf);
    this.frames = standing.filter((el) => el.type === 'frame').map(rect);
  }
  /** A fractional index after every shape the board has, so what is drawn stands on top. */
  private index(): string {
    this.top ??=
      this.live()
        .flatMap((el) => (typeof el.index === 'string' ? [el.index] : []))
        .sort()
        .at(-1) ?? '';
    // Stepped, keys stay short however often a board is drawn on; one that cannot be stepped,
    // which Excalidraw re-ranks anyway, is followed by a longer one.
    return (this.top = (this.top ? after(this.top) : 'a0') ?? `${this.top}V`);
  }
  /** A shape this call keyed, or one already on the board; anything else is refused by name. */
  private group(ref: string, includeDeleted = false): El[] {
    const id = this.created[ref] ?? ref;
    if (this.elements.has(id)) return []; // Explicit element IDs always address one element.
    const members = [...this.elements.values()].filter(
      (e) => (includeDeleted || !e.isDeleted) && e.groupIds?.includes(id),
    );
    const owners = new Set(members.map((e) => e.id));
    const labels = [...this.elements.values()].filter(
      (e) => (includeDeleted || !e.isDeleted) && e.type === 'text' && owners.has(e.containerId),
    );
    return [...new Set([...members, ...labels])];
  }
  private members(ref: string): El[] {
    const group = this.group(ref);
    if (group.length) return group;
    const el = this.find(ref);
    return [el, ...this.carried(el)];
  }
  find(ref: string): El {
    if (this.group(ref).length)
      throw new MervError(
        'board_group_operation',
        'This is a group handle. Use move, delete, frame holds, near, or board.look focus; edit and arrow require an individual element ID.',
        400,
      );
    const element = this.elements.get(this.created[ref] ?? ref);
    if (!element || element.isDeleted)
      throw new MervError('board_shape_not_found', `No shape "${ref}" on this board`, 400);
    return element;
  }
  private touch(el: El) {
    el.version += 1;
    el.versionNonce = nonce();
    el.updated = Date.now();
    this.changed.add(el.id);
  }
  private add(type: string, at: Rect, fields: Record<string, unknown> = {}): El {
    const el: El = {
      id: elementId(),
      type,
      ...at,
      angle: 0,
      strokeColor: '#1e1e1e',
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      strokeWidth: 2,
      strokeStyle: 'solid',
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      index: this.index(),
      roundness: null,
      seed: nonce(),
      version: 1,
      versionNonce: nonce(),
      isDeleted: false,
      boundElements: null,
      updated: Date.now(),
      link: null,
      locked: false,
      ...(this.agent ? { customData: { by: 'agent' } } : {}),
      ...fields,
    };
    this.elements.set(el.id, el);
    this.changed.add(el.id);
    return el;
  }
  private bind(container: El, kind: 'text' | 'arrow', id: string) {
    container.boundElements = [...(container.boundElements ?? []), { type: kind, id }];
    if (!this.changed.has(container.id) || container.version > 1) this.touch(container);
  }
  private text(at: Rect, content: string, size: number, fields: Record<string, unknown> = {}) {
    return this.add('text', at, {
      text: content,
      originalText: content,
      fontSize: size,
      fontFamily: 5,
      textAlign: 'left',
      verticalAlign: 'top',
      containerId: null,
      autoResize: true,
      lineHeight: LINE,
      ...fields,
    });
  }
  /** Text centred in a shape, bound to it so it moves and wraps with it. */
  private label(container: El, content: string, size = FONT) {
    const wrapped =
      container.type === 'arrow'
        ? content
        : wrap(
            content,
            Math.floor(
              this.innerWidth(container.type, container.width) /
                (size * this.labelCharWidth(content)),
            ),
          );
    const text = this.text({ x: 0, y: 0, ...measure(wrapped, size) }, wrapped, size, {
      originalText: content,
      textAlign: 'center',
      verticalAlign: 'middle',
      containerId: container.id,
      frameId: container.frameId,
    });
    centre(text, container);
    this.bind(container, 'text', text.id);
    return text;
  }
  /** Text bounds follow Excalidraw's shape-specific safe interior, with conservative padding. */
  private labelCharWidth(content: string) {
    return /[MW@#%]/u.test(content) ? 1 : CHAR;
  }
  private innerWidth(kind: string, width: number) {
    return Math.max(
      40,
      Math.round(width * (kind === 'diamond' ? 0.5 : kind === 'ellipse' ? Math.SQRT1_2 : 1)) - 10,
    );
  }
  private fit(content: string, width: number, minHeight: number, kind = 'rectangle') {
    const lines = wrap(
      content,
      Math.floor(this.innerWidth(kind, width) / (FONT * this.labelCharWidth(content))),
    );
    const factor = kind === 'diamond' ? 0.5 : kind === 'ellipse' ? Math.SQRT1_2 : 1;
    return {
      width,
      height: Math.max(minHeight, Math.ceil((measure(lines, FONT).height + 40) / factor)),
    };
  }

  /**
   * Whether a spot of this size overlaps a standing shape as `overlaps` judges it, asking only the
   * shapes filed under the cells the spot meets. A cell is at least the spot's size, so a spot
   * meets at most four; a shape is filed with a GAP of room, more than the margin, and one that
   * would meet more than nine cells is filed under `all`, which every spot asks.
   */
  private taken(size: { width: number; height: number }) {
    const side = Math.max(200, Math.abs(size.width), Math.abs(size.height));
    const cellsOf = (r: Rect, pad: number) => {
      const [x0, x1, y0, y1] = [
        Math.min(r.x, r.x + r.width) - pad,
        Math.max(r.x, r.x + r.width) + pad,
        Math.min(r.y, r.y + r.height) - pad,
        Math.max(r.y, r.y + r.height) + pad,
      ].map((at) => Math.floor(at / side)) as [number, number, number, number];
      const keys: string[] = [];
      // Counted, not stepped: past 2^53 a cell number plus one is the same number.
      if ((x1 - x0 + 1) * (y1 - y0 + 1) <= 9)
        for (let i = 0; i <= x1 - x0; i++)
          for (let j = 0; j <= y1 - y0; j++) keys.push(`${x0 + i},${y0 + j}`);
      return keys;
    };
    const cells = new Map<string, Rect[]>();
    for (const o of this.occupied) {
      const keys = cellsOf(o, GAP);
      for (const key of keys.length ? keys : ['all'])
        (cells.get(key) ?? cells.set(key, []).get(key)!).push(o);
    }
    return (r: Rect) =>
      [...cellsOf(r, 0), 'all'].some((key) => !!cells.get(key)?.some((o) => overlaps(o, r)));
  }
  /**
   * Where a new shape of this size goes: at the place the operation names (`at`, the top-left
   * corner in board coordinates, as board.read reports them), in a frame, as near a shape as
   * there is room (on its `side` if one is asked), or in the next free place.
   */
  private place(
    size: { width: number; height: number },
    where: Where = {},
  ): Rect & { frameId: string | null } {
    const { near, in: into, side } = where;
    // Only the size: a shape that is moved brings its old place along, which must not stand.
    size = { width: size.width, height: size.height };
    let at: Rect | undefined;
    let frameId: string | null = null;
    if (where.at) {
      at = { x: where.at[0], y: where.at[1], ...size };
      frameId = into ? this.find(into).id : null;
    } else if (into) {
      const frame = this.find(into);
      if (frame.type !== 'frame')
        throw new MervError('board_not_a_frame', `"${into}" is not a frame`, 400);
      frameId = frame.id;
      const inside = this.occupied.filter((r) => contains(frame, r));
      // A frame too vast to walk, or so far out that a step of GAP moves nothing, grows instead.
      const [right, bottom] = [frame.x + frame.width - 20, frame.y + frame.height - 20];
      for (let y = frame.y + 60, n = 0; !at && n < SPOTS && y + size.height <= bottom; y += GAP)
        for (let x = frame.x + 30; n++ < SPOTS && x + size.width <= right; x += GAP) {
          const r = { x, y, ...size };
          if (!inside.some((o) => overlaps(o, r))) {
            at = r;
            break;
          }
        }
      if (!at) {
        // A full frame grows down to take it.
        at = { x: frame.x + 30, y: frame.y + frame.height, ...size };
        frame.height += size.height + GAP;
        frame.width = Math.max(frame.width, size.width + 60);
        this.touch(frame);
      }
    } else if (near) {
      const group = this.group(near);
      const target = group[0] ?? this.find(near);
      const t = group.length ? bounds(group.map(rectOf))! : rectOf(target);
      const mid = {
        x: t.x + t.width / 2 - size.width / 2,
        y: t.y + t.height / 2 - size.height / 2,
      };
      const beside = {
        right: { x: t.x + t.width + GAP, y: mid.y },
        below: { x: mid.x, y: t.y + t.height + GAP },
        left: { x: t.x - GAP - size.width, y: mid.y },
        above: { x: mid.x, y: t.y - GAP - size.height },
      };
      const sides = [...new Set([side ?? 'right', 'right', 'below', 'left', 'above'] as const)];
      const taken = this.taken(size);
      // Outward from the shape ring by ring, its asked side first: the nearest room there is.
      for (let ring = 0; !at && ring <= 25; ring++)
        for (const name of sides) {
          const from = beside[name];
          const spots: { x: number; y: number }[] = [];
          for (let dx = -ring; dx <= ring; dx++)
            for (let dy = -ring; dy <= ring; dy++)
              if (Math.max(Math.abs(dx), Math.abs(dy)) === ring)
                spots.push({ x: from.x + dx * GAP, y: from.y + dy * GAP });
          spots.sort(
            (a, b) =>
              Math.hypot(a.x - from.x, a.y - from.y) - Math.hypot(b.x - from.x, b.y - from.y),
          );
          const free = spots.find((spot) => !taken({ ...spot, ...size }));
          if (free) {
            at = { ...free, ...size };
            break;
          }
        }
      at ??= { ...beside[side ?? 'right'], ...size };
      // It joins the frame only inside it: Excalidraw cuts members, a sketch wholly, at its edge.
      const frame = this.elements.get(target.frameId);
      frameId = frame && contains(frame, at) ? frame.id : null;
    } else {
      const c = this.cursor;
      for (let tries = 0; !at; tries++) {
        const r = { x: c.x, y: c.y, ...size };
        if (tries > 400 || ![...this.occupied, ...this.frames].some((o) => overlaps(o, r))) at = r;
        else c.y += GAP;
      }
      c.rowBottom = Math.max(c.rowBottom, at.y + at.height);
      c.inRow += 1;
      if (c.inRow === 4) Object.assign(c, { x: c.startX, y: c.rowBottom + 2 * GAP, inRow: 0 });
      else c.x = at.x + at.width + GAP;
    }
    // Past the largest number a place is Infinity, which a stored shape would keep as null.
    if (![at.x, at.y].every(Number.isFinite))
      throw new MervError('board_out_of_range', 'No finite place is left; use at', 400);
    this.occupied.push(at);
    return { ...at, frameId };
  }
  private shape(
    kind: 'rectangle' | 'ellipse' | 'diamond',
    content: string,
    size: { width: number; height: number },
    where: Where,
    fields: Record<string, unknown> = {},
  ) {
    const at = this.place(size, where);
    const el = this.add(kind, at, {
      frameId: at.frameId,
      customData: { ...(this.agent && { by: 'agent' }), semanticKind: 'box' },
      strokeColor:
        fields.backgroundColor && fields.backgroundColor !== 'transparent'
          ? 'transparent'
          : '#868e96',
      roundness: kind === 'rectangle' ? { type: 3 } : kind === 'diamond' ? { type: 2 } : null,
      ...fields,
    });
    if (content) this.label(el, content);
    return el;
  }
  /**
   * An arrow drawn again between its ends: each end on a shape it is bound to meets that shape's
   * edge, and an end bound to nothing (Excalidraw binds no pen stroke) stays where it was.
   */
  private route(arrow: El, ends: { from?: El; to?: El } = {}) {
    const from = ends.from ?? this.elements.get(arrow.startBinding?.elementId);
    const to = ends.to ?? this.elements.get(arrow.endBinding?.elementId);
    const points = (arrow.points ?? []) as [number, number][];
    const free = {
      start: { x: arrow.x + (points[0]?.[0] ?? 0), y: arrow.y + (points[0]?.[1] ?? 0) },
      end: { x: arrow.x + (points.at(-1)?.[0] ?? 0), y: arrow.y + (points.at(-1)?.[1] ?? 0) },
    };
    if (!from && !to) return;
    const start = from
      ? shapeEdge({ ...rectOf(from), type: from.type }, to ? center(rectOf(to)) : free.end)
      : free.start;
    const end = to
      ? shapeEdge({ ...rectOf(to), type: to.type }, from ? center(rectOf(from)) : free.start)
      : free.end;
    Object.assign(arrow, {
      x: start.x,
      y: start.y,
      points: [
        [0, 0],
        [end.x - start.x, end.y - start.y],
      ],
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y),
    });
    for (const bound of arrow.boundElements ?? []) {
      const text = this.elements.get(bound.id);
      if (text) centre(text, arrow);
    }
  }
  /** Variable-size layers; center each branch band and reserve space for edge labels. */
  private flowFitted(op: Extract<DrawOp, { op: 'flow' }>) {
    const down = op.direction === 'down';
    const depth = layers(
      op.nodes.map((n) => n.key),
      op.edges,
    );
    const groups = new Map<number, typeof op.nodes>();
    for (const node of op.nodes) {
      const d = depth.get(node.key)!;
      groups.set(d, [...(groups.get(d) ?? []), node]);
    }
    const dims = new Map(
      op.nodes.map((n) => [
        n.key,
        this.fit(
          n.text,
          n.shape && n.shape !== 'rectangle' ? 260 : 220,
          n.shape && n.shape !== 'rectangle' ? 120 : 80,
          n.shape ?? 'rectangle',
        ),
      ]),
    );
    const labelGap = Math.max(
      80,
      ...op.edges.map((e) =>
        e.label ? measure(e.label, FONT)[down ? 'height' : 'width'] + 60 : 80,
      ),
    );
    const crossGap = 70;
    const axes = [...groups.keys()].sort((a, b) => a - b);
    const crossSize = (nodes: typeof op.nodes) =>
      nodes.reduce((n, node) => n + dims.get(node.key)![down ? 'width' : 'height'], 0) +
      Math.max(0, nodes.length - 1) * crossGap;
    const widest = Math.max(...[...groups.values()].map(crossSize));
    const mainSize = (nodes: typeof op.nodes) =>
      Math.max(...nodes.map((n) => dims.get(n.key)![down ? 'height' : 'width']));
    const length =
      axes.reduce((sum, d) => sum + mainSize(groups.get(d)!), 0) +
      Math.max(0, axes.length - 1) * labelGap;
    const area = this.place(
      down ? { width: widest, height: length } : { width: length, height: widest },
      op,
    );
    let main = 0;
    for (const d of axes) {
      const nodes = groups.get(d)!;
      const extent = mainSize(nodes);
      let cross = (widest - crossSize(nodes)) / 2;
      for (const node of nodes) {
        const size = dims.get(node.key)!;
        const mainOffset = main + (extent - size[down ? 'height' : 'width']) / 2;
        const at = down
          ? { x: area.x + cross, y: area.y + mainOffset }
          : { x: area.x + mainOffset, y: area.y + cross };
        const kind = node.shape ?? 'rectangle';
        const el = this.add(
          kind,
          { ...at, ...size },
          {
            frameId: area.frameId,
            strokeColor: node.color ? 'transparent' : '#868e96',
            customData: { ...(this.agent && { by: 'agent' }), semanticKind: 'box' },
            roundness: kind === 'rectangle' ? { type: 3 } : kind === 'diamond' ? { type: 2 } : null,
            ...(node.color && { backgroundColor: paint(COLORS, node.color) }),
          },
        );
        this.label(el, node.text);
        this.keyed(node.key, el);
        cross += size[down ? 'width' : 'height'] + crossGap;
      }
      main += extent + labelGap;
    }
    for (const edge of op.edges) this.arrow(edge.from, edge.to, edge.label);
  }
  private arrow(fromRef: string, toRef: string, label?: string) {
    const from = this.find(fromRef);
    const to = this.find(toRef);
    // Excalidraw binds an arrow to a box, an ellipse, a diamond, text or a frame, never to a pen
    // stroke or a line: such an end starts at its edge and stays put.
    const binding = (el: El) =>
      BINDABLE.has(el.type) ? { elementId: el.id, focus: 0, gap: 0 } : null;
    const el = this.add(
      'arrow',
      { x: 0, y: 0, width: 0, height: 0 },
      {
        points: [
          [0, 0],
          [0, 0],
        ],
        lastCommittedPoint: null,
        startBinding: binding(from),
        endBinding: binding(to),
        startArrowhead: null,
        endArrowhead: 'arrow',
        roundness: { type: 2 },
        elbowed: false,
      },
    );
    this.route(el, { from, to });
    if (BINDABLE.has(from.type)) this.bind(from, 'arrow', el.id);
    if (BINDABLE.has(to.type)) this.bind(to, 'arrow', el.id);
    if (label) this.label(el, label, 16);
    return el;
  }
  /** What moves with a shape: its own text, and a frame's shapes. */
  private carried(el: El): El[] {
    const texts = (el.boundElements ?? [])
      .filter((b: { type: string }) => b.type === 'text')
      .map((b: { id: string }) => this.elements.get(b.id))
      .filter(Boolean);
    const held = el.type === 'frame' ? this.live().filter((o) => o.frameId === el.id) : [];
    return [...texts, ...held];
  }
  private remove(el: El) {
    if (el.isDeleted) return;
    el.isDeleted = true;
    this.touch(el);
    for (const bound of el.boundElements ?? []) {
      const other = this.elements.get(bound.id);
      if (other) this.remove(other);
    }
    for (const other of this.live()) {
      if (other.frameId === el.id) {
        other.frameId = null;
        this.touch(other);
      }
      if (other.boundElements?.some((b: { id: string }) => b.id === el.id)) {
        other.boundElements = other.boundElements.filter((b: { id: string }) => b.id !== el.id);
        this.touch(other);
      }
      // An arrow left with one end joins nothing: it goes with the shape it pointed at.
      if (
        other.type === 'arrow' &&
        [other.startBinding?.elementId, other.endBinding?.elementId].includes(el.id)
      )
        this.remove(other);
    }
    if (el.containerId) {
      const container = this.elements.get(el.containerId);
      if (container && !container.isDeleted) {
        container.boundElements = (container.boundElements ?? []).filter(
          (b: { id: string }) => b.id !== el.id,
        );
        this.touch(container);
      }
    }
  }
  private keyed(key: string | undefined, el: El) {
    if (!key) return;
    if (this.created[key])
      throw new MervError('board_key_repeated', `Key "${key}" is used twice`, 400);
    this.created[key] = el.id;
  }

  apply(op: DrawOp) {
    switch (op.op) {
      case 'note': {
        const el = this.shape('rectangle', op.text, this.fit(op.text, 240, 110), op, {
          backgroundColor: paint(COLORS, op.color ?? 'yellow'),
          strokeColor: 'transparent',
          customData: { ...(this.agent && { by: 'agent' }), semanticKind: 'note' },
        });
        return this.keyed(op.key, el);
      }
      case 'box': {
        const width = Math.min(320, Math.max(180, measure(op.text, FONT).width + 50));
        const kind = op.shape ?? 'rectangle';
        const defaultWidth = kind === 'rectangle' ? width : width + 80;
        const defaultHeight = kind === 'rectangle' ? 80 : 130;
        const factor = kind === 'diamond' ? 0.5 : kind === 'ellipse' ? Math.SQRT1_2 : 1;
        // Requested dimensions are minima for a bound label; blank shapes need no
        // text padding and preserve exact dimensions, just like an empty native shape.
        const size = op.text
          ? this.fit(
              op.text,
              Math.max(op.width ?? defaultWidth, Math.ceil(60 / factor)),
              op.height ?? defaultHeight,
              kind,
            )
          : { width: op.width ?? defaultWidth, height: op.height ?? defaultHeight };
        const el = this.shape(kind, op.text, size, op, {
          ...(op.color && { backgroundColor: paint(COLORS, op.color) }),
        });
        return this.keyed(op.key, el);
      }
      case 'text': {
        const size = { s: 16, m: 20, l: 32 }[op.size ?? 'm'];
        const content = wrap(op.text, 60);
        const at = this.place(measure(content, size), op);
        return this.keyed(
          op.key,
          this.text(at, content, size, {
            originalText: op.text,
            frameId: at.frameId,
            ...(op.color && { strokeColor: paint(INKS, op.color) }),
          }),
        );
      }
      case 'link': {
        const web = /^https?:\/\//.test(op.target);
        const el = this.shape('rectangle', `↗ ${op.text}`, this.fit(`↗ ${op.text}`, 280, 70), op, {
          strokeColor: 'transparent',
          backgroundColor: '#e7f5ff',
          link: web ? op.target : `merv:${op.target}`,
          customData: {
            ...(this.agent && { by: 'agent' }),
            target: op.target,
            ...(op.details && { details: op.details }),
          },
        });
        return this.keyed(op.key, el);
      }
      case 'arrow':
        return this.keyed(op.key, this.arrow(op.from, op.to, op.label));
      case 'frame': {
        const held = [...new Set((op.holds ?? []).flatMap((ref) => this.members(ref)))];
        const box = bounds(held.map(rectOf));
        const at = box
          ? // The frame's title stands above its edge, so the edge keeps close to what it holds.
            { x: box.x - 30, y: box.y - 30, width: box.width + 60, height: box.height + 60 }
          : this.place({ width: 640, height: 420 }, op);
        const frame = this.add('frame', at, { name: op.title, strokeColor: '#bbb' });
        for (const part of held) {
          part.frameId = frame.id;
          this.touch(part);
        }
        this.frames.push(at);
        if (!box) this.occupied.pop();
        return this.keyed(op.key, frame);
      }
      case 'flow': {
        return this.flowFitted(op);
      }
      case 'edit': {
        const el = this.find(op.id);
        const textOf =
          el.type === 'text' ? el : this.carried(el).find((part) => part.containerId === el.id);
        if (op.text !== undefined) {
          if (textOf) {
            const content =
              el.type === 'text' || el.type === 'arrow'
                ? op.text
                : wrap(op.text, Math.floor((el.width - 30) / (FONT * CHAR)));
            Object.assign(textOf, {
              text: content,
              originalText: op.text,
              ...measure(content, textOf.fontSize ?? FONT),
            });
            if (textOf.containerId) centre(textOf, el);
            this.touch(textOf);
          } else if (el.type !== 'frame') this.label(el, op.text);
          if (el.type === 'frame') {
            el.name = op.text;
            this.touch(el);
          }
        }
        if (op.ink) {
          el.strokeColor = paint(INKS, op.ink);
          this.touch(el);
        }
        if (op.color) {
          if (
            el.customData?.semanticKind === 'box' &&
            el.backgroundColor === 'transparent' &&
            el.strokeColor === '#868e96'
          )
            el.strokeColor = 'transparent';
          el.backgroundColor = paint(COLORS, op.color);
          this.touch(el);
        }
        return;
      }
      case 'move': {
        const group = this.group(op.id);
        if (group.length) {
          if (!op.near && !op.in && !op.at) return;
          this.survey(new Set(group));
          const box = bounds(group.map(rectOf))!;
          const at = this.place(box, op),
            dx = at.x - box.x,
            dy = at.y - box.y;
          for (const part of group) {
            part.x += dx;
            part.y += dy;
            if (op.in) part.frameId = at.frameId;
            this.touch(part);
          }
          const ids = new Set(group.map((e) => e.id));
          for (const arrow of this.live())
            if (
              arrow.type === 'arrow' &&
              [arrow.startBinding?.elementId, arrow.endBinding?.elementId].some((id) => ids.has(id))
            ) {
              this.route(arrow);
              this.touch(arrow);
            }
          return;
        }
        const el = this.find(op.id);
        if (!op.near && !op.in && !op.at) return;
        this.survey(new Set([el, ...this.carried(el)]));
        const at = this.place(el, op);
        const dx = at.x - el.x;
        const dy = at.y - el.y;
        for (const part of [el, ...this.carried(el)]) {
          part.x += dx;
          part.y += dy;
          this.touch(part);
        }
        if (op.in) {
          el.frameId = at.frameId;
          for (const part of this.carried(el)) part.frameId = at.frameId;
        }
        for (const arrow of this.live())
          if (
            arrow.type === 'arrow' &&
            [arrow.startBinding?.elementId, arrow.endBinding?.elementId].includes(el.id)
          ) {
            this.route(arrow);
            this.touch(arrow);
          }
        return;
      }
      case 'delete':
        // What an earlier deletion already took (a box's arrows) is gone, not missing.
        for (const ref of op.ids) {
          const group = this.group(ref, true);
          if (group.length) {
            for (const part of group) this.remove(part);
            continue;
          }
          const gone = this.elements.get(this.created[ref] ?? ref);
          if (!gone?.isDeleted) this.remove(this.find(ref));
        }
        return;
      case 'sketch': {
        // Each stroke in the sketch's own coordinates, scaled as one so its longest side is the
        // size asked for, and placed like any shape; the strokes move together as a group.
        const read = op.strokes.map((stroke) => ({ stroke, lines: strokesOf(stroke.path) }));
        const points = read.flatMap(({ lines }) => lines.flatMap((line) => line.points));
        const { x: minX, y: minY, ...extent } = around(points);
        const width = extent.width || 1;
        const height = extent.height || 1;
        if (op.size === 'native' && Math.max(width, height) > 10_000)
          throw new MervError(
            'board_sketch_too_large',
            'A native-size sketch is at most 10000 board units on either side',
            400,
          );
        const scale =
          op.size === 'native'
            ? 1
            : { s: 160, m: 280, l: 440 }[op.size ?? 'm'] / Math.max(width, height);
        const at = this.place({ width: width * scale, height: height * scale }, op);
        const group = elementId();
        let first: El | undefined;
        for (const { stroke, lines } of read)
          for (const line of lines) {
            const drawn = line.points.map(([x, y]) => [
              at.x + (x - minX) * scale,
              at.y + (y - minY) * scale,
            ]);
            const filled = !!stroke.fill;
            // A painted shape is a closed outline.
            if (filled && (drawn[0]![0] !== drawn.at(-1)![0] || drawn[0]![1] !== drawn.at(-1)![1]))
              drawn.push([...drawn[0]!]);
            const box = around(drawn);
            const el = this.add('line', box, {
              roughness: 0,
              roundness: null,
              points: drawn.map(([x, y]) => [x! - box.x, y! - box.y]),
              strokeColor: paint(INKS, stroke.color ?? stroke.fill ?? 'black'),
              backgroundColor: filled ? paint(PAINTS, stroke.fill!) : 'transparent',
              strokeWidth: { thin: 1, medium: 2, bold: 4 }[stroke.width ?? 'medium'],
              groupIds: [group],
              frameId: at.frameId,
              lastCommittedPoint: null,
              customData: { ...(this.agent && { by: 'agent' }), sketch: group },
              ...(filled
                ? {
                    startBinding: null,
                    endBinding: null,
                    startArrowhead: null,
                    endArrowhead: null,
                    polygon: true,
                  }
                : {
                    startBinding: null,
                    endBinding: null,
                    startArrowhead: null,
                    endArrowhead: null,
                  }),
            });
            first ??= el;
          }
        if (first && op.key) this.created[op.key] = group;
        return;
      }
    }
  }
  /** Every shape this call changed, as it now stands. */
  result(): El[] {
    return [...this.changed].map((id) => this.elements.get(id)!);
  }
}

const rect = (el: Rect): Rect => ({ x: el.x, y: el.y, width: el.width, height: el.height });
/** Where a shape stands, a line or a pen stroke by the points it passes through. */
export function rectOf(el: El): Rect {
  if (!Array.isArray(el.points) || !el.points.length) return rect(el);
  return around((el.points as [number, number][]).map(([x, y]) => [el.x + x, el.y + y]));
}
/** Where an operation puts what it makes. */
type Where = {
  near?: string;
  in?: string;
  side?: 'right' | 'left' | 'above' | 'below';
  at?: [number, number];
};
const contains = (outer: Rect, inner: Rect) =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;
/** The box around these, walked once: a sketch's points are too many to spread into Math.min. */
export function bounds(rects: Rect[]): Rect | undefined {
  if (!rects.length) return undefined;
  let [x, y, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const r of rects) {
    x = Math.min(x, r.x);
    y = Math.min(y, r.y);
    right = Math.max(right, r.x + r.width);
    bottom = Math.max(bottom, r.y + r.height);
  }
  return { x, y, width: right - x, height: bottom - y };
}
/** The box a nonempty list of points stands in. */
const around = (points: number[][]) =>
  bounds(points.map(([x, y]) => ({ x: x!, y: y!, width: 0, height: 0 })))!;
function arrowMiddle(arrow: El) {
  const [, end] = arrow.points as [number, number][];
  return { x: arrow.x + (end?.[0] ?? 0) / 2, y: arrow.y + (end?.[1] ?? 0) / 2 };
}
/** Text moved to stand centred on a shape: on an arrow's middle, on any other shape's centre. */
function centre(text: El, on: El) {
  const middle = on.type === 'arrow' ? arrowMiddle(on) : center(on);
  Object.assign(text, { x: middle.x - text.width / 2, y: middle.y - text.height / 2 });
}
/** Each node's column in a flow: the longest path of edges reaching it, cycles cut. */
function layers(keys: string[], edges: { from: string; to: string }[]) {
  const depth = new Map(keys.map((key) => [key, 0]));
  for (let pass = 0; pass < keys.length; pass++)
    for (const { from, to } of edges) {
      if (!depth.has(from) || !depth.has(to))
        throw new MervError(
          'board_shape_not_found',
          `A flow edge names "${depth.has(from) ? to : from}", which is not one of its nodes`,
          400,
        );
      if (depth.get(to)! <= depth.get(from)! && depth.get(from)! < keys.length)
        depth.set(to, depth.get(from)! + 1);
    }
  return depth;
}

/** The board as its agent reads it: what each shape says and where, without Excalidraw's fields. */
export function summarize(elements: BoardElement[]) {
  const live = (elements as El[]).filter((el) => !el.isDeleted);
  const byId = new Map(live.map((el) => [el.id, el]));
  const said = (el: El) =>
    el.type === 'text'
      ? (el.originalText ?? el.text)
      : (el.boundElements ?? [])
          .map((b: { id: string }) => byId.get(b.id))
          .filter((t: El | undefined) => t?.type === 'text')
          .map((t: El) => t.originalText ?? t.text)
          .join(' ') || undefined;
  const where = (el: El) => ({
    at: [Math.round(el.x), Math.round(el.y)],
    size: [Math.round(el.width), Math.round(el.height)],
  });
  const frames = live
    .filter((el) => el.type === 'frame')
    .map((el) => ({ id: el.id, title: el.name ?? '', ...where(el) }));
  // A line that joins shapes is an arrow; any other line, and every pen stroke, is a mark.
  const joins = (el: El) =>
    el.type === 'arrow' || (el.type === 'line' && !!(el.startBinding || el.endBinding));
  const marks = live.filter((el) => (el.type === 'line' || el.type === 'freedraw') && !joins(el));
  const arrows = live.filter(joins).map((el) => ({
    id: el.id,
    ...(el.startBinding?.elementId && { from: el.startBinding.elementId }),
    ...(el.endBinding?.elementId && { to: el.endBinding.elementId }),
    ...(said(el) && { label: said(el) }),
  }));
  const shapes = live
    .filter(
      (el) =>
        !['frame', 'arrow', 'line', 'freedraw'].includes(el.type) &&
        !(el.type === 'text' && el.containerId),
    )
    .map((el) => ({
      id: el.id,
      kind: el.customData?.target
        ? 'link'
        : el.type === 'rectangle' &&
            el.strokeColor === 'transparent' &&
            el.customData?.semanticKind !== 'box'
          ? 'note'
          : el.type === 'rectangle'
            ? 'box'
            : el.type,
      ...(said(el) && { text: said(el) }),
      ...(el.customData?.target && { target: el.customData.target }),
      ...(el.customData?.details && { details: el.customData.details }),
      ...(el.frameId && { frame: el.frameId }),
      ...(el.customData?.by === 'agent' && { by: 'agent' }),
      ...where(el),
    }));
  // Strokes drawn as one sketch, or grouped by hand, read as one drawing.
  const drawings = new Map<string, El[]>();
  for (const el of live.filter((e) => e.groupIds?.length || marks.includes(e))) {
    const group = el.groupIds?.at(-1) ?? el.id;
    drawings.set(group, [...(drawings.get(group) ?? []), el]);
  }
  for (const [groupId, parts] of drawings) {
    const owners = new Set(parts.map((e) => e.id));
    for (const label of live)
      if (label.type === 'text' && owners.has(label.containerId) && !parts.includes(label))
        parts.push(label);
    const box = bounds(parts.map(rectOf))!;
    const first = parts[0]!;
    shapes.push({
      id: groupId,
      kind: parts.every((e) => e.customData?.sketch === groupId) ? 'sketch' : 'drawing',
      ...(parts.length > 1 && { strokes: parts.length }),
      ...(first.frameId && { frame: first.frameId }),
      ...(first.customData?.by === 'agent' && { by: 'agent' }),
      ...where(box as El),
    } as (typeof shapes)[number]);
  }
  return {
    frames,
    shapes: shapes.slice(0, 600),
    arrows: arrows.slice(0, 600),
    ...(shapes.length > 600 || arrows.length > 600 ? { truncated: true } : {}),
  };
}

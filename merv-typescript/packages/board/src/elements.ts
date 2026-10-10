/**
 * An agent's operations as Excalidraw shapes. The agent names what to draw and where it goes
 * relative to what is there (beside a shape, inside a frame, or the next free place); Board works
 * out every coordinate, binds arrows to the shapes they join and sizes text roughly, which the
 * page measures exactly when it draws. Nothing here reads outside the board.
 */
import { randomBytes } from 'node:crypto';
import { MervError } from '@merv/contracts';
import { COLORS, INKS, PAINTS, type DrawOp } from './input.js';
import { strokesOf } from './path.js';
import type { BoardElement } from './types.js';

type El = BoardElement & Record<string, any>;
type Rect = { x: number; y: number; width: number; height: number };
const GAP = 40;
const FONT = 20;
const LINE = 1.25;
/** Roughly how wide a character of the hand-drawn font is, for a font size of one. */
const CHAR = 0.65;
/** What Excalidraw binds an arrow's end to. */
const BINDABLE = new Set(['rectangle', 'ellipse', 'diamond', 'text', 'frame']);
const KEY_DIGITS = 'VWXYZabcdefghijklmnopqrstuvwxyz';

const elementId = () => randomBytes(15).toString('base64url');
const nonce = () => randomBytes(4).readUInt32BE() >>> 1;

/** Text broken into lines of at most `chars` characters, at spaces where it can be. */
function wrap(text: string, chars: number): string {
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
            lines.push(rest.slice(0, chars));
            rest = rest.slice(chars);
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
function edge(r: Rect, to: { x: number; y: number }) {
  const c = center(r);
  const dx = to.x - c.x;
  const dy = to.y - c.y;
  const t = Math.min(
    dx ? r.width / 2 / Math.abs(dx) : Infinity,
    dy ? r.height / 2 / Math.abs(dy) : Infinity,
  );
  return Number.isFinite(t) ? { x: c.x + dx * t, y: c.y + dy * t } : c;
}

/** One call's drawing: the board's shapes, what this call changed, and the keys it gave. */
export class Drawing {
  readonly elements = new Map<string, El>();
  readonly changed = new Set<string>();
  readonly created: Record<string, string> = {};
  /** Where shapes stand, frames apart: a shape goes beside another inside a frame. */
  private occupied: Rect[] = [];
  private frames: Rect[] = [];
  private cursor: { x: number; y: number; startX: number; rowBottom: number; inRow: number };
  private nextKey: (() => string) | undefined;

  constructor(
    existing: BoardElement[],
    private readonly agent: boolean,
  ) {
    for (const element of existing) this.elements.set(element.id, structuredClone(element) as El);
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
      if (bound.some((b) => b.id === text.id)) continue;
      if (!box || box.isDeleted) {
        text.containerId = null;
        this.touch(text);
      } else if (bound.some((b) => b.type === 'text' && !this.elements.get(b.id)?.isDeleted))
        this.remove(text);
      else {
        box.boundElements = [...bound, { type: 'text', id: text.id }];
        const middle = center(box);
        Object.assign(text, { x: middle.x - text.width / 2, y: middle.y - text.height / 2 });
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
    if (!this.nextKey) {
      const top = this.live()
        .map((el) => el.index)
        .filter((index): index is string => typeof index === 'string')
        .sort()
        .at(-1);
      let n = 0;
      const base = top ?? 'a0';
      this.nextKey = () => {
        const at = n++;
        return `${base}${'z'.repeat(Math.floor(at / KEY_DIGITS.length))}${KEY_DIGITS[at % KEY_DIGITS.length]}`;
      };
    }
    return this.nextKey();
  }
  /** A shape this call keyed, or one already on the board; anything else is refused by name. */
  find(ref: string): El {
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
        : wrap(content, Math.max(8, Math.floor((container.width - 30) / (size * CHAR))));
    const { width, height } = measure(wrapped, size);
    const middle = container.type === 'arrow' ? arrowMiddle(container) : center(container);
    const text = this.text(
      { x: middle.x - width / 2, y: middle.y - height / 2, width, height },
      wrapped,
      size,
      {
        originalText: content,
        textAlign: 'center',
        verticalAlign: 'middle',
        containerId: container.id,
        frameId: container.frameId,
      },
    );
    this.bind(container, 'text', text.id);
    return text;
  }
  /** The size a shape needs for its text, as `measure` estimates it. */
  private fit(content: string, width: number, minHeight: number) {
    const lines = wrap(content, Math.floor((width - 30) / (FONT * CHAR)));
    return { width, height: Math.max(minHeight, measure(lines, FONT).height + 40) };
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
      for (let y = frame.y + 60; !at && y + size.height <= frame.y + frame.height - 20; y += GAP)
        for (let x = frame.x + 30; x + size.width <= frame.x + frame.width - 20; x += GAP) {
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
      const target = this.find(near);
      frameId = target.frameId ?? null;
      const t = rectOf(target);
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
          const free = spots.find(
            (spot) => !this.occupied.some((o) => overlaps(o, { ...spot, ...size })),
          );
          if (free) {
            at = { ...free, ...size };
            break;
          }
        }
      at ??= { ...beside[side ?? 'right'], ...size };
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
      roundness: kind === 'rectangle' ? { type: 3 } : kind === 'diamond' ? { type: 2 } : null,
      ...fields,
    });
    this.label(el, content);
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
    const start = from ? edge(rectOf(from), to ? center(rectOf(to)) : free.end) : free.start;
    const end = to ? edge(rectOf(to), from ? center(rectOf(from)) : free.start) : free.end;
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
      if (!text) continue;
      const middle = arrowMiddle(arrow);
      Object.assign(text, { x: middle.x - text.width / 2, y: middle.y - text.height / 2 });
    }
  }
  private arrow(fromRef: string, toRef: string, label?: string) {
    const from = this.find(fromRef);
    const to = this.find(toRef);
    // Excalidraw binds an arrow to a box, an ellipse, a diamond, text or a frame, never to a pen
    // stroke or a line: such an end starts at its edge and stays put.
    const binding = (el: El) =>
      BINDABLE.has(el.type) ? { elementId: el.id, focus: 0, gap: 8 } : null;
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
          backgroundColor: COLORS[op.color ?? 'yellow'],
          strokeColor: 'transparent',
        });
        return this.keyed(op.key, el);
      }
      case 'box': {
        const width = Math.min(320, Math.max(180, measure(op.text, FONT).width + 50));
        const kind = op.shape ?? 'rectangle';
        const size = this.fit(
          op.text,
          kind === 'rectangle' ? width : width + 80,
          kind === 'rectangle' ? 80 : 130,
        );
        const el = this.shape(kind, op.text, size, op, {
          ...(op.color && { backgroundColor: COLORS[op.color] }),
        });
        return this.keyed(op.key, el);
      }
      case 'text': {
        const size = { s: 16, m: 20, l: 32 }[op.size ?? 'm'];
        const content = wrap(op.text, 60);
        const at = this.place(measure(content, size), op);
        return this.keyed(
          op.key,
          this.text(at, content, size, { originalText: op.text, frameId: at.frameId }),
        );
      }
      case 'link': {
        const web = /^https?:\/\//.test(op.target);
        const el = this.shape('rectangle', `↗ ${op.text}`, this.fit(`↗ ${op.text}`, 280, 70), op, {
          strokeColor: '#1971c2',
          backgroundColor: '#e7f5ff',
          link: web ? op.target : `merv:${op.target}`,
          customData: { ...(this.agent && { by: 'agent' }), target: op.target },
        });
        return this.keyed(op.key, el);
      }
      case 'arrow':
        return this.keyed(op.key, this.arrow(op.from, op.to, op.label));
      case 'frame': {
        const held = (op.holds ?? []).map((ref) => this.find(ref));
        const box = bounds(held.flatMap((el) => [el, ...this.carried(el)]).map(rect));
        const at = box
          ? // The frame's title stands above its edge, so the edge keeps close to what it holds.
            { x: box.x - 30, y: box.y - 30, width: box.width + 60, height: box.height + 60 }
          : this.place({ width: 640, height: 420 }, op);
        const frame = this.add('frame', at, { name: op.title, strokeColor: '#bbb' });
        for (const el of held)
          for (const part of [el, ...this.carried(el)]) {
            part.frameId = frame.id;
            this.touch(part);
          }
        this.frames.push(at);
        if (!box) this.occupied.pop();
        return this.keyed(op.key, frame);
      }
      case 'flow': {
        const down = op.direction === 'down';
        const depth = layers(
          op.nodes.map((n) => n.key),
          op.edges,
        );
        const columns = new Map<number, string[]>();
        for (const node of op.nodes)
          columns.set(depth.get(node.key)!, [
            ...(columns.get(depth.get(node.key)!) ?? []),
            node.key,
          ]);
        const span = { width: 220, height: 100 };
        const deepest = Math.max(...columns.keys());
        const widest = Math.max(...[...columns.values()].map((c) => c.length));
        const across = (deepest + 1) * (span.width + 80);
        const along = widest * (span.height + 50);
        const area = this.place(
          down ? { width: along * 2, height: across / 1.5 } : { width: across, height: along },
          op,
        );
        for (const node of op.nodes) {
          const layer = depth.get(node.key)!;
          const row = columns.get(layer)!.indexOf(node.key);
          const step = { x: layer * (span.width + 80), y: row * (span.height + 50) };
          const at = down
            ? { x: area.x + step.y * 1.6, y: area.y + step.x / 1.5 }
            : { x: area.x + step.x, y: area.y + step.y };
          const kind = node.shape ?? 'rectangle';
          const el = this.add(
            kind,
            // A diamond or an ellipse holds its text in its middle, so it is drawn larger.
            {
              ...at,
              ...(kind === 'rectangle'
                ? this.fit(node.text, span.width, 80)
                : this.fit(node.text, span.width + 40, 120)),
            },
            {
              frameId: area.frameId,
              roundness:
                kind === 'rectangle' ? { type: 3 } : kind === 'diamond' ? { type: 2 } : null,
              ...(node.color && { backgroundColor: COLORS[node.color] }),
            },
          );
          this.label(el, node.text);
          this.keyed(node.key, el);
        }
        for (const e of op.edges) this.arrow(e.from, e.to, e.label);
        return;
      }
      case 'edit': {
        const el = this.find(op.id);
        const textOf =
          el.type === 'text' ? el : this.carried(el).find((part) => part.type === 'text');
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
            if (textOf.containerId) {
              const middle = el.type === 'arrow' ? arrowMiddle(el) : center(el);
              Object.assign(textOf, {
                x: middle.x - textOf.width / 2,
                y: middle.y - textOf.height / 2,
              });
            }
            this.touch(textOf);
          } else if (el.type !== 'frame') this.label(el, op.text);
          if (el.type === 'frame') {
            el.name = op.text;
            this.touch(el);
          }
        }
        if (op.color) {
          el.backgroundColor = COLORS[op.color];
          this.touch(el);
        }
        return;
      }
      case 'move': {
        const el = this.find(op.id);
        if (!op.near && !op.in) return;
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
          const gone = this.elements.get(this.created[ref] ?? ref);
          if (!gone?.isDeleted) this.remove(this.find(ref));
        }
        return;
      case 'sketch': {
        // Each stroke in the sketch's own coordinates, scaled as one so its longest side is the
        // size asked for, and placed like any shape; the strokes move together as a group.
        const read = op.strokes.map((stroke) => ({ stroke, lines: strokesOf(stroke.path) }));
        const points = read.flatMap(({ lines }) => lines.flatMap((line) => line.points));
        const [minX, minY] = [
          Math.min(...points.map((p) => p[0])),
          Math.min(...points.map((p) => p[1])),
        ];
        const width = Math.max(...points.map((p) => p[0])) - minX || 1;
        const height = Math.max(...points.map((p) => p[1])) - minY || 1;
        const scale = { s: 160, m: 280, l: 440 }[op.size ?? 'm'] / Math.max(width, height);
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
            const ox = Math.min(...drawn.map((p) => p[0]!));
            const oy = Math.min(...drawn.map((p) => p[1]!));
            const box = {
              x: ox,
              y: oy,
              width: Math.max(...drawn.map((p) => p[0]!)) - ox,
              height: Math.max(...drawn.map((p) => p[1]!)) - oy,
            };
            const el = this.add(filled ? 'line' : 'freedraw', box, {
              points: drawn.map(([x, y]) => [x! - ox, y! - oy]),
              strokeColor: INKS[stroke.color ?? stroke.fill ?? 'black'],
              backgroundColor: filled ? PAINTS[stroke.fill!] : 'transparent',
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
                : { pressures: [], simulatePressure: true }),
            });
            first ??= el;
          }
        if (first) this.keyed(op.key, first);
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
function rectOf(el: El): Rect {
  if (!Array.isArray(el.points) || !el.points.length) return rect(el);
  const xs = (el.points as [number, number][]).map((p) => el.x + p[0]);
  const ys = (el.points as [number, number][]).map((p) => el.y + p[1]);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
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
function bounds(rects: Rect[]): Rect | undefined {
  if (!rects.length) return undefined;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return {
    x,
    y,
    width: Math.max(...rects.map((r) => r.x + r.width)) - x,
    height: Math.max(...rects.map((r) => r.y + r.height)) - y,
  };
}
function arrowMiddle(arrow: El) {
  const [, end] = arrow.points as [number, number][];
  return { x: arrow.x + (end?.[0] ?? 0) / 2, y: arrow.y + (end?.[1] ?? 0) / 2 };
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
      kind:
        el.type === 'freedraw'
          ? 'drawing'
          : el.customData?.target
            ? 'link'
            : el.type === 'rectangle' && el.strokeColor === 'transparent'
              ? 'note'
              : el.type === 'rectangle'
                ? 'box'
                : el.type,
      ...(said(el) && { text: said(el) }),
      ...(el.customData?.target && { target: el.customData.target }),
      ...(el.frameId && { frame: el.frameId }),
      ...(el.customData?.by === 'agent' && { by: 'agent' }),
      ...where(el),
    }));
  // Strokes drawn as one sketch, or grouped by hand, read as one drawing.
  const drawings = new Map<string, El[]>();
  for (const el of marks) {
    const group = el.groupIds?.[0] ?? el.id;
    drawings.set(group, [...(drawings.get(group) ?? []), el]);
  }
  for (const parts of drawings.values()) {
    const box = bounds(parts.map(rect))!;
    const first = parts[0]!;
    shapes.push({
      id: first.id,
      kind: first.customData?.sketch ? 'sketch' : 'drawing',
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

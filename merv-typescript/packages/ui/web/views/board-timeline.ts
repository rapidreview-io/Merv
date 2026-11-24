/**
 * A board's history laid out on one clock, the replay's: each change cut into what lands together,
 * each of those given the time a hand takes to draw it, and silence kept short, so the board, the playhead
 * and the waveform are the same thing. What the waveform shows under the playhead is what is being
 * drawn at that moment. Its height is ink, how far a pen would travel to make what landed, and not
 * a count of shapes: a stroke the width of the board stands taller than a dot, and a person's
 * careful sketch of thirty marks weighs what it looks like and not thirty boxes.
 */
import { penMs, penUnits, type BoardChange, type BoardElement } from '@merv/board/models';

/** Who drew: someone's saves through the page, or an agent's calls under an actor. */
export interface Hand {
  actorId: string;
  person: boolean;
}
/** What lands together, a shape with its label or a card with its parts, and when on the clock. */
export interface Unit {
  shapes: BoardElement[];
  step: number;
  hand: number;
  ink: number;
  start: number;
  ms: number;
  /** How far it goes on the board, erased work too. */
  reach: Reach;
}
/** The least and most of x and y. */
export type Reach = readonly [number, number, number, number];
/** A silence too long to mean anything, cut to a moment. */
export interface Cut {
  from: number;
  to: number;
  ms: number;
}
/** One stretch of work by one hand: units from `first` up to `end`. */
export interface Chunk {
  first: number;
  end: number;
}
/** A line of the conversation on the clock: said on its own, or with what an agent drew. */
export interface Line {
  words: string;
  by: 'person' | 'agent';
  /** Which agent, as it was recorded: Merv, Claude, Codex. */
  name?: string;
  actorId: string;
  step: number;
  start: number;
  /** Up to here it is being read; from here it is the line before. */
  end: number;
  /** The unit it was said with, when it came with a drawing. */
  unit?: number;
}
export interface Timeline {
  units: Unit[];
  /** Everything said, in the order it was said. */
  lines: Line[];
  /** Whether a long board was squeezed into a quick overview. */
  quick: boolean;
  chunks: Chunk[];
  hands: Hand[];
  cuts: Cut[];
  /** The clock's whole length, in milliseconds at 1×. */
  length: number;
  /** Where each step starts on the clock, for stepping through by key. */
  steps: number[];
  /** Up to here the board stands as it did when history began, how it came being unknown. */
  before: number;
  /** How fast this plays against a hand's pace at 1×. */
  rate: number;
}

/** Which of the agents' tones a hand wears, by the order agents came; people have their own. */
export const toneOf = (hands: readonly Hand[], hand: number) =>
  hands.slice(0, hand).filter((other) => !other.person).length % 3;

/** Silence plays at this share of its length, up to the most, and never less than the least. */
const [REST_SHARE, LEAST_REST, MOST_REST] = [0.05, 60, 700];
/** The least between one hand and another, so the waveform falls between them. */
const NEW_HAND_REST = 300;
/** The least between an agent's answers, as a person pauses between one point and the next. */
const AGENT_REST = 900;
/** Past this a silence is cut, and takes this long. */
const [CUT_AFTER_MS, CUT_REST] = [20 * 60_000, 500];
/** How long a board plays at the least, whatever it holds, and at the most as a quick overview. */
const LEAST_LENGTH = 3_000;
export const QUICK_LENGTH = 60_000;
/** A line stays this long to be found, and then as long as reading it takes at this many words a minute. */
const [LEAST_READ, FIND_MS, WORDS_A_MINUTE] = [2_500, 750, 180];
/** How long a line stays up to be read, on the clock at 1×. */
const readingMs = (words: string) =>
  Math.max(
    LEAST_READ,
    FIND_MS + (words.trim().split(/\s+/u).filter(Boolean).length * 60_000) / WORDS_A_MINUTE,
  );
/** The beat before the first mark and after the last, so the waveform has its whole first hill. */
const EDGE_REST = 250;
/** A change to what stands is drawn at this share of its ink, and has at least this much. */
const [EDIT_INK, LEAST_INK] = [0.1, 20];
/** How much a letter makes a pen travel, in its font's size. */
const LETTER_INK = 1.6;
/**
 * A hand's silence past this ends its chunk of work. Real agents' steps came at most 58 s apart over
 * 60 steps of model time and people's strokes at most 51 s, while people's returns were 450 s on.
 */
const CHUNK_GAP_MS = 5 * 60_000;
/** A chunk that plays in less than this is too short to read, and takes in the one before it. */
const LEAST_CHUNK_MS = 2_000;

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const travel = (points: number[][]) =>
  points
    .slice(1)
    .reduce(
      (sum, [x, y], i) =>
        sum + Math.hypot(num(x) - num(points[i]![0]), num(y) - num(points[i]![1])),
      0,
    );
const strokeOf = (shape: BoardElement) =>
  ['freedraw', 'line', 'arrow'].includes(shape.type) && Array.isArray(shape.points)
    ? travel(shape.points as number[][])
    : 0;
/** How far a pen travels to draw it. */
const inkOf = (shape: BoardElement) => {
  if (shape.type === 'text')
    return String(shape.text ?? '').length * num(shape.fontSize) * LETTER_INK;
  return strokeOf(shape) || 2 * (num(shape.width) + num(shape.height));
};

/** The line an agent said with a shape as it drew it. */
const sayOf = (shape: BoardElement) => {
  const say = (shape.customData as { say?: unknown } | undefined)?.say;
  return typeof say === 'string' ? say.trim() : '';
};

/** Reaches taken together. */
export const widened = (a: Reach | undefined, b: Reach): Reach =>
  a ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])] : b;
/** How far a shape goes: a stroke by its points, which may lie either side of where it starts. */
const reachOf = (shape: BoardElement): Reach => {
  const [x, y] = [num(shape.x), num(shape.y)];
  const points = Array.isArray(shape.points) ? (shape.points as number[][]) : undefined;
  const [xs, ys] = points?.length
    ? [points.map(([px]) => x + num(px)), points.map(([, py]) => y + num(py))]
    : [
        [x, x + num(shape.width)],
        [y, y + num(shape.height)],
      ];
  const [x1, y1, x2, y2] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const turn = num(shape.angle);
  if (!turn) return [x1, y1, x2, y2];
  // Turned about its middle, it takes in at most this much either way.
  const [cos, sin] = [Math.abs(Math.cos(turn)), Math.abs(Math.sin(turn))];
  const [w, h] = [x2 - x1, y2 - y1];
  const [wide, tall] = [(w * cos + h * sin) / 2, (w * sin + h * cos) / 2];
  const [cx, cy] = [(x1 + x2) / 2, (y1 + y2) / 2];
  return [cx - wide, cy - tall, cx + wide, cy + tall];
};

/**
 * The words set the pace: a line stays until it is read, what was drawn with it is drawn in that
 * time, and the next line waits for it. `quick` squeezes a long board into a minute, words and all.
 */
export function timelineOf(changes: readonly BoardChange[], quick = false): Timeline {
  const hands: Hand[] = [];
  const handOf = ({ actorId, kind }: BoardChange) => {
    const person = kind === 'save';
    const found = hands.findIndex((h) => h.actorId === actorId && h.person === person);
    return found >= 0 ? found : hands.push({ actorId, person }) - 1;
  };
  const standing = new Set<string>();
  const units: Unit[] = [];
  const chunks: Chunk[] = [];
  const cuts: Cut[] = [];
  const steps: number[] = [];
  const lines: Line[] = [];
  /** What each shape last said: a line is said once, however often its shape changes after. */
  const spoken = new Map<string, string>();
  let clock = EDGE_REST;
  /** The last line is being read until here. */
  let read = 0;
  let before = 0;
  let last: number | undefined;
  let working: number | undefined;
  let drawn: BoardChange | undefined;
  const say = (line: Omit<Line, 'start' | 'end'>) => {
    clock = Math.max(clock, read);
    read = clock + readingMs(line.words);
    lines.push({ ...line, start: clock, end: read });
  };
  const reachOver = (shapes: BoardElement[]) =>
    shapes.reduce<Reach | undefined>((all, shape) => widened(all, reachOf(shape)), undefined) ??
    ([0, 0, 0, 0] as const);
  for (const [step, change] of changes.entries()) {
    // Words said aloud are steps of the board's story with no ink: they take their time on the clock.
    if (change.kind === 'said') {
      const words = change.said?.words.trim();
      const heard = lines.at(-1);
      // The pen said it already with what it drew.
      const twice = change.said?.by === 'agent' && heard?.by === 'agent' && heard.words === words;
      if (!change.said || !words || twice) continue;
      const { by, name } = change.said;
      say({ words, by, ...(name && { name }), actorId: change.actorId, step });
      steps.push(clock);
      continue;
    }
    const at = Date.parse(change.at);
    if (change.kind === 'before') {
      for (const shape of change.shapes) standing.add(shape.id);
      const whole = reachOver(change.shapes);
      units.push({ shapes: change.shapes, step, hand: -1, ink: 0, start: -1, ms: 0, reach: whole });
      clock = before = CUT_REST;
      last = at;
      continue;
    }
    const hand = handOf(change);
    if (hand !== working || (last !== undefined && at - last > CHUNK_GAP_MS))
      chunks.push({ first: units.length, end: units.length });
    working = hand;
    if (last !== undefined) {
      const silence = Math.max(0, at - last);
      // Against the drawing before it: words between two answers are no change of hand.
      const same = change.actorId === drawn?.actorId && change.kind === drawn.kind;
      const rest =
        silence > CUT_AFTER_MS
          ? CUT_REST
          : same && change.kind !== 'save'
            ? Math.max(AGENT_REST, Math.min(MOST_REST, silence * REST_SHARE))
            : Math.min(
                MOST_REST,
                Math.max(same ? LEAST_REST : NEW_HAND_REST, silence * REST_SHARE),
              );
      if (silence > CUT_AFTER_MS) {
        clock = Math.max(clock, read);
        cuts.push({ from: clock, to: clock + rest, ms: silence });
      }
      clock += rest;
    }
    last = at;
    drawn = change;
    const began = steps.push(clock) - 1;
    const first = units.length;
    for (const unit of penUnits(change.shapes, (id) => standing.has(id))) {
      const { shapes, steps: strokes } = unit;
      const fresh = new Set(strokes.map(({ shape }) => shape));
      const ink = shapes.reduce(
        (sum, shape) =>
          sum + (fresh.has(shape) ? inkOf(shape) : Math.max(LEAST_INK, inkOf(shape) * EDIT_INK)),
        0,
      );
      const ms = penMs([unit]);
      const said = shapes.find((shape) => sayOf(shape));
      const words = said && sayOf(said);
      if (words && change.kind === 'draw' && spoken.get(said.id) !== words) {
        say({ words, by: 'agent', actorId: change.actorId, step, unit: units.length });
        // Its drawing is part of reading it: the line stays at least until that has landed.
        lines.at(-1)!.end = read = Math.max(read, clock + ms);
        if (units.length === first) steps[began] = clock;
      }
      for (const shape of shapes) spoken.set(shape.id, sayOf(shape));
      units.push({ shapes, step, hand, ink, start: clock, ms, reach: reachOver(shapes) });
      clock += ms;
      chunks.at(-1)!.end = units.length;
      for (const shape of shapes)
        if (shape.isDeleted) standing.delete(shape.id);
        else standing.add(shape.id);
    }
  }
  clock = Math.max(clock + EDGE_REST, read);
  // Scaled as a whole, so what is long stays long beside what is short.
  const scale =
    quick && clock > QUICK_LENGTH
      ? QUICK_LENGTH / clock
      : units.length && clock < LEAST_LENGTH
        ? LEAST_LENGTH / clock
        : 1;
  for (const unit of units) {
    if (unit.start >= 0) unit.start *= scale;
    unit.ms *= scale;
  }
  for (const cut of cuts) [cut.from, cut.to] = [cut.from * scale, cut.to * scale];
  for (const line of lines) [line.start, line.end] = [line.start * scale, line.end * scale];
  return {
    units,
    lines,
    quick: scale < 1,
    chunks: chunks.filter(({ first, end }) => end > first),
    hands,
    cuts,
    length: clock * scale,
    steps: steps.map((at) => at * scale),
    before: before * scale,
    rate: 1 / scale,
  };
}

/**
 * Where a replay opens: the last chunk of an agent's work, or with no agent's the last of a person's,
 * since either way what is asked is what just happened. Too short to read, it takes in what led to it.
 */
export const openingOf = ({ chunks, units, hands, lines }: Timeline) => {
  const agents = chunks.filter(({ first }) => !hands[units[first]!.hand]?.person);
  const last = agents.at(-1) ?? chunks.at(-1);
  if (!last) return 0;
  const lastUnit = units[last.end - 1]!;
  const ends = lastUnit.start + lastUnit.ms;
  let at = chunks.indexOf(last);
  while (at > 0 && ends - units[chunks[at]!.first]!.start < LEAST_CHUNK_MS) at--;
  const { first } = chunks[at]!;
  // With what was said since the work before it: the question comes with its answer.
  const since = units[first - 1]?.step ?? -1;
  const led = lines.find(({ step }) => step > since);
  return Math.min(units[first]!.start, led?.start ?? Infinity);
};

/** How many units have landed by this moment: one lands as the playhead reaches it. */
export const landedBy = ({ units }: Timeline, at: number) => {
  let [low, high] = [0, units.length];
  while (low < high) {
    const middle = (low + high) >> 1;
    if (units[middle]!.start < at) low = middle + 1;
    else high = middle;
  }
  return low;
};

/** What happened at a moment, for saying so under a pointer. */
export const momentAt = (line: Timeline, at: number): { cut?: Cut; before?: true; unit?: Unit } => {
  const cut = line.cuts.find(({ from, to }) => at >= from && at <= to);
  if (cut) return { cut };
  if (at < line.before) return { before: true };
  const landed = landedBy(line, at);
  return { unit: line.units[Math.max(0, landed - 1)] };
};

export interface Profile {
  /** How much was drawn at each point along it, from 0 to 1. */
  heights: Float32Array;
  /** Who drew most there, by index into the timeline's hands. */
  hands: Int16Array;
}
/** How far a unit's ink spreads past its own time, so neighbours run into each other as hills. */
const SPREAD = 1.5;
/**
 * Ink as height: rounded over, so one great drawing does not flatten every small stroke and nothing
 * is cut off flat. `FULL_AT` is the tall end of what was drawn, and below `LEAST_SHOWN` of that is
 * only the tail of a hill.
 */
const [FULL_AT, ROUNDED, LEAST_SHOWN] = [0.9, 0.7, 0.004];

/** Softens one hand's ink over its neighbours, by a bell this many points wide. */
const soften = (ink: Float32Array, spread: number) => {
  if (spread <= 0) return ink;
  const reach = Math.ceil(spread * 3);
  const bell = Array.from({ length: 2 * reach + 1 }, (_, i) =>
    Math.exp(-((i - reach) ** 2) / (2 * spread * spread)),
  );
  const whole = bell.reduce((sum, part) => sum + part, 0);
  const out = new Float32Array(ink.length);
  for (let at = 0; at < ink.length; at++) {
    const here = ink[at]!;
    if (!here) continue;
    for (let i = -reach; i <= reach; i++) {
      const to = at + i;
      if (to >= 0 && to < out.length) out[to]! += (here * bell[i + reach]!) / whole;
    }
  }
  return out;
};

/** The waveform: ink over `count` points of the clock, each unit a hill whose area is its ink. */
export function profileOf({ units, hands, length }: Timeline, count: number, spread = 0): Profile {
  const per = length / count;
  const each = hands.map(() => new Float32Array(count));
  for (const { ink, start, ms, hand } of units) {
    if (!ink || !per) continue;
    const middle = (start + ms / 2) / per;
    const half = Math.max(0.5, (ms * SPREAD) / per / 2);
    const spots: [number, number][] = [];
    let whole = 0;
    const last = Math.min(count - 1, Math.ceil(middle + half));
    for (let at = Math.max(0, Math.floor(middle - half)); at <= last; at++) {
      const off = Math.abs(at + 0.5 - middle) / half;
      if (off >= 1) continue;
      const weight = Math.cos((off * Math.PI) / 2) ** 2;
      spots.push([at, weight]);
      whole += weight;
    }
    if (!spots.length)
      spots.push([Math.min(count - 1, Math.max(0, Math.floor(middle))), (whole = 1)]);
    for (const [at, weight] of spots) each[hand]![at]! += (ink * weight) / whole;
  }
  const soft = each.map((ink) => soften(ink, spread));
  const heights = new Float32Array(count);
  const drew = new Int16Array(count);
  for (let at = 0; at < count; at++) {
    let most = 0;
    for (const [hand, ink] of soft.entries()) {
      heights[at]! += ink[at]!;
      if (ink[at]! > most) [most, drew[at]] = [ink[at]!, hand];
    }
  }
  const sorted = [...heights].filter((height) => height > 0).sort((a, b) => a - b);
  const full = sorted[Math.floor((sorted.length - 1) * FULL_AT)] ?? 1;
  for (let at = 0; at < count; at++) {
    const share = heights[at]! / full;
    heights[at] = share < LEAST_SHOWN ? 0 : 1 - Math.exp(-1.6 * share ** ROUNDED);
  }
  return { heights, hands: drew };
}

/**
 * What is being read at a moment, and the line before it; between lines, only the line before. The
 * one rule for words wherever a replay shows them: on the page, and burned into a clip.
 */
export const linesAt = ({ lines }: Timeline, at: number): { now?: Line; before?: Line } => {
  let [low, high] = [0, lines.length];
  while (low < high) {
    const middle = (low + high) >> 1;
    if (lines[middle]!.start <= at) low = middle + 1;
    else high = middle;
  }
  const last = lines[low - 1];
  if (!last) return {};
  return at <= last.end
    ? { now: last, ...(low > 1 && { before: lines[low - 2] }) }
    : { before: last };
};

/** Whose voice a line is in, and what to call them: You, Merv, Claude Code, Codex. */
export type Voice = 'you' | 'merv' | 'claude' | 'codex';
export const speakerOf = ({ by, name }: Line, person = 'You'): { voice: Voice; name: string } => {
  if (by === 'person') return { voice: 'you', name: person };
  if (/claude/i.test(name ?? '')) return { voice: 'claude', name: 'Claude Code' };
  if (/codex/i.test(name ?? '')) return { voice: 'codex', name: 'Codex' };
  return { voice: 'merv', name: name?.trim() || 'Merv' };
};

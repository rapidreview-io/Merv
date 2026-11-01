import type { BoardChange, BoardElement } from './types.js';

/** The most lines and characters a person's actions come to, the newest kept. */
const [MOST_LINES, MOST_CHARS] = [12, 600];
/** How far a shape must go, in board units, to have moved. */
const MOVED = 8;

/** What a shape's customData says of it. */
const data = (el: BoardElement) => (el.customData ?? {}) as Record<string, unknown>;
const middle = (el: BoardElement) => ({ x: el.x + el.width / 2, y: el.y + el.height / 2 });
const stroke = (el: BoardElement) =>
  (el.type === 'freedraw' || el.type === 'line') && !data(el).sketch;
const text = (el?: BoardElement) => (typeof el?.text === 'string' ? el.text.trim() : '');
const quoted = (words: string) =>
  JSON.stringify(words.length > 40 ? `${words.slice(0, 40)}…` : words);
const bound = (end: unknown) => (end as { elementId?: string } | null)?.elementId;
/** What board.read calls a shape: a label is its box, a stroke of a sketch or a card its group. */
const named = (el: BoardElement) =>
  (el.containerId as string | null) ||
  (data(el).sketch as string | undefined) ||
  (data(el).target !== undefined && el.id) ||
  (el.groupIds as string[] | undefined)?.at(-1) ||
  el.id;
/** Whether a stroke comes back to where it began, as one round something does. */
const closed = (el: BoardElement) => {
  const points = el.points as [number, number][] | undefined;
  const [first, last] = [points?.[0], points?.at(-1)];
  return (
    !!first &&
    !!last &&
    points!.length > 4 &&
    Math.hypot(first[0] - last[0], first[1] - last[1]) < Math.max(el.width, el.height) / 3
  );
};

/** One line for a run of strokes, by what they lie on: only ever a guess, so it asks. */
function strokes(drawn: BoardElement[], live: BoardElement[]): string[] {
  const others = live.filter((el) => !stroke(el) && !el.containerId);
  const within = (el: BoardElement) =>
    others.filter((other) => {
      const { x, y } = middle(other);
      return x > el.x && x < el.x + el.width && y > el.y && y < el.y + el.height;
    });
  // With its words, so an agent told in the middle of something need not stop to read them.
  const said = (el: BoardElement) => {
    const words = text(live.find(({ containerId }) => containerId === el.id)) || text(el);
    return words ? `${named(el)} ${quoted(words)}` : named(el);
  };
  const ids = (shapes: BoardElement[]) => [...new Set(shapes.map(said))].slice(0, 4).join(', ');
  const count = (n: number) => (n === 1 ? 'a stroke' : `${n} strokes`);
  const lines: string[] = [];
  const crossing: BoardElement[] = [];
  const loose: BoardElement[] = [];
  for (const el of drawn) {
    const under = within(el);
    if (!under.length) loose.push(el);
    else if (closed(el)) lines.push(`a stroke around ${ids(under)} (circled?)`);
    else crossing.push(el);
  }
  if (crossing.length)
    lines.push(`${count(crossing.length)} across ${ids(crossing.flatMap(within))} (crossed out?)`);
  if (loose.length) {
    const { x, y } = middle(loose.at(-1)!);
    const near = nearest(others, x, y);
    lines.push(`${count(loose.length)}${near ? ` near ${named(near)}` : ''} (a sketch?)`);
  }
  return lines;
}
function nearest(shapes: BoardElement[], x: number, y: number) {
  const away = (el: BoardElement) => Math.hypot(middle(el).x - x, middle(el).y - y);
  return shapes.reduce<BoardElement | undefined>(
    (best, el) => (!best || away(el) < away(best) ? el : best),
    undefined,
  );
}

/**
 * What people did on a board after a revision, in words, from its history: their shapes as they
 * were then against how they stand now, so a shape moved twice is one move and one made and erased
 * is nothing. Texts, moves, edits, deletions and arrows are facts; strokes are guesses and say so.
 * `live` is the board now. `after` is the revision they are told from; changes up to it only say
 * how a shape stood.
 */
export function handLog(changes: BoardChange[], live: BoardElement[], after: number): string[] {
  const stood = new Map<string, BoardElement>();
  const touched = new Map<string, BoardElement>();
  for (const { revision, kind, shapes } of changes)
    for (const shape of shapes) {
      // Only what a person's hand made: an agent's own call is the agent's to know.
      const told = revision <= after || kind === 'before' || data(shape).changedBy === 'agent';
      if (told) {
        if (!touched.has(shape.id)) stood.set(shape.id, shape);
      } else {
        touched.delete(shape.id);
        touched.set(shape.id, shape);
      }
    }
  const others = live.filter((el) => !touched.has(el.id));
  const lines = new Map<string, string>();
  const drawn: BoardElement[] = [];
  for (const [id, now] of touched) {
    const was = stood.get(id);
    const name = named(now);
    if (now.isDeleted) {
      if (was && !was.isDeleted) lines.set(`gone ${name}`, `deleted ${name}`);
      continue;
    }
    if (!was || was.isDeleted) {
      if (stroke(now)) drawn.push(now);
      else if (now.type === 'arrow') {
        const [from, to] = [bound(now.startBinding), bound(now.endBinding)];
        lines.set(`new ${id}`, `arrow ${from ?? id} → ${to ?? 'nowhere'}`);
      } else if (now.type === 'text' && !now.containerId) {
        const near = nearest(others, middle(now).x, middle(now).y);
        lines.set(`new ${id}`, `wrote ${quoted(text(now))}${near ? ` near ${named(near)}` : ''}`);
      } else if (now.type === 'text') {
        lines.set(`new ${name}`, `labelled ${name} ${quoted(text(now))}`);
      } else if (!lines.has(`new ${name}`)) lines.set(`new ${name}`, `added ${now.type} ${name}`);
      continue;
    }
    if (text(was) !== text(now))
      lines.set(`text ${id}`, `changed ${name} ${quoted(text(was))} → ${quoted(text(now))}`);
    // A label goes with its box, and an arrow with what it joins.
    else if (
      Math.hypot(now.x - was.x, now.y - was.y) > MOVED &&
      !now.containerId &&
      !(now.type === 'arrow' && (bound(now.startBinding) || bound(now.endBinding)))
    ) {
      const near = nearest(others, middle(now).x, middle(now).y);
      lines.set(`moved ${name}`, `moved ${name}${near ? ` beside ${named(near)}` : ''}`);
    }
  }
  const said = [...lines.values(), ...(drawn.length ? strokes(drawn, others) : [])];
  const kept: string[] = [];
  let chars = 0;
  for (const line of said.reverse()) {
    if (kept.length >= MOST_LINES || chars + line.length > MOST_CHARS) break;
    kept.unshift(line);
    chars += line.length;
  }
  const more = said.length - kept.length;
  return more ? [`…and ${more} more: board.read get since ${after} lists them`, ...kept] : kept;
}

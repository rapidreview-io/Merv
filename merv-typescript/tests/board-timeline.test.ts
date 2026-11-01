import assert from 'node:assert/strict';
import test from 'node:test';
import type { BoardChange, BoardElement } from '@merv/board/models';
import { BoardFilm } from '../packages/ui/web/views/board-film.js';
import {
  captionAt,
  landedBy,
  momentAt,
  openingOf,
  profileOf,
  timelineOf,
  toneOf,
} from '../packages/ui/web/views/board-timeline.js';

const box = (id: string, version = 1, more: Partial<BoardElement> = {}): BoardElement => ({
  id,
  type: 'rectangle',
  version,
  versionNonce: version,
  isDeleted: false,
  x: 0,
  y: 0,
  width: 100,
  height: 60,
  ...more,
});
const stroke = (id: string, length: number): BoardElement =>
  box(id, 1, {
    type: 'freedraw',
    width: length,
    height: 0,
    points: [
      [0, 0],
      [length, 0],
    ],
  });
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 1) + minutes * 60_000).toISOString();
const change = (
  minutes: number,
  shapes: BoardElement[],
  actorId = 'agent',
  kind: BoardChange['kind'] = 'draw',
): BoardChange => ({ revision: minutes + 1, actorId, at: at(minutes), kind, shapes });

test('the clock is the drawing: units follow one another, and silence is kept short', () => {
  const line = timelineOf([change(0, [box('a')]), change(1, [box('b')]), change(2, [box('c')])]);
  assert.equal(line.units.length, 3);
  for (const [i, unit] of line.units.entries()) {
    assert.ok(unit.start >= (line.units[i - 1]?.start ?? 0));
    assert.ok(unit.start + unit.ms <= line.length);
  }
  // A minute of nobody drawing plays as well under a second, past the drawing itself.
  assert.ok(line.units[1]!.start - (line.units[0]!.start + line.units[0]!.ms) < 1000);
  assert.ok(line.length < 15_000);
});

test('a long silence is cut to a moment and marked with its length', () => {
  const days = 3 * 24 * 60;
  const line = timelineOf([change(0, [box('a')]), change(days, [box('b')])]);
  assert.equal(line.cuts.length, 1);
  assert.equal(line.cuts[0]!.ms, days * 60_000);
  assert.ok(line.cuts[0]!.to - line.cuts[0]!.from < line.length / 2);
  const middle = (line.cuts[0]!.from + line.cuts[0]!.to) / 2;
  assert.equal(momentAt(line, middle).cut, line.cuts[0]);
});

test('any board plays between a few seconds and a minute', () => {
  assert.ok(timelineOf([change(0, [box('a')])]).length >= 3000);
  const many = Array.from({ length: 10_000 }, (_, i) => change(i, [box(`s${i}`)]));
  const line = timelineOf(many);
  assert.equal(Math.round(line.length), 60_000);
  assert.equal(line.units.length, 10_000);
  assert.ok(line.units.at(-1)!.start + line.units.at(-1)!.ms <= line.length + 1);
});

test('a label lands with its shape, and a card with its parts', () => {
  const held = box('t', 1, { type: 'text', text: 'hi', fontSize: 20, containerId: 'a' });
  const card = (id: string) => box(id, 1, { customData: { card: true }, groupIds: ['g'] });
  const line = timelineOf([change(0, [box('a'), held, card('c1'), card('c2'), box('z')])]);
  assert.deepEqual(
    line.units.map((unit) => unit.shapes.map((shape) => shape.id)),
    [['a', 't'], ['c1', 'c2'], ['z']],
  );
});

test('height is ink: a long stroke stands taller than a short one, and nothing falls off', () => {
  const line = timelineOf([change(0, [stroke('long', 2000)]), change(1, [stroke('short', 60)])]);
  const { heights } = profileOf(line, 400, 2);
  const tallest = (from: number, to: number) => Math.max(...heights.slice(from, to));
  const middleOf = (i: number) => {
    const unit = line.units[i]!;
    return Math.round(((unit.start + unit.ms / 2) / line.length) * 400);
  };
  const long = tallest(middleOf(0) - 3, middleOf(0) + 3);
  const short = tallest(middleOf(1) - 3, middleOf(1) + 3);
  assert.ok(short > 0);
  assert.ok(long > short, `${long} > ${short}`);
  for (const height of heights) assert.ok(height >= 0 && height <= 1);
});

test('the bars say who drew: people by their saves, agents by their calls, in turn', () => {
  const line = timelineOf([
    change(0, [box('a')], 'one'),
    change(1, [box('b')], 'me', 'save'),
    change(2, [box('c')], 'two'),
    change(3, [box('d')], 'one'),
  ]);
  assert.deepEqual(
    line.hands.map((hand) => [hand.actorId, hand.person]),
    [
      ['one', false],
      ['me', true],
      ['two', false],
    ],
  );
  assert.deepEqual(
    line.units.map((unit) => unit.hand),
    [0, 1, 2, 0],
  );
  assert.equal(toneOf(line.hands, 0), 0);
  assert.equal(toneOf(line.hands, 2), 1);
  const { hands } = profileOf(line, 300, 1);
  const whose = (i: number) => {
    const unit = line.units[i]!;
    return hands[Math.round(((unit.start + unit.ms / 2) / line.length) * 300)];
  };
  assert.deepEqual([whose(0), whose(1), whose(2), whose(3)], [0, 1, 2, 0]);
});

test('a board older than history starts as it stood and says it does not know how it came', () => {
  const line = timelineOf([
    { revision: 5, actorId: 'x', at: at(0), kind: 'before', shapes: [box('old')] },
    change(1, [box('new')]),
  ]);
  assert.ok(line.before > 0);
  assert.equal(landedBy(line, 0), 1);
  assert.equal(momentAt(line, 0).before, true);
  assert.equal(landedBy(line, line.length), 2);
  assert.deepEqual(line.units[0]!.reach, [0, 0, 100, 60]);
});

test('a unit reaches as far as it goes, erased work too, by a stroke’s points', () => {
  const backward = box('b', 1, {
    type: 'line',
    x: 100,
    y: 100,
    points: [
      [0, 0],
      [-50, 30],
    ],
  });
  const line = timelineOf([
    change(0, [box('a', 1, { x: 200, y: 0 })]),
    change(1, [backward]),
    change(2, [box('a', 2, { x: 200, y: 0, isDeleted: true })]),
  ]);
  assert.deepEqual(line.units[1]!.reach, [50, 100, 100, 130]);
  assert.deepEqual(line.units[2]!.reach, [200, 0, 300, 60]);
});

test('a turned shape reaches as far as it turns', () => {
  const thin = box('thin', 1, { width: 400, height: 20, angle: Math.PI / 2 });
  const [x1, y1, x2, y2] = timelineOf([change(0, [thin])]).units[0]!.reach;
  assert.ok(Math.abs(x1 - 190) < 1e-6 && Math.abs(x2 - 210) < 1e-6, `${x1} ${x2}`);
  assert.ok(Math.abs(y1 + 190) < 1e-6 && Math.abs(y2 - 210) < 1e-6, `${y1} ${y2}`);
});

const work = (i: number, minutes: number, actorId: string, kind: 'draw' | 'save', size = 900) => ({
  revision: i + 1,
  actorId,
  at: new Date(Date.UTC(2026, 9, 1) + minutes * 60_000).toISOString(),
  kind,
  shapes: [box(`s${i}`, 1, { width: size, height: size })],
});
const startOfChange = (line: ReturnType<typeof timelineOf>, step: number) =>
  line.units.find((unit) => unit.step === step)!.start;

test('a replay opens at the last chunk of agent work, whatever people did after it', () => {
  const line = timelineOf([
    work(0, 0, 'a', 'draw'),
    work(1, 1, 'a', 'draw'),
    work(2, 2, 'me', 'save'),
    work(3, 3, 'b', 'draw'),
    work(4, 4, 'b', 'draw'),
    work(5, 4.5, 'b', 'draw'),
    work(6, 5, 'me', 'save'),
  ]);
  assert.equal(line.chunks.length, 4);
  assert.equal(openingOf(line), startOfChange(line, 3));
});

test('a long silence ends a chunk; a pause for thought does not', () => {
  const thought = timelineOf([work(0, 0, 'a', 'draw'), work(1, 4, 'a', 'draw')]);
  assert.equal(thought.chunks.length, 1);
  const away = timelineOf([
    work(0, 0, 'a', 'draw'),
    work(1, 6, 'a', 'draw'),
    work(2, 6.1, 'a', 'draw'),
    work(3, 6.2, 'a', 'draw'),
  ]);
  assert.equal(openingOf(away), startOfChange(away, 1));
});

test('with no agent work a replay opens at the last chunk of a person’s', () => {
  const line = timelineOf([
    work(0, 0, 'me', 'save'),
    work(1, 60, 'me', 'save'),
    work(2, 60.1, 'me', 'save'),
    work(3, 60.2, 'me', 'save'),
  ]);
  assert.equal(openingOf(line), startOfChange(line, 1));
});

test('a chunk too short to read takes in the one before it', () => {
  const steps = Array.from({ length: 30 }, (_, i) => work(i, i / 10, 'a', 'draw'));
  const line = timelineOf([...steps, work(30, 3.1, 'me', 'save'), work(31, 3.2, 'b', 'draw', 1)]);
  assert.ok(openingOf(line) < startOfChange(line, 31));
  assert.ok(line.length - openingOf(line) >= 2000 * 0.9);
});

test('a board older than history opens at what came after it, or at the start with nothing after', () => {
  const before = {
    revision: 5,
    actorId: 'x',
    at: at(0),
    kind: 'before' as const,
    shapes: [box('old')],
  };
  const line = timelineOf([before, work(1, 1, 'a', 'draw')]);
  assert.equal(openingOf(line), startOfChange(line, 1));
  assert.equal(openingOf(timelineOf([before])), 0);
});

test('the film moves either way and comes back to the very same objects', () => {
  const made: BoardElement[] = [];
  const changes = [
    change(0, [box('a', 1, { index: 'a0' }), box('b', 1, { index: 'a1' })]),
    change(1, [box('a', 2, { index: 'a0' })]),
    change(2, [box('b', 2, { index: 'a1', isDeleted: true })]),
    change(3, [box('c', 1, { index: 'Zz' })]),
  ];
  const film = new BoardFilm<BoardElement>(timelineOf(changes), (raw) => {
    made.push(raw);
    return { ...raw };
  });
  const ids = () => film.scene().map((shape) => `${shape.id}${shape.version}`);
  film.seek(2);
  assert.deepEqual(ids(), ['a1', 'b1']);
  assert.deepEqual([...film.standing].sort(), ['a', 'b']);
  const first = film.scene()[0];
  film.seek(3);
  assert.deepEqual(ids(), ['a2', 'b1']);
  film.seek(4);
  assert.deepEqual(ids(), ['a2']);
  assert.deepEqual([...film.standing], ['a']);
  film.seek(5);
  // By the order it stacks, the index, and not the order it came.
  assert.deepEqual(ids(), ['c1', 'a2']);
  film.seek(2);
  assert.deepEqual(ids(), ['a1', 'b1']);
  assert.equal(film.scene()[0], first);
  film.seek(0);
  assert.deepEqual(ids(), []);
  film.seek(5);
  film.seek(-3);
  assert.equal(film.at, 0);
  // Each version made once, however often the film passed it.
  assert.equal(new Set(made).size, made.length);
});

test('a longer film goes on from where this one stands, and knows the shapes it holds', () => {
  const start = [change(0, [box('a')]), change(1, [box('b')])];
  const film = new BoardFilm<BoardElement>(timelineOf(start), (raw) => raw);
  film.seek(2);
  assert.ok(film.held('a', 1, 1));
  assert.equal(film.held('a', 2, 1), undefined);
  const longer = film.longer(timelineOf([...start, change(2, [box('c')])]));
  assert.equal(longer.at, 2);
  assert.deepEqual([...longer.standing].sort(), ['a', 'b']);
  longer.seek(3);
  assert.deepEqual([...longer.standing].sort(), ['a', 'b', 'c']);
});

test('clip captions follow spoken units, survive a pause, and expire', () => {
  const line = timelineOf([]);
  line.units = [100, 1000].map((start, i) => ({
    start,
    ms: 300,
    step: i,
    hand: 0,
    ink: 1,
    reach: [0, 0, 100, 60],
    shapes: [box(`caption-${i}`, 1, { customData: { say: i ? 'Next line' : 'First line' } })],
  }));
  assert.equal(captionAt(line, 0), '');
  assert.equal(captionAt(line, 101), 'First line');
  assert.equal(captionAt(line, 900), 'First line');
  assert.equal(captionAt(line, 1001), 'Next line');
  assert.equal(captionAt(line, 8000), '');
  assert.equal(captionAt(line, 500), 'First line');
});

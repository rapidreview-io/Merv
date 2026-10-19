/**
 * Where the map of work draws everything, without a browser. Each test states one thing the
 * drawing must never do: lay the same work out two ways, put a mark on another, set what
 * waits left of what it waits on, fold what is live, or walk off the map with the keyboard.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAP_MIN,
  ROW_H,
  beneath,
  depths,
  workMapLayout,
  type MapEdge,
  type WorkMapLayout,
} from '../packages/ui/web/views/work-map-layout.js';

/** Each pair is [prerequisite, what waits on it]. */
const edges = (...pairs: [string, string][]): MapEdge[] =>
  pairs.map(([from, to]) => ({ from, to }));
const place = (layout: WorkMapLayout, key: string) => layout.at.get(key)!;
/** A wave like a real one: two chains, one of them wide, and work that waits on nothing. */
const WAVE = [
  'publish',
  'clean',
  'embed',
  'pin',
  'profile',
  'rewrite',
  'momentum',
  'merge',
  'long',
  'rerun',
  'sweep',
  'draft',
  'seeds',
];
const WAITS = edges(
  ['clean', 'embed'],
  ['pin', 'profile'],
  ['pin', 'rewrite'],
  ['pin', 'momentum'],
  ['rewrite', 'long'],
  ['rewrite', 'rerun'],
  ['momentum', 'long'],
  ['momentum', 'rerun'],
  ['merge', 'long'],
  ['merge', 'rerun'],
  ['sweep', 'draft'],
);
const WIDTHS = [MAP_MIN, 640, 760, 1080, 1440, 2200];

test('the drawing is the same wherever it is asked, and there is none too narrow to draw', () => {
  assert.equal(workMapLayout(WAVE, WAITS, MAP_MIN - 1), null);
  assert.equal(workMapLayout([], WAITS, 1000), null);
  for (const width of WIDTHS)
    assert.deepEqual(workMapLayout(WAVE, WAITS, width), workMapLayout(WAVE, WAITS, width));
});

test('a prerequisite stands in the column left of what waits on it, and every unit has a column', () => {
  const depth = depths(WAVE, WAITS);
  for (const key of WAVE) assert.ok(depth.has(key), key);
  for (const edge of WAITS)
    assert.ok(depth.get(edge.from)! < depth.get(edge.to)!, `${edge.from} → ${edge.to}`);
  assert.equal(depth.get('long'), 2);
  assert.equal(depth.get('seeds'), 0);
  for (const width of WIDTHS) {
    const layout = workMapLayout(WAVE, WAITS, width)!;
    for (const edge of WAITS)
      assert.ok(
        place(layout, edge.from).x < place(layout, edge.to).x,
        `${edge.from} left of ${edge.to} at ${width}`,
      );
  }
});

test('no mark stands on another, every mark stands inside the frame, and chains keep their own rows', () => {
  for (const width of WIDTHS) {
    const layout = workMapLayout(WAVE, WAITS, width)!;
    const spots = new Set<string>();
    for (const [key, { x, y }] of layout.at) {
      assert.ok(x >= 0 && x <= width && y > 0 && y < layout.height, `${key} inside at ${width}`);
      const spot = `${Math.round(x)},${Math.round(y)}`;
      assert.ok(!spots.has(spot), `${key} alone at ${spot}`);
      spots.add(spot);
    }
    // Work joined by lines shares rows with nothing it is not joined to.
    const rowsOf = (keys: string[]) => new Set(keys.map((key) => place(layout, key).y));
    const chain = rowsOf(['pin', 'profile', 'rewrite', 'momentum', 'merge', 'long', 'rerun']);
    for (const key of ['publish', 'clean', 'embed', 'sweep', 'draft', 'seeds'])
      assert.ok(!chain.has(place(layout, key).y), `${key} off the wide chain's rows at ${width}`);
    assert.equal(layout.height % ROW_H, 0);
  }
});

test('a line is one curve from the right of a mark to the left of the mark that waits on it, with no head', () => {
  const layout = workMapLayout(WAVE, WAITS, 1080)!;
  assert.equal(layout.wires.length, WAITS.length);
  for (const wire of layout.wires) {
    const [, x1, y1, x2, y2] = /^M(-?[\d.]+) (-?[\d.]+)C.* (-?[\d.]+) (-?[\d.]+)$/.exec(wire.d)!;
    const from = place(layout, wire.from);
    const to = place(layout, wire.to);
    assert.ok(+x1! > from.x && +x1! < to.x, 'leaves right of its prerequisite');
    assert.ok(+x2! < to.x && +x2! > from.x, 'arrives left of what waits');
    assert.equal(+y1!, from.y);
    assert.equal(+y2!, to.y);
    assert.ok(!('head' in wire));
  }
  const waiting = workMapLayout(['a', 'b'], [{ from: 'a', to: 'b', waiting: true }], 1000)!;
  assert.equal(waiting.wires[0]!.waiting, true);
});

test('a chain longer than the width folds its finished head to marks alone, never what is live, and unfolds', () => {
  const keys = Array.from({ length: 12 }, (_, n) => `u${n}`);
  const chain = edges(...keys.slice(1).map((key, n) => [keys[n]!, key] as [string, string]));
  const ended = new Set(keys.slice(0, 9));
  const held = new Set(['u4']);
  const folded = workMapLayout(keys, chain, 760, { ended, held })!;
  // The finished head folds up to the first unit still open or in hand; names begin there.
  for (const key of ['u0', 'u1', 'u2', 'u3']) assert.equal(place(folded, key).folded, true, key);
  for (const key of ['u4', 'u5']) assert.equal(place(folded, key).folded, false, key);
  // What the width still cannot hold folds from the right, as far as nothing there is live.
  assert.deepEqual(
    folded.folds.map((fold) => fold.count),
    [4, 6],
  );
  for (const key of ['u6', 'u11']) assert.equal(place(folded, key).folded, true, key);
  // Folded marks stand in short runs at each end, in order, and the rest keep their columns.
  assert.ok(
    place(folded, 'u0').x < place(folded, 'u1').x && place(folded, 'u3').x < place(folded, 'u4').x,
  );
  assert.ok(
    place(folded, 'u5').x < place(folded, 'u6').x && place(folded, 'u6').x < place(folded, 'u11').x,
  );
  assert.ok(place(folded, 'u11').x <= 760);
  // Nothing folds where the width holds the chain, or once the reader unfolds it.
  assert.equal(workMapLayout(keys, chain, 2600, { ended, held })!.folds.length, 0);
  const open = workMapLayout(keys, chain, 760, { ended, held, unfold: true })!;
  assert.equal(open.folds.length, 0);
  assert.ok([...open.at.values()].every((spot) => !spot.folded));
});

test('work that waits on itself in a ring is still drawn, once', () => {
  const layout = workMapLayout(['a', 'b', 'c'], edges(['a', 'b'], ['b', 'c'], ['c', 'a']), 900)!;
  assert.equal(layout.at.size, 3);
  assert.equal(layout.wires.length, 3);
});

test('the keyboard reads rows left to right, and goes straight down to the nearest mark', () => {
  const layout = workMapLayout(WAVE, WAITS, 1080)!;
  assert.equal(layout.order.length, WAVE.length);
  for (let n = 1; n < layout.order.length; n++) {
    const a = place(layout, layout.order[n - 1]!);
    const b = place(layout, layout.order[n]!);
    assert.ok(a.y < b.y || (a.y === b.y && a.x < b.x));
  }
  const first = layout.order[0]!;
  const down = beneath(layout, first, true)!;
  assert.ok(place(layout, down).y > place(layout, first).y);
  assert.equal(beneath(layout, first, false), undefined);
  assert.equal(beneath(layout, 'nobody', true), undefined);
});

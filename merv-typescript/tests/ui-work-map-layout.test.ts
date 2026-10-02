/**
 * Where the map of work draws everything, without a browser. Each test states one thing the
 * drawing must never do: lay the same work out two ways, put a card over another, run a
 * line through a card, set what waits above what it waits on, say with a shared line that
 * something waits on what it does not, or walk off the map with the keyboard.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CARD_H,
  MAP_MIN,
  beneath,
  workMapLayout,
  type MapBox,
  type MapEdge,
  type MapWire,
  type WorkMapLayout,
} from '../packages/ui/web/views/work-map-layout.js';

/** Each pair is [prerequisite, what waits on it]. */
const edges = (...pairs: [string, string][]): MapEdge[] =>
  pairs.map(([from, to]) => ({ from, to }));
const centre = (box: MapBox) => box.x + box.w / 2;
const row = (layout: WorkMapLayout, key: string) => layout.at.get(key)!.y / (CARD_H + 48);
/** A line as its straight runs: [x1, y1, x2, y2], read from its path. */
function runs(wire: MapWire): [number, number, number, number][] {
  const steps = [...wire.d.matchAll(/([MVH])(-?[\d.]+)(?: (-?[\d.]+))?/g)];
  let [x, y] = [0, 0];
  const out: [number, number, number, number][] = [];
  for (const [, op, a, b] of steps) {
    const [nx, ny] = op === 'M' ? [+a!, +b!] : op === 'V' ? [x, +a!] : [+a!, y];
    if (op !== 'M') out.push([x, y, nx, ny]);
    [x, y] = [nx, ny];
  }
  return out;
}
const turnOf = (wire: MapWire) => runs(wire)[0]![3];
/** A wave like a real one: two chains, one of them wide, and work that waits on nothing. */
const KEYS = ['publish', 'clean', 'embed', 'pin', 'profile', 'rewrite', 'momentum', 'merge'];
const WAVE = [...KEYS, 'long', 'rerun', 'sweep', 'draft', 'seeds'];
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
  const once = workMapLayout(WAVE, WAITS, 1080)!;
  assert.deepEqual(workMapLayout([...WAVE], structuredClone(WAITS), 1080), once);
  assert.equal(workMapLayout(WAVE, WAITS, MAP_MIN - 1), null, 'below the minimum the list says it');
  assert.equal(workMapLayout(WAVE, WAITS, 0), null, 'a page not yet measured is not drawn');
  assert.equal(workMapLayout([], [], 1080), null, 'nor is a wave with nothing on it');
  assert.ok(workMapLayout(WAVE, WAITS, MAP_MIN));
});

test('no card covers another, every card stands inside the frame, and no line runs through a card', () => {
  for (const width of WIDTHS) {
    const layout = workMapLayout(WAVE, WAITS, width)!;
    const boxes = [...layout.at.entries()];
    assert.equal(boxes.length, WAVE.length);
    for (const [key, box] of boxes) {
      assert.ok(box.x >= 0 && box.x + box.w <= width, `${key} leaves the frame at ${width}`);
      assert.ok(
        box.y >= 0 && box.y + box.h <= layout.height,
        `${key} is under the foot at ${width}`,
      );
      for (const [other, against] of boxes)
        if (other !== key)
          assert.ok(
            box.x + box.w <= against.x ||
              against.x + against.w <= box.x ||
              box.y + box.h <= against.y ||
              against.y + against.h <= box.y,
            `${key} covers ${other} at ${width}`,
          );
    }
    for (const wire of layout.wires)
      for (const [x1, y1, x2, y2] of runs(wire))
        for (const [key, box] of boxes)
          assert.ok(
            Math.max(x1, x2) <= box.x ||
              Math.min(x1, x2) >= box.x + box.w ||
              Math.max(y1, y2) <= box.y ||
              Math.min(y1, y2) >= box.y + box.h,
            `${wire.from} → ${wire.to} runs through ${key} at ${width}`,
          );
  }
});

test('what waits stands under what it waits on, and a line ends in an arrowhead over its head', () => {
  for (const width of WIDTHS) {
    const layout = workMapLayout(WAVE, WAITS, width)!;
    for (const wire of layout.wires) {
      const [from, to] = [layout.at.get(wire.from)!, layout.at.get(wire.to)!];
      assert.ok(to.y > from.y, `${wire.to} is not under ${wire.from} at ${width}`);
      const drawn = runs(wire);
      assert.equal(drawn[0]![1], from.y + from.h, 'it leaves the foot of the prerequisite');
      assert.deepEqual(drawn.at(-1)!.slice(2), [centre(to), to.y], 'and arrives over the middle');
      assert.ok(wire.head.includes(`L${centre(to)} ${to.y}`));
    }
  }
});

test('a chain of two stands in one column, and work that waits on nothing fills the first row', () => {
  const layout = workMapLayout(WAVE, WAITS, 1440)!;
  assert.equal(centre(layout.at.get('clean')!), centre(layout.at.get('embed')!));
  assert.equal(centre(layout.at.get('sweep')!), centre(layout.at.get('draft')!));
  assert.equal(row(layout, 'embed'), row(layout, 'clean') + 1);
  assert.equal(row(layout, 'publish'), 0);
  // One prerequisite of three stands over the middle one.
  assert.equal(centre(layout.at.get('pin')!), centre(layout.at.get('rewrite')!));
});

test('what waits on nothing stands just above what waits on it, or beside those above where that row is full', () => {
  // Four columns: the row over the two that wait has room for the merge.
  const wide = workMapLayout(WAVE, WAITS, 1000)!;
  assert.equal(row(wide, 'merge'), row(wide, 'long') - 1);
  assert.equal(row(wide, 'merge'), row(wide, 'rewrite'));
  // Three: that row is full, so it stands beside the pin, a row higher, and its lines pass
  // the full row down a gutter.
  const narrow = workMapLayout(WAVE, WAITS, 760)!;
  assert.equal(row(narrow, 'merge'), row(narrow, 'pin'));
  assert.equal(row(narrow, 'long'), row(narrow, 'merge') + 2);
  const past = narrow.wires.find((wire) => wire.from === 'merge' && wire.to === 'long')!;
  const down = runs(past).find(([x1, y1, x2, y2]) => x1 === x2 && Math.abs(y2 - y1) > CARD_H)!;
  for (const box of narrow.at.values())
    assert.ok(down[0] <= box.x || down[0] >= box.x + box.w, 'the gutter is between two columns');
});

test('prerequisites of the same things turn at one height, and the others in the row at their own', () => {
  const layout = workMapLayout(WAVE, WAITS, 1440)!;
  const from = (key: string) => layout.wires.filter((wire) => wire.from === key);
  const turns = (key: string) => new Set(from(key).map(turnOf));
  // The three that the same two wait on meet on one line.
  assert.deepEqual(turns('rewrite'), turns('momentum'));
  assert.deepEqual(turns('rewrite'), turns('merge'));
  assert.equal(turns('rewrite').size, 1);
  // Two in one row that different things wait on never share a line.
  const split = workMapLayout(
    ['a', 'b', 'c', 'd'],
    edges(['a', 'c'], ['a', 'd'], ['b', 'd']),
    1440,
  )!;
  const [a, b] = ['a', 'b'].map(
    (key) => new Set(split.wires.filter((wire) => wire.from === key).map(turnOf)),
  );
  assert.equal(a!.size, 1);
  assert.equal(b!.size, 1);
  assert.notDeepEqual(a, b);
});

test('a line leaves beside the middle where the card under it waits on others and not on it', () => {
  // At three columns the merge stands over one of the three that wait on the pin alone:
  // its line down to what waits on it must not read as a line into the card under it.
  const layout = workMapLayout(WAVE, WAITS, 760)!;
  let beside = 0;
  for (const wire of layout.wires) {
    const from = layout.at.get(wire.from)!;
    const under = [...layout.at.entries()].find(
      ([, box]) => box.x === from.x && box.y === from.y + CARD_H + 48,
    )?.[0];
    const waits = layout.wires.some((other) => other.from === wire.from && other.to === under);
    const others = layout.wires.some((other) => other.to === under);
    if (under && others && !waits) {
      beside++;
      assert.equal(wire.from, 'merge');
      assert.notEqual(runs(wire)[0]![0], centre(from), `${wire.from} leaves through ${under}`);
    } else assert.equal(runs(wire)[0]![0], centre(from));
  }
  assert.equal(beside, 2, 'both of the merge’s lines');
});

test('work that waits on itself in a ring is still drawn, once', () => {
  const layout = workMapLayout(
    ['a', 'b', 'c'],
    edges(['a', 'b'], ['b', 'c'], ['c', 'a'], ['a', 'a']),
    900,
  )!;
  assert.equal(layout.at.size, 3);
  assert.equal(layout.wires.length, 3, 'a unit is never drawn waiting on itself');
  // The same relation said twice is one line.
  assert.equal(workMapLayout(['a', 'b'], edges(['a', 'b'], ['a', 'b']), 900)!.wires.length, 1);
  // A relation to something that is not on the map is not drawn.
  assert.equal(workMapLayout(['a'], edges(['a', 'gone']), 900)!.wires.length, 0);
});

test('the keyboard reads rows left to right, and goes straight down to the nearest card', () => {
  const layout = workMapLayout(WAVE, WAITS, 1440)!;
  const places = layout.order.map((key) => layout.at.get(key)!);
  for (const [index, box] of places.entries())
    if (index)
      assert.ok(
        box.y > places[index - 1]!.y ||
          (box.y === places[index - 1]!.y && box.x > places[index - 1]!.x),
      );
  assert.equal(beneath(layout, 'clean', true), 'embed');
  assert.equal(beneath(layout, 'embed', false), 'clean');
  assert.equal(beneath(layout, layout.order[0]!, false), undefined);
  assert.equal(beneath(layout, layout.order.at(-1)!, true), undefined);
  assert.equal(beneath(layout, 'gone', true), undefined);
});

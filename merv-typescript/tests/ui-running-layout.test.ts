/**
 * Where the Running board draws everything, without a browser. Each test states one thing
 * the drawing must never do: lay the same board out two ways, put a card over another,
 * cut a face short of what its lane allows, stand a session away from its work, or light
 * a whole chain of prerequisites when one piece of work is in hand.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { RunningBoard, RunningNode } from '@merv/contracts/running';
import {
  HEAD,
  MIN_WIDTH,
  absorberOf,
  cardHeight,
  related,
  runningLayout,
  type RunningBox,
} from '../packages/ui/web/views/running-layout.js';
import { board, emptyBoard } from './ui-running-fixtures.js';

const overlap = (a: RunningBox, b: RunningBox) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const centre = (box: RunningBox) => box.x + box.w / 2;
/** A board of work only, chained as given: each pair is [dependent, prerequisite]. */
const chain = (keys: string[], waits: [string, string][]): RunningBoard => {
  const base = emptyBoard(Date.parse('2026-09-25T12:00:00Z'));
  base.lanes.work.nodes = keys.map(
    (key) =>
      ({ key, lane: 'work', kind: 'Task', title: key, lines: [], look: 'solid' }) as RunningNode,
  );
  base.edges = waits.map(([from, to]) => ({ from, to, verb: 'waits on', waiting: true }));
  return base;
};

test('the drawing is the same wherever it is asked, and there is none too narrow to draw', () => {
  const given = board(Date.parse('2026-09-25T12:00:00Z'));
  const once = runningLayout(given, 1200)!;
  assert.deepEqual(runningLayout(structuredClone(given), 1200), once);
  assert.equal(runningLayout(given, MIN_WIDTH - 1), null, 'below the minimum the bands are lists');
  assert.equal(runningLayout(given, 0), null, 'a page not yet measured is not drawn');
  assert.ok(runningLayout(given, MIN_WIDTH));
  // Three bands one under the other, in their order, each at least its heading.
  assert.deepEqual(
    once.bands.map((band) => band.lane),
    ['work', 'sessions', 'hardware'],
  );
  for (const [index, band] of once.bands.entries()) {
    assert.ok(band.height >= HEAD);
    if (index) assert.equal(band.top, once.bands[index - 1]!.top + once.bands[index - 1]!.height);
  }
  assert.equal(once.height, once.bands.at(-1)!.top + once.bands.at(-1)!.height);
});

test('no card covers another, and every card stands inside its own band', () => {
  const given = board();
  for (const width of [MIN_WIDTH, 800, 1200, 1600]) {
    const layout = runningLayout(given, width)!;
    const boxes = [...layout.at.entries()];
    for (const [key, box] of boxes) {
      const lane = (['work', 'sessions', 'hardware'] as const).find((name) =>
        given.lanes[name].nodes.some((node) => node.key === key),
      )!;
      const band = layout.bands.find((item) => item.lane === lane)!;
      assert.ok(box.y >= band.top + band.head, `${key} stands under its band's heading`);
      assert.ok(box.y + box.h <= band.top + band.height, `${key} stands inside its band`);
      assert.ok(box.x >= 0 && box.x + box.w <= width, `${key} stands inside the page at ${width}`);
      for (const [other, second] of boxes)
        if (other !== key) assert.ok(!overlap(box, second), `${key} covers ${other} at ${width}`);
    }
  }
});

test('the sidebar opening narrows the drawing, and it lays itself out again rather than being covered', () => {
  const given = board();
  const wide = runningLayout(given, 1200)!;
  const narrow = runningLayout(given, 800)!;
  assert.equal(narrow.width, 800);
  assert.ok(Math.max(...[...narrow.at.values()].map((box) => box.x + box.w)) <= 800);
  assert.notDeepEqual(narrow.at, wide.at, 'the same cards are placed again for the room left');
  assert.ok(narrow.height >= wide.height, 'a narrower drawing is never shorter');
});

test('a card is as tall as the face its lane allows: a kind word, a two-line title and two lines', () => {
  const given = board();
  // Two lines of title at 18px, two lines under it at 20px, and the card's own padding.
  const face = 20 + 2 * 18 + 2 * 20;
  const layout = runningLayout(given, 1200)!;
  const long = layout.at.get('work:wf_draft')!;
  assert.equal(
    given.lanes.work.nodes.find((node) => node.key === 'work:wf_draft')!.lines.length,
    2,
  );
  // The work lane mixes tasks and an experiment, so its cards print their kind above the title.
  assert.ok(
    long.h >= face + 20,
    `a two-line title and two lines need ${face + 20}px, not ${long.h}`,
  );
  assert.equal(long.h, cardHeight('work', { kinds: true }));
  // One kind of work prints none, and a machine that counts its units draws them above its title.
  assert.ok(cardHeight('work') >= 96);
  assert.ok(cardHeight('hardware', { units: true }) >= 104);
  const hardware = layout.at.get('sandbox:sbx_h100')!;
  assert.equal(hardware.h, cardHeight('hardware', { units: true }));
  // Every card of a lane is one height, so its rows line up.
  for (const lane of ['work', 'sessions', 'hardware'] as const)
    assert.equal(
      new Set(given.lanes[lane].nodes.map((node) => layout.at.get(node.key)!.h)).size,
      1,
      lane,
    );
});

test('work reads left to right by what it waits on, and each chain follows the lane’s own order', () => {
  const layout = runningLayout(board(), 1600)!;
  const x = (key: string) => layout.at.get(`work:${key}`)!.x;
  const y = (key: string) => layout.at.get(`work:${key}`)!.y;
  assert.ok(x('wf_review') > x('wf_index'), 'the review stands right of the work it waits on');
  assert.equal(y('wf_review'), y('wf_index'));
  assert.ok(x('wf_draft') > x('wf_ablate'));
  // The held task came first in the lane, so its chain of one comes first.
  assert.ok(x('wf_table') < x('wf_index') && x('wf_index') < x('wf_ablate'));
  // A prerequisite's line is an elbow into the dependent, with its arrowhead there.
  const line = layout.paths.find((path) => path.edge.from === 'work:wf_review')!;
  assert.equal(line.cross, false);
  const into = layout.at.get('work:wf_review')!;
  assert.match(line.d, new RegExp(` L ${into.x} ${into.y + into.h / 2}$`));
  assert.ok(line.head?.includes(`L ${into.x} ${into.y + into.h / 2}`));
});

test('a chain wider than the page carries on into the next block, and its line follows it there', () => {
  const layout = runningLayout(
    chain(
      ['work:a', 'work:b', 'work:c', 'work:d'],
      [
        ['work:b', 'work:a'],
        ['work:c', 'work:b'],
        ['work:d', 'work:c'],
      ],
    ),
    MIN_WIDTH,
  )!;
  const [a, b, c] = ['a', 'b', 'c'].map((key) => layout.at.get(`work:${key}`)!);
  assert.ok(b!.x > a!.x && b!.y === a!.y);
  assert.ok(c!.y > a!.y, 'the third column does not fit and starts the next block');
  const carried = layout.paths.find((path) => path.edge.from === 'work:c')!;
  assert.match(carried.d, new RegExp(` L ${c!.x} ${c!.y + c!.h / 2}$`));
  for (const box of [a!, b!, c!])
    assert.ok(!overlap(box, { x: c!.x - 8, y: c!.y, w: 1, h: 1 }), 'it enters from the gap');
});

test('a session stands under the work it is on, and a machine under what it serves', () => {
  const given = board();
  const layout = runningLayout(given, 1600)!;
  const at = (key: string) => layout.at.get(key)!;
  for (const [session, work] of [
    ['session:session_index', 'work:wf_index'],
    ['session:session_ablate', 'work:wf_ablate'],
  ])
    assert.ok(Math.abs(centre(at(session)) - centre(at(work))) <= 1, `${session} is under ${work}`);
  // A rented machine is not placed by what it was rented for: it comes after every anchored card.
  assert.ok(at('fleet:flt_spare').x > at('session:session_draft').x);
  // The GPU run has no session and stands under the experiment it runs for.
  assert.ok(Math.abs(centre(at('compute:c0ffee')) - centre(at('work:wf_ablate'))) <= 1);
  // A card with nothing to stand under that does not fit its row starts the next one.
  const tight = runningLayout(given, 700)!;
  assert.ok(tight.at.get('fleet:flt_spare')!.y > tight.at.get('session:session_draft')!.y);
  assert.equal(tight.at.get('fleet:flt_spare')!.x, 16);
  // The unrelated sandbox takes the next free place, after everything anchored.
  assert.ok(
    at('sandbox:sbx_a10').x > at('compute:c0ffee').x ||
      at('sandbox:sbx_a10').y > at('compute:c0ffee').y,
  );
});

test('a line between bands runs from the lower card’s top to the upper card’s foot, and each end is a port', () => {
  const layout = runningLayout(board(), 1200)!;
  const cross = layout.paths.filter((path) => path.cross);
  assert.deepEqual(cross.map((path) => path.edge.verb).sort(), [
    'checks',
    'rented for',
    'runs for',
    'works on',
    'works on',
    'works on',
  ]);
  const works = cross.find((path) => path.edge.from === 'session:session_index')!;
  const session = layout.at.get('session:session_index')!;
  const work = layout.at.get('work:wf_index')!;
  assert.ok(works.d.startsWith(`M ${centre(session)} ${session.y} C`));
  assert.ok(works.d.endsWith(`${centre(work)} ${work.y + work.h}`));
  assert.ok(
    layout.ports.some((port) => port.key === 'work:wf_index' && port.y === work.y + work.h),
  );
  assert.ok(
    layout.ports.some((port) => port.key === 'session:session_index' && port.y === session.y),
  );
  // Reading order is lane by lane, top to bottom, left to right.
  const lanes = layout.order.map((key) => key.split(':')[0]);
  assert.deepEqual(lanes.slice(0, 5), ['work', 'work', 'work', 'work', 'work']);
  assert.ok(lanes.slice(5).every((kind) => kind !== 'work'));
});

test('a lane whose source never answered holds grey cells; an empty lane is its heading alone', () => {
  const given = emptyBoard();
  given.lanes.hardware.pending = true;
  const layout = runningLayout(given, 1200)!;
  const band = (lane: string) => layout.bands.find((item) => item.lane === lane)!;
  assert.equal(band('work').height, HEAD);
  assert.equal(band('sessions').height, HEAD);
  assert.ok(band('hardware').height > HEAD);
  assert.equal(layout.ghosts.length, 3);
  assert.ok(layout.ghosts.every((ghost) => ghost.lane === 'hardware'));
  // A heading the page measured taller moves everything under it.
  const measured = runningLayout(given, 1200, { heads: { work: HEAD + 22 } })!;
  assert.equal(measured.bands[1]!.top, layout.bands[1]!.top + 22);
});

test('in hand, a card lights what it reaches across the bands, and only its own neighbours in a chain', () => {
  const four = chain(
    ['work:first', 'work:second', 'work:third', 'work:last'],
    [
      ['work:second', 'work:first'],
      ['work:third', 'work:second'],
      ['work:last', 'work:third'],
    ],
  );
  const lit = related(four, 'work:last');
  assert.ok(lit.has('work:third'), 'what it waits on is lit');
  assert.ok(!lit.has('work:first'), 'what that waits on is not: the chain is not walked');
  assert.ok(!lit.has('work:second'));

  const given = board();
  const task = related(given, 'work:wf_index');
  for (const key of ['session:session_index', 'work:wf_review']) assert.ok(task.has(key), key);
  assert.ok(!task.has('work:wf_ablate'));
  // A machine lights the work it serves, the sessions on that work, and their neighbours.
  const run = related(given, 'compute:c0ffee');
  for (const key of ['work:wf_ablate', 'session:session_ablate']) assert.ok(run.has(key), key);
  assert.ok(!run.has('work:wf_draft'), 'the waits-on neighbour of the work is not the machine’s');
  // An absorbed key stands for the card that absorbed it.
  assert.equal(absorberOf(given, 'fleet:flt_bound')?.key, 'session:session_ablate');
  assert.deepEqual(related(given, 'fleet:flt_bound'), related(given, 'session:session_ablate'));
});

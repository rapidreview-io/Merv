import { createService, MervError, type Caller } from '@merv/contracts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectScope } from '@merv/scope';
import { BoardService, boardPlugin, type BoardElement } from '@merv/board';
import { boardToolsPlugin } from '@merv/board/tools';
import { boardUiPlugin } from '@merv/board/ui';
import { Drawing, summarize } from '@merv/board/elements';
import { openState } from './fixtures/state.js';

const refused = (code: string) => (error: unknown) =>
  error instanceof MervError && error.code === code;

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'board-'));
  const state = await openState(dir);
  const scope = await createService(new ProjectScope(state));
  const board = await createService(new BoardService(state, scope));
  const boot = await scope.credentials.bootstrap({ projectName: 'Boards', actorName: 'Owner' });
  const operator: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  const actor = async (role: 'producer' | 'reviewer' | 'reader') => {
    const a = await scope.credentials.issueActor(operator, { name: role, role });
    return { projectId: operator.projectId, actorId: a.actor.id, credentialId: a.credential.id };
  };
  t.after(async () => {
    board.close();
    await state.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    board,
    operator,
    producer: await actor('producer'),
    reviewer: await actor('reviewer'),
    reader: await actor('reader'),
  };
}

test('an agent draws ideas, links and a flow on a new board, and reads back what it says', async (t) => {
  const f = await fixture(t);
  const drawn = await f.board.draw(f.producer, {
    title: 'Calibration angles',
    ops: [
      { op: 'note', key: 'idea', text: 'Temperature per head, fit on dev only' },
      {
        op: 'link',
        key: 'task',
        target: 'wf_5f922aa95d8a42b1a871b8bb73d43d67',
        text: 'Synthesis task',
        near: 'idea',
      },
      { op: 'arrow', from: 'idea', to: 'task', label: 'feeds' },
      { op: 'frame', key: 'area', title: 'Next experiment', holds: ['idea', 'task'] },
      {
        op: 'flow',
        nodes: [
          { key: 'a', text: 'Base' },
          { key: 'b', text: 'KL distill' },
          { key: 'c', text: 'Evaluate' },
        ],
        edges: [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'c' },
        ],
      },
    ],
  });
  assert.equal(drawn.board.title, 'Calibration angles');
  assert.equal(drawn.board.revision, 1, 'one call is one revision');
  assert.deepEqual(Object.keys(drawn.created).sort(), ['a', 'area', 'b', 'c', 'idea', 'task']);
  const scene = await f.board.scene(f.reader, drawn.board.id);
  const read = summarize(scene.elements);
  const shape = (key: string) => read.shapes.find((s) => s.id === drawn.created[key])!;
  assert.equal(shape('idea').kind, 'note');
  assert.equal(shape('idea').text, 'Temperature per head, fit on dev only');
  assert.equal(shape('task').kind, 'link');
  assert.equal(shape('task').target, 'wf_5f922aa95d8a42b1a871b8bb73d43d67');
  assert.equal(shape('idea').frame, drawn.created.area, 'held shapes stand in their frame');
  assert.deepEqual(
    read.frames.map((frame) => frame.title),
    ['Next experiment'],
  );
  const feeds = read.arrows.find((arrow) => arrow.label === 'feeds')!;
  assert.deepEqual([feeds.from, feeds.to], [drawn.created.idea, drawn.created.task]);
  assert.equal(read.arrows.length, 3);
  const link = scene.elements.find((el) => el.id === drawn.created.task)!;
  assert.equal(
    link.link,
    'merv:wf_5f922aa95d8a42b1a871b8bb73d43d67',
    'a card keeps only the id it opens',
  );
  // Nothing new overlaps anything else that stands on its own.
  const standing = scene.elements.filter(
    (el) => !el.containerId && !['arrow', 'frame'].includes(el.type),
  );
  for (const a of standing)
    for (const b of standing)
      if (a !== b)
        assert.ok(
          a.x + a.width <= b.x ||
            b.x + b.width <= a.x ||
            a.y + a.height <= b.y ||
            b.y + b.height <= a.y,
          `${a.id} overlaps ${b.id}`,
        );
  const flow = ['a', 'b', 'c'].map((key) =>
    scene.elements.find((el) => el.id === drawn.created[key])!,
  );
  assert.ok(flow[0]!.x < flow[1]!.x && flow[1]!.x < flow[2]!.x, 'a flow reads left to right');
});

test('shapes merge by version: a stale save loses, and a page asks only for what changed', async (t) => {
  const f = await fixture(t);
  const { board, created } = await f.board.draw(f.operator, {
    title: 'Merge',
    ops: [{ op: 'box', key: 'b', text: 'One' }],
  });
  const [box] = (await f.board.scene(f.operator, board.id)).elements.filter(
    (el) => el.id === created.b,
  );
  const newer = { ...box!, version: box!.version + 1, versionNonce: 5, x: 500 };
  const saved = await f.board.save(f.producer, board.id, [newer]);
  assert.equal(saved.accepted, 1);
  assert.equal(
    (await f.board.save(f.producer, board.id, [{ ...box!, x: -1 }])).accepted,
    0,
    'an older version is not kept',
  );
  assert.equal(
    (await f.board.save(f.producer, board.id, [{ ...newer, versionNonce: 9 }])).accepted,
    0,
    'a tie keeps the lower nonce',
  );
  assert.equal(
    (await f.board.save(f.producer, board.id, [{ ...newer, versionNonce: 1, x: 7 }])).accepted,
    1,
  );
  const since = (await f.board.scene(f.operator, board.id)).board.revision;
  await f.board.draw(f.operator, { board: board.id, ops: [{ op: 'delete', ids: [created.b!] }] });
  const changed = await f.board.scene(f.operator, board.id, since);
  assert.ok(
    changed.elements.length >= 2 && changed.elements.every((el) => el.isDeleted),
    'a deletion travels as a change',
  );
  assert.equal(
    (await f.board.scene(f.operator, board.id)).elements.length,
    0,
    'a whole read is live shapes only',
  );
});

test('readers and reviewers see boards but cannot draw; archived boards leave the list', async (t) => {
  const f = await fixture(t);
  const made = await f.board.create(f.producer, 'Ideas');
  for (const who of [f.reader, f.reviewer])
    await assert.rejects(
      f.board.draw(who, { board: made.id, ops: [{ op: 'note', text: 'x' }] }),
      refused('forbidden'),
    );
  assert.deepEqual(
    (await f.board.list(f.reader)).map((b) => b.title),
    ['Ideas'],
  );
  await f.board.set(f.operator, made.id, { archived: true });
  assert.deepEqual(await f.board.list(f.reader), []);
});

test('a page cannot save images, embeds or script links, and an agent cannot name a missing shape', async (t) => {
  const f = await fixture(t);
  const made = await f.board.create(f.operator, 'Guarded');
  const base = {
    id: 'e1',
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
  };
  for (const element of [
    { ...base, type: 'image' },
    { ...base, type: 'embeddable' },
    { ...base, type: 'rectangle', link: 'javascript:alert(1)' },
  ])
    await assert.rejects(
      f.board.save(f.operator, made.id, [element as BoardElement]),
      refused('invalid_board_input'),
    );
  await assert.rejects(
    f.board.draw(f.operator, {
      board: made.id,
      ops: [{ op: 'arrow', from: 'nowhere', to: 'either' }],
    }),
    /No shape "nowhere"/,
  );
  assert.equal(
    (await f.board.scene(f.operator, made.id)).board.revision,
    0,
    'a refused call draws nothing',
  );
});

test('deleting a shape takes its text and the arrows that join it', () => {
  const drawing = new Drawing([], true);
  drawing.apply({ op: 'box', key: 'a', text: 'A' });
  drawing.apply({ op: 'box', key: 'b', text: 'B', near: 'a' });
  drawing.apply({ op: 'arrow', from: 'a', to: 'b', label: 'then' });
  const drawn = drawing.result();
  assert.ok(
    drawn.every((el) => (el.customData as { by?: string })?.by === 'agent'),
    'what an agent draws says so',
  );
  const next = new Drawing(drawn, false);
  next.apply({ op: 'delete', ids: [drawing.created.a!] });
  assert.deepEqual(
    summarize(next.result().concat(drawn.filter((el) => !next.changed.has(el.id)))).shapes.map(
      (s) => s.text,
    ),
    ['B'],
  );
});

test('Board depends on State and Scope alone, and links to records only by id', () => {
  assert.deepEqual(boardPlugin.inject, ['state', 'scope']);
  assert.deepEqual(boardToolsPlugin.inject, ['board', 'tools']);
  assert.deepEqual(boardUiPlugin.inject, ['board', 'ui']);
  const src = new URL('../packages/board/src/', import.meta.url);
  const imports = readdirSync(src).flatMap((file) =>
    [...readFileSync(new URL(file, src), 'utf8').matchAll(/from '(@merv\/[^/']+)/g)].map(
      (m) => m[1],
    ),
  );
  assert.deepEqual([...new Set(imports)].sort(), ['@merv/api', '@merv/contracts', '@merv/ui']);
});

test('a sketch path reads as the points a pen passes: lines, curves, arcs and closed outlines', async () => {
  const { strokesOf } = await import('@merv/board/path');
  const [square] = strokesOf('M 0 0 H 10 V 10 h -10 Z');
  assert.deepEqual(square!.points, [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
    [0, 0],
  ]);
  assert.equal(square!.closed, true);
  const [curve] = strokesOf('M0,0 C 0,10 10,10 10,0');
  assert.deepEqual(curve!.points.at(-1), [10, 0]);
  assert.ok(
    curve!.points.length > 10 && curve!.points.some(([, y]) => y > 7),
    'a curve is walked, not cut short',
  );
  const [circle] = strokesOf('M 0 5 A 5 5 0 1 0 10 5 A 5 5 0 1 0 0 5 Z');
  assert.ok(
    circle!.points.every(([x, y]) => Math.abs(Math.hypot(x - 5, y - 5) - 5) < 0.01),
    'an arc keeps its radius',
  );
  assert.equal(strokesOf('M0 0 L1 1 M5 5 L6 6').length, 2, 'each move begins a stroke');
  assert.throws(() => strokesOf('M 0 0 X 3'), /could not be read/);
  assert.throws(() => strokesOf('L 1 1'), /does not begin with M/);
});

test('an agent sketches with a pen: grouped strokes, painted petals, scaled and placed as one', () => {
  const drawing = new Drawing([], true);
  drawing.apply({ op: 'note', key: 'n', text: 'A rose' });
  drawing.apply({
    op: 'sketch',
    key: 'rose',
    size: 'l',
    near: 'n',
    strokes: [
      { path: 'M 50 40 C 30 20, 30 0, 50 10 C 70 0, 70 20, 50 40 Z', fill: 'red', color: 'red' },
      { path: 'M 50 40 C 48 60, 52 80, 50 100', color: 'green', width: 'bold' },
    ],
  });
  const marks = drawing.result().filter((el) => ['line', 'freedraw'].includes(el.type));
  assert.deepEqual(
    marks.map((el) => el.type),
    ['line', 'freedraw'],
    'a filled stroke paints, a bare one is ink',
  );
  assert.equal(
    new Set(marks.map((el) => (el.groupIds as string[])[0])).size,
    1,
    'the strokes move together',
  );
  const tall =
    Math.max(...marks.map((el) => el.y + el.height)) - Math.min(...marks.map((el) => el.y));
  assert.ok(Math.abs(tall - 440) < 1, `the longest side is the size asked for (${tall})`);
  const note = drawing.find('n');
  assert.ok(
    Math.min(...marks.map((el) => el.x)) >= note.x + note.width,
    'it stands beside the note',
  );
  const read = summarize(drawing.result());
  const sketch = read.shapes.find((shape) => shape.kind === 'sketch')!;
  assert.equal((sketch as { strokes?: number }).strokes, 2, 'a sketch reads as one drawing');
  assert.equal(sketch.id, drawing.created.rose);
  assert.equal(read.arrows.length, 0, 'a sketched line is not an arrow');
});

/** A handwritten word as a pen stroke: a zigzag across its box. */
const word = (id: string, x: number, y: number, width = 160): BoardElement =>
  ({
    id,
    type: 'freedraw',
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    x,
    y,
    width,
    height: 30,
    points: Array.from({ length: 9 }, (_, i) => [(i * width) / 8, i % 2 ? 30 : 0]),
  }) as unknown as BoardElement;

test('a shape goes as near its target as there is room, on the side asked, or exactly where asked', () => {
  // A person's handwriting: a label with words packed to its right and below.
  const hand = [
    word('label', 0, 0),
    word('w1', 200, 0),
    word('w2', 400, 0),
    word('w3', 0, 60),
    word('w4', 200, 60),
  ];
  const drawing = new Drawing(hand, true);
  drawing.apply({ op: 'box', key: 'beside', text: 'Examples', near: 'label' });
  drawing.apply({ op: 'box', key: 'over', text: 'Above it', near: 'label', side: 'above' });
  drawing.apply({ op: 'box', key: 'pinned', text: 'Here', at: [1000, 500] });
  const box = (key: string) => drawing.find(key);
  const gap = (a: BoardElement, b: BoardElement) =>
    Math.hypot(a.x + a.width / 2 - (b.x + b.width / 2), a.y + a.height / 2 - (b.y + b.height / 2));
  assert.ok(
    gap(box('beside'), box('label')) < 420,
    `beside its label, not far off (${Math.round(gap(box('beside'), box('label')))})`,
  );
  assert.ok(box('over').y + box('over').height <= 0, 'above, when asked');
  assert.deepEqual([box('pinned').x, box('pinned').y], [1000, 500]);
  for (const key of ['beside', 'over'])
    for (const stroke of hand)
      assert.ok(
        box(key).x >= stroke.x + stroke.width ||
          stroke.x >= box(key).x + box(key).width ||
          box(key).y >= stroke.y + stroke.height ||
          stroke.y >= box(key).y + box(key).height,
        `${key} stays off the handwriting`,
      );
});

test('deleting a box and then its arrow in one call is fine, and loose text finds its box again', () => {
  const drawing = new Drawing([], true);
  drawing.apply({ op: 'box', key: 'a', text: 'A' });
  drawing.apply({ op: 'box', key: 'b', text: 'B' });
  drawing.apply({ op: 'arrow', key: 'ab', from: 'a', to: 'b' });
  drawing.apply({ op: 'delete', ids: [drawing.created.a!, drawing.created.ab!] });
  assert.throws(() => drawing.apply({ op: 'delete', ids: ['never-was'] }), /No shape "never-was"/);
  // A page that merged half a change left B's text pointing at B while B no longer lists it.
  const shapes = drawing.result().filter((el) => !el.isDeleted);
  const b = shapes.find((el) => el.id === drawing.created.b)!;
  const loose = shapes.map((el) => (el.id === b.id ? { ...el, boundElements: [] } : el));
  const next = new Drawing(loose as BoardElement[], false);
  const rebound = next.result().find((el) => el.id === b.id)!;
  assert.ok(
    (rebound.boundElements as { type: string }[]).some((bound) => bound.type === 'text'),
    'the box has its words again',
  );
  assert.equal(summarize(next.result()).shapes.find((s) => s.id === b.id)?.text, 'B');
});

test('a board draws itself for its agent: pen strokes and text as SVG, cropped to a focus', async () => {
  const { pictureOf } = await import('@merv/board/picture');
  const drawing = new Drawing([word('hand', 0, 0)], true);
  drawing.apply({ op: 'note', key: 'n', text: 'Training <objective>' });
  drawing.apply({ op: 'frame', key: 'f', title: 'Far away', holds: ['n'] });
  const elements = [word('hand', 0, 0), ...drawing.result()];
  const whole = pictureOf(elements);
  assert.ok(typeof whole !== 'string');
  assert.match(whole.html, /<polyline points="0,0 20,30/, 'the pen stroke is drawn');
  assert.match(whole.html, /&lt;objective&gt;/, 'text is drawn, escaped');
  assert.ok(Math.max(whole.width, whole.height) <= 1600);
  const part = pictureOf(elements, drawing.created.f);
  assert.ok(typeof part !== 'string');
  const [x] = part.html
    .match(/viewBox="(-?[\d.]+)/)!
    .slice(1)
    .map(Number);
  assert.ok(x! > 100, 'a focus crops to its part');
  assert.equal(pictureOf(elements, 'nope'), 'No shape "nope" on this board.');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { Drawing, summarize } from '../packages/board/src/elements.js';
import { drawSchema } from '../packages/board/src/input.js';
const live = (d: Drawing) => [...d.elements.values()].filter((e) => !e.isDeleted);
const arrow = (size: 'native' | 'l') => ({
  op: 'sketch' as const,
  key: 'arrow',
  size,
  at: [100, 700] as [number, number],
  strokes: [
    { path: 'M0 18 C125 -17 275 53 412.5 18 S587.5 -17 687.5 18' },
    { path: 'M687.5 18 L652.5 0 M687.5 18 L652.5 36' },
  ],
});
test('native drawings preserve requested width; preset size remains backward compatible', () => {
  for (const [size, width] of [
    ['native', 687.5],
    ['l', 440],
  ] as const) {
    const d = new Drawing([], true);
    d.apply(arrow(size));
    const b = summarize(live(d)).shapes.find((s) => s.kind === 'sketch')!;
    assert.equal(b.size[0], Math.round(width));
    assert.equal(b.id, d.created.arrow);
  }
});
test('replacing a production-style multi-stroke arrow leaves no orphan arrowhead', () => {
  const d = new Drawing([], true);
  d.apply(arrow('native'));
  assert.equal(live(d).length, 3);
  const id = d.created.arrow!;
  const reloaded = new Drawing(JSON.parse(JSON.stringify(live(d))), true);
  reloaded.apply({ op: 'delete', ids: [id] });
  assert.equal(live(reloaded).length, 0);
  reloaded.apply({ op: 'delete', ids: [id] });
  assert.equal(live(reloaded).length, 0);
});
test('moving a sketch preserves all internal offsets and loose labels remain untouched', () => {
  const d = new Drawing([], true);
  d.apply(arrow('native'));
  d.apply({ op: 'text', key: 'label', text: 'forward pass', at: [330, 650] });
  const before = live(d)
    .filter((e) => e.type === 'line')
    .map((e) => [e.id, e.x, e.y] as const);
  const label = JSON.stringify(d.find('label'));
  const bounds = summarize(live(d)).shapes.find((s) => s.id === d.created.arrow)!;
  d.apply({ op: 'move', id: d.created.arrow!, at: [1000, 1000] });
  for (const [id, x, y] of before) {
    const e = d.find(id);
    assert.equal(e.x - x, 1000 - bounds.at[0]);
    assert.ok(Math.abs(e.y - y - (1000 - bounds.at[1])) < 1);
  }
  assert.equal(JSON.stringify(d.find('label')), label);
});
test('reference details survive exact geometry/color additions', () => {
  const input = drawSchema.parse({
    title: 'References',
    ops: [
      { op: 'box', text: '', width: 60, height: 60, color: '#345678' },
      { op: 'text', text: 'annotation', color: '#aa2222' },
      { op: 'link', text: 'Paper', target: 'https://example.com', details: { text: 'Details' } },
    ],
  });
  const d = new Drawing([], true);
  for (const op of input.ops) d.apply(op);
  assert.equal(live(d)[0]!.width, 60);
  assert.equal(live(d)[0]!.backgroundColor, '#345678');
  assert.ok(live(d).some((e) => e.strokeColor === '#aa2222'));
  assert.ok(summarize(live(d)).shapes.some((e) => e.details?.text === 'Details'));
});

// Production robot leader lines use negative coordinates relative to their at anchor.
test('native path origin keeps separate leader groups aligned with labels', () => {
  const d = new Drawing([], true);
  d.apply({
    op: 'sketch',
    key: 'leaders',
    size: 'native',
    at: [160, 185],
    strokes: [{ path: 'M 0 0 L 170 0 L 205 45' }, { path: 'M 430 -55 L 250 70' }],
  });
  const lines = live(d).filter((e) => e.type === 'line');
  const points = lines.map((e) => (e.points as number[][]).map(([x, y]) => [e.x + x!, e.y + y!]));
  assert.deepEqual(points, [
    [
      [160, 185],
      [330, 185],
      [365, 230],
    ],
    [
      [590, 130],
      [410, 255],
    ],
  ]);
});
test('native paths retain positive offsets rather than snapping their first point to at', () => {
  const d = new Drawing([], true);
  d.apply({ op: 'sketch', size: 'native', at: [100, 200], strokes: [{ path: 'M 20 30 L 50 60' }] });
  const e = live(d)[0]!;
  assert.equal(e.x, 120);
  assert.equal(e.y, 230);
});

test('dense reference labels can fit native source-scale boxes and keep size when edited', () => {
  const d = new Drawing([], true);
  const input = drawSchema.parse({
    ops: [
      { op: 'box', key: 'rtk', text: 'RTK', width: 50, height: 24, fontSize: 8, at: [0, 0] },
      { op: 'text', key: 'caption', text: 'Linear/Angular Twist', fontSize: 9, at: [60, 0] },
    ],
  });
  for (const op of input.ops) d.apply(op);
  const box = d.find('rtk');
  assert.equal(box.width, 50);
  assert.equal(box.height, 24);
  let label = live(d).find((e) => e.containerId === box.id)!;
  assert.equal(label.fontSize, 8);
  assert.equal(label.text, 'RTK');
  d.apply({ op: 'edit', id: box.id, text: 'SBAS' });
  label = live(d).find((e) => e.containerId === box.id)!;
  assert.equal(label.fontSize, 8);
  assert.equal(label.text, 'SBAS');
  assert.equal(d.find('caption').fontSize, 9);
  assert.equal(
    drawSchema.safeParse({ ops: [{ op: 'text', text: 'x', fontSize: 0 }] }).success,
    false,
  );
});

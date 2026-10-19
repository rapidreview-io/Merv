import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Drawing, shapeEdge, summarize } from '../packages/board/src/elements.js';
import { geometry } from './fixtures/board-geometry.js';
test('analytic intersections lie on native diamond/ellipse/rectangle boundary', () => {
  for (const type of ['diamond', 'ellipse', 'rectangle'])
    for (const to of [
      { x: 700, y: 500 },
      { x: -300, y: 200 },
      { x: 20, y: -500 },
    ]) {
      const r = { type, x: 10, y: 20, width: 200, height: 100 };
      const p = shapeEdge(r, to);
      const nx = Math.abs(p.x - 110) / 100,
        ny = Math.abs(p.y - 70) / 50;
      assert.ok(
        Math.abs(
          (type === 'diamond'
            ? nx + ny
            : type === 'ellipse'
              ? nx * nx + ny * ny
              : Math.max(nx, ny)) - 1,
        ) < 1e-9,
      );
    }
});
test('fitted boxes have contained labels and do not change existing shapes', () => {
  const first = new Drawing([], true);
  first.apply({ op: 'note', text: 'Existing', at: [-500, -500] });
  const original = JSON.stringify([...first.elements.values()]);
  const drawing = new Drawing(JSON.parse(original), true);
  for (const shape of ['diamond', 'ellipse'] as const)
    drawing.apply({
      op: 'box',
      shape,
      text: 'Review café readiness and confirm who owns the recovery plan before proceeding',
    });
  assert.equal(JSON.stringify([...drawing.elements.values()].slice(0, 2)), original);
  assert.deepEqual(geometry([...drawing.elements.values()]), []);
});
test('v3 layers use fitted dimensions in right and down branches', () => {
  for (const direction of ['right', 'down'] as const) {
    const d = new Drawing([], true);
    d.apply({
      op: 'flow',
      direction,
      nodes: [
        { key: 'a', text: 'Start' },
        { key: 'b', text: 'Review '.repeat(40), shape: 'diamond' },
        { key: 'c', text: 'Short', shape: 'ellipse' },
        { key: 'd', text: 'Merge' },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'a', to: 'c' },
        { from: 'b', to: 'd' },
        { from: 'c', to: 'd' },
      ],
    });
    assert.deepEqual(geometry([...d.elements.values()]), []);
  }
});

test('restrained defaults retain semantic kinds and explicit sketch colors', () => {
  const d = new Drawing([], true);
  d.apply({ op: 'box', key: 'filled', text: 'Filled', color: 'blue' });
  d.apply({ op: 'box', key: 'outline', text: 'Outline' });
  d.apply({ op: 'note', key: 'note', text: 'Note' });
  d.apply({ op: 'sketch', key: 'stroke', strokes: [{ path: 'M0 0 L10 10', color: 'red' }] });
  const filled = d.find('filled'),
    outline = d.find('outline');
  assert.equal(filled.strokeColor, 'transparent');
  d.apply({ op: 'edit', id: filled.id, color: 'green' });
  assert.equal(filled.strokeColor, 'transparent');
  assert.equal(
    summarize([...d.elements.values()]).shapes.find((s) => s.id === filled.id)?.kind,
    'box',
  );
  filled.strokeColor = '#123456';
  d.apply({ op: 'edit', id: filled.id, color: 'red' });
  assert.equal(filled.strokeColor, '#123456');
  assert.equal(outline.strokeColor, '#868e96');
  d.apply({ op: 'edit', id: outline.id, color: 'blue' });
  assert.equal(outline.strokeColor, 'transparent');
  assert.equal(d.find('note').strokeColor, 'transparent');
  assert.equal(
    [...d.elements.values()].find((e) =>
      (e.groupIds as string[] | undefined)?.includes(d.created.stroke!),
    )?.strokeColor,
    '#e03131',
  );
});

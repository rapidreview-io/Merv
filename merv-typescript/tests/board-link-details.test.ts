import test from 'node:test';
import assert from 'node:assert/strict';
import type { BoardElement } from '../packages/board/src/models.js';
import { Drawing, summarize } from '../packages/board/src/elements.js';
import { parse, elementSchema, drawSchema } from '../packages/board/src/input.js';

test('link detail content survives native scene serialization and board.read', () => {
  const details = {
    title: 'Paper',
    text: 'A claim and its limitation.',
    preview: { title: 'Original paper', description: 'Caller-supplied metadata.' },
    artifactId: 'artifact_12345678901234567890123456789012',
  };
  const drawing = new Drawing([], true);
  drawing.apply({
    op: 'link',
    key: 'paper',
    text: 'Paper',
    target: 'https://example.org/paper',
    details,
  });
  const restored = drawing
    .result()
    .map((element) => elementSchema.parse(JSON.parse(JSON.stringify(element))) as BoardElement);
  const card = restored.find((element) => element.id === drawing.created.paper)!;
  assert.deepEqual((card.customData as Record<string, unknown>)?.details, details);
  assert.deepEqual(
    summarize(restored).shapes.find((shape) => shape.id === card.id)?.details,
    details,
  );
});

test('link details reject oversized text and unknown preview fields', () => {
  const base = {
    title: 'References',
    ops: [
      {
        op: 'link',
        text: 'Paper',
        target: 'https://example.org',
        details: { text: 'x'.repeat(20001) },
      },
    ],
  };
  assert.throws(() => parse(drawSchema, base));
  assert.throws(() =>
    parse(drawSchema, {
      ...base,
      ops: [
        { ...base.ops[0], details: { preview: { title: 'Paper', html: '<script>no</script>' } } },
      ],
    }),
  );
});

test('expansion follows readable content: links stay compact, notes widen, documents fill viewport', async () => {
  const { linkExpansionMode } = await import('../packages/ui/web/views/board-link-layout.js');
  assert.equal(linkExpansionMode(undefined), 'none');
  assert.equal(linkExpansionMode('   '), 'none');
  assert.equal(linkExpansionMode('A short finding and a limitation.'), 'reading');
  assert.equal(linkExpansionMode('x'.repeat(1600)), 'reading');
  assert.equal(linkExpansionMode('x'.repeat(1601)), 'fullscreen');
  assert.equal(linkExpansionMode(Array(26).fill('item').join('\n')), 'fullscreen');
  assert.equal(linkExpansionMode(undefined, 'artifact_fixture'), 'fullscreen');
});

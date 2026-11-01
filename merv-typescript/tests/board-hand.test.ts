import assert from 'node:assert/strict';
import test from 'node:test';
import type { BoardChange, BoardElement } from '@merv/board/models';
import { handLog } from '../packages/board/src/hand.js';

const shape = (id: string, more: object = {}): BoardElement =>
  ({
    id,
    type: 'rectangle',
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    ...more,
  }) as BoardElement;
const step = (revision: number, shapes: BoardElement[], kind: BoardChange['kind'] = 'save') =>
  ({ revision, actorId: 'a', at: '', kind, shapes }) as BoardChange;
const b = shape('b', { x: 500 });

test('what a person did comes out as one fact a shape, against how it stood', () => {
  const stood = shape('k', { x: 0, type: 'text', text: 'lr' });
  const log = handLog(
    [
      step(1, [stood, shape('moved'), shape('gone')], 'before'),
      step(2, [shape('k', { type: 'text', text: 'learning rate' })]),
      step(3, [shape('moved', { x: 40 }), shape('gone', { isDeleted: true })]),
      step(4, [shape('moved', { x: 480 })]),
      step(5, [shape('made'), shape('made', { isDeleted: true })]),
      step(6, [shape('t', { type: 'text', text: 'no', x: 520 })]),
      step(7, [shape('a', { type: 'arrow', startBinding: { elementId: 'b' }, endBinding: null })]),
      // A shape moved back is where it was; an agent's own drawing is not the person's.
      step(8, [shape('still', { x: 3 })]),
      step(9, [shape('agent', { customData: { changedBy: 'agent' } })], 'draw'),
    ],
    [b, shape('moved', { x: 480 }), shape('t', { type: 'text', text: 'no', x: 520 })],
    1,
  );
  assert.deepEqual(log, [
    'changed k "lr" → "learning rate"',
    'deleted gone',
    'moved moved beside b',
    'wrote "no" near b',
    'arrow b → nowhere',
    'added rectangle still',
  ]);
});

test('strokes are only ever guesses at what they mean', () => {
  const across = shape('s1', {
    type: 'freedraw',
    x: 480,
    y: 40,
    width: 150,
    height: 20,
    points: [
      [0, 0],
      [150, 20],
    ],
  });
  const around = shape('s2', {
    type: 'freedraw',
    x: 450,
    y: -50,
    width: 200,
    height: 200,
    points: [
      [0, 0],
      [200, 0],
      [200, 200],
      [0, 200],
      [5, 5],
    ],
  });
  const loose = (id: string) =>
    shape(id, { type: 'freedraw', x: 2000, y: 0, width: 5, height: 5, points: [] });
  assert.deepEqual(handLog([step(2, [across])], [b, across], 1), [
    'a stroke across b (crossed out?)',
  ]);
  assert.deepEqual(handLog([step(2, [around])], [b, around], 1), ['a stroke around b (circled?)']);
  assert.deepEqual(handLog([step(2, [loose('x'), loose('y')])], [b], 1), [
    '2 strokes near b (a sketch?)',
  ]);
});

test('it stays short, the newest kept, and says where the rest is', () => {
  const texts = Array.from({ length: 30 }, (_, i) =>
    shape(`t${i}`, { type: 'text', text: `word ${i}` }),
  );
  const log = handLog([step(5, texts)], [], 4);
  assert.equal(log.length, 13);
  assert.match(log[0]!, /^…and 18 more: board\.read get since 4/);
  assert.equal(log.at(-1), 'wrote "word 29"');
  assert.ok(log.join('').length < 700);
});

test('a stroke lies where its points go, not to the right of where it starts', () => {
  // Begun at its rightmost point and drawn round to the left: over `left`, nowhere near `right`.
  const left = shape('left', { x: 0, y: 0 });
  const right = shape('right', { x: 300, y: 0 });
  const ring = shape('ring', {
    type: 'freedraw',
    x: 200,
    y: 50,
    width: 300,
    height: 200,
    points: [
      [0, 0],
      [-100, -100],
      [-250, -100],
      [-300, 0],
      [-250, 100],
      [-100, 100],
      [-5, 5],
    ],
  });
  assert.deepEqual(handLog([step(2, [ring])], [left, right, ring], 1), [
    'a stroke around left (circled?)',
  ]);
});

test('a shape is told by its words, its label, or the label beside it, with its id', () => {
  const box = shape('box', { boundElements: [{ type: 'text', id: 'label' }] });
  const label = shape('label', { type: 'text', text: 'Softmax', containerId: 'box' });
  const sketch = shape('curve', { type: 'line', x: 1000, customData: { sketch: 'g' } });
  const beside = shape('name', { type: 'text', text: 'Loss', x: 1000, y: 110, height: 20 });
  const ring = (id: string, x: number) =>
    shape(id, {
      type: 'freedraw',
      x,
      y: -50,
      width: 200,
      height: 200,
      points: [
        [0, 0],
        [200, 0],
        [200, 200],
        [0, 200],
        [5, 5],
      ],
    });
  const live = [box, label, sketch, beside];
  assert.deepEqual(handLog([step(2, [ring('r', -50)])], live, 1), [
    'a stroke around box "Softmax" (circled?)',
  ]);
  assert.deepEqual(handLog([step(2, [ring('r', 950)])], live, 1), [
    'a stroke around g by "Loss", name "Loss" (circled?)',
  ]);
  assert.deepEqual(
    handLog([step(1, [box, label], 'before'), step(2, [{ ...box, isDeleted: true }])], [], 1),
    ['deleted box "Softmax"'],
  );
});

test('a mark on another’s shape says where it stands; a loose stroke is no mark', async () => {
  const { handRead } = await import('../packages/board/src/hand.js');
  const far = shape('far', {
    type: 'freedraw',
    x: 5000,
    y: 5000,
    points: [
      [0, 0],
      [20, 20],
    ],
  });
  const over = shape('over', {
    type: 'freedraw',
    x: 490,
    y: -10,
    width: 120,
    height: 120,
    points: [
      [0, 60],
      [60, 0],
      [120, 60],
      [60, 120],
      [0, 60],
    ],
  });
  const word = shape('w', { type: 'text', text: 'no', x: 520, y: 110, width: 30, height: 20 });
  const none = handRead([step(2, [far])], [b, far], 1);
  assert.equal(none.mark, undefined);
  assert.deepEqual(none.lines, ['a stroke near b (a sketch?)']);
  const marked = handRead([step(2, [over, word])], [b, over, word], 1);
  assert.deepEqual(marked.mark, { x: 490, y: -10, width: 120, height: 140 });
  assert.deepEqual(marked.lines, ['wrote "no" near b', 'a stroke around b (circled?)']);
});

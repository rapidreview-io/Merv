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

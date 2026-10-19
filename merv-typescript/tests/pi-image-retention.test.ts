import test from 'node:test';
import assert from 'node:assert/strict';
import { recentImages } from '../packages/pi/src/tool-image.js';
const view = (name: string, reference?: string) => ({
  role: 'toolResult',
  content: [
    {
      type: 'text',
      text: JSON.stringify(
        reference ? { page: `/ui/artifacts/${reference}` } : { path: '/ui/boards/board_1' },
      ),
    },
    { type: 'image', data: name },
  ],
});
const retained = (messages: ReturnType<typeof view>[]) =>
  recentImages(messages).flatMap((m) =>
    m.content.filter((p) => p.type === 'image').map((p) => p.data),
  );
test('source overview survives detail crops and two drawing inspections without mutating history', () => {
  const messages = [
    view('overview', 'art_1'),
    view('upper', 'art_1'),
    view('middle', 'art_1'),
    view('lower', 'art_1'),
    view('drawing'),
    view('drawing-detail'),
  ];
  const before = JSON.stringify(messages);
  assert.deepEqual(retained(messages), ['overview', 'lower', 'drawing', 'drawing-detail']);
  assert.equal(JSON.stringify(messages), before);
});
test('a new reference replaces the earlier retained source, and ordinary board work keeps two views', () => {
  assert.deepEqual(
    retained([
      view('old', 'art_old'),
      view('current', 'art_new'),
      view('detail', 'art_new'),
      view('drawing'),
      view('closeup'),
    ]),
    ['current', 'detail', 'drawing', 'closeup'],
  );
  assert.deepEqual(retained([view('one'), view('two'), view('three')]), ['two', 'three']);
});

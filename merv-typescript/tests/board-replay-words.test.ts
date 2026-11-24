/** A board's replay plays its whole conversation, at a pace set by the words (board-timeline.ts). */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { BoardChange } from '@merv/board/models';
import { timelineOf } from '../packages/ui/web/views/board-timeline.js';

const fixture = (name: string) => {
  const read = JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as
    BoardChange[] | { changes: BoardChange[] };
  return Array.isArray(read) ? read : read.changes;
};
/** Twenty drawings, seven with a line, and four lines said on their own: two the person's. */
const board = fixture('replay-history.json');

test('every line of the conversation plays, in the order it was said, the person’s too', () => {
  const first = board[1]!;
  const shape = first.shapes[0]!;
  const words = (shape.customData as { say: string }).say;
  const echo: BoardChange = { ...first, kind: 'said', shapes: [], said: { by: 'agent', words } };
  const moved: BoardChange = { ...first, kind: 'save', shapes: [{ ...shape, x: 40, version: 2 }] };
  const changes = [board[0]!, first, echo, moved, ...board.slice(2)];
  const line = timelineOf(changes.map((change, i) => ({ ...change, revision: i + 1 })));
  assert.equal(line.lines.filter((line) => line.words === words).length, 1);
  const { lines } = line;
  assert.equal(lines.length, 11, 'seven said with a drawing and four said on their own');
  assert.deepEqual(
    lines.filter(({ unit }) => unit === undefined).map(({ by, words }) => [by, words.slice(0, 15)]),
    [
      ['person', 'Conversation 0:'],
      ['agent', 'Conversation 5:'],
      ['person', 'Conversation 10'],
      ['agent', 'Conversation 15'],
    ],
  );
  assert.deepEqual(
    lines.map(({ step }) => step),
    [...lines.map(({ step }) => step)].sort((a, b) => a - b),
  );
  for (const [i, line] of lines.entries())
    if (i) assert.ok(line.start >= lines[i - 1]!.start, 'lines come in order on the clock');
  for (const each of line.lines) {
    if (each.unit === undefined) continue;
    const unit = line.units[each.unit]!;
    assert.equal(unit.start, each.start);
    assert.ok(unit.start + unit.ms <= each.end + 1e-6);
  }
});

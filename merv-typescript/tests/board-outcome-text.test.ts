import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hunksBetween, rebased } from '../packages/ui/web/views/board-outcome-text.js';

const applied = (text: string, hunks: ReturnType<typeof hunksBetween>) => {
  let out = text;
  for (const { from, to, insert } of [...hunks].reverse())
    out = out.slice(0, from) + insert + out.slice(to);
  return out;
};

test('what differs reaches the editor as the fewest changes, and they make the text exactly', () => {
  for (const [a, b] of [
    ['', 'first line'],
    ['first line', ''],
    ['one\ntwo\nthree', 'one\nTWO\nthree'],
    ['one\ntwo\nthree\n', 'top\none\ntwo\nthree\nbottom\n'],
    ['same\nsame\nsame', 'same\nsame\nsame\n'],
    ['a\n\nb\n\nc', 'x\n\na\n\nb\n\nc\n\ny'],
    ['# T\n\nline\n\nline\n', '# T\n\nline\n\nmore\nline\n'],
    ['😀 a', '😁 a'],
    ['no newline', 'no newline\n'],
    ['\r\nwindows\r\n', '\r\nwindows!\r\n'],
    ['x\ny', 'y\nx'],
  ] as const) {
    assert.equal(applied(a, hunksBetween(a, b)), b, JSON.stringify([a, b]));
  }
  assert.deepEqual(hunksBetween('same', 'same'), []);
  const long = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n');
  const rewritten = long.replaceAll('line', 'row');
  assert.equal(applied(long, hunksBetween(long, rewritten)), rewritten, 'a whole rewrite');
});

test('changes apart in one paragraph both stand, without either being a conflict', () => {
  const base = 'The first sentence is short. The second sentence is short too.';
  const mine = 'The first sentence is very short. The second sentence is short too.';
  const theirs = 'The first sentence is short. The second sentence is short too, in fact.';
  assert.equal(
    rebased(base, mine, theirs),
    'The first sentence is very short. The second sentence is short too, in fact.',
  );
  assert.equal(
    rebased(base, theirs, mine),
    'The first sentence is very short. The second sentence is short too, in fact.',
  );
});

test('conflicting edits preserve both authors at complete line boundaries', () => {
  for (const gap of ['\n', '\n\n', '\n\n\n', '\r\n']) {
    const base = `Heading${gap}original text${gap}End`;
    const mine = base.replace('original text', 'my replacement');
    const theirs = base.replace('original text', 'their replacement');
    const merged = rebased(base, mine, theirs);
    assert.ok(merged.includes('my replacement'));
    assert.ok(merged.includes('their replacement'));
    assert.ok(merged.indexOf('my replacement') < merged.indexOf('their replacement'));
    assert.equal(applied(theirs, hunksBetween(theirs, merged)), merged);
  }
  assert.equal(
    rebased('Heading\noriginal\nEnd', 'Heading\nmine\nEnd', 'Heading\ntheirs\nEnd'),
    'Heading\nmine\n\ntheirs\nEnd',
  );
  const rewritten = rebased(
    'Title\nHeading\nold',
    'Title\nHeading\nmine',
    'Title\nNew Heading\ntheirs',
  );
  assert.ok(rewritten.includes('New Heading\ntheirs'), 'a partial line is never an anchor');
});

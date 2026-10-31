import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EditorState } from '@codemirror/state';
import {
  hunksBetween,
  openingTitle,
  rebased,
} from '../packages/ui/web/views/board-outcome-text.js';

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

test('words on either side of a caret arrive as two changes, which leave it where it stands', () => {
  const was = 'Intro\n\nThe caret is here.\n\nEnd';
  const hunks = hunksBetween(was, 'Lead\n\nIntro\n\nThe caret is here.\n\nEnd\n\nTail');
  assert.equal(hunks.length, 2);
  const caret = was.indexOf('here');
  assert.ok(hunks[0]!.to <= caret && hunks[1]!.from >= caret);
});

test('two changes in one paragraph arrive as two, so a caret between them stays', () => {
  const was = 'Hello my typing world';
  const hunks = hunksBetween(was, 'BEFORE Hello my typing world AFTER');
  assert.equal(hunks.length, 2);
  assert.equal(applied(was, hunks), 'BEFORE Hello my typing world AFTER');
  assert.ok(hunks[0]!.to === 0 && hunks[1]!.from === was.length);
  // A sentence reworded in the middle touches only its words.
  const reworded = hunksBetween('One two three four five.', 'One two THREE four five.');
  assert.deepEqual(reworded, [{ from: 8, to: 13, insert: 'THREE' }]);
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

test("the document's own title is the heading it opens with", () => {
  assert.equal(openingTitle('# A plan\n\nwords'), 'A plan');
  assert.equal(openingTitle('\n\n# A plan #\n'), 'A plan');
  assert.equal(openingTitle('## A section'), null);
  assert.equal(openingTitle('words\n\n# Later'), null);
  assert.equal(openingTitle('#hashtag'), null);
  assert.equal(openingTitle(''), null);
});

test('Markdown stands in the editor byte for byte, whatever it holds', () => {
  const texts = [
    '# Title\n\n- list\n  - nested\n    - deeper\n* star\n+ plus\n\n1. one\n1. one again\n7) seven\n',
    '| a | b |\n|:--|--:|\n| `x|y` | \\| |\n\nno trailing newline',
    '```js\nconst a = 1;   \n\n\n```\n\n~~~\ntilde\n~~~\n\n    indented code\n',
    '[link](http://a.b "title") ![img](artifact:x) <http://auto.link> http://bare.link\n',
    'a stray * star and _ under and ` tick and ** two \\* escaped <b>html</b> &amp; entity\n',
    'Setext\n===\n\nOther\n---\n\n***\n\n___\n\n> quote\n>> deeper\n',
    '  leading spaces\ttabs\t\n\n\n\n\ntrailing   \n\n',
    'windows\r\nline\r\nendings\r\n',
    'old mac\rline\n separator paragraph\u0085next\n',
    '😀 emoji é accents 日本語 ​ zero width\n',
    '',
    '\n',
  ];
  for (const text of texts) {
    const state = EditorState.create({
      doc: text,
      extensions: [EditorState.lineSeparator.of('\n')],
    });
    assert.equal(state.doc.toString(), text);
    assert.equal(state.doc.length, text.length, "offsets are the text's own");
  }
});

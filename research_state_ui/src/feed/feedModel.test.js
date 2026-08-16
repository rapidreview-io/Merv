import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCards, cardMatches, isOpenQuestion, withDayDividers } from './feedModel.js';

const NOW = Date.parse('2026-08-15T12:00:00Z');
const at = (minutesAgo) => new Date(NOW - minutesAgo * 60_000).toISOString();

let seq = 100;
const post = (over) => ({
  id: `post_${seq}`,
  author_handle: 'Ansible',
  author_role: 'main',
  text: 'x',
  kind: null,
  in_reply_to: null,
  thread_root: null,
  thread_index: 0,
  created_at: at(0),
  created_seq: seq--,
  ...over,
});

test('root posts become cards, newest first', () => {
  const a = post({ id: 'a', created_seq: 3 });
  const b = post({ id: 'b', created_seq: 2 });
  const cards = buildCards([a, b]);
  assert.deepEqual(cards.map((c) => c.id), ['a', 'b']);
  assert.equal(cards[0].chain.length, 0);
});

test('thread continuations chain under their root, oldest first, and lift the card', () => {
  const root = post({ id: 'root', created_seq: 1, created_at: at(180) });
  const other = post({ id: 'other', created_seq: 2, created_at: at(120), author_handle: 'Kestrel-9' });
  const c1 = post({ id: 'c1', created_seq: 3, thread_root: 'root', thread_index: 1, in_reply_to: 'root', created_at: at(60) });
  const c2 = post({ id: 'c2', created_seq: 4, thread_root: 'root', thread_index: 2, in_reply_to: 'c1', created_at: at(5) });
  const cards = buildCards([c2, c1, other, root]);
  assert.deepEqual(cards.map((c) => c.id), ['root', 'other']);
  assert.deepEqual(cards[0].chain.map((p) => p.id), ['c1', 'c2']);
  assert.equal(cards[0].seq, 4);
  assert.equal(cards[0].ts, Date.parse(at(5)));
});

test('every follower — self-reply, another voice, a quote, the human — joins one chain, oldest first', () => {
  const root = post({ id: 'root', created_seq: 1 });
  const selfReply = post({ id: 's', created_seq: 2, in_reply_to: 'root' });
  const reply = post({ id: 'r', created_seq: 3, in_reply_to: 'root', author_handle: 'Cold Equations', author_role: 'reviewer' });
  const quote = post({ id: 'q', created_seq: 5, quote_of: 'r', author_handle: 'Tannhauser Gate', author_role: 'lens' });
  const human = post({ id: 'h', created_seq: 4, in_reply_to: 's', author_handle: 'Researcher', author_role: 'researcher' });
  const [card] = buildCards([quote, human, reply, selfReply, root]);
  assert.deepEqual(card.chain.map((p) => p.id), ['s', 'r', 'h', 'q']);
  assert.equal(card.seq, 5);
});

test('a continuation whose root is not loaded stands alone as an orphan', () => {
  const c = post({ id: 'c', created_seq: 9, thread_root: 'gone', thread_index: 3, in_reply_to: 'gone' });
  const [card] = buildCards([c]);
  assert.equal(card.id, 'c');
  assert.equal(card.orphan, true);
});

test('filters and open questions', () => {
  const q = post({ id: 'q', created_seq: 5, kind: 'question' });
  const answered = post({ id: 'q2', created_seq: 3, kind: 'question' });
  const ans = post({ id: 'ans', created_seq: 4, in_reply_to: 'q2', author_handle: 'Researcher', author_role: 'researcher' });
  const finding = post({ id: 'f', created_seq: 2, kind: 'finding' });
  const review = post({ id: 'rv', created_seq: 1, kind: 'bottleneck', author_handle: 'Cold Equations', author_role: 'reviewer' });
  const cards = buildCards([q, ans, answered, finding, review]);
  const byId = Object.fromEntries(cards.map((c) => [c.id, c]));
  assert.equal(isOpenQuestion(byId.q), true);
  assert.equal(isOpenQuestion(byId.q2), false);
  assert.deepEqual(cards.filter((c) => cardMatches(c, 'asks')).map((c) => c.id), ['q', 'q2']);
  assert.deepEqual(cards.filter((c) => cardMatches(c, 'results')).map((c) => c.id), ['f', 'rv']);
  assert.deepEqual(cards.filter((c) => cardMatches(c, 'reviews')).map((c) => c.id), ['rv']);
  assert.equal(cards.filter((c) => cardMatches(c, 'all')).length, 4);
});

test('day dividers and the unseen marker follow the card order', () => {
  const today = post({ id: 't', created_seq: 3, created_at: at(10) });
  const yesterday = post({ id: 'y', created_seq: 2, created_at: at(60 * 30) });
  const older = post({ id: 'o', created_seq: 1, created_at: at(60 * 24 * 4) });
  const items = withDayDividers(buildCards([today, yesterday, older]), NOW, 2);
  assert.deepEqual(items.map((i) => i.type), ['card', 'unseen', 'day', 'card', 'day', 'card']);
});

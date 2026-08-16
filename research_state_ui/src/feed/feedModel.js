// Presentation model for the feed: one shared clock, day dividers, and the
// grouping of a flat newest-first post list into cards (a root post with its
// thread continuations and its replies) plus the client-side filters.
import { useEffect, useState } from 'react';
import { fmtAgo } from '../utils/format.js';

// Shared ticking clock. One instance lives in Feed and flows down as a prop.
export function useNow(intervalMs = 30000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

// Calendar-aware (setDate handles DST days that aren't 24h long).
function yesterdayKey(now) {
  const d = new Date(now);
  d.setDate(d.getDate() - 1);
  return dayKey(d);
}

export function dayLabel(ts, now) {
  if (dayKey(ts) === dayKey(now)) return 'Today';
  if (dayKey(ts) === yesterdayKey(now)) return 'Yesterday';
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

// A post's timestamp: relative while it is from today ("5m ago"); on older
// days the divider already names the date, so just the clock time ("2:05 PM").
export function postTime(ts, now) {
  if (ts == null || !Number.isFinite(ts)) return '';
  if (dayKey(ts) === dayKey(now)) return fmtAgo(now - ts);
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// -- filters -----------------------------------------------------------------

export const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'results', label: 'Results' },
  { id: 'ideas', label: 'Ideas & papers' },
  { id: 'asks', label: 'Asks' },
  { id: 'reviews', label: 'Reviews' },
];

const RESULT_KINDS = new Set(['finding', 'kill', 'status', 'bottleneck']);
const IDEA_KINDS = new Set(['idea', 'hunch', 'paper', 'direction']);

// A question is open until the researcher has answered it in the thread.
export function isOpenQuestion(card) {
  return card.post.kind === 'question'
    && !card.chain.some((p) => p.author_role === 'researcher');
}

export function cardMatches(card, filter) {
  const { post } = card;
  switch (filter) {
    case 'results': return RESULT_KINDS.has(post.kind);
    case 'ideas': return IDEA_KINDS.has(post.kind);
    case 'asks': return post.kind === 'question';
    case 'reviews': return post.author_role === 'reviewer' || post.author_role === 'lens';
    default: return true;
  }
}

// -- cards -------------------------------------------------------------------

function seqOf(post) { return Number(post.created_seq) || 0; }
function tsOf(post) {
  const ts = post.created_at ? Date.parse(post.created_at) : NaN;
  return Number.isFinite(ts) ? ts : null;
}

// The one previous post this post follows: a reply, a continuation, or a
// quote — one relation, rendered one way.
export function parentOf(post) {
  return post.in_reply_to || post.quote_of || null;
}

/**
 * Group the flat newest-first list into cards. A card is a root post plus
 * `chain`: every loaded post that follows it (directly or through another
 * follower), by any voice, oldest first — the UI draws the whole card as one
 * thread under a single connector. Cards sort newest-first by their newest
 * member, so a thread that just got a reply or a checkpoint surfaces. A post
 * whose parent is beyond the loaded window stands alone as an `orphan` card
 * (it still carries the server's compact `quoted` view of what it follows).
 */
export function buildCards(posts) {
  const byId = new Map(posts.map((p) => [p.id, p]));
  const cards = new Map(); // root id -> card
  const rootOf = (post) => {
    let current = post;
    let guard = 0;
    while (guard++ < 50) {
      const parent = parentOf(current);
      const up = parent && byId.has(parent) ? byId.get(parent) : null;
      if (!up || up.id === current.id) return current;
      current = up;
    }
    return current;
  };
  const ensure = (root, orphan = false) => {
    if (!cards.has(root.id)) {
      cards.set(root.id, { id: root.id, post: root, chain: [], orphan, seq: seqOf(root), ts: tsOf(root) });
    }
    return cards.get(root.id);
  };
  for (const post of posts) {
    if (!parentOf(post)) ensure(post);
  }
  for (const post of posts) {
    if (!parentOf(post)) continue;
    const root = rootOf(post);
    if (root.id === post.id) {
      ensure(post, true);
      continue;
    }
    const card = ensure(root);
    card.chain.push(post);
    card.seq = Math.max(card.seq, seqOf(post));
    const ts = tsOf(post);
    if (ts != null && (card.ts == null || ts > card.ts)) card.ts = ts;
  }
  const out = [...cards.values()];
  for (const card of out) card.chain.sort((a, b) => seqOf(a) - seqOf(b));
  out.sort((a, b) => b.seq - a.seq);
  return out;
}

/**
 * Interleave day dividers into the newest-first card list. The leading "Today"
 * divider is skipped; any other day change gets one. `lastSeenSeq` places one
 * `unseen` marker between the newest already-seen card and everything above.
 */
export function withDayDividers(cards, now, lastSeenSeq = null) {
  const items = [];
  let prevKey = dayKey(now);
  let unseenPlaced = lastSeenSeq == null || (cards.length > 0 && cards[0].seq <= lastSeenSeq);
  for (const card of cards) {
    if (!unseenPlaced && card.seq <= lastSeenSeq) {
      items.push({ type: 'unseen', id: 'unseen' });
      unseenPlaced = true;
    }
    if (card.ts != null) {
      const key = dayKey(card.ts);
      if (key !== prevKey) {
        items.push({ type: 'day', id: `day-${key}-${card.id}`, ts: card.ts });
        prevKey = key;
      }
    }
    items.push({ type: 'card', id: card.id, card });
  }
  if (!unseenPlaced && cards.length) items.push({ type: 'unseen', id: 'unseen' });
  return items;
}

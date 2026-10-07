/**
 * A unit's history read as a thread. Its owner tells it (unit-history.test.ts); the page draws
 * what it is told: a submission is its producer's post, the verdict that answered it the
 * reviewer's, a return a quiet line after it, and a gate still open the last line — with no
 * number, no id and nothing made up in between.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mount, serve, text, unmount } from './ui-render.js';

const { createElement } = await import('react');
const { MemoryRouter } = await import('react-router-dom');
// components.tsx first: it and list-filters.tsx import each other through a view, and
// only this order has every module evaluated before another one calls into it.
await import('../packages/ui/web/components.js');
const { Thread, historyEntries } = await import('../packages/ui/web/thread.js');

const FIRST = 'art_00000000000000000000000000000002';
const TABLE = 'art_00000000000000000000000000000003';
const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 9, minute)).toISOString();
const names: Record<string, string> = { actor_ada: 'Ada Byron', actor_rex: 'Rex Reviewer' };
const nameOf = (id: string) => names[id];

/** A delivery sent back, the return, a second delivery, and its review still unclaimed. */
const history = (producer: string) => [
  {
    role: 'producer' as const,
    stage: 'in_progress',
    actor: producer,
    at: at(0),
    said: 'Delivered',
    artifact: { id: FIRST, title: 'Delivery: first try' },
  },
  {
    role: 'reviewer' as const,
    stage: 'in_review',
    actor: 'actor_rex',
    at: at(10),
    verdict: { word: 'needs_changes', met: 1, of: 3, text: 'The curve is there; the seed is not.' },
    review: 'review_1',
  },
  { at: at(10), said: 'Returned to in progress' },
  {
    role: 'producer' as const,
    stage: 'in_progress',
    actor: producer,
    at: at(20),
    said: 'Delivered',
    // Every file a delivery handed in besides its report.
    files: [{ id: TABLE, title: 'Seeds table' }],
  },
  { role: 'reviewer' as const, stage: 'in_review', said: 'Review unclaimed', review: 'review_2' },
];

test('a history is a thread: posts by role and name, quiet lines, and a review open as its way', () => {
  const entries = historyEntries(history('actor_ada'), nameOf);
  assert.deepEqual(
    entries.map((entry) =>
      entry.kind === 'post'
        ? [entry.role, entry.who, entry.said ?? entry.verdict?.word]
        : ['line', entry.said, entry.review ?? null],
    ),
    [
      ['Producer', 'Ada Byron', 'Delivered'],
      ['Reviewer', 'Rex Reviewer', 'needs_changes'],
      ['line', 'Returned to in progress', null],
      ['Producer', 'Ada Byron', 'Delivered'],
      ['line', 'Review unclaimed', 'review_2'],
    ],
  );
  // Beside the unit's threads each entry has its role's disc instead, and the open review is
  // its Review section's to reach.
  const marked = historyEntries(history('actor_ada'), nameOf, (entry) =>
    entry.role ? { letter: entry.role[0]!.toUpperCase(), label: 'Thread' } : undefined,
  );
  const last = marked.at(-1)!;
  assert.equal(last.kind === 'line' && last.review, undefined);
  assert.equal(last.mark?.letter, 'R');
});

test('a thread is read in words: the role alone for a stranger, files to open, no ids', async (t) => {
  t.after(async () => await unmount());
  // A review opens at the reviews row's page, where the composition has one.
  serve('/tools/ui.shell', {
    body: { result: { rows: [{ id: 'reviews', path: '/reviews', view: { kind: 'reviews' } }] } },
  });
  serve('/tools/artifact.list', {
    body: {
      result: [
        {
          id: FIRST,
          projectId: 'project_1',
          createdBy: 'actor_stranger',
          title: 'Delivery: first try',
          mediaType: 'text/markdown',
          hash: 'abc',
          size: 120,
          createdAt: at(0),
        },
        {
          id: TABLE,
          projectId: 'project_1',
          createdBy: 'actor_stranger',
          title: 'Seeds table',
          mediaType: 'text/csv',
          hash: 'def',
          size: 40,
          createdAt: at(20),
        },
      ],
    },
  });
  const entries = historyEntries(history('actor_stranger'), nameOf);
  await mount(createElement(MemoryRouter, null, createElement(Thread, { entries })));
  const posts = [...document.querySelectorAll('.thread > li:not(.feed-line)')];
  // Nobody the reader can name is a disc with a dot, and the part they played.
  assert.equal(posts[0]!.querySelector('.feed-avatar')?.textContent, '·');
  assert.deepEqual(
    [...posts[0]!.querySelectorAll('.feed-author, .thread-role')].map((said) => said.textContent),
    ['Producer'],
  );
  // The earlier delivery still opens from its own post.
  assert.match(posts[0]!.querySelector('details.crit-file summary')!.textContent!, /first try/);
  // A later delivery names every file it handed in.
  assert.match(posts[2]!.querySelector('details.crit-file summary')!.textContent!, /Seeds table/);
  assert.deepEqual(
    [...posts[1]!.querySelectorAll('.feed-author, .thread-role')].map((said) => said.textContent),
    ['Rex Reviewer', 'Reviewer'],
  );
  // A verdict is its word and its squares; its sentence and the way to it open on a press.
  assert.match(posts[1]!.querySelector('.verdict-line')!.textContent!, /needs changes/);
  assert.equal(posts[1]!.querySelector('[aria-label="1 of 3 met"]')?.getAttribute('role'), 'img');
  assert.deepEqual(
    [...document.querySelectorAll('.thread a.hit')].map((link) => link.getAttribute('href')),
    ['/reviews/review_2'],
  );
  assert.deepEqual(
    [...document.querySelectorAll('.feed-said')].map((line) => line.textContent),
    ['Returned to in progress', 'Review unclaimed'],
  );
  assert.doesNotMatch(text(), /review_|art_|wf_|actor_|round|attempt/i, 'no id and no number');
});

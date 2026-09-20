/**
 * The feed, rendered. A post is known by who wrote it — initials, a name, a time —
 * and never by the word for what it is; every entry stands on the same two columns;
 * a body is read as the document it may be; and a file a post attaches wears the
 * glyph of its type.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mount, serve, text, unmount } from './ui-render.js';

const { createElement } = await import('react');
const { MemoryRouter } = await import('react-router-dom');
const { FeedView } = await import('../packages/ui/web/views/feed.js');
const { initials } = await import('../packages/ui/web/views/people.js');

const TASK = `wf_${'1'.repeat(32)}`;
const FILE = `art_${'a'.repeat(32)}`;
const at = (ms: number) => new Date(Date.now() + ms).toISOString();
const row = (id: string) => ({
  id,
  label: id,
  group: 'activity',
  order: 1,
  path: `/${id}`,
  view: { kind: id },
  status: {},
  readable: true,
});
const shell = { rows: [row('feed'), row('artifacts')], plugins: [] };
const page = () =>
  createElement(
    MemoryRouter,
    { initialEntries: ['/feed'] },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createElement(FeedView as any, { row: shell.rows[0], shell }),
  );

function fixtures() {
  serve('/tools/ui.home', {
    body: {
      result: {
        actors: [{ id: 'actor_a', name: 'Codex producer' }],
        tasks: [{ id: TASK, title: 'Sweep weight decay' }],
      },
    },
  });
  serve('/tools/artifact.list', {
    body: {
      result: [
        { id: FILE, title: 'curve.csv', mediaType: 'text/csv', size: 10, createdAt: at(-1) },
      ],
    },
  });
  serve('/tools/feed.list', {
    body: {
      result: [
        {
          id: 'post_1',
          authorId: 'actor_a',
          body: `Reproduced at **seed 7**; see ${TASK}.`,
          artifactIds: [FILE],
          createdAt: at(-60_000),
        },
      ],
    },
  });
  serve('/tools/feed.activity', {
    body: {
      result: [
        {
          id: 1,
          type: 'workflow.transition',
          subjectId: TASK,
          data: { to: 'in_progress' },
          createdAt: at(-120_000),
        },
        // A subject nothing names is not a line.
        {
          id: 2,
          type: 'workflow.transition',
          subjectId: 'wf_unknown',
          data: { to: 'done' },
          createdAt: at(-90_000),
        },
      ],
    },
  });
}

test('a post is known by its author, and every entry stands on one column', async (t) => {
  t.after(unmount);
  fixtures();
  await mount(page());
  const feed = document.querySelector('.feed')!;
  assert.ok(feed, text().slice(0, 400));
  assert.equal(feed.querySelector('.kind'), null, 'no entry prints the word for what it is');
  assert.equal(feed.querySelector('.feed-avatar')?.textContent, 'CP');
  assert.ok(text().includes('Codex producer'));
  // One anatomy: a gutter and the words, so the times share one right edge.
  assert.equal(feed.children.length, 2);
  for (const entry of feed.children) assert.ok(entry.classList.contains('feed-entry'));
  assert.ok(text().includes('Sweep weight decay is now in progress'), text());
  assert.equal(feed.querySelectorAll('.feed-line svg').length, 1, 'a line wears its glyph');
  assert.equal(
    document.querySelector('input[type="search"]')?.getAttribute('placeholder'),
    'Search',
  );
});

test('a body is read as markdown, its ids as names, and a file by its type', async (t) => {
  t.after(unmount);
  fixtures();
  await mount(page());
  const body = document.querySelector('.feed-body')!;
  assert.equal(body.querySelector('strong')?.textContent, 'seed 7');
  const named = body.querySelector('a.record-link');
  assert.equal(named?.textContent, 'Sweep weight decay');
  assert.ok(!text().includes(TASK), 'no identifier is printed');
  const file = document.querySelector('a.feed-file')!;
  assert.equal(file.textContent, 'curve.csv');
  assert.equal(file.getAttribute('href'), `/artifacts/${FILE}`);
  assert.ok(file.querySelector('svg'), 'the file wears the glyph of its type');
});

test('initials are the first letters of up to two words, and a dot for nobody', () => {
  assert.equal(initials('Codex producer'), 'CP');
  assert.equal(initials('Demo · weight-decay researcher'), 'DW');
  assert.equal(initials('operator'), 'O');
  assert.equal(initials(undefined), '·');
});

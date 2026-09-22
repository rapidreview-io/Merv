import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accountLines,
  buildNavigation,
  documentTitle,
  dormantOwner,
  headed,
  topRows,
} from '../packages/ui/web/navigation.js';
import type { PluginState, Row } from '../packages/ui/web/shell-types.js';

const row = (id: string, kind: string, group: string, order: number, path = `/${id}`): Row => ({
  id,
  label: id,
  group,
  order,
  path,
  view: { kind },
  status: {},
  readable: false,
});

test('the rail lists places, hides the rows other pages absorbed, and owns the Work row', () => {
  const rows = [
    row('connections', 'connections', 'system', 40, '/external-connections'),
    row('settings', 'settings', 'settings', 100),
    row('people', 'people', 'project', 2, '/members'),
    row('research-provider', 'research', 'work', 8, '/cycles'),
    row('jobs', 'tasks', 'work', 12, '/task-browser'),
    row('trials', 'experiments', 'work', 13),
    row('verdicts', 'reviews', 'work', 14),
    row('artifacts', 'artifacts', 'work', 21),
    row('paper', 'paper', 'work', 16),
    row('reflections', 'reflections', 'work', 35),
    row('feed', 'feed', 'activity', 30),
  ];
  const before = structuredClone(rows);
  const sections = buildNavigation(rows);
  assert.deepEqual(
    sections.map((section) => section.id),
    ['research', 'work', 'activity'],
  );
  // The wave of work is one row the shell owns; the kinds inside it are not places.
  assert.deepEqual(
    sections.find((section) => section.id === 'work')!.rows.map((entry) => entry.id),
    ['work', 'reflections'],
  );
  // The paper stands with Home and Now, so it is not one of the sections' rows.
  assert.deepEqual(
    topRows(rows).map((entry) => entry.id),
    ['paper'],
  );
  const shown = sections.flatMap((section) => section.rows.map((entry) => entry.id));
  for (const hidden of [
    'research-provider',
    'jobs',
    'trials',
    'verdicts',
    'people',
    'connections',
    'paper',
  ])
    assert.ok(!shown.includes(hidden), `${hidden} is registered but not a place`);
  // Every row the rail does show is the registration itself, untouched.
  for (const entry of sections.flatMap((section) => section.rows))
    if (entry.id !== 'work')
      assert.equal(
        entry,
        rows.find((original) => original.id === entry.id),
      );
  const work = sections.find((section) => section.id === 'work')!.rows[0];
  assert.deepEqual({ path: work.path, kind: work.view.kind }, { path: '/work', kind: 'work' });
  assert.ok(!rows.includes(work), 'no plugin registered the Work row');
  assert.deepEqual(rows, before);
  // Work appears only with the work it opens; the archive only when it holds records.
  const listed = (entries: Row[]) =>
    buildNavigation(entries).flatMap((section) => section.rows.map((entry) => entry.id));
  assert.deepEqual(listed([row('reflections', 'reflections', 'work', 35)]), ['reflections']);
  const archive = row('legacy-history', 'legacy-history', 'work', 19);
  assert.deepEqual(listed([archive]), []);
  archive.status = { count: 412 };
  assert.deepEqual(listed([archive]), ['legacy-history']);
});

test('unknown views retain their declared group, path, status and deterministic ordering', () => {
  const rows = [
    row('z-lab', 'new-scientific-view', 'science-lab', 20, '/laboratory/results'),
    row('feed', 'custom-dashboard', 'extensions', 10, '/custom-feed'),
    row('a-lab', 'another-future-view', 'science-lab', 20, '/laboratory/input'),
  ];
  rows[0].status = { state: 'unavailable', detail: 'Owner is reconnecting' };
  const sections = buildNavigation(rows);
  assert.deepEqual(
    sections.map(({ id, label }) => ({ id, label })),
    [
      { id: 'extensions', label: 'Extensions' },
      { id: 'science-lab', label: 'Science Lab' },
    ],
  );
  assert.deepEqual(
    sections[1].rows.map((entry) => entry.id),
    ['a-lab', 'z-lab'],
  );
  assert.equal(sections[0].rows[0].path, '/custom-feed');
  assert.equal(sections[1].rows[1], rows[0]);
  assert.equal(sections[1].rows[1].status.state, 'unavailable');
});

test('plugin removal removes only its rows and re-addition restores navigation without duplicates', () => {
  const tasks = row('tasks', 'tasks', 'work', 10);
  const feed = row('feed', 'feed', 'activity', 20);
  const artifacts = row('artifacts', 'artifacts', 'work', 21);
  const extension = row('custom', 'unrecognized', 'extensions', 30);
  const all = [tasks, feed, artifacts, extension];
  const initial = buildNavigation(all);
  // Files belong to Research; the tasks row is not a place, but Work opens on it.
  assert.deepEqual(initial[0].rows, [artifacts]);
  assert.deepEqual(
    initial.map((section) => section.id),
    ['research', 'work', 'activity', 'extensions'],
  );
  const removed = buildNavigation([tasks, extension]);
  assert.deepEqual(
    removed.flatMap((section) => section.rows.map((entry) => entry.id)),
    ['work', 'custom'],
  );
  assert.ok(!removed.some((section) => section.id === 'activity'));
  assert.deepEqual(buildNavigation([extension, artifacts, tasks, feed]), initial);
  assert.deepEqual(buildNavigation([]), []);
  assert.deepEqual(buildNavigation([row('settings', 'settings', 'settings', 100)]), []);
});

test('a heading is drawn only where it names more than its one row already says', () => {
  const labelled = (
    id: string,
    kind: string,
    group: string,
    order: number,
    label: string,
  ): Row => ({
    ...row(id, kind, group, order),
    label,
  });
  const sections = buildNavigation([
    labelled('artifacts', 'artifacts', 'work', 21, 'Files'),
    labelled('sessions', 'sessions', 'work', 25, 'Sessions'),
    labelled('feed', 'feed', 'activity', 30, 'Feed'),
  ]);
  assert.deepEqual(
    sections.map((section) => [section.label, headed(section)]),
    [
      ['Research', true],
      // One row, and a different word from its heading: the heading still says something.
      ['Agents', true],
      // Feed over Feed says the same word twice, so the row stands alone.
      ['Feed', false],
    ],
  );
  // The comparison is of words, not of bytes; a second row brings the heading back.
  const feed = {
    id: 'activity',
    label: 'Feed',
    rows: [labelled('feed', 'feed', 'activity', 30, ' feed ')],
  };
  assert.equal(headed(feed), false);
  feed.rows.push(labelled('digest', 'feed', 'activity', 31, 'Digest'));
  assert.equal(headed(feed), true);
  assert.equal(headed({ id: 'empty', label: 'Empty', rows: [] }), true);
});

test('the account row prints the role only where it adds to the name', () => {
  assert.deepEqual(accountLines('Operator', 'operator'), ['Operator']);
  assert.deepEqual(accountLines('Ada Lovelace', 'operator'), ['Ada Lovelace', 'Operator']);
  assert.deepEqual(accountLines('ada@example.org', 'reviewer'), ['ada@example.org', 'Reviewer']);
  // An account nobody named is known by its role, written as a person writes it.
  assert.deepEqual(accountLines(undefined, 'operator'), ['Operator']);
});

test('the document is titled by its page, its project and the app, each said once', () => {
  assert.equal(documentTitle('Work', 'Grokking replication'), 'Work · Grokking replication · Merv');
  // Home's heading is the project's name, and a page still loading has no heading yet.
  assert.equal(
    documentTitle('Grokking replication', 'Grokking replication'),
    'Grokking replication · Merv',
  );
  assert.equal(documentTitle(undefined, 'Grokking replication'), 'Grokking replication · Merv');
  assert.equal(documentTitle('  ', 'Merv'), 'Merv');
});

test('a missing page speaks of a plugin only where the shell can show one that is not active', () => {
  const kinds = ['feed', 'paper', 'settings'];
  const plugin = (id: string, state: string, name = `@merv/${id}`): PluginState => ({
    id,
    name,
    state,
  });
  const rows = [row('artifacts', 'artifacts', 'work', 21)];
  const plugins = [plugin('paper-ui', 'active'), plugin('feed-ui', 'disabled')];
  assert.equal(dormantOwner('/feed', kinds, rows, plugins)?.id, 'feed-ui');
  assert.equal(dormantOwner('/feed/post_1', kinds, rows, plugins)?.id, 'feed-ui');
  // An entry is named by whoever configured it; the module it loads says what it is.
  assert.equal(
    dormantOwner('/feed', kinds, rows, [plugin('stream', 'failed', '@merv/feed/ui')])?.id,
    'stream',
  );
  // A mistyped address, a kind this build cannot draw, a kind whose row is registered
  // and a plugin that is running are none of them a plugin's absence.
  assert.equal(dormantOwner('/nope', kinds, rows, plugins), undefined);
  assert.equal(dormantOwner('/', kinds, rows, plugins), undefined);
  assert.equal(
    dormantOwner('/telemetry', kinds, rows, [plugin('telemetry-ui', 'disabled')]),
    undefined,
  );
  assert.equal(dormantOwner('/paper/methods/extra', kinds, rows, plugins), undefined);
  assert.equal(dormantOwner('/feed', kinds, rows, [plugin('feed-ui', 'active')]), undefined);
});

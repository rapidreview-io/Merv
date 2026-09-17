import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNavigation, topRows } from '../packages/ui/web/navigation.js';
import type { Row } from '../packages/ui/web/shell-types.js';

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
    row('claims', 'claims', 'work', 15),
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

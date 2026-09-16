import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNavigation } from '../packages/ui/web/navigation.js';
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

test('navigation groups actual view kinds without changing server routes or inventing rows', () => {
  const rows = [
    row('connections', 'connections', 'system', 40, '/external-connections'),
    row('settings', 'settings', 'settings', 100),
    row('people', 'people', 'project', 2, '/members'),
    row('research-provider', 'research', 'work', 8, '/cycles'),
    row('jobs', 'tasks', 'work', 12, '/task-browser'),
    row('feed', 'feed', 'activity', 30),
  ];
  const before = structuredClone(rows);
  const sections = buildNavigation(rows);
  assert.deepEqual(
    sections.map((section) => section.id),
    ['research', 'work', 'operations', 'activity'],
  );
  assert.deepEqual(
    sections.find((section) => section.id === 'operations')!.rows.map((entry) => entry.id),
    ['people', 'connections'],
  );
  const shown = sections.flatMap((section) => section.rows);
  assert.deepEqual(
    shown.map((entry) => entry.id).sort(),
    rows
      .filter((entry) => entry.group !== 'settings')
      .map((entry) => entry.id)
      .sort(),
  );
  for (const entry of shown)
    assert.equal(
      entry,
      rows.find((original) => original.id === entry.id),
    );
  assert.deepEqual(rows, before);
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
  const research = row('research', 'research', 'work', 10);
  const feed = row('feed', 'feed', 'activity', 20);
  const activity = row('activity', 'activity', 'activity', 21);
  const extension = row('custom', 'unrecognized', 'extensions', 30);
  const all = [research, feed, activity, extension];
  const initial = buildNavigation(all);
  const removed = buildNavigation([research, extension]);
  assert.deepEqual(
    removed.flatMap((section) => section.rows),
    [research, extension],
  );
  assert.ok(!removed.some((section) => section.id === 'activity'));
  assert.deepEqual(buildNavigation([extension, activity, research, feed]), initial);
  assert.deepEqual(buildNavigation([]), []);
  assert.deepEqual(buildNavigation([row('settings', 'settings', 'settings', 100)]), []);
});

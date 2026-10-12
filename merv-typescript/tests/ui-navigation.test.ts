import type { UiRowDescription } from '@merv/ui/rows';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accountLines,
  documentTitle,
  dormantOwner,
  holds,
  homeOf,
  MOVED,
  railSections,
} from '../packages/ui/web/navigation.js';
import type { PluginState } from '../packages/ui/web/shell-types.js';

const row = (
  id: string,
  kind: string,
  group: string,
  order: number,
  path = `/${id}`,
): UiRowDescription => ({
  id,
  label: id,
  group,
  order,
  path,
  view: { kind },
  status: {},
  readable: false,
});

test('the rail is Home with Work, Pi and Board, then Fleet and Ops; every other row is left out', () => {
  const work = row('work', 'work', 'lead', 14);
  const rows: UiRowDescription[] = [
    row('settings', 'settings', 'settings', 100),
    row('artifacts', 'artifacts', 'research', 21),
    row('code', 'code', 'operations', 25),
    row('sandboxes', 'sandboxes', 'operations', 45),
    row('sessions', 'sessions', 'operations', 24),
    row('boards', 'board', 'research', 22),
    row('pi', 'pi', 'operations', 23),
    work,
    // Registered, but not places on the rail.
    row('paper', 'paper', 'top', 16),
    row('feed', 'feed', 'activity', 30),
    row('reflections', 'reflections', 'hidden', 35),
    row('connections', 'connections', 'hidden', 40, '/external-connections'),
    {
      ...row('legacy-history', 'legacy-history', 'research', 19),
      whenCounted: true,
      status: { count: 412 },
    },
  ];
  const before = structuredClone(rows);
  const sections = railSections(rows);
  assert.deepEqual(
    sections.map((section) => [section.label, section.rows.map((entry) => entry.id)]),
    [
      ['', ['work', 'pi', 'boards']],
      ['Fleet', ['sessions', 'sandboxes']],
      ['Ops', ['code', 'artifacts', 'settings']],
    ],
  );
  // The rail draws the registrations themselves, untouched.
  assert.equal(sections[0]!.rows[0], work);
  assert.deepEqual(rows, before);
  // No page is nowhere: a page the rail leaves out lights the Work row.
  const lit = (pathname: string) =>
    sections
      .flatMap((section) => section.rows)
      .filter((entry) => holds(entry, pathname, rows))
      .map((entry) => entry.id);
  assert.deepEqual(lit('/work'), ['work']);
  assert.deepEqual(lit('/paper'), ['work']);
  assert.deepEqual(lit('/reflections/wf_2'), ['work']);
  assert.deepEqual(lit('/artifacts/art_1'), ['artifacts']);
  assert.deepEqual(lit('/nowhere'), []);
});

test('a section with none of its rows registered is left out, but the first always stands for Home', () => {
  assert.deepEqual(
    railSections([row('code', 'code', 'operations', 25)]).map((section) => section.label),
    ['', 'Ops'],
  );
  assert.deepEqual(
    railSections([{ ...row('sessions', 'sessions', 'hidden', 24) }]).map((s) => s.label),
    [''],
  );
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

test('a retired address and a record’s way back lead to the lead row, and to Home without one', () => {
  const work = row('work', 'work', 'lead', 14);
  const tasks = row('tasks', 'tasks', 'work', 15);
  assert.equal(MOVED.running([work, tasks]), '/work');
  assert.deepEqual(homeOf([work, tasks]), { to: '/work', label: 'work' });
  // Research off: no row answers /work, so a link there would land on a missing page.
  assert.equal(MOVED.running([tasks]), '/');
  assert.deepEqual(homeOf([tasks]), { to: '/', label: 'Home' });
  assert.equal(MOVED.connections([tasks]), '/settings/connections');
  // What needs the reader is Home's first part, whatever the composition.
  assert.equal(MOVED.now([work, tasks]), '/');
});

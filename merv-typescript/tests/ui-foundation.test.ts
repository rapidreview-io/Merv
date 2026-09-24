/**
 * The shared pieces every list and record is built from. Each test states one
 * thing a page must do without being told twice: say a kind only where kinds
 * mix, offer the first record from the empty state itself, give a form one
 * Cancel and one way out, state a time to the minute, and know a file by its type.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { click, mount, resize, serve, settle, text, unmount } from './ui-render.js';

const { createElement, useState } = await import('react');
const { Link, MemoryRouter, Route, Routes, useLocation } = await import('react-router-dom');
const { act } = await import('react-dom/test-utils');
// components.tsx first: it and list-filters.tsx import each other through a view, and
// only this order has every module evaluated before another one calls into it.
const { KV, stamp, timeRows, toneOf } = await import('../packages/ui/web/components.js');
const { ListPage, mixesKinds, splitRoutes, stateCounts, useListFilter } =
  await import('../packages/ui/web/list-filters.js');
const { fileIcon } = await import('../packages/ui/web/icons.js');
const { reviewClause } = await import('../packages/ui/web/states.js');
const { CollectionView } = await import('../packages/ui/web/views/remote.js');

interface Item {
  id: string;
  kind: string;
  name: string;
  state: string;
}
const task = (id: string, state = 'in_progress'): Item => ({
  id,
  kind: 'tasks',
  name: `Task ${id}`,
  state,
});
const experiment: Item = { id: 'e1', kind: 'experiments', name: 'Experiment e1', state: 'running' };

/** A collection as a view writes one: every row names its kind, and the list decides. */
function Page({
  items,
  creates = true,
  checks = false,
}: {
  items: Item[];
  creates?: boolean;
  checks?: boolean;
}) {
  const filter = useListFilter(items, {
    stateOf: (item: Item) => item.state,
    isOpen: (state: string) => state !== 'done',
    mine: (item: Item) => item.id === 't1',
    labels: (item: Item) => [item.name],
  });
  return createElement(ListPage<Item>, {
    load: { loading: false, data: items },
    noun: 'work',
    kind: 'work',
    filter,
    line: (item: Item) => ({ kind: item.kind, name: item.name }),
    emptyTitle: 'No work yet',
    create: creates
      ? {
          label: 'New cycle',
          form: (close: () => void) =>
            createElement(
              'form',
              { 'aria-label': 'New cycle' },
              createElement('input', { 'aria-label': 'Name' }),
              createElement('button', { type: 'button', onClick: close }, 'Create'),
            ),
        }
      : undefined,
    aside: checks
      ? {
          label: 'Check references',
          plain: true,
          form: () => createElement('form', { 'aria-label': 'Check references' }),
        }
      : undefined,
  });
}
const page = (items: Item[], creates = true, checks = false) =>
  createElement(
    MemoryRouter,
    { initialEntries: ['/work'] },
    createElement(Page, { items, creates, checks }),
  );
const kinds = () => [...document.querySelectorAll('.rows .kind')].map((node) => node.textContent);
/**
 * What the page holds, and what the cursor is on, asked as questions rather than
 * compared as nodes. `assert` prints a failed comparison by inspecting both sides
 * to a depth of a thousand, and every node React rendered carries its own fiber:
 * inspecting one walks the whole tree back through the document, so a comparison
 * of two of them fills the heap instead of saying which one it wanted.
 */
const shows = (selector: string) => !!document.querySelector(selector);
const cursorOn = (selector: string) =>
  !!document.activeElement && document.activeElement === document.querySelector(selector);

test('a list prints the kind of a row only while its rows are of more than one kind', async (t) => {
  t.after(async () => await unmount());
  assert.equal(
    mixesKinds([
      { kind: 'tasks', name: 'a' },
      { kind: 'tasks', name: 'b' },
    ]),
    false,
  );
  assert.equal(mixesKinds([{ kind: 'tasks', name: 'a' }, { name: 'b' }]), false);
  assert.equal(
    mixesKinds([
      { kind: 'tasks', name: 'a' },
      { kind: 'experiments', name: 'b' },
    ]),
    true,
  );

  await mount(page([task('t1'), task('t2')]));
  assert.deepEqual(kinds(), [], 'one kind down the whole list says nothing');
  await unmount();

  await mount(page([task('t1'), experiment]));
  assert.deepEqual(kinds(), ['Task', 'Experiment']);
});

test('the filters are pressed buttons in named groups, and a search that says one word', async (t) => {
  t.after(async () => await unmount());
  await mount(page([task('t1'), task('t2'), task('t3', 'done')]));
  const scope = document.querySelector('.segments')!;
  assert.equal(scope.getAttribute('role'), 'group');
  assert.equal(scope.getAttribute('aria-label'), 'Whose work');
  const pressed = (group: Element) =>
    [...group.querySelectorAll('button')]
      .filter((button) => button.getAttribute('aria-pressed') === 'true')
      .map((button) => button.textContent);
  assert.deepEqual(pressed(scope), ['Everyone']);
  await click('Mine');
  assert.deepEqual(pressed(scope), ['Mine']);
  assert.ok(!text().includes('Task t2'), 'Mine keeps only the reader’s rows');

  // The list opened on its open work: that chip is the pressed one, and the number
  // beside it is the number of rows on screen — the reader's one, not the list's two.
  assert.deepEqual(pressed(document.querySelector('.chips')!), ['open 1']);
  assert.equal(document.querySelectorAll('.rows > .row').length, 1);
  await click('Everyone');
  assert.deepEqual(pressed(document.querySelector('.chips')!), ['open 2']);
  const search = document.querySelector<HTMLInputElement>('.search input')!;
  assert.equal(search.placeholder, 'Search');
  assert.equal(search.getAttribute('aria-label'), 'Search work');
  assert.ok(shows('.search svg[aria-hidden="true"]'), 'the glyph says what it is');
});

test('a chip counts the rows pressing it would show, and no chip leaves when its count is zero', () => {
  const items = [task('t1'), task('t2'), task('t3', 'done')];
  const stateOf = (item: Item) => item.state;
  const isOpen = (state: string) => state !== 'done';
  assert.deepEqual(stateCounts(items, stateOf, isOpen), [
    { value: 'open', count: 2 },
    { value: 'done', count: 1 },
    { value: 'in_progress', count: 2 },
  ]);
  // Narrowed to one reader's rows, the states stand still and the numbers follow.
  assert.deepEqual(stateCounts(items, stateOf, isOpen, [items[0]!]), [
    { value: 'open', count: 1 },
    { value: 'done', count: 0 },
    { value: 'in_progress', count: 1 },
  ]);
});

test('filtered to nothing is said without the list’s noun, and offers the way out', async (t) => {
  t.after(async () => await unmount());
  await mount(page([task('t2'), task('t3', 'done')]));
  await click('Mine');
  assert.equal(document.querySelector('.empty-title')!.textContent, 'Nothing here is yours');
  await click('Clear filters');
  assert.equal(document.querySelectorAll('.rows > .row').length, 2);
});

test('a search or a chip that empties the reader’s own rows does not say they are not theirs', async (t) => {
  t.after(async () => await unmount());
  await mount(page([task('t1'), task('t2'), task('t3', 'done')]));
  await click('Mine');
  assert.equal(document.querySelectorAll('.rows > .row').length, 1);
  // Mine holds a row; the chip pressed over it holds none of the reader's.
  await click('done');
  assert.equal(document.querySelector('.empty-title')!.textContent, 'Nothing matches');
  await click('Clear filters');
  await click('Mine');
  const search = document.querySelector<HTMLInputElement>('.search input')!;
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    set.call(search, 'zzzz');
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  assert.equal(document.querySelector('.empty-title')!.textContent, 'Nothing matches');
});

test('a published list whose rows have all ended flags none of them for attention', async (t) => {
  t.after(async () => await unmount());
  const live = ['queued', 'running'];
  const spec = {
    noun: { singular: 'agent', plural: 'agents' },
    key: 'id',
    title: 'title',
    states: { field: 'phase', open: live, live },
    attention: { field: 'attention' },
    columns: [{ type: 'state', label: 'Status', field: 'phase' }],
    empty: { title: 'No agents allocated' },
  };
  const row = {
    id: 'fleet',
    label: 'Fleet',
    group: 'operations',
    order: 20,
    path: '/fleet',
    view: { kind: 'collection', spec },
    status: {},
    readable: true,
  };
  const attention = 'Waiting for the runtime service';
  serve('/tools/ui.read', {
    body: { result: [{ id: 'flt_1', title: 'pi agent', phase: 'released', attention }] },
  });
  await mount(
    createElement(
      MemoryRouter,
      { initialEntries: ['/fleet'] },
      createElement(
        Routes,
        null,
        createElement(Route, {
          path: '/fleet/*',
          element: createElement(CollectionView, { row, shell: { rows: [row], plugins: [] } }),
        }),
      ),
    ),
  );
  await settle(20);
  assert.equal(document.querySelectorAll('.rows > .row').length, 1);
  for (const gone of ['attention', attention, 'Nothing matches'])
    assert.ok(!text().includes(gone), `“${gone}” is on the page: ${text()}`);
});

test('every state a record stands in has a tone, and a review gate never reads as stopped', () => {
  const tones = (words: string) => words.split(' ').map((word) => toneOf(word));
  // The states the deployed programs hold, the two ways a claim's references come back,
  // and how a claim may stand: none of them is the neutral grey of a word nobody knows.
  for (const word of (
    'planned design_review running experiment_review complete abandoned failed ' +
    'in_progress in_review done reflecting synthesizing approved consolidating ' +
    'defining researching requested started ' +
    'resolved missing unsupported unpublished draft active supported weakened contradicted'
  ).split(' '))
    assert.notEqual(toneOf(word), 'neutral', `${word} has no tone`);
  assert.deepEqual(tones('in_review design_review experiment_review in_progress'), [
    'warn',
    'warn',
    'warn',
    'warn',
  ]);
  assert.deepEqual(tones('resolved missing unsupported'), ['ok', 'bad', 'bad']);
});

test('an open review adds to the state pill beside it and never repeats it', () => {
  const open = { subjectId: 'wf_1', subjectRevision: 1, createdAt: '2026-09-20T10:00:00Z' };
  assert.deepEqual(reviewClause({ ...open, status: 'requested' }), { word: 'unclaimed' });
  // The pill already says IN REVIEW: the clause says whose hands it is in, or that it is in some.
  const held = reviewClause({ ...open, status: 'started' }, 'Claude reviewer')!;
  assert.equal(held.word, undefined);
  assert.deepEqual(reviewClause({ ...open, status: 'started' }), { word: 'claimed' });
});

test('an empty list offers its first record itself, and the form has one Cancel and one way out', async (t) => {
  t.after(async () => await unmount());
  await mount(page([]));
  const offered = document.querySelector<HTMLButtonElement>('.empty-state [data-opens="create"]')!;
  assert.equal(offered.textContent, 'New cycle');
  assert.ok(shows('.empty-state .empty-icon svg'), 'the kind’s glyph is drawn');
  assert.equal(
    document.querySelectorAll('[data-opens="create"]').length,
    1,
    'one creation control on the page, not one in the row and one in the empty state',
  );

  await click('New cycle');
  assert.ok(!shows('.empty-state'), 'the form replaces the empty state');
  const opener = document.querySelector<HTMLButtonElement>('.action-row [data-opens="create"]')!;
  assert.equal(opener.textContent, 'Cancel');
  assert.equal(opener.getAttribute('aria-expanded'), 'true');
  assert.ok(!opener.classList.contains('btn--primary'), 'Cancel is never the accent');
  assert.equal(
    document.activeElement?.getAttribute('aria-label'),
    'Name',
    'the first field has focus',
  );

  await act(async () => {
    document.activeElement!.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
  });
  await settle(0);
  assert.ok(!shows('.creation'), 'Escape closes the form');
  assert.equal(document.activeElement?.textContent, 'New cycle', 'and hands the cursor back');

  await click('New cycle');
  await click('Create');
  assert.ok(!shows('.creation'), 'the form closes itself on success');
});

test('what a page can open ends its control row together, the quiet control before the primary', async (t) => {
  t.after(async () => await unmount());
  await mount(page([task('t1')], true, true));
  const end = document.querySelector('.action-row > .action-end')!;
  assert.deepEqual(
    [...end.querySelectorAll('button')].map((button) => [
      button.textContent,
      button.classList.contains('btn--primary'),
    ]),
    [
      ['Check references', false],
      ['New cycle', true],
    ],
  );
  assert.ok(!shows('.action-filters [data-opens]'));
  // One thing is open at a time, and what is not a new record closes with Close.
  await click('Check references');
  assert.ok(shows('form[aria-label="Check references"]'));
  assert.deepEqual(
    [...end.querySelectorAll('button')].map((button) => button.textContent),
    ['Close', 'New cycle'],
  );
  await click('New cycle');
  assert.ok(!shows('form[aria-label="Check references"]'));
  assert.ok(shows('form[aria-label="New cycle"]'));
});

test('an empty list nobody may add to says so and offers nothing', async (t) => {
  t.after(async () => await unmount());
  await mount(page([], false));
  assert.ok(text().includes('No work yet'));
  assert.ok(!shows('.empty-state button'));
});

test('a time is stated to the minute, and Updated only where it differs from Created', async (t) => {
  t.after(async () => await unmount());
  const created = '2026-09-20T10:38:37.000Z';
  assert.ok(!/:37/.test(stamp(created)), 'seconds stay in the ISO string');
  assert.match(stamp(created), /2026/);
  assert.equal(stamp('not a time'), 'not a time');

  const labels = (rows: unknown[]) =>
    rows.filter(Array.isArray).map((row) => (row as [string, unknown])[0]);
  assert.deepEqual(labels(timeRows(created, created)), ['Created']);
  assert.deepEqual(labels(timeRows(created, '2026-09-20T10:38:59.000Z')), ['Created']);
  assert.deepEqual(labels(timeRows(created, '2026-09-20T11:02:00.000Z')), ['Created', 'Updated']);
  assert.deepEqual(labels(timeRows(undefined, created)), ['Updated']);
  assert.deepEqual(labels(timeRows(null, null)), []);

  await mount(createElement(KV, { rows: timeRows(created, '2026-09-21T09:00:00.000Z') }));
  const times = [...document.querySelectorAll('time')];
  assert.equal(times.length, 2);
  assert.equal(times[0]!.getAttribute('datetime'), created);
  assert.equal(times[0]!.getAttribute('title'), created, 'the exact instant is one hover away');
  assert.equal(times[0]!.textContent, stamp(created));
});

test('a file is known by its media type, then by its name, and is otherwise a plain file', () => {
  assert.equal(fileIcon('text/markdown', 'notes.md'), 'file-text');
  assert.equal(fileIcon('application/pdf'), 'file-text');
  assert.equal(fileIcon('image/png', 'loss.png'), 'file-image');
  assert.equal(fileIcon('text/csv; charset=utf-8'), 'file-data');
  assert.equal(fileIcon('application/json', 'metrics.json'), 'file-data');
  assert.equal(fileIcon('text/x-python', 'train.py'), 'file-code');
  // A type that says nothing of the kind leaves the question to the name.
  assert.equal(fileIcon('text/plain', 'train.py'), 'file-code');
  assert.equal(fileIcon('application/octet-stream', 'sweep.parquet'), 'file-data');
  assert.equal(fileIcon('text/plain', 'README'), 'file-text');
  assert.equal(fileIcon('application/octet-stream', 'weights.bin'), 'file');
  assert.equal(fileIcon(undefined, null), 'file');
});

/** A form as the views write them: its fields in a fieldset that its command locks. */
function Locking({ items }: { items: Item[] }) {
  const filter = useListFilter(items, {});
  return createElement(ListPage<Item>, {
    load: { loading: false, data: items },
    noun: 'notes',
    kind: 'notes',
    filter,
    line: (item: Item) => ({ name: item.name }),
    emptyTitle: 'No notes yet',
    create: {
      label: 'New note',
      form: (close: () => void) => createElement(LockingForm, { close }),
    },
  });
}
function LockingForm({ close }: { close(): void }) {
  const [locked, setLocked] = useState(false);
  return createElement(
    'form',
    { 'aria-label': 'New note' },
    createElement(
      'fieldset',
      { disabled: locked },
      createElement('input', { 'aria-label': 'Text' }),
    ),
    createElement('button', { type: 'button', onClick: () => setLocked(true) }, 'Send'),
    createElement('button', { type: 'button', onClick: close }, 'Land'),
  );
}
const escape = async () => {
  await act(async () => {
    document.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
  });
  await settle(0);
};

test('while a form’s request is in flight neither Escape nor Cancel can take it away', async (t) => {
  t.after(async () => await unmount());
  await mount(
    createElement(
      MemoryRouter,
      { initialEntries: ['/notes'] },
      createElement(Locking, { items: [task('t1')] }),
    ),
  );
  await click('New note');
  await click('Send');
  await settle(0);
  const opener = document.querySelector<HTMLButtonElement>('.action-row [data-opens="create"]')!;
  assert.equal(opener.textContent, 'Cancel');
  assert.ok(opener.disabled, 'Cancel holds still while the fields are locked');
  await escape();
  assert.ok(shows('.creation'), 'and so does Escape');
});

test('the cursor follows the opener from the empty state to the row once the first record lands', async (t) => {
  t.after(async () => await unmount());
  // The record lands a moment after the form that made it closed, as a command's
  // answer does. The test lands it itself rather than on a short timer: a timer
  // raced the runner's own scheduling, and on a loaded machine the record arrived
  // before the line below had looked at the empty state it was supposed to leave.
  let land = () => {};
  function Book() {
    const [items, setItems] = useState<Item[]>([]);
    land = () => setItems([task('t1')]);
    return createElement(Locking, { items });
  }
  await mount(createElement(MemoryRouter, { initialEntries: ['/notes'] }, createElement(Book)));
  await click('New note');
  await click('Land');
  assert.ok(
    cursorOn('.empty-state [data-opens="create"]'),
    'closed, the cursor is back on the control that opened the form',
  );
  await act(async () => land());
  await settle(0);
  assert.ok(!shows('.empty-state'), 'the first record takes the empty state away');
  assert.ok(
    cursorOn('.action-row [data-opens="create"]'),
    'and it is still on that control where the first record moved it',
  );
});

test('a row whose name is its link opens from anywhere on it, and its other link keeps its own way', async (t) => {
  t.after(async () => await unmount());
  function Wave() {
    const items = [task('t1')];
    const filter = useListFilter(items, {});
    const { pathname } = useLocation();
    return createElement(
      'div',
      null,
      createElement('output', null, pathname),
      createElement(ListPage<Item>, {
        load: { loading: false, data: items },
        noun: 'work',
        kind: 'work',
        filter,
        emptyTitle: 'No work yet',
        line: (item: Item) => ({
          name: createElement(Link, { className: 'row-link', to: `/tasks/${item.id}` }, item.name),
          standing: createElement(
            'div',
            { className: 'states' },
            createElement('span', { className: 'states-clause' }, 'in progress'),
            createElement(Link, { className: 'states-clause', to: '/reviews/r1' }, 'pass'),
          ),
        }),
      }),
    );
  }
  await mount(createElement(MemoryRouter, { initialEntries: ['/work'] }, createElement(Wave)));
  const at = () => document.querySelector('output')!.textContent;
  await act(async () => document.querySelector<HTMLElement>('.states-clause')!.click());
  assert.equal(at(), '/tasks/t1', 'the words of the second line are the row too');
  await unmount();

  await mount(createElement(MemoryRouter, { initialEntries: ['/work'] }, createElement(Wave)));
  await act(async () => document.querySelector<HTMLElement>('a.states-clause')!.click());
  assert.equal(at(), '/reviews/r1', 'the verdict is still the way to the review');
});

test('a record keeps what is being written on it when the window crosses the split’s width', async (t) => {
  t.after(async () => await unmount());
  const Index = () => createElement('p', { className: 'the-list' }, 'The list');
  // A desk holds its draft in the record's own state, as the delivery and verdict desks do.
  function Detail() {
    const [draft, setDraft] = useState('');
    return createElement('input', {
      'aria-label': 'Draft',
      value: draft,
      onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
    });
  }
  const Routed = splitRoutes(Index, Detail);
  await mount(
    createElement(
      MemoryRouter,
      { initialEntries: ['/t1'] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createElement(Routed as any, { row: { path: '/' }, shell: {} }),
    ),
  );
  const field = () => document.querySelector<HTMLInputElement>('input[aria-label="Draft"]')!;
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    set.call(field(), 'Reached 100% at step 1,640.');
    field().dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  assert.ok(shows('.split > .split-list .the-list'), 'wide: the list stands beside');
  const kept = field();

  await resize(false);
  assert.ok(!shows('.the-list'), 'narrow: the record is the page');
  assert.ok(!shows('.split'));
  assert.ok(field() === kept, 'the record was not mounted again');
  assert.equal(field().value, 'Reached 100% at step 1,640.');

  await resize(true);
  assert.ok(shows('.split > .split-list .the-list'));
  assert.ok(field() === kept);
  assert.equal(field().value, 'Reached 100% at step 1,640.');
});

test('Escape leaves a record for its list, but not while a desk on it holds something unsent', async (t) => {
  t.after(async () => await unmount());
  const Index = () => createElement('p', { className: 'the-list' }, 'The list');
  // A desk marks itself `data-draft` while it holds anything, as both real desks do.
  function Detail() {
    const [picked, setPicked] = useState(false);
    return createElement(
      'div',
      { 'data-draft': picked ? '' : undefined },
      createElement('button', { type: 'button', onClick: () => setPicked(!picked) }, 'Met'),
    );
  }
  const Routed = splitRoutes(Index, Detail);
  await mount(
    createElement(
      MemoryRouter,
      { initialEntries: ['/t1'] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createElement(Routed as any, { row: { path: '/' }, shell: {} }),
    ),
  );
  const pick = () => document.querySelector<HTMLButtonElement>('button')!;
  const escape = async () =>
    await act(async () => {
      pick()?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

  // Focus sits on a pick right after it is pressed, so this is where the slip happens.
  await act(async () => pick().click());
  await escape();
  assert.ok(pick(), 'the record is still the page');
  assert.ok(shows('[data-draft]'), 'and the pick is still made');

  // With nothing held, Escape is the way back to the list it always was.
  await act(async () => pick().click());
  await escape();
  assert.ok(!shows('button'), 'the record was left');
  assert.ok(shows('.the-list'));
});

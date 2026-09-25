/**
 * The shell and the pages it frames directly, rendered through the real sign-in
 * flow against a fixture server. Each test states one thing the frame must not
 * do: say a word twice in the rail or the account row, blame a plugin for a
 * mistyped address, lose the Settings title in a room, or open diagnostics on a
 * person who did not ask for them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { click, mount, requests, serve, settle, text, unmount } from './ui-render.js';

// The credential is read as api.ts is evaluated, so it is stored before anything loads.
sessionStorage.setItem('merv:token', 'fixture-token');
Object.assign(globalThis, {
  IntersectionObserver: class {
    observe() {}
    disconnect() {}
  },
});

const { createElement } = await import('react');
const { MemoryRouter } = await import('react-router-dom');
const { act } = await import('react-dom/test-utils');
const { App } = await import('../packages/ui/web/app.js');
const { setToken } = await import('../packages/ui/web/api.js');

const project = {
  id: 'project_1',
  name: 'Grokking replication',
  createdAt: '2026-09-01T00:00:00Z',
};
const row = (id: string, kind: string, group: string, order: number, label: string) => ({
  id,
  label,
  group,
  order,
  path: `/${id}`,
  view: { kind },
  status: {},
  readable: false,
});
const rows = [
  row('paper', 'paper', 'work', 15, 'Paper'),
  row('artifacts', 'artifacts', 'work', 21, 'Files'),
  row('settings', 'settings', 'settings', 100, 'Settings'),
];
const plugin = (id: string, state = 'active') => ({ id, name: `@merv/${id}`, state });

/** One signed-in operator, the rows above, and whatever a test adds to the shell. */
function boot(name: string, shell: Record<string, unknown> = {}) {
  const actor = { id: 'actor_1', projectId: project.id, name, role: 'operator', active: true };
  serve('/auth/config', { body: { enabled: false } });
  serve('/account', { body: { kind: 'actor', actor, projects: [project] } });
  serve('/tools/ui.shell', {
    body: { result: { actor, project, rows, plugins: [plugin('paper-ui')], ...shell } },
  });
  serve('/tools/project.get', { body: { result: project } });
}
const open = async (path: string) => {
  await mount(createElement(MemoryRouter, { initialEntries: [path] }, createElement(App)));
  await settle(20);
};
const rail = () => document.querySelector('.sidebar')!;

test('the rail says a word once: no heading over its own row, no role under its own name', async (t) => {
  t.after(async () => await unmount());
  boot('Operator', { rows: [...rows, row('feed', 'feed', 'activity', 30, 'Feed')] });
  await open('/paper');
  const heads = [...rail().querySelectorAll('.rail-group-head')].map((node) => node.textContent);
  assert.deepEqual(heads, ['Research'], 'Feed over Feed is the row alone');
  const feed = rail().querySelector('.rail-group[aria-label="Feed"]')!;
  assert.equal(
    feed.querySelectorAll('a').length,
    1,
    'the group is still named for a screen reader',
  );

  const account = rail().querySelector<HTMLButtonElement>('.account-row')!;
  assert.equal(account.querySelector('.account-name')!.textContent, 'Operator');
  assert.equal(account.querySelector('.account-role'), null, 'Operator / Operator is one line');
  assert.ok(account.querySelector('svg.account-caret'), 'the caret is a drawn glyph');
  assert.equal(account.getAttribute('aria-expanded'), 'false');
  assert.equal(account.getAttribute('aria-haspopup'), 'menu');
  await click('Operator');
  assert.equal(account.getAttribute('aria-expanded'), 'true');
  assert.equal(document.querySelectorAll('.account-menu [role="menuitem"]').length, 2);

  // The place you are in is said as well as shown, and no other row claims it.
  assert.deepEqual(
    [...rail().querySelectorAll('[aria-current="page"]')].map((node) => node.textContent),
    ['Paper'],
  );
});

test('the account menu is operated as the menu it says it is', async (t) => {
  t.after(async () => await unmount());
  boot('Operator');
  await open('/paper');
  const account = rail().querySelector<HTMLButtonElement>('.account-row')!;
  const key = async (name: string) => {
    await act(async () => {
      document.activeElement!.dispatchEvent(
        new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }),
      );
    });
  };
  const held = () => document.activeElement?.textContent;
  await click('Operator');
  assert.match(held()!, /^Theme/, 'opening it puts the cursor on its first item');
  // The items follow the row in the document, so nothing is reached only backwards.
  assert.ok(
    account.compareDocumentPosition(document.querySelector('.account-menu')!) &
      window.Node.DOCUMENT_POSITION_FOLLOWING,
  );
  await key('ArrowDown');
  assert.equal(held(), 'Sign out');
  await key('ArrowDown');
  assert.match(held()!, /^Theme/, 'the arrows wrap');
  await key('End');
  assert.equal(held(), 'Sign out');
  await key('Home');
  assert.match(held()!, /^Theme/);
  await key('Escape');
  assert.equal(account.getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement, account, 'Escape hands the cursor back to the row');
  await click('Operator');
  await key('Tab');
  assert.equal(account.getAttribute('aria-expanded'), 'false', 'leaving it shuts it');
});

test('a name that is not the role keeps the role beneath it', async (t) => {
  t.after(async () => await unmount());
  boot('Ada Lovelace');
  await open('/paper');
  const account = rail().querySelector('.account-row')!;
  assert.equal(account.querySelector('.account-name')!.textContent, 'Ada Lovelace');
  assert.equal(account.querySelector('.account-role')!.textContent, 'Operator');
});

test('a mistyped address is a page not found, with the way home and no word about plugins', async (t) => {
  t.after(async () => await unmount());
  boot('Operator');
  await open('/nope');
  assert.ok(text().includes('Page not found'));
  // The state is the whole page, so its words are the page's one heading and its title.
  assert.equal(document.querySelector('main h1')!.textContent, 'Page not found');
  assert.equal(document.title, 'Page not found · Grokking replication · Merv');
  assert.ok(!/plugin|registered/i.test(document.querySelector('.main')!.textContent ?? ''));
  const home = document.querySelector<HTMLAnchorElement>('.empty-state a.btn')!;
  assert.equal(home.textContent, 'Home');
  assert.equal(home.getAttribute('href'), '/');
});

test('an address whose plugin is switched off says which, and how it stands', async (t) => {
  t.after(async () => await unmount());
  boot('Operator', { plugins: [plugin('paper-ui'), plugin('feed-ui', 'disabled')] });
  await open('/feed');
  const page = document.querySelector('.main .empty-state')!;
  assert.ok(page.textContent!.includes('Feed is switched off'));
  assert.ok(page.textContent!.includes('feed-ui'));
  assert.ok(page.querySelector('.status'), 'the state is a state word, not a sentence');
  assert.ok(page.querySelector('a.btn[href="/"]'));
});

test('Settings keeps its title in every room, and folds its diagnostics under one line each', async (t) => {
  t.after(async () => await unmount());
  boot('Operator', { plugins: [plugin('paper-ui'), plugin('state'), plugin('scope')] });
  await open('/settings/plugins');
  assert.equal(document.querySelector('h1')!.textContent, 'Settings');
  assert.equal(
    document.querySelector('.settings nav [aria-current="page"]')!.textContent,
    'Plugins',
  );
  const folds = [...document.querySelectorAll<HTMLDetailsElement>('details.fold')];
  assert.deepEqual(
    folds.map((fold) => fold.querySelector('summary')!.textContent),
    ['Plugins 3 all active', 'Sidebar rows 3 all ready'],
  );
  assert.ok(
    folds.every((fold) => !fold.open),
    'nothing is wrong, so nothing is open',
  );
});

test('a plugin that is not active opens its table and is read first', async (t) => {
  t.after(async () => await unmount());
  boot('Operator', {
    plugins: [plugin('paper-ui'), plugin('feed-ui', 'disabled'), plugin('state')],
  });
  await open('/settings/plugins');
  const [plugins, sidebar] = [...document.querySelectorAll<HTMLDetailsElement>('details.fold')];
  assert.equal(plugins!.querySelector('summary .status')!.textContent, '1 not active');
  assert.ok(plugins!.open);
  // The rows are a ruled list, which stacks on a phone, so how an entry stands is never
  // the column a narrow page scrolls away; the one that is unwell is read first.
  const first = plugins!.querySelector('.ruled-row')!;
  assert.ok(first.textContent!.includes('feed-ui'));
  assert.equal(first.querySelector('[data-label="State"]')!.textContent, 'disabled');
  assert.ok(!sidebar!.open);
});

test('a room with nothing in it is an empty state, and the session room ends the session in one size of button', async (t) => {
  t.after(async () => await unmount());
  boot('Operator');
  await open('/settings/keys');
  assert.equal(document.querySelector('h1')!.textContent, 'Settings');
  // Keys belong to a person's account, and this session is a bearer credential: the
  // room says what would open it, offers the one step there is, and is not in the list.
  const empty = document.querySelector('.split-record .empty-state')!;
  assert.ok(empty.querySelector('.empty-icon svg'));
  assert.equal(empty.querySelector('h2')!.textContent, 'Sign in with an account to make keys');
  assert.equal(empty.querySelector('button')!.textContent, 'Sign out');
  assert.deepEqual(
    [...document.querySelectorAll('nav[aria-label="Settings"] a')].map((room) => room.textContent),
    ['Introduction', 'Integrations', 'Connections', 'Plugins', 'Session'],
  );
  await unmount();

  boot('Operator');
  await open('/settings/session');
  const out = [...document.querySelectorAll('.split-record button')].find(
    (button) => button.textContent === 'Sign out',
  )!;
  assert.ok(out.classList.contains('btn') && !out.classList.contains('btn--sm'));
  // The name is the role here, and a row that only repeats it is still the name's row.
  assert.ok(document.querySelector('.split-record .kv')!.textContent!.includes('Operator'));
});

test('the archive narrows by the app’s own tabs, turns pages only where there are pages, and closes by a glyph', async (t) => {
  t.after(async () => await unmount());
  const archive = { ...row('legacy-history', 'legacy-history', 'work', 19, 'Archive') };
  boot('Operator', { rows: [...rows, { ...archive, status: { count: 3 }, readable: true }] });
  serve('/tools/ui.read', (_call, sent) => {
    const asked = (sent.params ?? {}) as { action?: string; type?: string };
    if (asked.action === 'summary')
      return {
        body: {
          result: {
            sourceId: 'source_1',
            fingerprint: 'f'.repeat(64),
            importedAt: '2026-08-01T12:00:00Z',
            counts: { experiments: 2, claims: 1, reviews: 4 },
          },
        },
      };
    if (asked.action === 'list')
      return {
        body: {
          result: {
            records: [
              {
                type: asked.type,
                id: 'old_1',
                hash: 'a'.repeat(64),
                label: 'Seed sweep',
                status: 'complete',
              },
            ],
          },
        },
      };
    return {
      body: {
        result: {
          type: 'experiments',
          id: 'old_1',
          hash: 'a'.repeat(64),
          data: { name: 'Seed sweep', status: 'complete', intent: 'Does it **grok**?' },
        },
      },
    };
  });
  await open('/legacy-history');
  const tabs = document.querySelector('.history-tabs .tabs')!;
  assert.equal(tabs.getAttribute('role'), 'group');
  assert.deepEqual(
    [...tabs.querySelectorAll('button')].map((tab) => [
      tab.textContent,
      tab.getAttribute('aria-pressed'),
    ]),
    [
      ['Experiments 2', 'true'],
      ['Claims 1', 'false'],
    ],
  );
  assert.equal(document.querySelector('[aria-label="Next page"]'), null, 'one page has no pager');

  await click('Seed sweep');
  await settle(10);
  const detail = document.querySelector('#history-detail')!;
  assert.equal(detail.querySelector('.md strong')!.textContent, 'grok');
  const close = detail.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!;
  assert.equal(close.textContent, '', 'the control is its glyph');
  assert.ok(close.getAttribute('title'));
  await act(async () => close.click());
  assert.equal(document.querySelector('#history-detail'), null);
});

test('a server that cannot answer is asked again later each time, never in a loop, and the sign-in is kept', async (t) => {
  t.after(async () => {
    await unmount();
    setToken('fixture-token');
  });
  boot('Operator');
  const actor = { id: 'actor_1', projectId: project.id, name: 'Operator', role: 'operator' };
  // A membership still settling, then an outage, then the server again.
  serve('/account', (call) =>
    call === 1
      ? { status: 403, body: { error: { code: 'membership_required', message: 'Settling' } } }
      : call === 2
        ? { network: true }
        : { body: { kind: 'actor', actor: { ...actor, active: true }, projects: [project] } },
  );
  await open('/');
  const asked = () => requests.filter((request) => request === 'GET /account').length;
  assert.equal(asked(), 1);
  assert.ok(text().includes('Connecting'));
  await settle(1100);
  assert.equal(asked(), 2);
  await settle(2100);
  assert.equal(asked(), 3);
  assert.ok(document.querySelector('.sidebar'), text().slice(0, 300));
  assert.equal(sessionStorage.getItem('merv:token'), 'fixture-token');
});

test('a new tab opens the project this account chose last, and choosing one keeps the page asked for', async (t) => {
  t.after(async () => {
    await unmount();
    localStorage.clear();
    setToken('fixture-token');
  });
  const user = { issuer: 'https://login.example/auth/v1', subject: 'user-1', createdAt: '' };
  const second = { ...project, id: 'project_2', name: 'Second project' };
  const account = () => {
    boot('Operator');
    serve('/account', { body: { kind: 'user', user, projects: [project, second] } });
    // A tab of its own: signing in leaves nothing chosen in it.
    setToken('fixture-token');
  };
  account();
  await open('/settings/session');
  assert.ok(text().includes('Choose a project'));
  await click('Grokking replication');
  await settle(20);
  assert.equal(document.querySelector('h1')!.textContent, 'Settings');
  await unmount();
  account();
  await open('/settings/session');
  assert.equal(document.querySelector('h1')!.textContent, 'Settings');
  assert.ok(!text().includes('Choose a project'));
});

test('the box that names a new project is named by its label, as every reader finds it', async (t) => {
  t.after(async () => {
    await unmount();
    setToken('fixture-token');
  });
  boot('Operator');
  const user = { issuer: 'https://login.example/auth/v1', subject: 'user-1', createdAt: '' };
  serve('/account', { body: { kind: 'user', user, projects: [] } });
  setToken('fixture-token');
  await open('/');
  assert.ok(text().includes('Choose a project'), text().slice(0, 300));
  const box = document.querySelector<HTMLInputElement>('.signin form input')!;
  // Named explicitly: a label that only wraps its box is read as a bare textbox by some readers.
  const name =
    box.getAttribute('aria-label') ??
    (box.id ? document.querySelector(`label[for="${box.id}"]`)?.textContent : undefined);
  assert.equal(name, 'New project');
});

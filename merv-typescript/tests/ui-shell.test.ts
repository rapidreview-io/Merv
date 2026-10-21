/**
 * The shell and the pages it frames directly, rendered through the real sign-in
 * flow against a fixture server. Each test states one thing the frame must not
 * do: say a word twice in the rail or the account row, blame a plugin for a
 * mistyped address, lose the Settings title in a room, or open diagnostics on a
 * person who did not ask for them.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
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
const { MemoryRouter, useLocation } = await import('react-router-dom');
const { act } = await import('react-dom/test-utils');
const { App } = await import('../packages/ui/web/app.js');
const { setProject, setToken } = await import('../packages/ui/web/api.js');

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
// Each placed as its plugin places it (UiRow.group, rooms).
const rows = [
  row('paper', 'paper', 'top', 15, 'Paper'),
  row('artifacts', 'artifacts', 'research', 21, 'Files'),
  { ...row('settings', 'settings', 'settings', 100, 'Settings'), rooms: true },
  // Registered by @merv/research: the lead row, standing under Home.
  row('work', 'work', 'lead', 14, 'Work'),
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
}
const open = async (path: string) => {
  await mount(createElement(MemoryRouter, { initialEntries: [path] }, createElement(App)));
  await settle(20);
};

test('the only operator is offered no control that would leave the project without one', async (t) => {
  t.after(async () => {
    await unmount();
    setProject(null);
  });
  setProject(project.id);
  const user = {
    issuer: 'https://login.example',
    subject: 'subject-1',
    createdAt: project.createdAt,
  };
  const member = (n: number, role: string) => ({
    id: `member_${n}`,
    projectId: project.id,
    issuer: user.issuer,
    subject: `subject-${n}`,
    actorId: `actor_${n}`,
    role,
    active: true,
  });
  const names = ['Operator', 'Reviewer'].map((name, at) => ({ id: `actor_${at + 1}`, name }));
  const controls = (name: string) => {
    const role = document.querySelector<HTMLSelectElement>(
      `select[aria-label="Role for ${name}"]`,
    )!;
    const remove = [...role.closest('.states')!.querySelectorAll('button')].at(-1)!;
    assert.equal(remove.textContent, 'Remove');
    return [role.disabled, remove.disabled];
  };
  for (const [second, locked] of [
    ['reviewer', true],
    ['operator', false],
  ] as const) {
    boot('Operator');
    serve('/account', { body: { kind: 'user', user, projects: [project] } });
    serve('/tools/project.read:actors', { body: { result: names } });
    serve(`/projects/${project.id}/members`, {
      body: { memberships: [member(1, 'operator'), member(2, second)], admin: null, payers: [] },
    });
    await open('/settings/members');
    assert.equal(document.querySelector('h1')!.textContent, 'Settings');
    assert.equal(
      document.querySelector('.settings nav [aria-current="page"]')!.textContent,
      'Members',
    );
    assert.deepEqual(controls('Operator'), [locked, locked], second);
    assert.deepEqual(controls('Reviewer'), [false, false], second);
    await unmount();
  }
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

test('a sign-in that lands while the first check reads still opens the project that check chose', async (t) => {
  const { browserAuth, setAuthMode } = await import('../packages/ui/web/auth.js');
  const user = { issuer: 'https://login.example/auth/v1', subject: 'user-1', createdAt: '' };
  const login = { url: 'https://login.example', publishableKey: 'sb_publishable_fixture' };
  boot('Operator');
  serve('/account', { body: { kind: 'user', user, projects: [project] } });
  const who = `${user.issuer} ${user.subject}`;
  localStorage.setItem('merv:last-project', JSON.stringify({ who, project: project.id }));
  // The same shared account as before in this tab, so the SDK's word renews and reloads only.
  sessionStorage.setItem('merv:shared-account', `${login.url}\n${user.subject}`);
  setAuthMode('shared');
  setToken('fixture-token');
  let emit!: (event: string, session: unknown) => void;
  const held = await browserAuth(() => {}, {
    fetch: (async () => Response.json({ enabled: true, login })) as typeof fetch,
    createClient: (() => ({
      auth: {
        onAuthStateChange: (fn: typeof emit) => (
          (emit = fn),
          { data: { subscription: { unsubscribe() {} } } }
        ),
        stopAutoRefresh: async () => {},
      },
    })) as never,
  });
  t.after(async () => {
    await unmount();
    held.dispose();
    setAuthMode('local');
    localStorage.clear();
    sessionStorage.removeItem('merv:shared-account');
    setToken('fixture-token');
  });
  // The first check's account answers only once the second has asked, and the second's only
  // once the first has chosen the project.
  const real = globalThis.fetch;
  const gate = () => {
    let open!: () => void;
    return Object.assign(new Promise<void>((resolve) => (open = resolve)), { open: () => open() });
  };
  const [first, chosen] = [gate(), gate()];
  let accounts = 0;
  t.mock.method(globalThis, 'fetch', async (input: string, init?: RequestInit) => {
    if (input === '/account' && ++accounts === 1) await first;
    else if (input === '/account' && accounts === 2) (first.open(), await chosen);
    if (input === '/tools/ui.shell') chosen.open();
    return await real(input, init);
  });
  await mount(createElement(MemoryRouter, { initialEntries: ['/'] }, createElement(App)));
  await act(async () =>
    emit('SIGNED_IN', { user: { id: user.subject }, access_token: 'fixture-token' }),
  );
  await settle(50);
  assert.ok(document.querySelector('.sidebar'), `the project opened: ${text().slice(0, 200)}`);
  assert.equal(accounts, 3, 'the check that lost the race asked once more, and no more');
});

test('project chooser lists pending invitations but joins only after Accept', async (t) => {
  t.after(async () => {
    sessionStorage.removeItem('merv:invitation');
    await unmount();
  });
  boot('Operator');
  const user = {
    issuer: 'https://identity.example/auth/v1',
    subject: 'recipient',
    createdAt: project.createdAt,
  };
  let joined = false;
  serve('/account', () => ({ body: { kind: 'user', user, projects: joined ? [project] : [] } }));
  serve('/account/invitations', {
    body: {
      invitations: [
        {
          id: 'invite_ui',
          projectId: project.id,
          projectName: project.name,
          role: 'reader',
          status: 'pending',
          expiresAt: '2027-01-01T00:00:00.000Z',
        },
      ],
    },
  });
  serve('/account/invitations/invite_ui/accept', () => {
    joined = true;
    return { body: { membership: {} } };
  });
  setToken('invited-user');
  setProject(null);
  sessionStorage.setItem('merv:invitation', 'invite_ui');
  await open('/');
  assert.ok(text().includes('Accept invitation'));
  assert.equal(joined, false);
  assert.ok(!requests.some((r) => r === 'POST /account/invitations/invite_ui/accept'));
  await click('Accept invitation');
  await settle(20);
  assert.equal(joined, true);
  assert.equal(sessionStorage.getItem('merv:invitation'), null);
  assert.ok(document.querySelector('.sidebar'), 'accepting opens the newly joined project');
});

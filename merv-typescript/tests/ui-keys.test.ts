/**
 * Machine keys, rendered. The panel reads as every list does: with no key yet the
 * empty state carries the one control, the form it opens is headed once and
 * closed by Cancel or Escape, and a key is a row whose times are times.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { click, mount, serve, settle, text, unmount } from './ui-render.js';

sessionStorage.setItem('merv:token', 'fixture-token');

const { createElement } = await import('react');
const { act } = await import('react-dom/test-utils');
const { KeysPanel } = await import('../packages/ui/web/views/keys.js');
const { setProject } = await import('../packages/ui/web/api.js');
const { snapshotPage } = await import('../packages/ui/web/views/pi-screen.js');

const project = { id: 'project_1', name: 'Grokking', createdAt: '2026-09-01T00:00:00Z' };
const account = {
  kind: 'user' as const,
  user: { issuer: 'https://login.example', subject: 'subject-1', createdAt: project.createdAt },
  projects: [project],
};
const key = {
  id: 'key_1',
  owner: { issuer: account.user.issuer, subject: account.user.subject },
  projectId: project.id,
  grantScope: 'project',
  label: 'Laptop runner',
  createdAt: '2026-09-10T09:00:00Z',
  expiresAt: null,
  revokedAt: null,
  previousId: null,
};
const open = async (keys: unknown[], onClose?: () => void) => {
  serve('/account/keys', { body: { keys } });
  serve('/account', { body: account });
  await mount(createElement(KeysPanel, { account, initialProjectId: project.id, onClose }));
  await settle(10);
};

const fleetShell = (role: string, rows = [{ id: 'fleet' }]) => ({
  body: {
    result: {
      actor: { id: 'actor_1', projectId: project.id, name: 'Member', role, active: true },
      project,
      rows,
      plugins: [],
    },
  },
});

test('with no key yet the empty state offers the first one, and the form is headed once', async (t) => {
  t.after(async () => await unmount());
  await open([]);
  // Under Settings the page already has its title, and an account is never named by its id.
  assert.equal(document.querySelector('h1'), null);
  assert.ok(!text().includes('subject-1'));
  const offered = document.querySelector<HTMLButtonElement>('.empty-state button')!;
  assert.equal(offered.textContent, 'New key');
  assert.ok(document.querySelector('.empty-state .empty-icon svg'));
  assert.equal(document.querySelectorAll('form').length, 0, 'the form waits to be asked for');

  await click('New key');
  assert.equal(document.querySelector('.empty-state'), null);
  const form = document.querySelector('form')!;
  assert.equal(form.querySelector('h2')!.textContent, 'New key');
  assert.equal(form.querySelector('button[type="submit"]')!.textContent, 'Create');
  const opener = document.querySelector<HTMLButtonElement>('.action-row button')!;
  assert.equal(opener.textContent, 'Cancel');
  assert.equal(opener.getAttribute('aria-expanded'), 'true');
  assert.ok(!opener.classList.contains('btn--primary'), 'Cancel is never the accent');
  assert.equal((text().match(/New key/g) ?? []).length, 1, 'the words are said once');

  await act(async () => {
    form.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
  });
  assert.equal(document.querySelector('form'), null, 'Escape means Cancel');
});

test('a key is a row: its name, how it stands, and times that are times', async (t) => {
  t.after(async () => await unmount());
  let closed = false;
  await open([key], () => (closed = true));
  // Standing alone, the panel names itself and carries its way back.
  assert.equal(document.querySelector('h1')!.textContent, 'Machine keys');
  const row = document.querySelector('.rows > .row')!;
  assert.equal(row.querySelector('strong')!.textContent, 'Laptop runner');
  assert.ok(row.querySelector('.status')!.textContent!.includes('active'));
  assert.equal(row.querySelector('time')!.getAttribute('datetime'), key.createdAt);
  assert.ok(!row.textContent!.includes('no expiration'), 'an absent fact is not drawn');
  assert.equal(document.querySelector('.action-row button')!.textContent, 'New key');
  await click('Close');
  assert.ok(closed);
});

test('the Fleet source credential is its title and its control, never a sentence about them', async (t) => {
  t.after(async () => {
    await unmount();
    setProject(null);
  });
  setProject(project.id);
  serve('/tools/ui.shell', fleetShell('operator'));
  await open([]);
  await settle(10);
  const said = document.querySelector('[aria-label="Fleet source credential"]')!.textContent!;
  assert.ok(said.startsWith('Fleet source credential'), said);
  assert.ok(!said.includes('temporary operator identity'), said);
  assert.equal(document.querySelector('[aria-label="Fleet source credential"] p'), null, said);
});

test('Fleet source creation is operator-only, finite, and reveals its secret only until scope changes', async (t) => {
  t.after(async () => {
    await unmount();
    setProject(null);
  });
  setProject(project.id);
  serve('/tools/ui.shell', fleetShell('operator'));
  serve('/tools/actor.create', (_call, sent) => {
    assert.equal(sent.role, 'operator');
    assert.equal(sent.name, 'Fleet source');
    assert.ok(
      typeof sent.expiresAt === 'string' &&
        Date.parse(sent.expiresAt as string) > Date.now() &&
        Date.parse(sent.expiresAt as string) <= Date.now() + 7 * 24 * 60 * 60_000,
    );
    return { body: { result: { token: 'one-time-fleet-secret' } } };
  });
  await open([]);
  await click('New Fleet source credential');
  const field = document.querySelector<HTMLInputElement>('input[type="datetime-local"][required]')!;
  const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!;
  const write = async (value: string) =>
    await act(async () => {
      set.call(field, value);
      field.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  await write(new Date(Date.now() + 8 * 24 * 60 * 60_000).toISOString().slice(0, 16));
  await act(async () => {
    field
      .closest('form')!
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });
  assert.ok(text().includes('within the next seven days'));
  assert.equal(document.querySelector('[aria-label="Fleet source credential secret"]'), null);
  await write(new Date(Date.now() + 4 * 60 * 60_000).toISOString().slice(0, 16));
  await act(async () => {
    field
      .closest('form')!
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });
  await settle(0);
  assert.equal(
    document.querySelector<HTMLTextAreaElement>('[aria-label="Fleet source credential secret"]')
      ?.value,
    'one-time-fleet-secret',
  );
  // An agent's look at this page leaves the credential behind.
  assert.ok(!snapshotPage(window).html.includes('one-time-fleet-secret'), 'a look carries it');
  await act(async () => setProject('project_elsewhere'));
  assert.equal(document.querySelector('[aria-label="Fleet source credential secret"]'), null);
});

test('a new key is shown once to the person, and never to an agent looking at the page', async (t) => {
  t.after(async () => await unmount());
  await open([]);
  serve('/account/keys', (_call, sent) => ({
    body: sent.projectId ? { key, token: 'mk_shown_once' } : { keys: [key] },
  }));
  await click('New key');
  await act(async () => {
    document
      .querySelector('form')!
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });
  await settle(10);
  assert.equal(
    document.querySelector<HTMLTextAreaElement>('[aria-label="New machine key secret"]')?.value,
    'mk_shown_once',
  );
  assert.ok(!snapshotPage(window).html.includes('mk_shown_once'), 'a look carries the key');
});

test('Fleet credential control is hidden from non-operators and projects without Fleet', async (t) => {
  t.after(async () => {
    await unmount();
    setProject(null);
  });
  setProject(project.id);
  serve('/tools/ui.shell', fleetShell('producer'));
  await open([]);
  assert.ok(!text().includes('Fleet source credential'));
  await unmount();
  setProject(null);
  setProject(project.id);
  serve('/tools/ui.shell', fleetShell('operator', []));
  await open([]);
  assert.ok(!text().includes('Fleet source credential'));
});

test('an actor creation reply after switching projects never reveals its credential', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await unmount();
    setProject(null);
  });
  setProject(project.id);
  serve('/tools/ui.shell', fleetShell('operator'));
  await open([]);
  let reply!: (response: Response) => void;
  let requested = false;
  const pending = new Promise<Response>((resolve) => {
    reply = resolve;
  });
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/tools/actor.create') {
      requested = true;
      return pending;
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  await click('New Fleet source credential');
  const field = document.querySelector<HTMLInputElement>('input[type="datetime-local"][required]')!;
  const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!;
  await act(async () => {
    set.call(field, new Date(Date.now() + 4 * 60 * 60_000).toISOString().slice(0, 16));
    field.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await act(async () => {
    field
      .closest('form')!
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });
  assert.ok(requested);
  await act(async () => setProject('project_elsewhere'));
  await act(async () =>
    reply({
      status: 200,
      ok: true,
      json: async () => ({ result: { token: 'late-secret' } }),
    } as Response),
  );
  await settle(0);
  assert.ok(!text().includes('late-secret'));
  assert.equal(document.querySelector('[aria-label="Fleet source credential secret"]'), null);
});

const snippet = () => document.querySelector('.connect pre')!.textContent!;
const choose = async (client: string) => {
  const button = [
    ...document.querySelectorAll<HTMLButtonElement>('[aria-label="Client"] button'),
  ].find((b) => b.textContent === client)!;
  await act(async () => button.click());
};
const mcpUrl = 'https://merv.example/mcp';
const headers = { Authorization: 'Bearer <key>' };

test('where agent sign-in is off, connecting an agent is the MCP URL and one snippet per client', async (t) => {
  t.after(async () => await unmount());
  serve('/auth/config', { body: { enabled: false, mcpUrl } });
  await open([]);
  const connect = document.querySelector('[aria-label="Connect your agent"]')!;
  assert.equal(connect.querySelector('h2')!.textContent, 'Connect your agent');
  assert.ok(connect.textContent!.includes(mcpUrl));
  assert.equal(connect.querySelector('p'), null, 'no paragraph of explanation');
  assert.equal(
    snippet(),
    `claude mcp add --transport http merv ${mcpUrl} --header "Authorization: Bearer <key>"`,
  );
  await choose('Codex');
  assert.equal(connect.querySelector('.code-lang')!.textContent, '~/.codex/config.toml');
  assert.equal(
    snippet(),
    `[mcp_servers.merv]\nurl = "${mcpUrl}"\nhttp_headers = { "Authorization" = "Bearer <key>" }`,
  );
  await choose('Cursor');
  assert.deepEqual(JSON.parse(snippet()), { mcpServers: { merv: { url: mcpUrl, headers } } });
  await choose('Other');
  assert.deepEqual(JSON.parse(snippet()), { url: mcpUrl, headers });
});

test('a key made for a client fills its snippet once, for the person only', async (t) => {
  t.after(async () => await unmount());
  serve('/auth/config', { body: { enabled: false, mcpUrl } });
  await open([]);
  serve('/account/keys', (_call, sent) => {
    if (!sent.projectId) return { body: { keys: [{ ...key, label: 'Codex' }] } };
    assert.deepEqual(sent, { projectId: project.id, grantScope: 'project', label: 'Codex' });
    return { body: { key: { ...key, label: 'Codex' }, token: 'mk_codex_once' } };
  });
  await choose('Codex');
  await click('Make a key for Codex');
  await settle(10);
  assert.ok(snippet().includes('"Bearer mk_codex_once"'));
  assert.equal(document.querySelector('[aria-label="New machine key secret"]'), null);
  assert.ok(!snapshotPage(window).html.includes('mk_codex_once'), 'a look carries the key');
  assert.equal(document.querySelector('.rows strong')!.textContent, 'Codex');
  await choose('Cursor');
  assert.ok(!snippet().includes('mk_codex_once'), 'another client is not handed it');
  await choose('Codex');
  await click('Hide and forget key');
  assert.ok(snippet().includes('"Bearer <key>"'));
});

test('Test says who the agent is connected as, or why not, in one line', async (t) => {
  t.after(async () => await unmount());
  await open([]);
  serve('/tools/project.read:whoami', (call) =>
    call === 1
      ? { body: { result: { id: 'actor_1', name: 'Ada', role: 'producer', active: true } } }
      : { status: 403, body: { error: { code: 'forbidden', message: 'Project access denied' } } },
  );
  await click('Test');
  await settle(0);
  const line = () => document.querySelector('.connect [role="status"]')!.textContent;
  assert.equal(line(), 'Connected as Ada · producer');
  await click('Test');
  await settle(0);
  assert.equal(line(), 'Project access denied');
});

test('where agent sign-in is on, connecting an agent is one line to tell it, with no key in sight', async (t) => {
  t.after(async () => await unmount());
  serve('/auth/config', {
    body: {
      enabled: false,
      mcpUrl: 'https://merv.example/mcp',
      connectUrl: 'https://merv.example/connect',
    },
  });
  await open([]);
  await settle(10);
  const connect = document.querySelector('[aria-label="Connect your agent"]')!;
  assert.equal(connect.querySelector('h2')!.textContent, 'Connect your agent');
  assert.equal(
    connect.textContent,
    'Connect your agentTell it: Connect to Merv using https://merv.example/connect',
  );
  assert.equal(connect.querySelector('pre'), null, 'no snippet carries a key');
  assert.ok(!text().includes('Make a key for'));
});

test('an agent sign-in is a row that says what signed in, and can be revoked but not replaced', async (t) => {
  t.after(async () => await unmount());
  await open([
    {
      ...key,
      grantScope: 'account',
      label: 'Codex on ada-mbp',
      expiresAt: '2027-01-18T12:00:00.000Z',
      via: 'email_code',
    },
  ]);
  const row = document.querySelector('.rows > .row')!;
  assert.equal(row.querySelector('strong')!.textContent, 'Agent sign-in · Codex on ada-mbp');
  assert.ok(row.textContent!.includes('Used by every agent on that machine'));
  const buttons = [...row.querySelectorAll('button')].map((button) => button.textContent);
  assert.deepEqual(buttons, ['Revoke key and descendants']);
});

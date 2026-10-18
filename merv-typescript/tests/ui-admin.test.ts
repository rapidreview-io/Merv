/**
 * The platform admin (/ui/admin) through the real sign-in and fetch layer: the work table, the
 * credits and their grant form, and the credentials, each against the /admin routes' fixtures.
 * Each test states what a page must say, never invent, or send.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { click, mount, requests, serve, settle, text, unmount } from './ui-render.js';

sessionStorage.setItem('merv:token', 'fixture-token');

const { createElement } = await import('react');
const { MemoryRouter } = await import('react-router-dom');
const { act } = await import('react-dom/test-utils');
const { App } = await import('../packages/ui/web/app.js');

const user = {
  issuer: 'https://auth.example',
  subject: 'founder',
  createdAt: '2026-09-01T00:00:00Z',
};
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const unit = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: 'task',
  type: 'task.work',
  title: `Unit ${id.slice(3)}`,
  parent: null,
  project: { id: 'project_a', name: 'Grokking replication' },
  person: 'Mira Chen',
  state: 'in_progress',
  terminal: false,
  attention: [],
  agent: null,
  machine: null,
  lastActivity: ago(5),
  createdAt: ago(600),
  cost: null,
  ...over,
});
const work = {
  rows: [
    unit('wf_quiet', {
      lastActivity: ago(1),
      machine: { phase: 'provisioning', profile: 'standard', provider: 'cf', usdPerHour: 0.074 },
    }),
    unit('wf_held', {
      kind: 'experiment',
      title: 'Decay sweep',
      lastActivity: ago(30),
      attention: [
        {
          reason: 'agent',
          code: 'agent_question',
          message: [{ text: 'Its agent asked its owner: p = 113?' }],
        },
      ],
      agent: { role: 'producer', status: 'active' },
      machine: {
        phase: 'running',
        profile: 'gpu-l4',
        provider: 'modal',
        usdPerHour: 0.8,
      },
      cost: {
        sessions: 2,
        reportedSessions: 2,
        wallMs: 3_600_000,
        inputTokens: 1_000_000,
        outputTokens: 250_000,
      },
    }),
    unit('wf_alone', {
      kind: 'service_experiment',
      title: 'Customer study',
      project: { id: 'project_c', name: 'Customer study' },
      state: 'ready',
      attention: [{ reason: 'customer', code: 'approval' }],
      lastActivity: ago(60),
      requestId: 'ce_request',
      // A closed visit that reported nothing measured nothing.
      cost: { sessions: 1, reportedSessions: 0, wallMs: 0, inputTokens: 0, outputTokens: 0 },
    }),
    unit('wf_done', { state: 'done', terminal: true, title: 'Finished task' }),
  ],
  at: new Date().toISOString(),
};
function boot() {
  serve('/auth/config', { body: { enabled: false } });
  serve('/account', { body: { kind: 'user', user, projects: [] } });
  serve('/admin/work', { body: work });
}
const open = async (path: string) => {
  await mount(createElement(MemoryRouter, { initialEntries: [path] }, createElement(App)));
  await settle(20);
};
const rows = () => [...document.querySelectorAll('[aria-label="Work"] .ruled-row')];

test('work: a lens stands under its reflection, which sorts by its latest part', async (t) => {
  t.after(async () => await unmount());
  boot();
  serve('/admin/work', {
    body: {
      ...work,
      rows: [
        unit('wf_recent', { lastActivity: ago(10) }),
        unit('wf_wave', { kind: 'reflection', title: 'Mid-point', lastActivity: ago(50) }),
        unit('wf_lens', {
          kind: 'reflection.lens',
          title: 'theory',
          parent: 'wf_wave',
          lastActivity: ago(1),
        }),
      ],
    },
  });
  await open('/admin');
  const names = rows().map((row) => row.querySelector('[role="cell"]')!.textContent);
  assert.deepEqual(names, ['ReflectionMid-point', 'theory', 'TaskUnit recent']);
  assert.ok(rows()[1]!.classList.contains('admin-part'));
});

test('work: attention first, links into the drill-in, no ids, nothing ended until asked', async (t) => {
  t.after(async () => await unmount());
  boot();
  await open('/admin');
  assert.match(text(), /3 running/);
  assert.match(text(), /2 need attention/);
  assert.match(rows()[0]!.textContent!, /Decay sweep/, 'the unit that needs someone leads');
  assert.match(rows()[0]!.textContent!, /agent question/i);
  assert.match(rows()[0]!.textContent!, /Its agent asked its owner/, 'the phrase, read as words');
  assert.match(rows()[0]!.textContent!, /1\.3M/, 'tokens counted');
  // A running machine by its profile, its price in its title.
  assert.match(rows()[0]!.textContent!, /producer active · gpu-l4/);
  assert.ok(rows()[0]!.querySelector('[title="modal · $0.80/h"]'));
  // Under the app's /ui base: a drill-in is loaded whole, as an app of its own.
  const link = rows()[0]!.querySelector('a')!;
  assert.equal(link.getAttribute('href'), '/admin/p/project_a/experiments/wf_held');
  const quiet = rows().find((row) => /Unit quiet/.test(row.textContent!))!;
  assert.equal(quiet.querySelector('a')!.getAttribute('href'), '/admin/p/project_a/tasks/wf_quiet');
  // A standalone experiment opens as its customer sees it, which takes its request.
  const alone = rows().find((row) => /Customer study/.test(row.textContent!))!;
  assert.equal(alone.querySelector('a')!.getAttribute('href'), '/admin/standalone/ce_request');
  assert.doesNotMatch(alone.textContent!, /\b0 · 0s|\b0s\b/, 'no cost where nothing was measured');
  // It waits on its customer in its owner's words, its state in that tone, in a project its own.
  assert.match(alone.textContent!, /waits on approval/);
  assert.equal(alone.querySelector('.status')!.className, 'status status--warn');
  assert.equal(alone.textContent!.match(/Customer study/g)!.length, 1);
  // A machine not yet running says its phase; its price is in its title, never cut.
  assert.match(quiet.textContent!, /standard provisioning/);
  assert.ok(quiet.querySelector('[title="cf · $0.074/h"]'));
  assert.doesNotMatch(text(), /wf_|project_a|ce_request/, 'ids live in routes and titles only');
  assert.doesNotMatch(text(), /Finished task/);
  await click('Filter');
  await click('Ended today');
  assert.match(text(), /Finished task/);
  assert.match(rows().at(-1)!.textContent!, /Finished task/, 'what ended comes last');
  // An admin page has no project: nothing asks for one.
  assert.ok(!requests.some((r) => r.includes('/tools/')), requests.join('\n'));
  // The foot of the rail names the signed-in admin.
  assert.equal(document.querySelector('.account-name')!.textContent, 'Admin');
});

test('work: / opens the filter with the cursor in its search, and a search narrows the rows', async (t) => {
  t.after(async () => await unmount());
  boot();
  await open('/admin');
  await act(async () => {
    document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: '/', bubbles: true }));
  });
  await settle(0);
  const search = document.querySelector<HTMLInputElement>('.narrowing-panel input[type="search"]')!;
  assert.equal(document.activeElement, search);
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    set.call(search, 'decay');
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  assert.equal(rows().length, 1);
  assert.match(rows()[0]!.textContent!, /Decay sweep/);
});

test('standalone: its title, the plan it was accepted on, its customer, the chat as they read it', async (t) => {
  t.after(async () => await unmount());
  boot();
  serve('/admin/standalone/ce_request', {
    body: {
      title: 'Label smoothing for the churn classifier',
      state: 'ready',
      waits: 'approval',
      email: 'priya@example.org',
      planStatus: 'accepted',
      contract: { question: 'Does smoothing help?', criteria: ['ECE falls by 20%'] },
      contractSummary: {
        priceCents: 1000,
        currency: 'usd',
        limits: { wallMinutes: 180, maxTokens: 4e6, maxAttempts: 2 },
      },
      conversation: [
        { role: 'user', text: 'Submitted the plan.' },
        { role: 'assistant', text: 'Plan approved.' },
      ],
    },
  });
  await open('/admin/standalone/ce_request');
  assert.equal(
    document.querySelector('h1')!.textContent,
    'Label smoothing for the churn classifier',
  );
  assert.match(text(), /QuestionDoes smoothing help\?/);
  assert.match(text(), /SuccessECE falls by 20%/);
  assert.match(text(), /Limits3 h · 4M tokens · 2 attempts/);
  assert.match(text(), /Customerpriya@example\.org/);
  assert.match(text(), /waits on approval/);
  const pill = [...document.querySelectorAll('.status')].find((el) => el.textContent === 'ready');
  assert.equal(pill!.className, 'status status--warn', 'its state in the tone of its wait');
  assert.match(text(), /Submitted the plan\./);
  // An admin page has no project: nothing asks for one, the state words included.
  assert.ok(!requests.some((r) => r.includes('/tools/')), requests.join('\n'));
});

const account = (accountId: string, name: string, over: Record<string, unknown> = {}) => ({
  accountId,
  name,
  projects: [{ projectId: 'project_a', name: 'Grokking replication' }],
  pools: [
    {
      provider: 'modal',
      granted: '100.000000',
      used: '4.950000',
      reserved: '0',
      available: '95.050000',
      expired: '0',
      revoked: '0',
    },
  ],
  grants: [
    {
      id: 'grant_pilot',
      provider: 'modal',
      amount: '100',
      used: '4.95',
      reserved: '0',
      available: '95.05',
      valid_from: ago(60),
      expires_at: null,
      revoked_at: null,
      schedule_id: null,
      created_at: ago(60),
      reason: 'Design partner pilot',
    },
  ],
  schedules: [],
  budgets: [{ id: 'cap_1', window: 'month', metric: 'money', cap: '75', provider: null }],
  ...over,
});
const credits = {
  at: new Date().toISOString(),
  providers: ['fake', 'modal'],
  people: [
    {
      label: 'Mira Chen',
      issuer: user.issuer,
      subject: 'mira',
      accounts: [{ accountId: 'acct_mira', role: 'admin' }],
      fleet: { usd: 3.2, usdCap: 25, tokens: { used: 120_000, limit: 2_000_000 } },
      pi: { used: 40_000, limit: 1_000_000 },
    },
    {
      label: 'Tomás Ruiz',
      issuer: user.issuer,
      subject: 'tomas',
      accounts: [],
      fleet: { usd: 0.004, usdCap: 25, tokens: null },
      pi: null,
    },
  ],
  accounts: [
    account('acct_mira', 'Personal account'),
    account('acct_lab', 'merv-lab', { pools: [] }),
  ],
};

test('credits: left of granted per provider, an unfolded person, and a grant that keeps its key', async (t) => {
  t.after(async () => await unmount());
  serve('/auth/config', { body: { enabled: false } });
  serve('/account', { body: { kind: 'user', user, projects: [] } });
  serve('/admin/credits', { body: credits });
  const sent: Record<string, unknown>[] = [];
  serve('/admin/credits/grants', (call, body) => {
    sent.push(body);
    // The first answer is lost: the retry must be the same grant.
    return call === 1 ? { status: 502, body: null } : { body: { id: body.id } };
  });
  await open('/admin/credits');
  const head = [...document.querySelectorAll('[aria-label="Credits"] .ruled-head > *')].map(
    (th) => th.textContent,
  );
  assert.deepEqual(head, [
    'Person',
    'fake',
    'modal',
    'Fleet today',
    'Fleet tokens',
    'Agent tokens',
  ]);
  const mira = document.querySelector('[aria-label="Credits"] .ruled-row')!;
  assert.match(mira.textContent!, /\$95\.05 of\s\$100\.00/);
  assert.match(mira.textContent!, /\$3\.20 of\s\$25\.00/);
  assert.match(mira.textContent!, /120K of\s2M/);
  // Money is in cents: one under a cent says so, never a third decimal.
  assert.match(text(), /Tomás Ruiz——<\$0\.01 of\s\$25\.00/);
  assert.match(text(), /merv-lab/, 'an account nobody belongs to is still a row');
  assert.ok(!requests.some((r) => r.includes('/admin/work')), 'the rail reads no work table');
  assert.doesNotMatch(text(), /Design partner pilot/);
  await click('Mira Chen');
  assert.match(text(), /Design partner pilot/);
  assert.match(text(), /modal \$95\.05 of \$100\.00 · cap \$75\.00 a month/, 'pools, then caps');
  assert.doesNotMatch(text(), /acct_|grant_pilot|namespace|money/);
  assert.equal(document.querySelector('form'), null, 'the grant form waits for its word');
  await click('Grant');
  const form = document.querySelector<HTMLFormElement>(
    'form[aria-label="Grant credits to Mira Chen"]',
  )!;
  const fill = async (label: string, value: string) => {
    const input = [...form.querySelectorAll('label')]
      .find((l) => l.textContent!.startsWith(label))!
      .querySelector('input, select') as HTMLInputElement;
    await act(async () => {
      const proto =
        input instanceof window.HTMLSelectElement
          ? window.HTMLSelectElement
          : window.HTMLInputElement;
      Object.getOwnPropertyDescriptor(proto.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(
        new window.Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }),
      );
    });
  };
  await fill('Provider', 'modal');
  await fill('Amount', ' 25 ');
  await fill('Reason', 'Burst for the sweep');
  await act(async () => {
    form.requestSubmit();
  });
  await settle(10);
  assert.match(text(), /Retry same request/);
  await click('Retry same request');
  await settle(10);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], sent[0], 'the retry is the same grant: its id and its validFrom');
  assert.equal(sent[0]!.accountId, 'acct_mira');
  assert.equal(sent[0]!.provider, 'modal');
  assert.equal(sent[0]!.amount, '25');
  assert.equal(typeof sent[0]!.id, 'string');
  assert.ok(!Number.isNaN(Date.parse(String(sent[0]!.validFrom))), 'validFrom is always sent');
  assert.equal(document.querySelector('form'), null, 'granted, the form closes');
});

test('credits: ⋯ on a grant opens its guard, which revokes it', async (t) => {
  t.after(async () => await unmount());
  serve('/auth/config', { body: { enabled: false } });
  serve('/account', { body: { kind: 'user', user, projects: [] } });
  serve('/admin/credits', { body: credits });
  serve('/admin/credits/grants/grant_pilot/revoke', { body: { id: 'grant_pilot', revoked: true } });
  await open('/admin/credits');
  await click('Mira Chen');
  const more = document.querySelector<HTMLButtonElement>('button[aria-label="Revoke grant"]')!;
  await act(async () => more.click());
  assert.ok(document.querySelector('[role="alertdialog"][aria-label="Revoke grant?"]'));
  await click('Revoke grant');
  await settle(10);
  assert.ok(
    requests.includes('POST /admin/credits/grants/grant_pilot/revoke'),
    requests.join('\n'),
  );
  assert.equal(document.querySelector('[role="alertdialog"]'), null, 'done, the guard closes');
});

test('credentials: purposes in order, a fingerprint and what shares it, a dead key in red', async (t) => {
  t.after(async () => await unmount());
  const credential = (env: string, over: Record<string, unknown> = {}) => ({
    env,
    plugin: 'pi',
    field: 'model.keyEnv',
    set: true,
    fingerprint: 'a1b2c3d4',
    sharedWith: [],
    lastChanged: null,
    lastOk: null,
    lastFailure: null,
    dead: false,
    ...over,
  });
  serve('/auth/config', { body: { enabled: false } });
  serve('/account', { body: { kind: 'user', user, projects: [] } });
  serve('/admin/credentials', {
    body: {
      at: new Date().toISOString(),
      groups: [
        {
          purpose: 'Agent',
          credentials: [
            credential('OPENAI_API_KEY', {
              sharedWith: [{ plugin: 'fleet', field: 'relay.keyEnv', env: 'FLEET_OPENAI_KEY' }],
              // Overloaded once, and answered since.
              lastOk: { at: ago(1), relay: 'pi', model: 'gpt-5' },
              lastFailure: {
                at: ago(5),
                relay: 'pi',
                model: 'gpt-5',
                status: 529,
                code: 'overloaded',
              },
            }),
          ],
        },
        {
          purpose: 'Fleet agents',
          credentials: [
            credential('FLEET_OPENAI_KEY', {
              dead: true,
              lastFailure: {
                at: ago(30),
                relay: 'openai',
                model: 'gpt-5',
                status: 401,
                code: 'invalid_api_key',
              },
            }),
          ],
        },
        {
          purpose: 'Sandbox provider',
          provider: {
            name: 'modal-main',
            plugin: 'modal',
            source: 'host',
            enabled: true,
            fields: [],
            verified_at: ago(2),
            health: { status: 'degraded', message: 'slow' },
            health_reason: null,
          },
          credentials: [credential('MODAL_TOKEN', { set: false, fingerprint: null })],
        },
        {
          purpose: 'Platform services',
          credentials: [credential('MERV_DB_URL', { plugin: 'state' })],
        },
      ],
      minted: [
        {
          owner: 'sessions',
          kind: 'session-execution',
          live: '8',
          soonestExpiry: new Date(Date.now() + 3 * 3_600_000).toISOString(),
          revokedLastDay: '0',
          newestIssued: ago(1),
        },
      ],
    },
  });
  await open('/admin/credentials');
  const groups = [...document.querySelectorAll('.admin-group')].map((row) => row.textContent);
  assert.deepEqual(
    groups.map((g) => g!.replace(/ degraded.*/, '')),
    ['Agent', 'Fleet agents', 'modal-main', 'Platform services'],
  );
  assert.match(text(), /a1b2c3d4 = FLEET_OPENAI_KEY/);
  assert.doesNotMatch(text(), /model\.keyEnv|same as/, 'a config path is a hover title');
  const dead = document.querySelector('.admin-dead')!;
  assert.match(dead.textContent!, /dead/);
  assert.match(dead.textContent!, /invalid_api_key/);
  assert.match(text(), /3 set\s*1 unset\s*1 dead/, 'unset is no failure');
  const red = [...document.querySelectorAll('.ruled .status--bad')].map((el) => el.textContent);
  assert.deepEqual(red, ['dead', 'invalid_api_key 30m ago'], 'a recovered failure is faint');
  assert.match(text(), /degraded/);
  assert.match(text(), /in 3h/, 'an expiry still to come');
});

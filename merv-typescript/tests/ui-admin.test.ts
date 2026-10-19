/**
 * The platform admin (/ui/admin) through the real sign-in and fetch layer: the work table, the
 * credentials by purpose with their reveal and change, and the credits with each person's
 * drawer, each against the /admin routes' fixtures (docs/ADMIN.md, v2). Each test states what a
 * page must say, never invent, or send.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { click, jump, mount, requests, resize, serve, settle, text, unmount } from './ui-render.js';

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
    unit('wf_paid', {
      kind: 'service_experiment',
      title: 'Paid study',
      project: { id: 'project_d', name: 'Paid study' },
      state: 'awaiting_payment',
      attention: [{ reason: 'customer', code: 'payment' }],
      lastActivity: ago(90),
      requestId: 'ce_paid',
    }),
    unit('wf_done', { state: 'done', terminal: true, title: 'Finished task' }),
  ],
  at: new Date().toISOString(),
};
const signedIn = () => {
  serve('/auth/config', { body: { enabled: false } });
  serve('/account', { body: { kind: 'user', user, projects: [] } });
};
function boot() {
  signedIn();
  serve('/admin/work', { body: work });
}
const open = async (path: string) => {
  await mount(createElement(MemoryRouter, { initialEntries: [path] }, createElement(App)));
  await settle(20);
};
const rows = () => [...document.querySelectorAll('[aria-label="Work"] .ruled-row')];

test('work: a lens stands under its reflection, which sorts by its latest part and counts it', async (t) => {
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
          agent: { role: 'producer', status: 'active' },
        }),
      ],
    },
  });
  await open('/admin');
  const names = rows().map((row) => row.querySelector('[role="cell"]')!.textContent);
  assert.deepEqual(names, ['ReflectionMid-point', 'theory', 'TaskUnit recent']);
  assert.ok(rows()[1]!.classList.contains('admin-part'));
  // Units are counted, not their parts; a lens at work is its reflection at work.
  assert.match(text(), /2 open\s*1 working/);
});

test('work: attention first, links into the drill-in, no ids, nothing ended until asked', async (t) => {
  t.after(async () => await unmount());
  boot();
  await open('/admin');
  // Units open, those an agent works on, those that need someone.
  assert.match(text(), /4 open\s*1 working\s*3 need attention/);
  assert.match(rows()[0]!.textContent!, /Decay sweep/, 'the unit that needs someone leads');
  assert.match(rows()[0]!.textContent!, /agent question/i);
  assert.match(rows()[0]!.textContent!, /Its agent asked its owner/, 'the phrase, read as words');
  assert.match(rows()[0]!.textContent!, /1\.3M/, 'tokens counted');
  // A running machine by its profile, its price in its title.
  assert.match(rows()[0]!.textContent!, /producer active · gpu-l4/);
  const machine = rows()[0]!.querySelector('[title="modal · $0.80/h"]')!;
  assert.equal(machine.textContent, '· gpu-l4', 'the separator wraps with the machine');
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
  // A need its state already names is said once, by the state in the need's tone.
  const paid = rows().find((row) => /Paid study/.test(row.textContent!))!;
  assert.equal(paid.querySelector('.admin-attn'), null);
  assert.equal(paid.querySelector('.status')!.textContent, 'awaiting payment');
  assert.equal(paid.querySelector('.status')!.className, 'status status--warn');
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

/** Press the button reading `label` inside `scope`: a page holds many `Change` words. */
const press = async (scope: Element, label: string) => {
  const button = [...scope.querySelectorAll('button')].find(
    (b) => b.textContent === label || b.getAttribute('aria-label') === label,
  );
  assert.ok(button, `No “${label}” in ${scope.textContent}`);
  await act(async () => button.click());
  await settle(0);
};
/** Type into the field labelled `label` (an input or a select) inside `form`. */
const fill = async (form: Element, label: string, value: string) => {
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
const send = async (form: HTMLFormElement) => {
  await act(async () => form.requestSubmit());
  await settle(10);
};
const escape = async () => {
  await act(async () => {
    document.body.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
  });
  await settle(0);
};
// ── Credentials (v2): by purpose, a separate table of provider keys, reveal and change ──

const secret = (env: string, purpose: string, over: Record<string, unknown> = {}) => ({
  env,
  purpose,
  plugin: 'pi',
  field: 'model.keyEnv',
  set: true,
  sharedWith: [],
  lastChanged: null,
  lastOk: null,
  lastFailure: null,
  dead: false,
  editable: true,
  ...over,
});
const failure = (minutes: number, code: string, status: number) => ({
  at: ago(minutes),
  relay: 'openai',
  model: 'gpt-5',
  status,
  code,
});
const providerKey = (field: string, description: string, over: Record<string, unknown> = {}) => ({
  provider: 'modal-main',
  label: 'Modal',
  field,
  description,
  present: true,
  health: 'degraded',
  healthReason: 'slow to answer',
  editable: true,
  ...over,
});
const credentials = {
  groups: [
    {
      purpose: 'Agent',
      secrets: [
        secret('OPENAI_API_KEY', 'Agent model calls · OpenAI', {
          lastChanged: ago(3 * 24 * 60),
          // Overloaded once, and answered since.
          lastOk: { at: ago(1), relay: 'pi', model: 'gpt-5' },
          lastFailure: failure(5, 'overloaded', 529),
        }),
      ],
    },
    {
      purpose: 'Fleet agents',
      secrets: [
        secret('FLEET_OPENAI_KEY', 'Fleet agent model calls · OpenAI', {
          plugin: 'fleet',
          field: 'agent.keyEnv',
          dead: true,
          lastFailure: failure(30, 'invalid_api_key', 401),
        }),
      ],
    },
    {
      purpose: 'Fleet machines',
      secrets: [
        secret('CLOUDFLARE_API_TOKEN', 'Fleet machines · Cloudflare', {
          plugin: 'fleet',
          field: 'cloudflare.tokenEnv',
          lastOk: { at: ago(10), relay: 'cloudflare', model: 'vm' },
          lastFailure: failure(2, 'expired', 403),
        }),
      ],
    },
    {
      purpose: 'Platform services',
      secrets: [
        secret('MERV_DB_URL', 'Database', { plugin: 'state', field: 'urlEnv', editable: false }),
        secret('RESEND_API_KEY', 'Invitation email · Resend', {
          plugin: 'mail',
          field: 'resend.keyEnv',
          set: false,
        }),
      ],
    },
  ],
  providers: [
    // Unset, which says so whatever its provider's health.
    providerKey('token_id', 'Modal token id', { present: false }),
    providerKey('token_secret', 'Modal token secret'),
    providerKey('api_key', 'Lambda API key', {
      provider: 'lambda-main',
      label: 'Lambda',
      health: 'ok',
      healthReason: null,
    }),
  ],
  minted: [
    {
      owner: 'sessions',
      kind: 'session-execution',
      live: '8',
      soonestExpiry: new Date(Date.now() + 3.5 * 3_600_000).toISOString(),
      revokedLastDay: '0',
      newestIssued: ago(1),
    },
    {
      owner: 'billing',
      kind: 'invoice-signer',
      live: '1',
      soonestExpiry: null,
      revokedLastDay: '0',
      newestIssued: ago(60),
    },
  ],
};
const rowOf = (table: string, reads: RegExp) =>
  [...document.querySelectorAll(`[aria-label="${table}"] .ruled-row`)].find((row) =>
    reads.test(row.textContent!),
  )!;

test('credentials: purposes lead, names faint, no fingerprint, provider keys their own table', async (t) => {
  t.after(async () => await unmount());
  signedIn();
  serve('/admin/credentials', { body: credentials });
  await open('/admin/credentials');
  const groups = [...document.querySelectorAll('.admin-group')].map((h) => h.textContent);
  assert.deepEqual(groups, [
    'Agent',
    'Fleet agents',
    'Fleet machines',
    'Platform services',
    'Sandbox providers',
  ]);
  // What it is for, then the name it is kept under, faint and in the mono, beneath.
  const agent = rowOf('Agent', /OPENAI_API_KEY/);
  const first = agent.querySelector('[role="cell"]')!;
  assert.equal(first.textContent, 'Agent model calls · OpenAIOPENAI_API_KEY');
  assert.equal(first.querySelector('.admin-env')!.textContent, 'OPENAI_API_KEY');
  assert.ok(first.querySelector('.admin-env')!.classList.contains('mono'));
  const head = [...document.querySelectorAll('[aria-label="Agent"] .ruled-head > *')].map(
    (th) => th.textContent,
  );
  assert.deepEqual(head, ['Purpose', 'State', 'Changed', 'Last call', '']);
  assert.doesNotMatch(text(), /fingerprint|a1b2c3d4|keyEnv/i, 'no hash, no config path');
  // The last call is the newer outcome: a failure since answered is no failing key, and red is
  // a dead key or a failure newer than the last ok.
  assert.match(agent.textContent!, /set3d agook 1m ago/);
  assert.doesNotMatch(agent.textContent!, /failed/);
  const red = [...document.querySelectorAll('.ruled .status--bad')].map((el) => el.textContent);
  assert.deepEqual(red, ['dead', 'failed 30m ago', 'failing', 'failed 2m ago']);
  assert.match(rowOf('Platform services', /RESEND/).textContent!, /unset/);
  // A row without a change or a call draws nothing there, not a dash.
  assert.doesNotMatch(rowOf('Platform services', /MERV_DB_URL/).textContent!, /—/);
  // The head counts what the rows say, a provider key's health included.
  assert.match(text(), /3 set\s*2 unset\s*1 dead\s*1 failing\s*1 degraded/);
  // Only an editable key has its words; an unset one cannot be revealed.
  assert.doesNotMatch(rowOf('Platform services', /MERV_DB_URL/).textContent!, /Reveal|Change/);
  assert.doesNotMatch(rowOf('Platform services', /RESEND/).textContent!, /Reveal/);
  assert.match(rowOf('Platform services', /RESEND/).textContent!, /Change/);
  // The provider keys: the provider by its name, what the key is, its state: unset, else its
  // provider's health while that is not ok, else set.
  const keys = [...document.querySelectorAll('[aria-label="Sandbox providers"] .ruled-head > *')];
  assert.deepEqual(
    keys.map((th) => th.textContent),
    ['Provider', 'Key', 'State', ''],
  );
  const modal = rowOf('Sandbox providers', /token_secret/);
  assert.match(modal.textContent!, /^ModalModal token secrettoken_secretdegraded/);
  assert.ok(modal.querySelector('[title="slow to answer"]'), 'the health reason is its title');
  assert.match(rowOf('Sandbox providers', /token_id/).textContent!, /token_idunset/);
  assert.match(
    rowOf('Sandbox providers', /api_key/).textContent!,
    /^LambdaLambda API keyapi_keyset/,
  );
  assert.doesNotMatch(text(), /modal-main|lambda-main/, 'a provider by its name, not its id');
  assert.equal(document.querySelectorAll('[aria-label="Agent"] .ruled-row').length, 1);
  // Machine credentials stand at the foot, each by what it is for, its owner and kind faint.
  const minted = [...document.querySelectorAll('[aria-label="Machine credentials"] .ruled-row')];
  assert.deepEqual(
    minted.map((row) => row.querySelector('[role="cell"]')!.textContent),
    ['Agent session runssessions · session-execution', 'invoice-signerbilling · invoice-signer'],
  );
  assert.match(minted[0]!.textContent!, /in 3h/, 'an expiry still to come');
});

test('credentials: Reveal shows the value for 30 s with Copy, then takes it off the page', async (t) => {
  t.after(async () => await unmount());
  const copied: string[] = [];
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (value: string) => void copied.push(value) },
  });
  t.after(() => void Reflect.deleteProperty(window.navigator, 'clipboard'));
  signedIn();
  serve('/admin/credentials', { body: credentials });
  const asked: Record<string, unknown>[] = [];
  serve('/admin/credentials/reveal', (_call, body) => {
    asked.push(body);
    return { body: { value: 'env' in body ? 'sk-agent-1234' : 'as-secret-5678' } };
  });
  await open('/admin/credentials');
  await press(rowOf('Agent', /OPENAI_API_KEY/), 'Reveal');
  await settle(10);
  assert.deepEqual(asked, [{ env: 'OPENAI_API_KEY' }], 'one secret per call, by its name');
  assert.match(text(), /sk-agent-1234/);
  const shown = document.querySelector('.admin-secret')!;
  assert.ok(shown.classList.contains('mono'));
  assert.match(shown.parentElement!.textContent!, /30s$/);
  await press(shown.parentElement!, 'Copy');
  await settle(10);
  assert.deepEqual(copied, ['sk-agent-1234']);
  await jump(10_000);
  assert.match(shown.parentElement!.textContent!, /1[89]s$/, 'a quiet countdown');
  await jump(21_000);
  assert.doesNotMatch(text(), /sk-agent-1234/, 'hidden at 30 s');
  assert.equal(document.querySelector('.admin-secret'), null);
  // A provider key is named by its provider and field; Hide takes it away early.
  await press(rowOf('Sandbox providers', /token_secret/), 'Reveal');
  await settle(10);
  assert.deepEqual(asked[1], { provider: 'modal-main', field: 'token_secret' });
  assert.match(text(), /as-secret-5678/);
  await press(rowOf('Sandbox providers', /token_secret/), 'Hide');
  assert.doesNotMatch(text(), /as-secret-5678/);
  assert.equal(asked.length, 2, 'hiding asks nothing');
});

test('credentials: Change sends the new value, states a refusal verbatim, then what reloaded', async (t) => {
  t.after(async () => await unmount());
  signedIn();
  serve('/admin/credentials', { body: credentials });
  const changes: Record<string, unknown>[] = [];
  serve('/admin/credentials/change', (call, body) => {
    changes.push(body);
    return call === 1
      ? {
          status: 422,
          body: {
            error: { code: 'credential_rejected', message: 'OpenAI refused the key (401).' },
          },
        }
      : { body: { ok: true, reloaded: ['pi', 'fleet'] } };
  });
  await open('/admin/credentials');
  assert.equal(document.querySelector('form'), null, 'the form waits for its word');
  await press(rowOf('Agent', /OPENAI_API_KEY/), 'Change');
  const form = document.querySelector<HTMLFormElement>(
    'form[aria-label="Change Agent model calls · OpenAI"]',
  )!;
  assert.ok(form.classList.contains('guard'));
  assert.equal(form.querySelector('input')!.type, 'password');
  await fill(form, 'OPENAI_API_KEY', 'sk-new');
  await send(form);
  assert.match(text(), /OpenAI refused the key \(401\)\./, 'the server’s own words');
  assert.ok(document.querySelector('form'), 'a refusal keeps the form open');
  await send(form);
  assert.deepEqual(changes, [
    { env: 'OPENAI_API_KEY', value: 'sk-new' },
    { env: 'OPENAI_API_KEY', value: 'sk-new' },
  ]);
  assert.equal(document.querySelector('form'), null, 'saved, the form closes');
  assert.match(text(), /Reloaded pi · fleet/);
  assert.ok(requests.filter((r) => r === 'GET /admin/credentials').length >= 2, 'read again');
  // A provider key changes through its provider's fields.
  await press(rowOf('Sandbox providers', /token_id/), 'Change');
  const key = document.querySelector<HTMLFormElement>(
    'form[aria-label="Change Modal · Modal token id"]',
  )!;
  await fill(key, 'token_id', 'ak-1');
  await send(key);
  assert.deepEqual(changes[2], { provider: 'modal-main', fields: { token_id: 'ak-1' } });
});

test('credentials: two rows naming one variable open apart, and only the one changed says so', async (t) => {
  t.after(async () => await unmount());
  signedIn();
  serve('/admin/credentials', {
    body: {
      groups: [
        {
          purpose: 'Agent',
          secrets: [
            secret('OPENAI_API_KEY', 'Agent model calls · OpenAI', { field: 'modelApiKeyEnv' }),
          ],
        },
        {
          purpose: 'Platform services',
          secrets: [
            secret('OPENAI_API_KEY', 'Web search fallback · OpenAI', {
              plugin: 'web',
              field: 'fallback.keyEnv',
            }),
          ],
        },
      ],
      providers: [],
      minted: [],
    },
  });
  serve('/admin/credentials/change', { body: { ok: true, reloaded: ['pi', 'web'] } });
  await open('/admin/credentials');
  const agent = () => rowOf('Agent', /OPENAI_API_KEY/);
  const platform = () => rowOf('Platform services', /OPENAI_API_KEY/);
  await press(agent(), 'Change');
  assert.equal(document.querySelectorAll('form').length, 1, 'one form, under the row pressed');
  assert.ok(agent().classList.contains('admin-unfolded'));
  assert.ok(!platform().classList.contains('admin-unfolded'));
  const form = document.querySelector<HTMLFormElement>('[aria-label="Agent"] form')!;
  await fill(form, 'OPENAI_API_KEY', 'sk-new');
  await send(form);
  assert.equal(text().match(/Reloaded pi · web/g)!.length, 1);
  assert.equal(
    document.querySelector('[aria-label="Agent"] [role="status"]')!.textContent,
    'Reloaded pi · web',
  );
  assert.equal(document.querySelector('[aria-label="Platform services"] [role="status"]'), null);
});

// ── Credits (v2): one row per person, a drawer per person with its windows and controls ──

const grant = (id: string, over: Record<string, unknown> = {}) => ({
  id,
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
  ...over,
});
const use = (kind: string, label: string, unit: string, over: Record<string, unknown>) => ({
  kind,
  label,
  unit,
  limit: null,
  own: false,
  used: { day: 0, week: 0, month: 0, total: 0 },
  left: null,
  ...over,
});
/** The list's row of a type: the drawer's, with today's use alone. */
const listed = (kinds: ReturnType<typeof use>[]) =>
  kinds.map((kind) => ({ ...kind, used: kind.used.day }));
const tomasKinds = [
  use('agent-tokens', 'Agent tokens', 'tokens', { limit: 1_000_000, left: 1_000_000 }),
  // At its limit: the one figure in red.
  use('fleet-tokens', 'Fleet agent tokens', 'tokens', {
    limit: 2_000_000,
    used: { day: 2_000_000, week: 2_000_000, month: 2_000_000, total: 2_000_000 },
    left: 0,
  }),
  use('fleet-usd', 'Fleet machines', 'usd', {
    limit: 25,
    used: { day: 0.004, week: 0.004, month: 0.004, total: 0.004 },
    left: 24.996,
  }),
  // Nothing granted of either provider yet.
  use('provider:fake', 'Fake', 'usd', { limit: 0, left: 0 }),
  use('provider:modal', 'Modal', 'usd', { limit: 0, left: 0 }),
];
const miraKey = `${user.issuer}|mira`;
const miraPath = `/admin/credits/people/${encodeURIComponent(miraKey)}`;
const mira = {
  person: { key: miraKey, label: 'Mira Chen' },
  kinds: [
    use('agent-tokens', 'Agent tokens', 'tokens', {
      limit: 1_000_000,
      own: true,
      used: { day: 40_000, week: 250_000, month: 900_000, total: 4_200_000 },
      left: 960_000,
    }),
    use('fleet-tokens', 'Fleet agent tokens', 'tokens', {
      limit: 2_000_000,
      used: { day: 120_000, week: 600_000, month: 1_500_000, total: 3_000_000 },
      left: 1_880_000,
    }),
    use('fleet-usd', 'Fleet machines', 'usd', {
      limit: 25,
      used: { day: 3.2, week: 18.4, month: 61, total: 140.5 },
      left: 21.8,
    }),
    use('provider:fake', 'Fake', 'usd', { limit: 0, left: 0 }),
    use('provider:modal', 'Modal', 'usd', {
      limit: 100,
      used: { day: 0.5, week: 2.1, month: 4.95, total: 4.95 },
      left: 95.05,
    }),
  ],
  grants: [grant('grant_pilot'), grant('grant_old', { revoked_at: ago(30), reason: 'Trial' })],
  schedules: [
    {
      id: 'sched_monthly',
      provider: 'modal',
      amount: '25',
      starts_at: ago(60),
      cadence: 'monthly',
      validity_periods: 1,
      ends_at: null,
      enabled: true,
    },
  ],
};
const credits = {
  people: [
    { key: miraKey, label: 'Mira Chen', kinds: listed(mira.kinds) },
    { key: `${user.issuer}|tomas`, label: 'Tomás Ruiz', kinds: listed(tomasKinds) },
  ],
};
const tomasPath = `/admin/credits/people/${encodeURIComponent(`${user.issuer}|tomas`)}`;
const drawer = () => document.querySelector<HTMLElement>('#admin-drawer')!;
const block = (label: string) => drawer().querySelector(`section[aria-label="${label}"]`)!;
const bootCredits = () => {
  signedIn();
  serve('/admin/credits', { body: credits });
  serve(miraPath, { body: mira });
  serve(tomasPath, {
    body: {
      person: { key: `${user.issuer}|tomas`, label: 'Tomás Ruiz' },
      kinds: [],
      grants: [],
      schedules: [],
    },
  });
};
/** The whole row opens the drawer, not only the name. */
const openRowOf = async (at = 0) => {
  const row = document.querySelectorAll('[aria-label="Credits"] .ruled-row')[at]!;
  await act(async () => (row.querySelectorAll('[role="cell"]')[2] as HTMLElement).click());
  await settle(10);
};
const openMira = async () => {
  await open('/admin/credits');
  await openRowOf(0);
};

test('credits: one row per person, what is left of each kind, no drawer until a row is opened', async (t) => {
  t.after(async () => await unmount());
  bootCredits();
  await open('/admin/credits');
  const head = [...document.querySelectorAll('[aria-label="Credits"] .ruled-head > *')].map(
    (th) => th.textContent,
  );
  // A column per type, named by what it is for, in the order the server gives them.
  assert.deepEqual(head, [
    'Person',
    'Agent tokens',
    'Fleet agent tokens',
    'Fleet machines',
    'Fake',
    'Modal',
  ]);
  const rows = [...document.querySelectorAll('[aria-label="Credits"] .ruled-row')];
  assert.equal(rows.length, 2);
  // What is left of each limit: today's for the platform's own kinds, a provider's grants.
  assert.equal(
    [...rows[0]!.querySelectorAll('[role="cell"]')].map((c) => c.textContent).join(' | '),
    'Mira Chen | 960K of 1M | 1.9M of 2M | $21.80 of $25 | — | $95.05 of $100',
  );
  const red = [...document.querySelectorAll('[aria-label="Credits"] .status--bad')];
  assert.deepEqual(
    red.map((el) => el.textContent),
    ['0 of 2M'],
    'red is nothing left',
  );
  assert.doesNotMatch(text(), /Design partner pilot/);
  assert.match(text(), /2 people/);
  assert.ok(drawer().hidden);
  assert.ok(
    !requests.some((r) => r.includes('/admin/credits/people/')),
    'nothing read until opened',
  );
});

test('credits: a row opens the drawer — one window for every type, Escape and ↑↓', async (t) => {
  t.after(async () => await unmount());
  bootCredits();
  await openMira();
  assert.ok(!drawer().hidden);
  assert.equal(drawer().querySelector('h2')!.textContent, 'Mira Chen');
  assert.equal(document.activeElement, drawer().querySelector('h2'), 'the cursor goes to the name');
  assert.ok(requests.includes(`GET ${miraPath}`), requests.join('\n'));
  const windows = drawer().querySelectorAll('[role="group"][aria-label="Window"] button');
  assert.deepEqual(
    [...windows].map((b) => [b.textContent, b.getAttribute('aria-pressed')]),
    [
      ['1D', 'true'],
      ['1W', 'false'],
      ['1M', 'false'],
      ['Total', 'false'],
    ],
  );
  assert.deepEqual(
    [...drawer().querySelectorAll('section')].map((s) => s.getAttribute('aria-label')),
    ['Agent tokens', 'Fleet agent tokens', 'Fleet machines', 'Fake', 'Modal'],
  );
  // The limit beside the word that changes it (a day's for the platform's own kinds), then
  // what was used in the window and what is left.
  assert.match(
    block('Agent tokens').textContent!,
    /^Agent tokens1M a dayownSet limit40K used960K left$/,
  );
  assert.match(
    block('Fleet machines').textContent!,
    /^Fleet machines\$25 a daySet limit\$3\.20 used\$21\.80 left$/,
  );
  // A provider's limit is what was granted, and its control gives more.
  assert.match(
    block('Modal').textContent!,
    /^Modal\$100 grantedGive credit\$0\.50 used\$95\.05 left/,
  );
  assert.match(block('Modal').textContent!, /Give credit/);
  // Nothing granted yet: no limit, nothing left to draw, still the word that gives.
  assert.equal(block('Fake').textContent, 'FakeGive credit$0 used');
  assert.match(block('Modal').textContent!, /Design partner pilot/);
  assert.match(block('Modal').textContent!, /\$25 monthlyon/);
  assert.match(block('Modal').textContent!, /revoked/);
  // The meter stands beside the figure it draws, and only where there is a limit.
  const meter = block('Modal').querySelector<HTMLElement>('.home-meter > span')!;
  assert.equal(meter.style.width, '95.05%');
  // One window, at the top, for every type.
  await press(drawer(), '1W');
  assert.match(block('Agent tokens').textContent!, /250K used/);
  assert.match(block('Modal').textContent!, /\$2\.10 used/);
  await press(drawer(), 'Total');
  assert.match(block('Fleet machines').textContent!, /\$140\.50 used/);
  assert.doesNotMatch(drawer().textContent!, /acct_|grant_|sched_|auth\.example|mira\b/);
  // ↓ opens the next person; Escape closes and hands the cursor back to the name.
  await act(async () => {
    document.body.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    );
  });
  await settle(10);
  assert.equal(drawer().querySelector('h2')!.textContent, 'Tomás Ruiz');
  assert.ok(requests.includes(`GET ${tomasPath}`));
  await escape();
  assert.ok(drawer().hidden);
  assert.equal(document.activeElement!.textContent, 'Tomás Ruiz');
  // Close, too, returns to the list.
  await openRowOf(0);
  assert.equal(drawer().querySelector('h2')!.textContent, 'Mira Chen');
  await press(drawer(), 'Close');
  assert.ok(drawer().hidden);
});

test('credits: on a phone the drawer takes the page', async (t) => {
  t.after(async () => await unmount());
  bootCredits();
  await resize(false);
  await openMira();
  assert.ok(document.querySelector<HTMLElement>('.work-main')!.hidden, 'the list steps aside');
  assert.ok(!drawer().hidden);
  await escape();
  assert.ok(!document.querySelector<HTMLElement>('.work-main')!.hidden);
});

test('credits: Set limit posts the person’s own limit, and Clear returns to the default', async (t) => {
  t.after(async () => await unmount());
  bootCredits();
  const limits: Record<string, unknown>[] = [];
  serve(`${miraPath}/limits`, (_call, body) => {
    limits.push(body);
    return { body: { kind: body.kind, limit: body.limit } };
  });
  await openMira();
  await press(block('Agent tokens'), 'Set limit');
  const form = block('Agent tokens').querySelector('form')!;
  const input = form.querySelector('input')!;
  assert.equal(input.value, '1000000', 'its own limit, to change');
  assert.equal(input.type, 'number');
  assert.deepEqual([input.min, input.max, input.step], ['1', '1000000000', '1'], 'whole tokens');
  await fill(form, 'Tokens a day', '2000000');
  await send(form);
  assert.deepEqual(limits, [{ kind: 'agent-tokens', limit: 2_000_000 }]);
  assert.equal(block('Agent tokens').querySelector('form'), null, 'saved, the form closes');
  assert.equal(requests.filter((r) => r === `GET ${miraPath}`).length, 2, 'the drawer reads again');
  await press(block('Agent tokens'), 'Set limit');
  await press(block('Agent tokens'), 'Clear');
  await settle(10);
  assert.deepEqual(limits[1], { kind: 'agent-tokens', limit: null });
  // A kind on the platform's default has nothing to clear.
  await press(block('Fleet machines'), 'Set limit');
  const usdForm = block('Fleet machines').querySelector('form')!;
  assert.match(usdForm.textContent!, /Dollars a day/);
  assert.doesNotMatch(usdForm.textContent!, /Clear/);
  const dollars = usdForm.querySelector('input')!;
  assert.deepEqual([dollars.min, dollars.max, dollars.step], ['0.01', '100000', '0.01']);
  await fill(usdForm, 'Dollars a day', '40');
  await send(usdForm);
  assert.deepEqual(limits[2], { kind: 'fleet-usd', limit: 40 });
});

test('credits: Give credit grants the person, keeps its key through a retry; ⋯ revokes', async (t) => {
  t.after(async () => await unmount());
  bootCredits();
  const grants: Record<string, unknown>[] = [];
  serve('/admin/credits/grants', (call, body) => {
    grants.push(body);
    // The first answer is lost: the retry must be the same grant.
    return call === 1 ? { status: 502, body: null } : { body: { id: body.id } };
  });
  serve('/admin/credits/grants/grant_pilot/revoke', { body: { id: 'grant_pilot', revoked: true } });
  await openMira();
  await press(block('Modal'), 'Give credit');
  const form = block('Modal').querySelector<HTMLFormElement>(
    'form[aria-label="Give credit · modal"]',
  )!;
  await fill(form, 'Amount', ' 25 ');
  await fill(form, 'Reason', 'Burst for the sweep');
  await send(form);
  assert.match(text(), /Retry same request/);
  await click('Retry same request');
  await settle(10);
  assert.equal(grants.length, 2);
  assert.deepEqual(grants[1], grants[0], 'the retry is the same grant: its id and its validFrom');
  const { id, validFrom, ...terms } = grants[0]!;
  assert.equal(typeof id, 'string');
  assert.ok(!Number.isNaN(Date.parse(String(validFrom))), 'validFrom is always sent');
  assert.deepEqual(terms, {
    provider: 'modal',
    amount: '25',
    person: miraKey,
    expiresAt: null,
    reason: 'Burst for the sweep',
  });
  assert.equal(block('Modal').querySelector('form'), null, 'given, the form closes');
  // A revoked grant has no ⋯; the live one's opens its guard.
  assert.equal(block('Modal').querySelectorAll('button[aria-label="Revoke grant"]').length, 1);
  await press(block('Modal'), 'Revoke grant');
  // Escape inside the guard is its Cancel, not the drawer's.
  await act(async () => {
    document
      .querySelector('[role="alertdialog"] button')!
      .dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  assert.equal(document.querySelector('[role="alertdialog"]'), null);
  assert.ok(!drawer().hidden, 'the drawer stays');
  await press(block('Modal'), 'Revoke grant');
  assert.ok(document.querySelector('[role="alertdialog"][aria-label="Revoke grant?"]'));
  await press(document.querySelector('[role="alertdialog"]')!, 'Revoke grant');
  await settle(10);
  assert.ok(
    requests.includes('POST /admin/credits/grants/grant_pilot/revoke'),
    requests.join('\n'),
  );
  assert.equal(document.querySelector('[role="alertdialog"]'), null, 'done, the guard closes');
  assert.ok(!drawer().hidden);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { click, eventStream, mount, requests, serve, settle, text, unmount } from './ui-render.js';

const { createElement } = await import('react');
const { act } = await import('react-dom/test-utils');
const { CustomerApp } = await import('../packages/ui/web/customer/app.js');
const { Uploader } = await import('../packages/ui/web/customer/uploads.js');
const { deletionNotice, POLICY } = await import('../packages/ui/web/customer/files.js');
const { setCredentials } = await import('../packages/ui/web/customer/api.js');

const ID = `ce_${'a'.repeat(32)}`;
const BASE = `/customer-experiments/requests/${ID}`;
const CAPABILITY = 'ce_customer_capability';

const conversation = {
  id: 'conversation_1',
  projectId: 'p1',
  userId: 'sponsor',
  title: 'Intake',
  revision: 1,
  activeCommandId: null as string | null,
  checkpoint: null,
  previousCheckpoint: null,
  createdAt: '2026-10-14T00:00:00Z',
  updatedAt: '2026-10-14T00:00:00Z',
};
const turn = (id: string, messages: { role: string; text: string }[]) => ({
  id,
  conversationId: 'conversation_1',
  epoch: 0,
  runtimeId: 'runtime_1',
  status: 'completed',
  messages,
  outcomes: [],
  error: null,
  createdAt: '2026-10-14T00:00:00Z',
  expiresAt: '2026-10-14T01:00:00Z',
  completedAt: '2026-10-14T00:01:00Z',
});
// The customer's snapshot: the sponsor-only fields (host, models) removed.
const snapshot = (commands: ReturnType<typeof turn>[] = []) => ({
  stage: { name: 'idle', since: '2026-10-14T00:00:00Z' },
  now: new Date().toISOString(),
  available: true,
  conversation,
  commands,
  streamId: 'stream_1',
  sequence: commands.length,
  tail: [],
});
const plan = (extra: object = {}) => ({
  revision: 1,
  document: '',
  updatedBy: 'agent',
  updatedAt: '2026-10-14T00:00:00Z',
  status: 'drafting',
  feedback: null,
  contract: null,
  ...extra,
});
const listing = (extra: object = {}) => ({
  folders: [],
  files: [],
  cursor: null,
  totalBytes: 0,
  limitBytes: 1e12,
  deleteAt: null,
  deletionPolicy: null,
  ...extra,
});

/** A Supabase client that has no session yet and signs in anonymously. */
const supabase = (made: string[]) =>
  (() => ({
    auth: {
      getSession: async () => ({ data: { session: null } }),
      signInAnonymously: async () => {
        made.push('anonymous');
        return { data: { session: { access_token: 'anon-token' } }, error: null };
      },
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      refreshSession: async () => ({ data: { session: { access_token: 'anon-token-2' } } }),
    },
  })) as unknown as typeof import('@supabase/supabase-js').createClient;

/** Every request's headers, by `METHOD path`, as the page sent them. */
function recordHeaders() {
  const inner = globalThis.fetch;
  const seen: { request: string; headers: Headers; body?: unknown }[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init: RequestInit = {}) => {
    seen.push({
      request: `${init.method ?? 'GET'} ${String(input)}`,
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return inner(input, init);
  }) as typeof fetch;
  return { seen, restore: () => void (globalThis.fetch = inner) };
}

function boot(state: { plan: object; files: object; commands: ReturnType<typeof turn>[] }) {
  serve(`${BASE}/session`, {
    body: {
      version: 3,
      bound: false,
      login: { url: 'https://supabase.test', publishableKey: 'pk' },
    },
  });
  serve(`${BASE}/chat`, () => ({ body: snapshot(state.commands) }));
  serve(`${BASE}/plan`, () => ({ body: state.plan }));
  serve(`${BASE}/files?prefix=`, () => ({ body: state.files }));
  serve(BASE, { body: { state: 'planning' } });
  const stream = eventStream();
  serve(`${BASE}/chat/events`, { stream: stream.stream });
  return stream;
}

const open = async (made: string[] = []) => {
  history.replaceState(null, '', `/customer-experiments/r/${ID}#token=${CAPABILITY}`);
  await mount(createElement(CustomerApp, { client: supabase(made) }));
  await settle(20);
};
const write = async (value: string) => {
  const area = document.querySelector<HTMLTextAreaElement>('#pi-draft')!;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )!.set!;
  await act(async () => {
    setter.call(area, value);
    area.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
};

test('the customer page signs in silently, keeps the capability off the address bar, and speaks in the intake conversation', async (t) => {
  const headers = recordHeaders();
  t.after(async () => {
    await unmount();
    headers.restore();
    setCredentials(null);
  });
  const state = {
    plan: plan(),
    files: listing({ totalBytes: 48_000_000 }),
    commands: [turn('c1', [{ role: 'assistant', text: 'What do you want to test? ce_abc_123' }])],
  };
  boot(state);
  const sent: Record<string, unknown>[] = [];
  serve(`${BASE}/chat/messages`, (_call, body) => {
    sent.push(body);
    state.commands = [
      ...state.commands,
      turn(body.commandId as string, [{ role: 'user', text: body.text as string }]),
    ];
    return { body: { ok: true } };
  });
  const made: string[] = [];
  await open(made);

  // The capability left the address and stays for this tab only; an anonymous user was made.
  assert.equal(location.hash, '');
  assert.equal(sessionStorage.getItem(`merv:customer-experiment:${ID}`), CAPABILITY);
  assert.deepEqual(made, ['anonymous']);
  const bind = headers.seen.find((entry) => entry.request === `POST ${BASE}/session`)!;
  assert.equal(bind.headers.get('authorization'), `Bearer ${CAPABILITY}`);
  assert.equal(bind.headers.get('x-merv-identity'), 'anon-token');
  // GET /session is the capability's alone.
  const first = headers.seen.find((entry) => entry.request === `GET ${BASE}/session`)!;
  assert.equal(first.headers.get('x-merv-identity'), null);

  // Arrive: the drop zone with the request's size, the reused transcript and composer below.
  assert.match(text(), /Merv \| Experiment/);
  assert.match(text(), /Drop datasets, papers, context/);
  assert.match(text(), /48 MB/);
  assert.match(text(), /What do you want to test\? ce_abc_123/);
  assert.equal(text().includes('Audio'), false);
  // No project's records are read on this page, and the account's token is never sent.
  assert.equal(
    requests.some((request) => request.includes('/tools/')),
    false,
  );
  const stream = headers.seen.find((entry) => entry.request === `GET ${BASE}/chat/events`)!;
  assert.equal(stream.headers.get('authorization'), `Bearer ${CAPABILITY}`);
  assert.equal(stream.headers.get('x-merv-identity'), 'anon-token');

  await write('Does augmentation help?');
  await click('Send');
  await settle(10);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'Does augmentation help?');
  assert.equal(typeof sent[0].commandId, 'string');
  assert.deepEqual(Object.keys(sent[0]).sort(), ['commandId', 'text']);
  assert.match(text(), /Does augmentation help\?/);

  // Scrolling down makes the chat the page; the header gains Files and Plan.
  assert.equal(text().includes('Files'), false);
  await act(async () => {
    document
      .querySelector('.cx-arrive')!
      .dispatchEvent(new window.WheelEvent('wheel', { deltaY: 40, bubbles: true }));
  });
  await settle(0);
  assert.equal(text().includes('Drop datasets'), false);
  assert.match(text(), /Files/);
  assert.match(text(), /Plan/);
  assert.equal(document.querySelector('.cx-dot'), null);
});

test('the plan is edited against its revision, submitted, and paid for once accepted', async (t) => {
  t.after(async () => {
    await unmount();
    setCredentials(null);
  });
  const state = {
    plan: plan({ document: '# Plan\n\nTrain twice.' }) as Record<string, unknown>,
    files: listing(),
    commands: [],
  };
  boot(state);
  const saved: Record<string, unknown>[] = [];
  serve(`${BASE}/plan`, (_call, body) => {
    if (Object.keys(body).length) {
      saved.push(body);
      state.plan = { ...state.plan, revision: 2, document: body.document };
    }
    return { body: state.plan };
  });
  const submitted: Record<string, unknown>[] = [];
  serve(`${BASE}/plan/submit`, (_call, body) => {
    submitted.push(body);
    state.plan = { ...state.plan, status: 'verifying' };
    return { body: state.plan };
  });
  await open();
  await act(async () => {
    document
      .querySelector('.cx-arrive')!
      .dispatchEvent(new window.WheelEvent('wheel', { deltaY: 40, bubbles: true }));
  });
  await settle(0);
  // A written document lights the Plan button's dot.
  assert.ok(document.querySelector('.cx-dot'));
  await click('Plan');
  await settle(10);
  assert.match(text(), /Draft/);
  const area = document.querySelector<HTMLTextAreaElement>('.cx-plan-text')!;
  assert.equal(area.value, '# Plan\n\nTrain twice.');
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )!.set!;
  await act(async () => {
    setter.call(area, '# Plan\n\nTrain three times.');
    area.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await click('Submit');
  await settle(20);
  assert.deepEqual(saved, [{ expectedRevision: 1, document: '# Plan\n\nTrain three times.' }]);
  assert.deepEqual(submitted, [{ expectedRevision: 2 }]);
  assert.match(text(), /Verifying/);
  // Read-only while it is verified: no editor, no Submit.
  assert.equal(document.querySelector('.cx-plan-text'), null);
  assert.equal(text().includes('Submit'), false);

  state.plan = {
    ...state.plan,
    status: 'accepted',
    contract: { version: 4, priceCents: 1000, currency: 'usd', limits: {} },
  };
  const checkouts: Record<string, unknown>[] = [];
  serve(`${BASE}/checkout`, (_call, body) => {
    checkouts.push(body);
    return { body: { url: 'https://checkout.stripe.com/c/pay_1' } };
  });
  await settle(4100);
  assert.match(text(), /Accepted/);
  assert.match(text(), /Payment is taken once, securely, by Stripe/);
  await click('Pay $10');
  // v3 checkout names the accepted contract and sends no email.
  assert.deepEqual(checkouts, [{ contractVersion: 4 }]);
});

test('uploads go to the presigned part URLs, sign missing or expired parts again, and complete with ETags', async (t) => {
  t.after(async () => {
    await unmount();
    setCredentials(null);
  });
  setCredentials({
    request: ID,
    capability: CAPABILITY,
    identity: () => 'anon-token',
    renew: async () => null,
  });
  const created: Record<string, unknown>[] = [];
  serve(`${BASE}/files/uploads`, (_call, body) => {
    created.push(body);
    // Only the first part's URL comes with the upload; the rest are asked for.
    return { body: { uploadId: 'up_1', partSize: 5, parts: [{ partNumber: 1, url: 'u1' }] } };
  });
  const signed: Record<string, unknown>[] = [];
  serve(`${BASE}/files/uploads/up_1/parts`, (call, body) => {
    signed.push(body);
    const numbers = body.partNumbers as number[];
    return {
      body: { parts: numbers.map((n) => ({ partNumber: n, url: `u${n}${call > 2 ? 'b' : ''}` })) },
    };
  });
  const completed: Record<string, unknown>[] = [];
  serve(`${BASE}/files/uploads/up_1/complete`, (_call, body) => {
    completed.push(body);
    return { body: { key: body.key } };
  });
  const puts: string[] = [];
  let expired = true;
  const done: string[] = [];
  const uploader = new Uploader({
    onDone: () => done.push('done'),
    put: async (url, body, progress) => {
      puts.push(url);
      // Part 3's first URL has expired.
      if (url === 'u3' && expired) {
        expired = false;
        return { status: 403, etag: null };
      }
      progress(body.size);
      return { status: 200, etag: `"etag-${url}"` };
    },
  });
  const file = new File(['abcdefghijkl'], 'train.csv', { type: 'text/csv' });
  uploader.add([{ file, path: 'train.csv' }], 'data/');
  for (let i = 0; i < 20 && !done.length; i++) await settle(5);
  assert.deepEqual(created, [{ key: 'data/train.csv', size: 12, contentType: 'text/csv' }]);
  assert.ok(signed.length >= 2);
  assert.equal(puts.includes('u3b'), true);
  assert.deepEqual(completed, [
    {
      key: 'data/train.csv',
      parts: [
        { partNumber: 1, etag: '"etag-u1"' },
        { partNumber: 2, etag: '"etag-u2"' },
        { partNumber: 3, etag: '"etag-u3b"' },
      ],
    },
  ]);
  const view = uploader.snapshot();
  assert.equal(view.items[0]!.state, 'done');
  assert.equal(view.loaded, 12);
});

test('the files screen says when the files are deleted', () => {
  assert.deepEqual(deletionNotice({ deleteAt: null }), { text: POLICY, deleted: false });
  assert.equal(POLICY, 'Deleted 48 hours after the experiment ends');
  const later = deletionNotice({ deleteAt: new Date(Date.now() + 86_400_000).toISOString() });
  assert.match(later.text, /^Files are deleted on /);
  assert.equal(later.deleted, false);
  const gone = deletionNotice({ deleteAt: new Date(Date.now() - 1000).toISOString() });
  assert.match(gone.text, /^Files deleted on /);
  assert.equal(gone.deleted, true);
});

test('the file manager lists folders with their sizes and deletes after confirming', async (t) => {
  t.after(async () => {
    await unmount();
    setCredentials(null);
  });
  const state = {
    plan: plan(),
    files: listing({
      folders: [{ prefix: 'images/', size: 3_200_000, count: 12 }],
      files: [{ key: 'notes.md', size: 2048, uploaded: '2026-10-14T10:00:00Z' }],
      totalBytes: 3_202_048,
    }),
    commands: [],
  };
  boot(state);
  const deleted: string[] = [];
  serve(`${BASE}/files?key=notes.md`, () => {
    deleted.push('notes.md');
    return { body: { deleted: 1 } };
  });
  await open();
  await click('Drop datasets');
  await settle(10);
  assert.match(text(), /images/);
  assert.match(text(), /3\.2 MB/);
  assert.match(text(), /notes\.md/);
  assert.match(text(), /Deleted 48 hours after the experiment ends/);
  await act(async () =>
    document.querySelector<HTMLButtonElement>('.cx-entry.file [aria-label="Delete"]')!.click(),
  );
  assert.match(text(), /Delete notes\.md\?/);
  assert.match(text(), /can’t be undone/);
  await act(async () =>
    document.querySelector<HTMLButtonElement>('.cx-dialog .btn--danger')!.click(),
  );
  await settle(10);
  assert.deepEqual(deleted, ['notes.md']);
  assert.ok(requests.includes(`DELETE ${BASE}/files?key=notes.md`));
});

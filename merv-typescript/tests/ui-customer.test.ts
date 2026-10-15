import assert from 'node:assert/strict';
import test from 'node:test';
import { click, eventStream, mount, requests, serve, settle, text, unmount } from './ui-render.js';

const { createElement } = await import('react');
const { act } = await import('react-dom/test-utils');
const { CustomerApp } = await import('../packages/ui/web/customer/app.js');
const { Uploader } = await import('../packages/ui/web/customer/uploads.js');
const { deletionNotice, POLICY } = await import('../packages/ui/web/customer/files.js');
const { splitPlan } = await import('../packages/ui/web/customer/plan-card.js');
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
// The customer's snapshot (chat-http.ts customerChat): models removed, and of the machine only
// whether it runs.
const snapshot = (
  commands: ReturnType<typeof turn>[] = [],
  state: 'none' | 'starting' | 'ready' = 'none',
) => ({
  stage: { name: 'idle', since: '2026-10-14T00:00:00Z' },
  now: new Date().toISOString(),
  available: true,
  conversation,
  commands,
  host: {
    machine: null,
    preferred: '',
    catalog: [],
    state,
    idleEndsAt: null,
    idleSeconds: 600,
    moving: null,
    lastMove: null,
  },
  models: [],
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
  // Opening the page starts the intake's machine.
  serve(`${BASE}/chat/warm`, () => ({ body: snapshot(state.commands, 'starting') }));
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
  // Merv leads to runmerv.com; the pill says this is Merv's New experiment.
  assert.equal(
    document.querySelector<HTMLAnchorElement>('.cx-brand-merv')!.href,
    'https://runmerv.com/',
  );
  assert.match(document.querySelector('.cx-feature')!.textContent!, /New experiment/);
  assert.match(text(), /Chug anything/);
  assert.match(text(), /48 MB/);
  assert.match(text(), /What do you want to test\? ce_abc_123/);
  assert.equal(text().includes('Audio'), true);
  // No project's records are read on this page, and the account's token is never sent.
  assert.equal(
    requests.some((request) => request.includes('/tools/')),
    false,
  );
  const stream = headers.seen.find((entry) => entry.request === `GET ${BASE}/chat/events`)!;
  assert.equal(stream.headers.get('authorization'), `Bearer ${CAPABILITY}`);
  assert.equal(stream.headers.get('x-merv-identity'), 'anon-token');
  // Opening the page starts the agent's machine once, with the customer's credentials.
  const warms = headers.seen.filter((entry) => entry.request === `POST ${BASE}/chat/warm`);
  assert.equal(warms.length, 1);
  assert.equal(warms[0].headers.get('authorization'), `Bearer ${CAPABILITY}`);
  assert.equal(warms[0].headers.get('x-merv-identity'), 'anon-token');
  // A conversation under way keeps its heading and has no first-question prompt.
  assert.equal(document.querySelector('.cx-chat--empty'), null);
  assert.ok(document.querySelector('#cx-chat-title'));

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
  assert.equal(text().includes('Chug anything'), false);
  assert.match(text(), /Files/);
  // No plan yet: no Plan button.
  assert.equal(
    [...document.querySelectorAll('.cx-nav-button')].some((b) => b.textContent === 'Plan'),
    false,
  );
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
  // A written document brings the Plan button.
  assert.ok([...document.querySelectorAll('.cx-nav-button')].some((b) => b.textContent === 'Plan'));
  // An unopened revision makes it pulse; opening the plan quiets it.
  assert.ok(document.querySelector('.cx-nav-button--fresh'));
  await write('Keep this draft while I read the plan');
  await click('Plan');
  await settle(10);
  assert.equal(document.querySelector('.cx-nav-button--fresh'), null);
  assert.ok(document.querySelector('.pi-dock'));
  assert.equal(
    document.querySelector<HTMLTextAreaElement>('#pi-draft')!.value,
    'Keep this draft while I read the plan',
  );
  assert.match(document.querySelector('.pi-dock')!.textContent!, /Audio/);
  await act(async () =>
    document.querySelector<HTMLButtonElement>('button[aria-label="Expand"]')!.click(),
  );
  assert.equal(document.querySelector('.pi-dock'), null);
  assert.equal(
    document.querySelector<HTMLTextAreaElement>('#pi-draft')!.value,
    'Keep this draft while I read the plan',
  );
  await click('Plan');
  await act(async () =>
    document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click(),
  );
  assert.equal(document.querySelector('.pi-dock'), null);
  await click('Chat');
  assert.ok(document.querySelector('.pi-dock'));
  await settle(10);
  assert.match(text(), /Draft/);
  // A written plan opens as its card; Edit opens the text.
  assert.ok(document.querySelector('.plan-card h1'));
  assert.equal(document.querySelector('.cx-plan-text'), null);
  await click('Edit');
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
  // With the agent idle, the verification turn can be sent again for the same revision.
  await click('Resend');
  await settle(20);
  assert.deepEqual(submitted, [{ expectedRevision: 2 }, { expectedRevision: 2 }]);

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
  // The sweeper's record wins: the files are gone even where deleteAt is still ahead.
  const swept = deletionNotice({
    deleteAt: new Date(Date.now() + 86_400_000).toISOString(),
    deletedAt: new Date(Date.now() - 1000).toISOString(),
  });
  assert.equal(swept.deleted, true);
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
  // The drop zone opens the file picker; the size beside it opens the files.
  await act(async () => {
    document.querySelector<HTMLElement>('.cx-drop-size')!.click();
  });
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

test('a failure opening the page offers a retry; only a refused link is called invalid', async (t) => {
  t.after(async () => {
    await unmount();
    setCredentials(null);
  });
  const state = { plan: plan(), files: listing(), commands: [] };
  boot(state);
  serve(`${BASE}/session`, { status: 503, body: { error: { code: 'unavailable', message: 'x' } } });
  await open();
  assert.match(text(), /Couldn’t open the experiment\. Try again\./);
  assert.equal(text().includes('not valid'), false);
  boot(state);
  await click('Retry');
  await settle(20);
  assert.match(text(), /Chug anything/);
});

test('a link the server refuses is not valid', async (t) => {
  t.after(async () => {
    await unmount();
    setCredentials(null);
  });
  boot({ plan: plan(), files: listing(), commands: [] });
  serve(`${BASE}/session`, {
    status: 404,
    body: { error: { code: 'not_found', message: 'Request not found' } },
  });
  await open();
  assert.match(text(), /Request not found/);
  assert.equal(text().includes('Retry'), false);
});

test('before the first question the chat has no heading and asks for one mid-page', async (t) => {
  t.after(async () => {
    await unmount();
    setCredentials(null);
  });
  boot({ plan: plan(), files: listing(), commands: [] });
  await open();
  assert.ok(document.querySelector('.cx-chat--empty'));
  assert.equal(document.querySelector('#cx-chat-title'), null);
  assert.equal(document.querySelector('.cx-chat')!.getAttribute('aria-label'), 'Chat');
  assert.equal(document.querySelector('.pi-messages'), null);
  // The question types itself out: it starts empty and grows toward the full prompt.
  const placeholder = () => document.querySelector<HTMLTextAreaElement>('#pi-draft')!.placeholder;
  assert.ok('What do you want to learn?'.startsWith(placeholder().replace(/[\u258F ]$/, '')));
  await settle(2500);
  assert.match(placeholder(), /^What do you want to learn\?[\u258F ]$/);
  // The machine is already starting for that first question.
  assert.equal(requests.filter((request) => request === `POST ${BASE}/chat/warm`).length, 1);
});

test('/start makes its request as it opens and becomes that request’s page', async (t) => {
  t.after(async () => {
    await unmount();
    setCredentials(null);
  });
  const made: Record<string, unknown>[] = [];
  boot({ plan: plan(), files: listing(), commands: [] });
  serve('/start/requests', (_call, body) => {
    made.push(body);
    return {
      status: 201,
      body: { id: ID, customerUrl: `/customer-experiments/r/${ID}#token=${CAPABILITY}` },
    };
  });
  history.replaceState(null, '', '/start');
  await mount(createElement(CustomerApp, { client: supabase([]) }));
  await settle(20);
  // Nothing was typed or dropped: the request is made with no message, once.
  assert.equal(made.length, 1);
  assert.equal(made[0].message, undefined);
  assert.equal(made[0].title, 'New experiment');
  assert.equal(typeof made[0].requestId, 'string');
  // The page is the request's now, its capability off the address bar, its machine warming.
  assert.equal(location.pathname, `/customer-experiments/r/${ID}`);
  assert.equal(location.hash, '');
  assert.match(text(), /Chug anything/);
  assert.ok(document.querySelector('.cx-chat--empty'));
  assert.equal(requests.filter((request) => request === `POST ${BASE}/chat/warm`).length, 1);
});

test('the plan card takes its title, question and sections from the free text', () => {
  const plan = splitPlan(
    '# Does it help?\n\nIntro line.\n\n## Question\nWhy ask.\n\n```\n## not a heading\n```\n\n## Method\n1. Train.\n\n## Empty\n',
  );
  assert.equal(plan.title, 'Does it help?');
  assert.equal(plan.lead, 'Intro line.');
  assert.deepEqual(
    plan.sections.map((s) => s.name),
    ['Question', 'Method'],
  );
  assert.match(plan.sections[0]!.body, /## not a heading/);
});

test('customer audio uses its authenticated transport and survives moving into and out of the plan dock', async (t) => {
  const headers = recordHeaders();
  t.after(async () => {
    await unmount();
    headers.restore();
    setCredentials(null);
  });
  let connections = 0,
    closed = 0,
    stopped = 0;
  let channel: { onmessage?: (event: { data: string }) => void; readyState: string; send(): void };
  const original = {
    Audio: globalThis.Audio,
    AudioContext: globalThis.AudioContext,
    RTCPeerConnection: globalThis.RTCPeerConnection,
  };
  const media = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  t.after(() => {
    Object.assign(globalThis, original);
    if (media) Object.defineProperty(navigator, 'mediaDevices', media);
    else Reflect.deleteProperty(navigator, 'mediaDevices');
  });
  Object.assign(globalThis, {
    Audio: class {
      setAttribute() {}
    },
    AudioContext: class {
      createAnalyser = () => ({
        fftSize: 512,
        getByteTimeDomainData(data: Uint8Array) {
          data.fill(128);
        },
      });
      createMediaStreamSource = () => ({ connect() {} });
      async close() {}
    },
    RTCPeerConnection: class {
      constructor() {
        connections++;
      }
      iceGatheringState = 'complete';
      localDescription = { sdp: 'customer-offer' };
      createDataChannel = () => (channel = { readyState: 'open', send() {} });
      addTrack() {}
      createOffer = async () => ({});
      setLocalDescription = async () => {};
      setRemoteDescription = async () => {};
      close() {
        closed++;
      }
    },
  });
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: async () => ({
        getAudioTracks: () => [],
        getTracks: () => [
          {
            stop() {
              stopped++;
            },
          },
        ],
      }),
    },
  });
  boot({
    plan: plan({ document: '# Test plan' }),
    files: listing(),
    commands: [
      turn('c1', [
        { role: 'user', text: 'Hello' },
        { role: 'assistant', text: 'Hi there' },
      ]),
    ],
  });
  serve(`${BASE}/chat/voice`, { body: { sdp: 'customer-answer' } });
  await open();
  await click('Audio');
  const offer = headers.seen.find((entry) => entry.request === `POST ${BASE}/chat/voice`)!;
  assert.ok(offer);
  assert.equal(offer.headers.get('authorization'), `Bearer ${CAPABILITY}`);
  assert.equal(offer.headers.get('x-merv-identity'), 'anon-token');
  assert.equal(
    requests.some((request) => request.includes('/tools/pi.voice')),
    false,
  );
  await act(async () =>
    document
      .querySelector('.cx-arrive')!
      .dispatchEvent(new window.WheelEvent('wheel', { deltaY: 40, bubbles: true })),
  );
  await click('Collapse to voice');
  assert.ok(document.querySelector('.pi-dock--voice'));
  assert.equal(document.querySelector('.pi-messages'), null);
  assert.match(text(), /Chat/);
  await act(async () => {
    channel.onmessage?.({ data: JSON.stringify({ type: 'session.started' }) });
    channel.onmessage?.({
      data: JSON.stringify({ type: 'session.input_transcript.delta', delta: 'Explain this plan' }),
    });
  });
  assert.match(document.querySelector('.voice--sphere')!.textContent!, /Explain this plan/);
  const sphere = document.querySelector<HTMLButtonElement>('.voice-sphere-button')!;
  await act(async () =>
    sphere.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 1 })),
  );
  await settle(350);
  assert.equal(sphere.getAttribute('aria-pressed'), 'true');
  await click('Resume');
  assert.equal(sphere.getAttribute('aria-pressed'), 'false');
  await click('Plan');
  assert.ok(document.querySelector('.pi-dock--voice .voice'));
  assert.equal(document.querySelector('.pi-messages'), null);
  await act(async () => {
    const sphere = document.querySelector<HTMLButtonElement>('.voice-sphere-button')!;
    sphere.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 1 }));
    sphere.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 2 }));
    sphere.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, detail: 2 }));
  });
  await settle(350);
  assert.ok(document.querySelector('.pi-dock .pi-messages'));
  assert.equal(document.querySelector('.pi-dock--voice'), null);
  assert.equal(connections, 1);
  await act(async () =>
    document.querySelector<HTMLButtonElement>('button[aria-label="Expand"]')!.click(),
  );
  assert.ok(document.querySelector('.cx-chat .voice'));
  assert.equal(connections, 1);
  assert.equal(closed, 0);
  await click('Collapse to voice');
  assert.equal(document.querySelector('.pi-messages'), null);
  await click('Close');
  await act(async () => channel.onmessage?.({ data: JSON.stringify({ type: 'session.closed' }) }));
  assert.equal(closed, 1);
  assert.equal(stopped, 1);
  assert.equal(document.querySelector('.pi-dock--voice'), null);
  assert.ok(document.querySelector('.pi-messages'));
  assert.match(text(), /Audio/);
});

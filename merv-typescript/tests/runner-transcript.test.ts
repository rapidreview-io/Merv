/**
 * Session transcripts on the runner: what `readTranscript` keeps of a launch's stdout, and how
 * a launch declares it before its release and delivers it last, against the stand-in Sessions
 * server with the transcript route answered as Sessions does and a loopback store.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  MAX_TRANSCRIPT_BYTES,
  type WorkspaceDriverFactory,
  type WorkspaceHandle,
} from '@merv/contracts';
import { readTranscript } from '../packages/runner/src/transcript.js';
import {
  ended,
  launchId,
  machine,
  metadata,
  node,
  offer,
  projectId,
  Refusal,
  server,
  until,
  type Body,
} from './fixtures/runner-stand-in.js';

const directory = (t: TestContext) => {
  const path = mkdtempSync(join(tmpdir(), 'merv-transcript-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
};
const log = (path: string, text: string | Buffer) => writeFileSync(join(path, 'stdout.log'), text);
const read = (path: string, secrets: string[] = [], cap?: number, chunk?: number) =>
  readTranscript(path, secrets, cap, chunk);
const text = (path: string, ...rest: [string[]?, number?, number?]) =>
  Buffer.from(read(path, ...rest)!.bytes).toString('utf8');

const b64 = (c: string) => c.repeat(43);
const hex = 'a1'.repeat(32);
const tokens = [
  `ms_${b64('A')}`,
  `mi_${b64('b')}`,
  `mk_${b64('-')}`,
  `me_${hex}`,
  `mr_${hex}`,
  `pir_${'Q'.repeat(24)}`,
  `rr_sk_${'Z'.repeat(32)}`,
  `sk-proj-${'k'.repeat(40)}`,
  `sk-ant-api03-${'w'.repeat(40)}`,
  `ghp_${'G'.repeat(36)}`,
  'AKIA' + 'ABCDEFGHIJKLMNOP',
];

test('bearers standing alone are blanked, whatever the chunk, and identifiers are kept', (t) => {
  const path = directory(t);
  const kept = [
    'mcp__merv__fleet_workflow_retry_status',
    `max_${'x'.repeat(41)}`,
    'list_items_by_the_owner_of_the_project_and_its_members(',
    `foo_ms_${b64('C')}`,
    `ms_${b64('C')}x`,
    'risk-assessment-for-the-project-and-its-members',
    'task-list-by-the-owner-of-the-project',
  ];
  const lines = tokens.flatMap((token) => [
    `{"text":"${token}"}`,
    `KEY=${token}`,
    `Authorization: Bearer ${token}`,
    `{"text":"line\\n${token}"}`,
    `{"text":"\\u0022${token}\\u0022"}`,
  ]);
  log(path, [...lines, ...kept].join('\n') + '\n');
  const whole = text(path);
  for (const token of tokens) assert.ok(!whole.includes(token), token);
  assert.equal(whole.split('[REDACTED]').length - 1, lines.length);
  for (const identifier of kept) assert.ok(whole.includes(identifier), identifier);
  // A token cut by a chunk boundary, or starting right after one, is blanked the same way.
  for (const chunk of [1, 7, 45, 64]) assert.equal(text(path, [], undefined, chunk), whole);
});

test('the exact source bearer is blanked even unprefixed and inside a word', (t) => {
  const path = directory(t);
  const legacy = 'Z9'.repeat(21) + 'q';
  log(path, `token=${legacy}\nprefix${legacy}suffix\nshort secrets stay: abc\n`);
  assert.equal(
    text(path, [legacy, 'abc']),
    'token=[REDACTED]\nprefix[REDACTED]suffix\nshort secrets stay: abc\n',
  );
  assert.equal(text(path, [legacy, 'abc'], undefined, 5), text(path, [legacy, 'abc']));
});

test('multibyte UTF-8 passes byte for byte across chunks', (t) => {
  const path = directory(t);
  const bytes = Buffer.from('é漢字🙂 — ünïcødé\n'.repeat(50));
  log(path, bytes);
  for (const chunk of [1, 3, 1000]) {
    const file = read(path, [], undefined, chunk)!;
    assert.deepEqual(Buffer.from(file.bytes), bytes);
    assert.equal(file.facts.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(file.facts.truncated, false);
    assert.equal(file.facts.logBytes, bytes.length);
  }
});

test('a log over the cap keeps its head and tail at line ends around one marker', (t) => {
  const path = directory(t);
  const cap = 4096;
  const lines = Array.from({ length: 400 }, (_, i) => `{"n":${i},"pad":"${'p'.repeat(20)}"}`);
  const whole = lines.join('\n') + '\n';
  log(path, whole);
  const file = read(path, [], cap)!;
  assert.equal(file.facts.truncated, true);
  assert.equal(file.facts.logBytes, whole.length);
  assert.ok(file.facts.size <= cap);
  const kept = Buffer.from(file.bytes).toString('utf8').split('\n');
  const at = kept.findIndex((line) => line.includes('merv.transcript.truncated'));
  const { type, omittedBytes } = JSON.parse(kept[at]!);
  assert.equal(type, 'merv.transcript.truncated');
  const head = kept.slice(0, at),
    tail = kept.slice(at + 1, -1);
  assert.deepEqual(head, lines.slice(0, head.length), 'whole lines from the start');
  assert.deepEqual(tail, lines.slice(-tail.length), 'whole lines to the end');
  assert.equal(
    omittedBytes,
    whole.length - (head.join('\n').length + 1) - (tail.join('\n').length + 1),
  );
  assert.ok(head.length > 0 && tail.length > head.length);
  assert.deepEqual(read(path, [], cap), file, 'the same bytes and hash every time');
});

test('a log near the cap is read in about a second, within the cap', (t) => {
  const path = directory(t);
  const line = `{"type":"item.completed","item":{"text":"${'mcp__merv__tool max_value '.repeat(40)}"}}\n`;
  log(path, line.repeat(Math.ceil((MAX_TRANSCRIPT_BYTES + (4 << 20)) / line.length)));
  const started = Date.now();
  const file = read(path, [`mk_${b64('l')}`])!;
  assert.ok(Date.now() - started < 10_000, `${Date.now() - started} ms`);
  assert.equal(file.facts.truncated, true);
  assert.ok(
    file.facts.size <= MAX_TRANSCRIPT_BYTES && file.facts.size > MAX_TRANSCRIPT_BYTES - (4 << 20),
  );
});

test('nothing printed, a link and a FIFO', (t) => {
  const path = directory(t);
  assert.equal(read(path), undefined, 'no log');
  log(path, '');
  assert.equal(read(path), undefined, 'an empty log');
  rmSync(join(path, 'stdout.log'));
  writeFileSync(join(path, 'elsewhere'), 'secret\n');
  symlinkSync(join(path, 'elsewhere'), join(path, 'stdout.log'));
  assert.throws(() => read(path), { code: 'ELOOP' });
  rmSync(join(path, 'stdout.log'));
  execFileSync('mkfifo', [join(path, 'stdout.log')]);
  assert.equal(read(path), undefined, 'a FIFO is not waited on');
});

// The runner's half, against the stand-in with Sessions' transcript route and a loopback store.

const store = 'http://127.0.0.1:10';
/** What the store answers a PUT: a status, or never. */
type StoreAnswer = 200 | 412 | 503 | 'never';
function transcripts(
  fake: ReturnType<typeof server>,
  options: { url?: (key: string) => string } = {},
) {
  /** Every session route by action ('declare' and 'deliver' for the transcript), and 'PUT'. */
  const events: string[] = [];
  const rows = new Map<string, Body>();
  const objects = new Map<string, Buffer>();
  const puts: { headers: Headers; body: Buffer }[] = [];
  const bodies: Body[] = [];
  const state = {
    store: 200 as StoreAnswer,
    refuse: undefined as Refusal | undefined,
    aborted: 0,
  };
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (url.origin === store) {
      events.push('PUT');
      puts.push({
        headers: new Headers(init!.headers),
        body: Buffer.from(init!.body as Uint8Array),
      });
      if (state.store === 'never')
        return await new Promise((_, reject) =>
          init!.signal!.addEventListener('abort', () => {
            state.aborted++;
            reject(init!.signal!.reason);
          }),
        );
      // 412: the same bytes were stored by another session first.
      if (state.store !== 503) objects.set(url.pathname.slice(1), puts.at(-1)!.body);
      return new Response(null, { status: state.store });
    }
    const [, , id, action] = url.pathname.split('/');
    if (action !== 'transcript') {
      if (id?.startsWith('session_')) events.push(action ?? 'get');
      return await fake.fetch(input as string, init);
    }
    const body = JSON.parse(String(init!.body)) as Body;
    bodies.push(body);
    events.push(body.deliver ? 'deliver' : 'declare');
    if (state.refuse)
      return Response.json(
        { error: { code: state.refuse.code, message: 'No' } },
        { status: state.refuse.status },
      );
    const sessionId = decodeURIComponent(id!);
    const row = rows.get(sessionId) ?? {
      sessionId,
      sha256: body.sha256,
      size: body.size,
      uploadedAt: null,
    };
    rows.set(sessionId, row);
    if (row.sha256 !== body.sha256)
      return Response.json(
        { error: { code: 'transcript_conflict', message: 'No' } },
        { status: 409 },
      );
    if (!body.deliver || row.uploadedAt) return Response.json({ transcript: row });
    const key = `transcripts-${projectId}/${row.sha256}`;
    if (objects.get(key)?.length === row.size) {
      row.uploadedAt = new Date().toISOString();
      return Response.json({ transcript: row });
    }
    const upload = {
      url: options.url?.(key) ?? `${store}/${key}`,
      headers: {
        'x-amz-checksum-sha256': Buffer.from(row.sha256, 'hex').toString('base64'),
        'if-none-match': '*',
      },
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
    return Response.json({ transcript: { ...row, upload } });
  };
  const of = (event: string) => events.filter((e) => e === event).length;
  return { fetch, events, rows, objects, puts, bodies, state, of };
}
/** An ended launch an earlier controller left owing its release, with what it printed. */
function seed(
  f: ReturnType<typeof machine>,
  fake: ReturnType<typeof server>,
  name: string,
  printed?: string,
) {
  const ledger = f.ledger();
  const session: Body = { ...offer(name), runnerId: ledger.runnerId };
  const record = ledger.reserve({
    id: launchId(session.id),
    sessionId: session.id,
    deadline: Date.now() + 3_600_000,
    metadata: { platform: 'a', requestId: `request_${name}` },
  });
  ledger.close();
  ended(f.config.directory, record.id, { status: 'exited', reason: null, exitCode: 0 });
  if (printed !== undefined) log(record.runDirectory, printed);
  session.hostRef = record.id;
  fake.sessions.set(session.id, session);
  return { session, id: record.id, runDirectory: record.runDirectory };
}
const transcript = (f: ReturnType<typeof machine>, id: string) =>
  metadata(f.config.directory, id).transcript;
const open = (f: ReturnType<typeof machine>) => {
  const ledger = f.ledger();
  try {
    return ledger.open().map((record) => record.id);
  } finally {
    ledger.close();
  }
};
/** A driver whose checkouts are the machine's own directory, as the settle tests use. */
function driver(root: string) {
  const handles = new Map<string, WorkspaceHandle>();
  const factory: WorkspaceDriverFactory = {
    name: 'code.v2',
    create: () => ({
      get: (id) => handles.get(id),
      prepare: async (launch) => {
        handles.set(launch.id, {
          path: root,
          snapshot: attachment,
          retain: false,
          readOnly: false,
          status: 'ready',
        });
        return handles.get(launch.id)!;
      },
      capture: async (launch) => {
        handles.get(launch.id)!.status = 'captured';
        return attachment;
      },
      close: async (launch) => {
        handles.get(launch.id)!.status = 'closed';
      },
      dispose: () => {},
    }),
  };
  return factory;
}
const attachment = {
  repositoryId: 'repository_fixture',
  workspaceId: 'workspace_fixture',
  mode: 'ephemeral' as const,
  branch: null,
  baseOid: '1'.repeat(40),
  headOid: '1'.repeat(40),
  stats: { commitCount: 0, filesChanged: 0, insertions: 0, deletions: 0 },
};

test('a launch declares before its release and delivers after its workspace result', async (t) => {
  const work = offer('order', {
    workspace: { mode: 'ephemeral', namespace: 'n', retain: false, driver: 'code.v2' },
  });
  const queue = [work];
  const fake = server(() => queue.shift() ?? null);
  const sessions = transcripts(fake);
  const f = machine(
    t,
    [node('a', `process.stdout.write('{"turn":1}\\n' + process.env.MERV_AGENT_SESSION_TOKEN)`)],
    sessions.fetch,
  );
  const runner = f.make([driver(f.root)]);
  await runner.start();
  await until(runner, () => sessions.of('PUT') === 1, 'the PUT');
  const id = launchId(work.id);
  assert.equal(runner.snapshot().launches[0]?.transcriptPending, true);
  await until(runner, () => !runner.snapshot().launches[0]?.transcriptPending, 'the stamp');
  assert.deepEqual(
    sessions.events.filter((e) => !['get', 'attach', 'heartbeat'].includes(e)),
    ['declare', 'release', 'workspace-result', 'deliver', 'PUT', 'deliver'],
  );
  const [put] = sessions.puts;
  assert.equal(put!.headers.get('authorization'), null, 'no Merv bearer goes to the store');
  assert.equal(put!.headers.get('if-none-match'), '*');
  assert.equal(
    put!.headers.get('x-amz-checksum-sha256'),
    createHash('sha256').update(put!.body).digest('base64'),
  );
  assert.equal(put!.headers.get('x-merv-project-id'), null);
  assert.equal(put!.body.toString(), '{"turn":1}\n[REDACTED]');
  const row = sessions.rows.get(work.id)!;
  assert.equal(row.sha256, createHash('sha256').update(put!.body).digest('hex'));
  assert.equal(row.size, put!.body.length);
  assert.ok(row.uploadedAt);
  assert.deepEqual(transcript(f, id), { state: 'uploaded' });
  assert.deepEqual(open(f), []);
});

test('each release try declares once, from one read; a log changed since is not sent', async (t) => {
  let refused = 3;
  const fake = server(
    () => null,
    undefined,
    (path) =>
      path.endsWith('/release') && refused-- > 0 ? new Refusal(503, 'state_busy') : undefined,
  );
  const sessions = transcripts(fake);
  const f = machine(t, [node('a')], sessions.fetch);
  const { session, id, runDirectory } = seed(f, fake, 'retried', 'first\n');
  const runner = f.make();
  await runner.start();
  log(runDirectory, 'rewritten\n');
  for (let i = 0; i < 4; i++) await runner.tick();
  assert.equal(sessions.of('declare'), 4);
  assert.equal(sessions.of('release'), 4);
  assert.deepEqual(
    sessions.events.filter((e) => e === 'declare' || e === 'release'),
    ['declare', 'release', 'declare', 'release', 'declare', 'release', 'declare', 'release'],
  );
  const declared = sessions.bodies.filter((body) => !body.deliver);
  assert.ok(
    declared.every((body) => body.sha256 === declared[0]!.sha256),
    'never read again',
  );
  assert.equal(sessions.rows.get(session.id)!.sha256, declared[0]!.sha256);
  assert.equal(sessions.of('deliver'), 1);
  assert.equal(sessions.of('PUT'), 0);
  assert.deepEqual(transcript(f, id), { state: 'refused', code: 'transcript_changed' });
  assert.deepEqual(open(f), []);
});

test('an unreadable log is refused locally and the release goes out in the same tick', async (t) => {
  const fake = server(() => null);
  const sessions = transcripts(fake);
  const f = machine(t, [node('a')], sessions.fetch);
  const { session, id, runDirectory } = seed(f, fake, 'linked');
  writeFileSync(join(runDirectory, 'elsewhere'), 'x\n');
  symlinkSync(join(runDirectory, 'elsewhere'), join(runDirectory, 'stdout.log'));
  await f.make().start();
  assert.equal(sessions.of('declare') + sessions.of('deliver'), 0);
  assert.equal(fake.releases(session.id).length, 1);
  assert.deepEqual(transcript(f, id), { state: 'refused', code: 'transcript_unreadable' });
  assert.deepEqual(open(f), []);
});

test('a launch that printed nothing makes no transcript call', async (t) => {
  const fake = server(() => null);
  const sessions = transcripts(fake);
  const f = machine(t, [node('a')], sessions.fetch);
  const { id } = seed(f, fake, 'silent');
  await f.make().start();
  assert.equal(sessions.of('declare') + sessions.of('deliver'), 0);
  assert.deepEqual(transcript(f, id), { state: 'none' });
  assert.deepEqual(open(f), []);
});

test('a server without the route, or a conflict, is answered once and the launch settles', async (t) => {
  // The stand-in alone answers 404 `not_found`, as a server from before transcripts does.
  const old = server(() => null);
  const f = machine(t, [node('a')], old.fetch);
  const { session, id } = seed(f, old, 'old', 'printed\n');
  const runner = f.make();
  await runner.start();
  assert.equal(runner.snapshot().lastError, undefined, 'a final refusal is no error');
  await runner.tick();
  assert.equal(old.calls.filter((call) => call.path.endsWith('/transcript')).length, 1);
  assert.equal(old.releases(session.id).length, 1);
  assert.deepEqual(transcript(f, id), { state: 'refused', code: 'not_found' });
  assert.deepEqual(open(f), []);

  const fake = server(() => null);
  const sessions = transcripts(fake);
  sessions.state.refuse = new Refusal(409, 'transcript_conflict');
  const g = machine(t, [node('a')], sessions.fetch);
  const conflict = seed(g, fake, 'conflict', 'printed\n');
  await g.make().start();
  assert.equal(sessions.of('declare') + sessions.of('deliver'), 1);
  assert.deepEqual(transcript(g, conflict.id), { state: 'refused', code: 'transcript_conflict' });
  assert.deepEqual(open(g), []);
});

test('bytes another session stored first (412) are stamped by the next delivery', async (t) => {
  const fake = server(() => null);
  const sessions = transcripts(fake);
  sessions.state.store = 412;
  const f = machine(t, [node('a')], sessions.fetch);
  const { id } = seed(f, fake, 'same', 'the same bytes\n');
  const runner = f.make();
  await runner.start();
  await until(runner, () => transcript(f, id)?.state === 'uploaded', 'the stamp');
  assert.equal(sessions.of('PUT'), 1);
  assert.equal(sessions.of('deliver'), 2);
});

test('a PUT to anything but https or loopback is never sent and counts as a try', async (t) => {
  let now = Date.now();
  const fake = server(() => null);
  const sessions = transcripts(fake, { url: (key) => `http://store.example/${key}` });
  const f = machine(t, [node('a')], sessions.fetch, { clock: () => now });
  const { id } = seed(f, fake, 'plain', 'printed\n');
  const runner = f.make();
  await runner.start();
  assert.equal(runner.snapshot().lastError, 'invalid_control_response');
  assert.equal(transcript(f, id).tries, 1);
  await runner.tick();
  assert.equal(sessions.of('deliver'), 1, 'not again within the minute');
  now += 60_001;
  await runner.tick();
  assert.equal(sessions.of('deliver'), 2);
  assert.equal(sessions.of('PUT'), 0);
  assert.equal(transcript(f, id).tries, 2);
});

test('a failing store is sent ten PUTs, a minute apart, across a restart', async (t) => {
  let now = Date.now();
  const fake = server(() => null);
  const sessions = transcripts(fake);
  sessions.state.store = 503;
  const f = machine(t, [node('a')], sessions.fetch, { clock: () => now });
  const { id } = seed(f, fake, 'outage', 'printed\n');
  let runner = f.make();
  await runner.start();
  // The failed PUT settles off the tick; a tick is not needed, and would clear `lastError`.
  const failed = async (puts: number) => {
    assert.equal(sessions.of('PUT'), puts);
    await delay(20);
    assert.equal(runner.snapshot().lastError, 'transcript_upload_failed');
  };
  await failed(1);
  now += 30_000;
  await runner.tick();
  assert.equal(sessions.of('deliver'), 1, 'no call within the minute');
  for (let i = 2; i <= 4; i++) {
    now += 60_001;
    await runner.tick();
    await failed(i);
  }
  await runner.stop();
  runner = f.make();
  await runner.start(); // a restart tries at once, and counts on
  await failed(5);
  assert.equal(transcript(f, id).tries, 5);
  for (let i = 6; i <= 10; i++) {
    now += 60_001;
    await runner.tick();
    await failed(i);
  }
  assert.equal(runner.snapshot().launches[0]?.transcriptPending, true);
  now += 60_001;
  await runner.tick();
  assert.equal(sessions.of('deliver'), 11, 'the last delivery only confirms');
  assert.equal(sessions.of('PUT'), 10);
  assert.deepEqual(transcript(f, id), { state: 'refused', code: 'transcript_abandoned' });
  assert.equal(runner.snapshot().launches[0]?.transcriptPending, false);
  assert.deepEqual(open(f), []);
});

test('the tenth PUT, stored, is confirmed by one more delivery', async (t) => {
  let now = Date.now();
  const fake = server(() => null);
  const sessions = transcripts(fake);
  sessions.state.store = 503;
  const f = machine(t, [node('a')], sessions.fetch, { clock: () => now });
  const { id } = seed(f, fake, 'late', 'printed\n');
  const runner = f.make();
  await runner.start();
  for (let i = 2; i <= 10; i++) {
    await delay(20);
    if (i === 10) sessions.state.store = 200;
    now += 60_001;
    await runner.tick();
  }
  assert.equal(sessions.of('PUT'), 10);
  await delay(20);
  await runner.tick();
  assert.equal(sessions.of('deliver'), 11);
  assert.deepEqual(transcript(f, id), { state: 'uploaded' });
});

test('a PUT that never answers holds no tick, one PUT runs at a time, and stop aborts it', async (t) => {
  let now = Date.now();
  const fake = server(() => null);
  const sessions = transcripts(fake);
  sessions.state.store = 'never';
  const f = machine(t, [node('a', 'process.exit(0)', 2)], sessions.fetch, { clock: () => now });
  const first = seed(f, fake, 'first', 'one\n');
  const second = seed(f, fake, 'second', 'two\n');
  const runner = f.make();
  await runner.start();
  assert.equal(sessions.of('PUT'), 1);
  const heartbeats = () =>
    fake.calls.filter((call) => call.path === '/sessions/runners/heartbeat').length;
  const [presence, leases] = [heartbeats(), fake.leases('a').length];
  now += 16_000;
  await runner.tick();
  assert.equal(heartbeats(), presence + 1, 'presence still goes out');
  assert.equal(fake.leases('a').length, leases + 1, 'leasing goes on');
  assert.equal(sessions.of('PUT'), 1, 'the second launch waits for the first PUT');
  assert.equal(sessions.of('deliver'), 1);
  assert.deepEqual(
    runner.snapshot().launches.map((launch) => launch.transcriptPending),
    [true, true],
  );
  await runner.stop();
  assert.equal(sessions.state.aborted, 1, 'the stop aborts the PUT in flight');
  await delay(10);
  assert.equal(sessions.of('PUT'), 1, 'a stop starts no PUT');
  assert.deepEqual(open(f).sort(), [first.id, second.id].sort());

  sessions.state.store = 200;
  const next = f.make();
  await next.start();
  await until(
    next,
    () => [first.id, second.id].every((id) => transcript(f, id)?.state === 'uploaded'),
    'both delivered by the next start',
  );
  assert.equal(sessions.of('PUT'), 3);
  assert.deepEqual(open(f), []);
});

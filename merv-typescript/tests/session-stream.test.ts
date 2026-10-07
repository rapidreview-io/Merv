/**
 * A worker agent's live stream over HTTP, on the default composition: the runner that holds a
 * session sends batches of its agent's events, numbered here in arrival order, a retried batch
 * once; an operator's page reads them as server-sent events, a snapshot first, then what
 * follows, and from `after` on a reconnect; the unit's sidebar lists the sessions to read.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, get } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Caller, WorkflowPolicy } from '@merv/contracts';
import type { AgentEvent } from '@merv/sessions/agent-stream';
import { serveEvents } from '@merv/api/event-stream';
import type { ApplicationConfig } from '../src/config.js';
import { AgentStream } from '../packages/runner/src/agent-stream.js';
import { createApp } from './fixtures/app.js';

const secret = () => `ms_${randomBytes(32).toString('base64url')}`;
const profile = { name: 'codex', harness: 'codex' as const, enabled: true, parallelism: 4 };
const machine = { hostname: 'stream-host', system: 'Linux', architecture: 'x64' };

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'merv-stream-'));
  const env = `MERV_STREAM_TEST_${randomUUID().replaceAll('-', '')}`;
  process.env[env] = randomBytes(48).toString('hex');
  const config = JSON.parse(
    readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
  ) as ApplicationConfig;
  const keep = ['state', 'domain-events', 'scope', 'workflows', 'identity', 'api', 'tools'];
  config.plugins = config.plugins.flatMap((plugin) =>
    plugin.id === 'sessions'
      ? [{ ...plugin, config: { managedSecretEnv: env, sweepIntervalMs: 60_000 } }]
      : keep.includes(plugin.id) || plugin.id === 'sessions-api'
        ? [plugin]
        : [],
  );
  const app = await createApp({ directory, config, port: 0 });
  const readers: AbortController[] = [];
  t.after(async () => {
    for (const reader of readers) reader.abort();
    await app.stop();
    await rm(directory, { recursive: true, force: true });
    delete process.env[env];
  });
  const scope = app.ctx.scope;
  const policy: WorkflowPolicy = {
    successStates: ['done'],
    actions: [
      {
        name: 'finish',
        states: ['working'],
        transitions: ['finish'],
        tool: 'finish',
        instruction: 'Finish.',
        check: async ({ caller, tx }) => {
          await scope.require(caller, 'write', tx);
        },
      },
    ],
    assignments: [
      {
        state: 'working',
        check: async ({ caller, tx }) => {
          await scope.require(caller, 'write', tx);
        },
        build: () => ({
          role: 'producer',
          label: 'Stream work',
          brief: 'Do the work',
          references: [],
          handoff: { instruction: 'Finish', tools: ['finish'] },
          execution: { readOnly: false, tools: [] },
          context: null,
        }),
        execution: { readOnly: false, tools: [] },
        lease: {
          role: () => 'producer',
          acquire: ({ leaseId }) => ({ leaseId }),
          check: () => {},
          release: () => {},
        },
      },
    ],
  };
  const handle = await app.ctx.workflows.register(
    {
      name: 'stream-test',
      version: 1,
      initial: 'working',
      states: ['working', 'done'],
      terminal: ['done'],
      edges: [{ from: 'working', action: 'finish', to: 'done' }],
    },
    policy,
  );
  const url = app.ctx.api.url;
  const http = async (method: string, path: string, token: string, body?: unknown) => {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: JSON.parse(text) };
  };
  const ok = async (method: string, path: string, token: string, body?: unknown) => {
    const result = await http(method, path, token, body);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  };
  const boot = await scope.credentials.bootstrap({ projectName: 'Streams', actorName: 'Owner' });
  const owner: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const token = boot.token;
  /** A dispatched session of `runnerId`, attached as `hostRef`, with its worker secret. */
  const leased = async (runnerId = 'runner', hostRef = `launch-${randomUUID()}`) => {
    await ok('POST', '/sessions/runners/heartbeat', token, {
      runnerId,
      machine,
      platforms: [profile],
      capacity: 4,
    });
    await app.ctx.sessions.dispatch.setDispatch(owner, { enabled: true });
    const instance = await handle.start(owner, {
      workflow: 'stream-test',
      requestId: randomUUID(),
    });
    const input = {
      runnerId,
      requestId: randomUUID(),
      secret: secret(),
      platform: { name: profile.name, harness: profile.harness },
    };
    const lease = await ok('POST', '/sessions/lease', token, input);
    assert.ok(lease.session, JSON.stringify(lease));
    await ok('POST', `/sessions/${lease.session.id}/attach`, token, { runnerId, hostRef });
    return {
      session: lease.session,
      instance,
      secret: input.secret,
      control: { runnerId, hostRef },
    };
  };
  /** An SSE reader: each frame as { event, data }, read until `count` have arrived. */
  const events = (path: string, bearer: string) => {
    const abort = new AbortController();
    readers.push(abort);
    const frames: { event: string; data: any }[] = [];
    let buffer = '';
    const response = fetch(`${url}${path}`, {
      headers: { authorization: `Bearer ${bearer}` },
      signal: abort.signal,
    });
    const reading = (async () => {
      const reply = await response;
      if (!reply.ok) return reply.status;
      const decoder = new TextDecoder();
      try {
        for await (const chunk of reply.body!) {
          buffer += decoder.decode(chunk, { stream: true });
          for (let end; (end = buffer.indexOf('\n\n')) >= 0; buffer = buffer.slice(end + 2)) {
            const frame = buffer.slice(0, end);
            frames.push({
              event: /^event: (.*)$/m.exec(frame)![1]!,
              data: JSON.parse(/^data: (.*)$/m.exec(frame)![1]!),
            });
          }
        }
      } catch {
        // Aborted by the test.
      }
      return 200;
    })();
    return {
      frames,
      status: async () => (await response).status,
      async until(count: number) {
        for (let tries = 0; frames.length < count && tries < 200; tries++)
          await new Promise((resolve) => setTimeout(resolve, 25));
        assert.ok(frames.length >= count, JSON.stringify(frames));
        return frames;
      },
      close: () => abort.abort(),
      reading,
    };
  };
  return { app, http, ok, owner, token, leased, events };
}

const thinking = (id: string, delta: string): AgentEvent => ({ kind: 'thinking', id, delta });
const call: AgentEvent = { kind: 'tool_call', id: 't1', name: 'sandbox.run', input: '{}' };

test('the runner that holds a session sends its agent’s events; a retry is taken once, in order', async (t) => {
  const f = await fixture(t);
  const { session, control } = await f.leased();
  const path = `/sessions/${session.id}/stream`;
  const first = { ...control, from: 0, to: 100, events: [thinking('a', 'Look'), call] };
  assert.deepEqual(await f.ok('POST', path, f.token, first), { stream: { until: 100, seq: 2 } });
  // The same batch again, as after a lost answer: answered, not added.
  assert.deepEqual(await f.ok('POST', path, f.token, first), { stream: { until: 100, seq: 2 } });
  // A batch overlapping what is held (a restarted runner reading from the start) is not added.
  assert.deepEqual(
    await f.ok('POST', path, f.token, { ...control, from: 0, to: 180, events: [call] }),
    { stream: { until: 100, seq: 2 } },
  );
  // The same new batch twice at once, as a retry racing its first try: added once.
  const next = { ...control, from: 100, to: 150, events: [{ ...call, id: 't2' }] };
  assert.deepEqual(
    await Promise.all([f.ok('POST', path, f.token, next), f.ok('POST', path, f.token, next)]),
    [{ stream: { until: 150, seq: 3 } }, { stream: { until: 150, seq: 3 } }],
  );
  const rows = await f.app.ctx.state.read((sql) =>
    sql.all<{ seq: string; until: string; event: AgentEvent }>(
      'SELECT seq,until,event FROM session_events WHERE session_id=? ORDER BY seq',
      session.id,
    ),
  );
  assert.deepEqual(
    rows.map((row) => [Number(row.seq), Number(row.until), row.event.id]),
    [
      [1, 100, 'a'],
      [2, 100, 't1'],
      [3, 150, 't2'],
    ],
  );

  // Another runner of the same source, the worker's own bearer, another host and a malformed
  // batch are each refused.
  const refused = async (bearer: string, body: unknown) => {
    const reply = await f.http('POST', path, bearer, body);
    return [reply.status, reply.body.error.code];
  };
  assert.deepEqual(await refused(f.token, { ...next, runnerId: 'other' }), [
    403,
    'session_forbidden',
  ]);
  assert.deepEqual(await refused(f.token, { ...next, hostRef: 'elsewhere' }), [
    409,
    'host_conflict',
  ]);
  assert.deepEqual((await refused((await f.leased()).secret, next))[0], 403);
  assert.deepEqual(await refused(f.token, { ...next, events: [{ kind: 'thinking' }] }), [
    400,
    'invalid_stream',
  ]);
  assert.deepEqual(
    await refused(f.token, {
      ...next,
      from: 150,
      to: 151,
      events: [{ kind: 'text', id: 'x', delta: 'y'.repeat(16_001) }],
    }),
    [400, 'invalid_stream'],
  );
});

test('an operator’s page reads a snapshot, then live events, and from `after` on a reconnect; a reader is refused', async (t) => {
  const f = await fixture(t);
  const { session, control } = await f.leased();
  const path = `/sessions/${session.id}/stream`;
  await f.ok('POST', path, f.token, {
    ...control,
    from: 0,
    to: 10,
    events: [thinking('a', 'One')],
  });

  const page = f.events(`/sessions/${session.id}/events`, f.token);
  const [snapshot] = await page.until(1);
  assert.equal(snapshot!.event, 'snapshot');
  assert.deepEqual(
    snapshot!.data.events.map((event: { seq: number; event: AgentEvent }) => [
      event.seq,
      event.event,
    ]),
    [[1, thinking('a', 'One')]],
  );
  assert.equal(typeof snapshot!.data.events[0].at, 'string');
  // A batch taken now reaches the open page at once.
  await f.ok('POST', path, f.token, { ...control, from: 10, to: 20, events: [call] });
  const [, live] = await page.until(2);
  assert.equal(live!.event, 'events');
  assert.deepEqual(
    live!.data.events.map((event: { seq: number }) => event.seq),
    [2],
  );
  page.close();

  // A reconnect from seq 1 is sent only what followed it.
  const again = f.events(`/sessions/${session.id}/events?after=1`, f.token);
  const [resumed] = await again.until(1);
  assert.equal(resumed!.event, 'events');
  assert.deepEqual(
    resumed!.data.events.map((event: { seq: number; event: AgentEvent }) => [
      event.seq,
      event.event,
    ]),
    [[2, call]],
  );
  again.close();

  // Only an operator reads it; a worker's own bearer may only use /mcp; a stray query is refused.
  const reader = await f.app.ctx.scope.credentials.issueActor(f.owner, {
    name: 'Reader',
    role: 'reader',
  });
  assert.equal(await f.events(`/sessions/${session.id}/events`, reader.token).status(), 403);
  assert.equal(
    await f
      .events(`/sessions/${(await f.leased()).session.id}/events`, (await f.leased()).secret)
      .status(),
    403,
  );
  assert.equal(await f.events(`/sessions/${session.id}/events?after=x`, f.token).status(), 400);
  assert.equal(await f.events('/sessions/session_missing/events', f.token).status(), 404);
});

test('a page’s first snapshot is the newest events within 2 MB', async (t) => {
  const f = await fixture(t);
  const { session } = await f.leased();
  // Each event is 15,040 characters as stored, 15,104 counted: 132 fit in 2,000,000.
  const event = JSON.stringify({ kind: 'text', id: 'x', delta: 'y'.repeat(15_000) });
  await f.app.ctx.state.transaction((tx) =>
    tx.run(
      `INSERT INTO session_events(session_id,seq,at,until,event)
        SELECT ?,n,'2026-01-01T00:00:00Z',n,CAST(? AS JSONB) FROM generate_series(1,200) n`,
      session.id,
      event,
    ),
  );
  const shown = await f.app.ctx.sessions.streams.snapshot(session.id);
  assert.deepEqual(
    shown.map((item) => item.seq),
    Array.from({ length: 132 }, (_, i) => 69 + i),
  );
});

test('a closed session still takes its agent’s last words within its grace', async (t) => {
  const f = await fixture(t);
  const { session, control } = await f.leased();
  await f.ok('POST', `/sessions/${session.id}/stream`, f.token, {
    ...control,
    from: 0,
    to: 5,
    events: [thinking('a', 'Bye')],
  });
  await f.ok('POST', `/sessions/${session.id}/halt`, f.token, { reason: 'halted_by_operator' });
  // Within its grace the closed session still takes the agent's last words.
  await f.ok('POST', `/sessions/${session.id}/stream`, f.token, {
    ...control,
    from: 5,
    to: 9,
    events: [{ kind: 'status', id: 's', text: 'Finished' }],
  });
  const rows = await f.app.ctx.state.read((sql) =>
    sql.all('SELECT seq FROM session_events WHERE session_id=?', session.id),
  );
  assert.equal(rows.length, 2);
});

test('a lease’s line says what its agent does', async (t) => {
  const f = await fixture(t);
  const { session, control, secret: worker } = await f.leased();
  await f.app.ctx.sessions.authenticate(worker); // the worker takes it up
  const reader = await f.app.ctx.scope.credentials.issueActor(f.owner, {
    name: 'Reader',
    role: 'reader',
  });
  const readerCaller: Caller = {
    actorId: reader.actor.id,
    projectId: f.owner.projectId,
    credentialId: reader.credential.id,
  };
  // The lease's node says what its agent does now, from the newest event.
  const line = async () =>
    (await f.app.ctx.sessions.running.nodes(f.owner)).nodes.find(
      (node) => node.key === `session:${session.id}`,
    )!.lines[0];
  await f.ok('POST', `/sessions/${session.id}/stream`, f.token, {
    ...control,
    from: 0,
    to: 10,
    events: [thinking('a', 'Hmm')],
  });
  assert.equal((await line())![0], 'Thinking · ');
  await f.ok('POST', `/sessions/${session.id}/stream`, f.token, {
    ...control,
    from: 10,
    to: 20,
    events: [call],
  });
  assert.deepEqual((await line())!.slice(0, 2), ['Calling ', { mono: 'sandbox.run' }]);
  // What the agent said of itself is an operator's to read, as its stream is.
  await f.ok('POST', `/sessions/${session.id}/stream`, f.token, {
    ...control,
    from: 20,
    to: 30,
    events: [{ kind: 'status', id: 'st', text: 'Turn failed · /home/agent/notes.txt' }],
  });
  assert.equal((await line())![0], 'Turn failed · /home/agent/notes.txt');
  const readerLine = (await f.app.ctx.sessions.running.nodes(readerCaller)).nodes.find(
    (node) => node.key === `session:${session.id}`,
  )!.lines[0];
  assert.ok(!JSON.stringify(readerLine).includes('Turn failed'), JSON.stringify(readerLine));
});

test('a page gone while its authority was read gives its reader slot back at once', async (t) => {
  let taken = 0,
    given = 0;
  let served!: Promise<void>;
  let arrive!: () => void;
  const arrived = new Promise<void>((resolve) => (arrive = resolve));
  const server = createServer((req, res) => {
    served = (async () => {
      arrive();
      // The page leaves before the stream opens, as one closed during `authorize`.
      if (!res.destroyed) await new Promise((resolve) => res.once('close', resolve));
      await serveEvents(req, res, {
        rotateMs: 20_000,
        subscribe: () => {
          taken++;
          return () => given++;
        },
        step: async () => undefined,
      });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const request = get(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
  request.on('error', () => undefined);
  await arrived;
  request.destroy();
  const ended = await Promise.race([
    served.then(() => 'ended'),
    new Promise((resolve) => setTimeout(resolve, 2000, 'held')),
  ]);
  assert.equal(ended, 'ended');
  assert.equal(given, taken);
});

test('a runner restarted over 4 MiB behind what Sessions holds skips to the log’s end and is taken', async (t) => {
  const f = await fixture(t);
  const { session, control } = await f.leased();
  const path = `/sessions/${session.id}/stream`;
  const directory = await mkdtemp(join(tmpdir(), 'merv-stream-log-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const one = (n: number) =>
    `${JSON.stringify({ type: 'item.completed', item: { id: `i${n}`, type: 'agent_message', text: `m${n}${' '.repeat(200)}` } })}\n`;
  let log = '';
  for (let n = 0; log.length < 6 << 20; n++) log += one(n);
  writeFileSync(join(directory, 'stdout.log'), log);
  // The runner before the restart sent the log up to 1 MiB; then it lost its place.
  const held = log.indexOf('\n', 1 << 20) + 1;
  await f.ok('POST', path, f.token, { ...control, from: 0, to: held, events: [call] });
  let posts = 0;
  const restarted = new AgentStream(
    directory,
    'codex',
    [],
    async (batch) => {
      posts++;
      return (await f.ok('POST', path, f.token, { ...control, ...batch })).stream;
    },
    () => 0,
  );
  for (let tick = 0; tick < 6; tick++) await restarted.flush();
  appendFileSync(join(directory, 'stdout.log'), one(-1));
  await restarted.flush();
  const rows = await f.app.ctx.state.read((sql) =>
    sql.all<{ until: string; event: AgentEvent }>(
      'SELECT until,event FROM session_events WHERE session_id=? ORDER BY seq',
      session.id,
    ),
  );
  assert.deepEqual(
    rows.map((row) => [row.event.kind, row.event.id]),
    [
      ['tool_call', 't1'],
      ['status', `skip-${log.length}`],
      ['text', 'i-1'],
    ],
  );
  assert.equal(Number(rows.at(-1)!.until), log.length + one(-1).length);
  // Caught up, the stream sends nothing while the log is still.
  const sent = posts;
  await restarted.flush();
  assert.equal(posts, sent);
});

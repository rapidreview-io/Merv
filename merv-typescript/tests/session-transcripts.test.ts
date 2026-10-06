/**
 * Session transcripts over HTTP, on the default composition with Blobs over the S3 fixture: the
 * runner that held a session declares its transcript (no store I/O), then delivers it (one HEAD,
 * then a signed PUT or the stamp). Nothing reads a transcript back.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { MAX_TRANSCRIPT_BYTES, type Caller, type WorkflowPolicy } from '@merv/contracts';
import type { ApplicationConfig } from '../src/config.js';
import { createApp } from './fixtures/app.js';
import { s3Blobs } from './fixtures/s3-blobs.js';

const secret = () => `ms_${randomBytes(32).toString('base64url')}`;
const profile = {
  name: 'codex',
  harness: 'codex' as const,
  model: 'gpt-6-luna',
  enabled: true,
  parallelism: 1,
};
const machine = { hostname: 'transcript-host', system: 'Linux', architecture: 'x64' };
/** A transcript file as a runner would declare it. */
const file = (text: string) => {
  const bytes = Buffer.from(text);
  return {
    bytes,
    facts: {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
      logBytes: bytes.length,
      truncated: false,
    },
  };
};

/** The default composition over S3 blobs, disk blobs (which cannot sign) or none at all. */
async function fixture(t: TestContext, store: 's3' | 'disk' | 'none' = 's3') {
  const directory = await mkdtemp(join(tmpdir(), 'merv-transcripts-'));
  const env = `MERV_TRANSCRIPT_TEST_${randomUUID().replaceAll('-', '')}`;
  process.env[env] = randomBytes(48).toString('hex');
  const s3 = await s3Blobs(t);
  const config = JSON.parse(
    readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
  ) as ApplicationConfig;
  // Without Blobs, only Sessions, its routes and what they need load.
  const storeless = [
    'state',
    'domain-events',
    'scope',
    'workflows',
    'identity',
    'api',
    'tools',
    'sessions-api',
  ];
  config.plugins = config.plugins.flatMap((plugin) => {
    if (plugin.id === 'sessions')
      return [{ ...plugin, config: { managedSecretEnv: env, sweepIntervalMs: 60_000 } }];
    if (plugin.id === 'blobs')
      return store === 's3' ? [s3.entry] : store === 'disk' ? [plugin] : [];
    if (store === 'none' && !storeless.includes(plugin.id)) return [];
    return [plugin];
  });
  const app = await createApp({ directory, config, port: 0 });
  t.after(async () => {
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
          label: 'Transcript work',
          brief: 'Do the work',
          references: [],
          handoff: { instruction: 'Finish', tools: ['finish'] },
          execution: { readOnly: false, tools: [] },
          context: null,
        }),
        execution: {
          readOnly: false,
          tools: [
            {
              name: 'finish',
              alternatives: [
                {
                  instanceId: { kind: 'target', field: 'instanceId' },
                  expectedRevision: { kind: 'target', field: 'revision' },
                },
              ],
            },
          ],
        },
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
      name: 'transcript-test',
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
    return { status: response.status, text, body: JSON.parse(text) };
  };
  const ok = async (method: string, path: string, token: string, body?: unknown) => {
    const result = await http(method, path, token, body);
    assert.equal(result.status, 200, result.text);
    return result.body;
  };
  const rows = async (projectId?: string) =>
    await app.ctx.state.read((sql) =>
      projectId
        ? sql.all<Record<string, unknown>>(
            'SELECT * FROM session_transcripts WHERE project_id=? ORDER BY declared_at,session_id',
            projectId,
          )
        : sql.all<Record<string, unknown>>('SELECT * FROM session_transcripts'),
    );

  /** A project whose owner's credential is its source runner's. */
  async function project(name: string) {
    const boot = await scope.credentials.bootstrap({ projectName: name, actorName: 'Owner' });
    const owner: Caller = {
      actorId: boot.actor.id,
      projectId: boot.project.id,
      credentialId: boot.credential.id,
    };
    const token = boot.token;
    const start = async () =>
      await handle.start(owner, { workflow: 'transcript-test', requestId: randomUUID() });
    return {
      boot,
      owner,
      token,
      start,
      /** A dispatched session of `runnerId`, attached as `hostRef`, with its worker secret. */
      async leased(runnerId = 'runner', hostRef = `launch-${randomUUID()}`, bearer = token) {
        // A managed runner, a work host, holds one session; a source runner here holds up to four.
        const managed = bearer !== token;
        await ok('POST', '/sessions/runners/heartbeat', bearer, {
          runnerId,
          machine,
          platforms: [{ ...profile, parallelism: managed ? 1 : 4 }],
          capacity: managed ? 1 : 4,
          ...(managed ? { capabilities: ['workflow.workhost.1'] } : {}),
        });
        await app.ctx.sessions.dispatch.setDispatch(owner, { enabled: true });
        await start();
        const input = {
          runnerId,
          requestId: randomUUID(),
          secret: secret(),
          platform: { name: profile.name, harness: profile.harness, model: profile.model },
        };
        const leased = await ok('POST', '/sessions/lease', bearer, input);
        assert.ok(leased.session, JSON.stringify(leased));
        const session = leased.session;
        await ok('POST', `/sessions/${session.id}/attach`, bearer, { runnerId, hostRef });
        return { session, secret: input.secret, control: { runnerId, hostRef } };
      },
      /** A hand offer: no dispatch receipt, so no hostname. */
      async offered(runnerId = 'runner') {
        const instance = await start();
        const session = await app.ctx.sessions.offer(owner, {
          instanceId: instance.id,
          expectedRevision: 0,
          runnerId,
          requestId: randomUUID(),
          secret: secret(),
        });
        return { session, control: { runnerId, hostRef: `launch-${randomUUID()}` } };
      },
    };
  }
  const transcript = async (token: string, sessionId: string, body: unknown) =>
    await http('POST', `/sessions/${sessionId}/transcript`, token, body);
  return { app, s3, handle, http, ok, rows, project, transcript };
}

test('a declaration records derived metadata with no store I/O; a delivery HEADs, signs one PUT, then stamps once', async (t) => {
  const f = await fixture(t);
  const a = await f.project('Transcripts');
  const { session, control } = await a.leased();
  const { bytes, facts } = file('{"type":"turn.completed"}\n');
  const before = await f.http('GET', `/sessions/${session.id}`, a.token);
  const events = (await f.app.ctx.state.events(a.owner.projectId)).length;
  const requests = f.s3.server.requests.length;

  const declared = await f.ok('POST', `/sessions/${session.id}/transcript`, a.token, {
    ...control,
    ...facts,
  });
  assert.deepEqual(declared, {
    transcript: { sessionId: session.id, sha256: facts.sha256, size: facts.size, uploadedAt: null },
  });
  assert.equal(f.s3.server.requests.length, requests, 'a declaration makes no store request');
  const [row] = await f.rows(a.owner.projectId);
  assert.deepEqual(
    { ...row, declared_at: typeof row!.declared_at },
    {
      session_id: session.id,
      project_id: a.owner.projectId,
      workflow: 'transcript-test',
      role: 'producer',
      runner_id: 'runner',
      agent_id: session.agentId,
      host_ref: control.hostRef,
      hostname: machine.hostname,
      sha256: facts.sha256,
      size: facts.size,
      log_bytes: facts.logBytes,
      truncated: 0,
      declared_at: 'string',
      uploaded_at: null,
    },
  );
  // A replay changes nothing.
  assert.deepEqual(
    await f.ok('POST', `/sessions/${session.id}/transcript`, a.token, { ...control, ...facts }),
    declared,
  );
  assert.deepEqual(await f.rows(a.owner.projectId), [row]);

  // The delivery: one HEAD finds nothing, and the reply is the store's own signed PUT.
  const planned = (
    await f.ok('POST', `/sessions/${session.id}/transcript`, a.token, {
      ...control,
      ...facts,
      deliver: true,
    })
  ).transcript;
  assert.deepEqual(
    f.s3.server.requests.slice(requests).map((request) => [request.method, request.key]),
    [['HEAD', f.s3.key(`transcripts-${a.owner.projectId}`, facts.sha256)]],
  );
  assert.equal(planned.uploadedAt, null);
  assert.match(
    planned.upload.url,
    new RegExp(`/merv-artifacts/${f.s3.key(`transcripts-${a.owner.projectId}`, facts.sha256)}\\?`),
  );
  assert.deepEqual(planned.upload.headers, {
    'x-amz-checksum-sha256': Buffer.from(facts.sha256, 'hex').toString('base64'),
    'if-none-match': '*',
  });
  // The PUT carries the plan's headers and the bytes, and no Merv bearer.
  const put = await fetch(planned.upload.url, {
    method: 'PUT',
    headers: planned.upload.headers,
    body: new Uint8Array(bytes),
  });
  assert.equal(put.status, 200);
  assert.equal(f.s3.server.requests.at(-1)!.headers.authorization, undefined);

  // The next delivery's HEAD finds the bytes and records the upload once.
  const stamped = (
    await f.ok('POST', `/sessions/${session.id}/transcript`, a.token, {
      ...control,
      ...facts,
      deliver: true,
    })
  ).transcript;
  assert.equal(typeof stamped.uploadedAt, 'string');
  assert.equal(stamped.upload, undefined);
  const counted = f.s3.server.requests.length;
  for (const deliver of [true, undefined])
    assert.deepEqual(
      await f.ok('POST', `/sessions/${session.id}/transcript`, a.token, {
        ...control,
        ...facts,
        ...(deliver && { deliver }),
      }),
      { transcript: stamped },
    );
  assert.equal(f.s3.server.requests.length, counted, 'a stamped row is answered as it is');

  // Nothing else about the session changed, and no event was appended.
  const after = await f.http('GET', `/sessions/${session.id}`, a.token);
  assert.equal(after.text, before.text);
  assert.equal((await f.app.ctx.state.events(a.owner.projectId)).length, events);
  // Nothing serves a transcript back.
  const read = await f.http('GET', `/sessions/${session.id}/transcript`, a.token);
  assert.deepEqual([read.status, read.body.error.code], [404, 'not_found']);
});

test('byte-identical transcripts share one object within a project, and each project has its own', async (t) => {
  const f = await fixture(t);
  const a = await f.project('First');
  const b = await f.project('Second');
  const { bytes, facts } = file('{"type":"result"}\n');
  const first = await a.leased();
  const second = await a.leased();
  const other = await b.leased();
  const deliver = async (
    token: string,
    leased: Awaited<ReturnType<typeof a.leased>>,
  ): Promise<{ uploadedAt: string | null; upload?: { url: string; headers: {} } }> =>
    (
      await f.ok('POST', `/sessions/${leased.session.id}/transcript`, token, {
        ...leased.control,
        ...facts,
        deliver: true,
      })
    ).transcript;
  const put = async (upload: { url: string; headers: {} }) =>
    (
      await fetch(upload.url, {
        method: 'PUT',
        headers: upload.headers,
        body: new Uint8Array(bytes),
      })
    ).status;
  // Both plans are signed before either PUT, so the second PUT finds the key taken.
  const plans = [await deliver(a.token, first), await deliver(a.token, second)];
  assert.deepEqual(await put(plans[0]!.upload!), 200);
  assert.deepEqual(await put(plans[1]!.upload!), 412);
  // The HEAD confirms the shared object for each.
  for (const leased of [first, second])
    assert.equal(typeof (await deliver(a.token, leased)).uploadedAt, 'string');
  // Another project's identical bytes go to its own key.
  const planned = await deliver(b.token, other);
  assert.equal(planned.uploadedAt, null);
  assert.match(planned.upload!.url, new RegExp(`/transcripts-${b.owner.projectId}/`));
  assert.equal(await put(planned.upload!), 200);
  assert.deepEqual(
    [...f.s3.server.objects.keys()].filter((key) => key.includes('/transcripts-')).sort(),
    [
      f.s3.key(`transcripts-${a.owner.projectId}`, facts.sha256),
      f.s3.key(`transcripts-${b.owner.projectId}`, facts.sha256),
    ].sort(),
  );
});

test('the runner that held a session declares after it closed; every other caller and shape is refused', async (t) => {
  const f = await fixture(t);
  const a = await f.project('Closed');
  const b = await f.project('Elsewhere');
  const { facts } = file('{"type":"turn.completed"}\n');

  // Closed by its own handoff, then released by its runner.
  const handed = await a.leased();
  const worker = await f.app.ctx.sessions.authenticate(handed.secret);
  const prepared = await f.app.ctx.sessions.invocations.prepare(worker, 'finish', {});
  await f.app.ctx.sessions.invocations.run(prepared, (caller) =>
    f.app.ctx.state.transaction((tx) =>
      f.handle.transition(
        caller,
        {
          instanceId: handed.session.instanceId,
          expectedRevision: handed.session.expectedRevision,
          action: 'finish',
          requestId: 'finish',
        },
        tx,
      ),
    ),
  );
  await f.ok('POST', `/sessions/${handed.session.id}/release`, a.token, { runnerId: 'runner' });
  assert.equal((await f.app.ctx.sessions.get(a.owner, handed.session.id)).closeReason, 'handoff');
  await f.ok('POST', `/sessions/${handed.session.id}/transcript`, a.token, {
    ...handed.control,
    ...facts,
  });

  // A hand offer attached and released without ever activating; it has no hostname.
  const offered = await a.offered();
  await f.ok('POST', `/sessions/${offered.session.id}/attach`, a.token, offered.control);
  await f.ok('POST', `/sessions/${offered.session.id}/release`, a.token, { runnerId: 'runner' });
  const released = await f.app.ctx.sessions.get(a.owner, offered.session.id);
  assert.deepEqual([released.status, released.activatedAt], ['released', null]);
  await f.ok('POST', `/sessions/${offered.session.id}/transcript`, a.token, {
    ...offered.control,
    ...facts,
  });
  assert.deepEqual(
    (await f.rows(a.owner.projectId)).map((row) => [row.session_id, row.hostname]),
    [
      [handed.session.id, machine.hostname],
      [offered.session.id, null],
    ],
  );

  // Refusals leave no row.
  const live = await a.leased();
  const unattached = await a.offered();
  const issued = await f.app.ctx.scope.credentials.issueActor(a.owner, {
    name: 'Other',
    role: 'producer',
  });
  const body = { ...live.control, ...facts };
  const refusals: [string, string, unknown, number, string][] = [
    ['another runner', a.token, { ...body, runnerId: 'other' }, 403, 'session_forbidden'],
    ['another owner', issued.token, body, 403, 'session_forbidden'],
    ['another project', b.token, body, 404, 'session_not_found'],
    ['another host', a.token, { ...body, hostRef: 'launch-other' }, 409, 'host_conflict'],
    ['an empty host', a.token, { ...body, hostRef: ' ' }, 400, 'invalid_host'],
    ['size 0', a.token, { ...body, size: 0 }, 400, 'invalid_transcript'],
    [
      'over the cap',
      a.token,
      { ...body, size: MAX_TRANSCRIPT_BYTES + 1 },
      400,
      'invalid_transcript',
    ],
    ['a bad sha', a.token, { ...body, sha256: 'A'.repeat(64) }, 400, 'invalid_transcript'],
    ['a negative log', a.token, { ...body, logBytes: -1 }, 400, 'invalid_transcript'],
    ['deliver: false', a.token, { ...body, deliver: false }, 400, 'invalid_transcript'],
    ['an unknown field', a.token, { ...body, format: 'jsonl' }, 400, 'invalid_transcript'],
    ['a body session', a.token, { ...body, sessionId: live.session.id }, 400, 'invalid_input'],
  ];
  for (const [label, token, input, status, code] of refusals) {
    const refused = await f.transcript(token, live.session.id, input);
    assert.deepEqual([refused.status, refused.body.error?.code], [status, code], label);
  }
  const noHost = await f.transcript(a.token, unattached.session.id, {
    ...unattached.control,
    ...facts,
  });
  assert.deepEqual([noHost.status, noHost.body.error?.code], [409, 'host_conflict']);
  assert.equal((await f.rows()).length, 2);

  // The first declaration wins.
  await f.ok('POST', `/sessions/${live.session.id}/transcript`, a.token, body);
  const conflict = await f.transcript(a.token, live.session.id, {
    ...file('other').facts,
    ...live.control,
  });
  assert.deepEqual([conflict.status, conflict.body.error?.code], [409, 'transcript_conflict']);
  const resized = await f.transcript(a.token, live.session.id, { ...body, size: facts.size + 1 });
  assert.deepEqual([resized.status, resized.body.error?.code], [409, 'transcript_conflict']);
});

test('a managed runner declares and delivers for its bound session after release, and no other', async (t) => {
  const f = await fixture(t);
  const a = await f.project('Managed');
  f.app.ctx.sessions.managed.registerValidator({
    current: async () => true,
    admits: async () => true,
    retired: async () => false,
    assignmentSources: async (binding) => [binding.source],
  });
  const allocationId = randomUUID();
  const work = await a.start();
  const { enrollmentToken } = await f.app.ctx.sessions.managed.ensure({
    allocationId,
    epoch: 1,
    source: await f.app.ctx.scope.delegationSource(a.owner),
    runtimeProfileId: 'codex-profile',
    platform: profile,
    capabilities: ['workflow.workhost.1'],
    workInstanceId: work.id,
    stepSeconds: 900,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const { controlToken } = await f.app.ctx.sessions.managed.enroll(enrollmentToken, {
    workerNonce: randomBytes(32).toString('hex'),
  });
  const runnerId = `managed-${allocationId}`;
  const bound = await a.leased(runnerId, 'launch-managed', controlToken);
  await f.ok('POST', `/sessions/${bound.session.id}/release`, controlToken, { runnerId });
  const { facts } = file('{"type":"turn.completed"}\n');
  const body = { ...bound.control, ...facts };
  await f.ok('POST', `/sessions/${bound.session.id}/transcript`, controlToken, body);
  const planned = await f.ok('POST', `/sessions/${bound.session.id}/transcript`, controlToken, {
    ...body,
    deliver: true,
  });
  assert.ok(planned.transcript.upload);
  const other = await a.offered(runnerId);
  const refused = await f.transcript(controlToken, other.session.id, {
    ...other.control,
    ...facts,
  });
  assert.deepEqual([refused.status, refused.body.error?.code], [403, 'session_forbidden']);
  assert.deepEqual(
    (await f.rows()).map((row) => [row.session_id, row.runner_id, row.hostname]),
    [[bound.session.id, runnerId, machine.hostname]],
  );
});

test('without a store that signs uploads a transcript is refused and nothing is recorded', async (t) => {
  for (const [store, status, code] of [
    ['none', 503, 'blob_unavailable'],
    ['disk', 409, 'transcripts_unsupported'],
  ] as const)
    await t.test(store, async (subtest) => {
      const f = await fixture(subtest, store);
      const a = await f.project('Storeless');
      const { session, control } = await a.leased();
      const refused = await f.transcript(a.token, session.id, {
        ...control,
        ...file('output').facts,
      });
      assert.deepEqual([refused.status, refused.body.error?.code], [status, code]);
      assert.deepEqual(await f.rows(), []);
    });
});

test('a failed HEAD is refused as retryable and leaves the row undelivered', async (t) => {
  const f = await fixture(t);
  const a = await f.project('Unreachable');
  const { session, control } = await a.leased();
  const body = { ...control, ...file('{"type":"result"}\n').facts };
  await f.ok('POST', `/sessions/${session.id}/transcript`, a.token, body);
  f.s3.server.fail(500);
  const refused = await f.transcript(a.token, session.id, { ...body, deliver: true });
  assert.deepEqual([refused.status, refused.body.error?.code], [503, 'blob_unavailable']);
  assert.deepEqual(
    (await f.rows(a.owner.projectId)).map((row) => row.uploaded_at),
    [null],
  );
  // Once the store answers again, the same delivery plans the PUT.
  f.s3.server.fail(undefined);
  const planned = await f.ok('POST', `/sessions/${session.id}/transcript`, a.token, {
    ...body,
    deliver: true,
  });
  assert.equal(typeof planned.transcript.upload.url, 'string');
});

test('a stored object of another size is refused, and the row is write-once in the database', async (t) => {
  const f = await fixture(t);
  const a = await f.project('Guarded');
  const { session, control } = await a.leased();
  const { bytes, facts } = file('{"type":"result"}\n');
  f.s3.server.objects.set(
    f.s3.key(`transcripts-${a.owner.projectId}`, facts.sha256),
    Buffer.concat([bytes, bytes]),
  );
  const body = { ...control, ...facts };
  await f.ok('POST', `/sessions/${session.id}/transcript`, a.token, body);
  const mismatch = await f.transcript(a.token, session.id, { ...body, deliver: true });
  assert.deepEqual([mismatch.status, mismatch.body.error?.code], [409, 'transcript_mismatch']);

  const write = (sql: string) => f.app.ctx.state.transaction((tx) => tx.run(sql, session.id));
  // The guard's RAISE, not a CHECK: State keeps the routine and drops the message.
  const retained = (error: { code?: string; cause?: { routine?: string } }) =>
    error.code === 'state_constraint' && error.cause?.routine === 'exec_stmt_raise';
  await assert.rejects(write('DELETE FROM session_transcripts WHERE session_id=?'), retained);
  await assert.rejects(
    write("UPDATE session_transcripts SET hostname='other' WHERE session_id=?"),
    retained,
  );
  await assert.rejects(
    write("UPDATE session_transcripts SET uploaded_at='now', size=1 WHERE session_id=?"),
    retained,
  );
  await write("UPDATE session_transcripts SET uploaded_at='now' WHERE session_id=?");
  await assert.rejects(
    write("UPDATE session_transcripts SET uploaded_at='later' WHERE session_id=?"),
    retained,
  );
  await assert.rejects(
    write('UPDATE session_transcripts SET uploaded_at=NULL WHERE session_id=?'),
    retained,
  );
});

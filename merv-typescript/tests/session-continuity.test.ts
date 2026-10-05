/**
 * Continuity on the default composition with Blobs over the S3 fixture: when work comes back to a
 * state, the agent that held it takes it up again with the conversation its runner delivered.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Caller, WorkflowPolicy } from '@merv/contracts';
import { excludedFromReview } from '@merv/reviews/rules';
import { dormantMs } from '../packages/sessions/src/conversations.js';
import type { LeasedSessions } from '../packages/sessions/src/index.js';
import type { Session } from '../packages/sessions/src/types.js';
import type { ApplicationConfig } from '../src/config.js';
import { createApp } from './fixtures/app.js';
import { s3Blobs } from './fixtures/s3-blobs.js';

const secret = () => `ms_${randomBytes(32).toString('base64url')}`;

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'merv-continuity-'));
  const env = `MERV_CONTINUITY_TEST_${randomUUID().replaceAll('-', '')}`;
  process.env[env] = randomBytes(48).toString('hex');
  const s3 = await s3Blobs(t);
  const config = JSON.parse(
    readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
  ) as ApplicationConfig;
  config.plugins = config.plugins.map((plugin) =>
    plugin.id === 'sessions'
      ? { ...plugin, config: { managedSecretEnv: env, sweepIntervalMs: 60_000 } }
      : plugin.id === 'blobs'
        ? s3.entry
        : plugin,
  );
  const app = await createApp({ directory, config, port: 0 });
  t.after(async () => {
    await app.stop();
    await rm(directory, { recursive: true, force: true });
    delete process.env[env];
  });
  const scope = app.ctx.scope;
  const allow: WorkflowPolicy['actions'][number]['check'] = async ({ caller, tx }) => {
    await scope.require(caller, 'write', tx);
  };
  const action = (name: string, state: string) => ({
    name,
    states: [state],
    transitions: [name],
    tool: name,
    instruction: name,
    check: allow,
  });
  const assignment = (state: string, role: 'producer' | 'reviewer') => ({
    state,
    check: async ({ caller, tx }: Parameters<typeof allow>[0]) => {
      await scope.require(caller, role === 'reviewer' ? 'review' : 'write', tx);
    },
    build: () => ({
      role,
      label: `${state} work`,
      brief: 'Do the work',
      references: [],
      handoff: { instruction: 'Hand off', tools: [] },
      execution: { readOnly: role === 'reviewer', tools: [] },
      context: null,
    }),
    execution: { readOnly: role === 'reviewer', tools: [] },
    lease: {
      role: () => role,
      acquire: ({ leaseId }: { leaseId: string }) => ({ leaseId }),
      check: () => {},
      release: () => {},
    },
  });
  const handle = await app.ctx.workflows.register(
    {
      name: 'continuity-test',
      version: 1,
      initial: 'working',
      states: ['working', 'review', 'done'],
      terminal: ['done'],
      edges: [
        { from: 'working', action: 'submit', to: 'review' },
        { from: 'review', action: 'revise', to: 'working' },
        { from: 'review', action: 'approve', to: 'done' },
      ],
    },
    {
      successStates: ['done'],
      actions: [
        action('submit', 'working'),
        action('revise', 'review'),
        action('approve', 'review'),
      ],
      assignments: [assignment('working', 'producer'), assignment('review', 'reviewer')],
    } as WorkflowPolicy,
  );
  const http = async (method: string, path: string, token: string, body?: unknown) => {
    const response = await fetch(`${app.ctx.api.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: JSON.parse(text), text };
  };
  const ok = async (method: string, path: string, token: string, body?: unknown) => {
    const result = await http(method, path, token, body);
    assert.equal(result.status, 200, result.text);
    return result.body;
  };
  const boot = await scope.bootstrap({ projectName: 'Continuity', actorName: 'Owner' });
  const owner: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const token = boot.token;
  const sessions = app.ctx.sessions;
  /** A hand offer of the instance's current step, attached by `runnerId`. */
  const offer = async (instanceId: string, runnerId = 'runner', requestId = randomUUID()) => {
    const { revision } = await app.ctx.workflows.get(owner, instanceId);
    const input = { instanceId, expectedRevision: revision, runnerId, requestId, secret: secret() };
    const session = await sessions.offer(owner, input);
    const control = { runnerId, hostRef: `launch-${randomUUID()}` };
    await ok('POST', `/sessions/${session.id}/attach`, token, control);
    return { session, control, input };
  };
  const release = async (session: Session) =>
    await ok('POST', `/sessions/${session.id}/release`, token, { runnerId: session.runnerId });
  const move = async (instanceId: string, name: string) => {
    const { revision } = await app.ctx.workflows.get(owner, instanceId);
    await app.ctx.state.transaction((tx) =>
      handle.transition(
        owner,
        { instanceId, expectedRevision: revision, action: name, requestId: randomUUID() },
        tx,
      ),
    );
  };
  /** The runner's declaration and delivery of a conversation file, through its signed PUT. */
  const keep = async (
    session: Session,
    control: { runnerId: string; hostRef: string },
    text = `{"type":"user","text":"${randomUUID()}"}\n`,
  ) => {
    const bytes = Buffer.from(text);
    const facts = {
      harness: 'codex',
      conversationId: '0199a0b2-1111-7222-8333-944445555666',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
    };
    const path = `/sessions/${session.id}/conversation`;
    await ok('POST', path, token, { ...control, ...facts });
    const { upload } = (await ok('POST', path, token, { ...control, ...facts, deliver: true }))
      .conversation;
    const put = await fetch(upload.url, {
      method: 'PUT',
      headers: upload.headers,
      body: new Uint8Array(bytes),
    });
    assert.equal(put.status, 200);
    const stamped = (await ok('POST', path, token, { ...control, ...facts, deliver: true }))
      .conversation;
    assert.equal(typeof stamped.uploadedAt, 'string');
    return { bytes, facts };
  };
  const agent = async (id: string) => (await sessions.agent(owner, id)).agent;
  const start = async () =>
    await handle.start(owner, { workflow: 'continuity-test', requestId: randomUUID() });
  return {
    app,
    sessions,
    token,
    owner,
    http,
    ok,
    offer,
    release,
    move,
    keep,
    agent,
    start,
    /** As though every key's work had stayed away for `ms`. */
    age: async (ms: number) =>
      await app.ctx.state.transaction((tx) =>
        tx.run(
          'UPDATE session_conversations SET updated_at=?',
          new Date(Date.now() - ms).toISOString(),
        ),
      ),
  };
}

test('work that comes back resumes its producer: same agent actor, new session, lease and credential', async (t) => {
  const f = await fixture(t);
  const unit = await f.start();
  const first = await f.offer(unit.id, 'runner-a');
  assert.deepEqual(first.session.continuity, {
    key: JSON.stringify([unit.id, 'working', 'producer']),
  });
  await f.release(first.session);
  // Its agent waits, dormant: the session's own credential is revoked as before.
  assert.equal((await f.agent(first.session.agentId!)).status, 'active');
  const { bytes, facts } = await f.keep(first.session, first.control);

  await f.move(unit.id, 'submit');
  const review = await f.offer(unit.id, 'runner-a');
  // A reviewer reads each round with fresh eyes: no key, never the producer's conversation or agent.
  assert.equal(review.session.continuity, undefined);
  assert.notEqual(review.session.actorId, first.session.actorId);
  await f.release(review.session);
  await f.move(unit.id, 'revise');

  // Another runner takes the returned work: the earlier agent, its conversation, a new session.
  const second = await f.offer(unit.id, 'runner-b');
  assert.notEqual(second.session.id, first.session.id);
  assert.equal(second.session.agentId, first.session.agentId);
  assert.equal(second.session.actorId, first.session.actorId);
  assert.deepEqual(second.session.continuity, {
    key: first.session.continuity!.key,
    resume: { sessionId: first.session.id, ...facts },
  });
  // A replay of the offer is the same session; a changed input is still refused.
  const replay = await f.sessions.offer(f.owner, second.input);
  assert.deepEqual(
    [replay.id, replay.actorId, replay.continuity],
    [second.session.id, second.session.actorId, second.session.continuity],
  );
  await assert.rejects(f.sessions.offer(f.owner, { ...second.input, secret: secret() }), {
    code: 'request_conflict',
  });
  // Its runner, and only while it is attached and live, fetches the bytes by a signed GET.
  const { download } = await f.ok('POST', `/sessions/${second.session.id}/resume`, f.token, {
    ...second.control,
  });
  assert.deepEqual(Buffer.from(await (await fetch(download.url)).arrayBuffer()), bytes);
  assert.equal(
    (await f.http('POST', `/sessions/${first.session.id}/resume`, f.token, first.control)).status,
    409,
  );

  // The reactivated producer is still a contributor under both sessions: excluded from review.
  const contributors = await f.app.ctx.state.transaction((tx) =>
    f.sessions.contributors(f.owner.projectId, unit.id, null, tx),
  );
  assert.deepEqual(
    contributors.map((c) => [c.ref, c.actorId]).sort(),
    [
      [first.session.id, first.session.actorId],
      [second.session.id, first.session.actorId],
    ].sort(),
  );
  assert.ok(
    excludedFromReview(
      { producerId: 'someone', excludedActorIds: contributors.map((c) => c.actorId) },
      second.session.actorId,
    ),
  );

  // The first session's conversation is no longer the latest once the second closes.
  await f.release(second.session);
  const stale = await f.http('POST', `/sessions/${first.session.id}/conversation`, f.token, {
    ...first.control,
    ...facts,
  });
  assert.deepEqual([stale.status, stale.body.error.code], [409, 'conversation_superseded']);
});

test('a key without a delivered conversation offers a new agent; the one it replaced is retired', async (t) => {
  const f = await fixture(t);
  const unit = await f.start();
  const first = await f.offer(unit.id);
  await f.release(first.session);
  // Nothing was delivered: the next offer of the key is fresh, and its close supersedes the first.
  const second = await f.offer(unit.id);
  assert.equal(second.session.continuity?.resume, undefined);
  assert.notEqual(second.session.agentId, first.session.agentId);
  await f.release(second.session);
  assert.equal((await f.agent(first.session.agentId!)).status, 'retired');
  assert.equal((await f.agent(second.session.agentId!)).status, 'active');
  // A conversation of the latest session, delivered, is what the next offer resumes.
  await f.keep(second.session, second.control);
  const third = await f.offer(unit.id);
  assert.equal(third.session.agentId, second.session.agentId);
  assert.equal(third.session.continuity?.resume?.sessionId, second.session.id);
  await f.release(third.session);
  // An agent whose work stays away past the dormancy window is retired by the sweep.
  await f.age(dormantMs + 1);
  await f.sessions.sweep();
  assert.equal((await f.agent(second.session.agentId!)).status, 'retired');
  const fourth = await f.offer(unit.id);
  assert.equal(fourth.session.continuity?.resume, undefined);
  assert.notEqual(fourth.session.agentId, second.session.agentId);
});

test('a provider keys a workflow: across instances, or never', async (t) => {
  const f = await fixture(t);
  const keys: (string | null)[] = ['shared', null];
  const dispose = f.sessions.registerContinuity('continuity-test', ({ role }) =>
    keys.length ? keys.shift()! : `${role}:last`,
  );
  t.after(dispose);
  assert.throws(() => f.sessions.registerContinuity('continuity-test', () => null), {
    code: 'continuity_registered',
  });
  const a = await f.offer((await f.start()).id);
  assert.deepEqual(a.session.continuity, { key: 'shared' });
  await f.release(a.session);
  await f.keep(a.session, a.control);
  // Null: no key, and its agent is retired at close as before.
  const b = await f.offer((await f.start()).id);
  assert.equal(b.session.continuity, undefined);
  await f.release(b.session);
  assert.equal((await f.agent(b.session.agentId!)).status, 'retired');
  const refused = await f.http('POST', `/sessions/${b.session.id}/conversation`, f.token, {
    ...b.control,
    harness: 'claude',
    conversationId: '0199a0b2-1111-7222-8333-944445555666',
    sha256: 'a'.repeat(64),
    size: 1,
  });
  assert.deepEqual([refused.status, refused.body.error.code], [409, 'conversation_unkept']);
  // Another instance with the same key continues the first.
  keys.push('shared');
  const c = await f.offer((await f.start()).id);
  assert.equal(c.session.agentId, a.session.agentId);
  assert.equal(c.session.continuity?.resume?.sessionId, a.session.id);
});

test('research keys: a lens by wave and perspective across restarts, an experiment across attempts', async (t) => {
  const f = await fixture(t);
  const { conversations } = f.sessions as unknown as LeasedSessions;
  const lens = (instanceId: string, attempt: number, perspective: string, role = 'producer') =>
    conversations.key({
      instanceId,
      workflow: 'reflection.lens',
      state: 'reflecting',
      data: { reflectionId: 'wave', attempt, perspective },
      role: role as 'producer',
    });
  // A restart makes new lens instances; each perspective's author continues its own.
  assert.equal(lens('lens-1', 1, 'theory'), lens('lens-6', 2, 'theory'));
  assert.notEqual(lens('lens-1', 1, 'theory'), lens('lens-2', 1, 'methods'));
  assert.equal(lens('lens-1', 1, 'theory', 'reviewer'), null);
  // A design revision starts a new attempt of the same experiment: the planner continues.
  const experiment = (attempt: number, state: string, role: 'producer' | 'reviewer') =>
    conversations.key({
      instanceId: 'experiment',
      workflow: 'experiment',
      state,
      data: { attempt },
      role,
    });
  assert.equal(experiment(1, 'planned', 'producer'), experiment(2, 'planned', 'producer'));
  assert.notEqual(experiment(1, 'running', 'producer'), experiment(1, 'planned', 'producer'));
  assert.equal(experiment(1, 'design_review', 'reviewer'), null);
});

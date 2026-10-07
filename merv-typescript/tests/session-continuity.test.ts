/**
 * Continuity on the default composition with Blobs over the S3 fixture: when work comes back to a
 * state, the agent that held it takes it up again with the conversation its runner delivered.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { Blobs, Caller, Scope, State, WorkflowPolicy } from '@merv/contracts';
import { excludedFromReview } from '@merv/reviews/rules';
import { MachineRunner } from '@merv/runner';
import { dormantMs, SessionThreads } from '../packages/sessions/src/threads.js';
import type { LeasedSessions } from '../packages/sessions/src/index.js';
import type { AgentStreamEvent } from '@merv/sessions/agent-stream';
import type {
  Session,
  ThreadConversation,
  ThreadView,
  VisitView,
} from '../packages/sessions/src/types.js';
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
  const boot = await scope.credentials.bootstrap({ projectName: 'Continuity', actorName: 'Owner' });
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
    harness = 'codex',
  ) => {
    const bytes = Buffer.from(text);
    const facts = {
      harness,
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
  const agent = async (id: string) => (await sessions.observations.read(owner, id)).agent;
  const start = async () =>
    await handle.start(owner, { workflow: 'continuity-test', requestId: randomUUID() });
  return {
    app,
    s3,
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
          "UPDATE session_threads SET updated_at=? WHERE status<>'retired'",
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
  assert.equal((await f.agent(first.session.threadId!)).status, 'active');
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
  assert.equal(second.session.threadId, first.session.threadId);
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

  // The first session's conversation is no longer the latest once the second delivers its own.
  await f.release(second.session);
  await f.keep(second.session, second.control);
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
  assert.notEqual(second.session.threadId, first.session.threadId);
  await f.release(second.session);
  assert.equal((await f.agent(first.session.threadId!)).status, 'retired');
  assert.equal((await f.agent(second.session.threadId!)).status, 'active');
  // A conversation of the latest session, delivered, is what the next offer resumes.
  await f.keep(second.session, second.control);
  const third = await f.offer(unit.id);
  assert.equal(third.session.threadId, second.session.threadId);
  assert.equal(third.session.continuity?.resume?.sessionId, second.session.id);
  await f.release(third.session);
  // An agent whose work stays away past the dormancy window is retired by the sweep.
  await f.age(dormantMs + 1);
  await f.sessions.sweep();
  assert.equal((await f.agent(second.session.threadId!)).status, 'retired');
  const fourth = await f.offer(unit.id);
  assert.equal(fourth.session.continuity?.resume, undefined);
  assert.notEqual(fourth.session.threadId, second.session.threadId);
});

test('a resumed session that closes having declared nothing leaves the conversation it continued', async (t) => {
  const f = await fixture(t);
  const unit = await f.start();
  const first = await f.offer(unit.id, 'runner-a');
  await f.release(first.session);
  const { facts } = await f.keep(first.session, first.control);
  // The resumed launch fails before its harness runs (a lost machine, a lapsed offer): nothing kept.
  const second = await f.offer(unit.id, 'runner-b');
  assert.equal(second.session.continuity?.resume?.sessionId, first.session.id);
  await f.ok('POST', `/sessions/${second.session.id}/release`, f.token, {
    runnerId: 'runner-b',
    outcome: 'launch_failed',
  });
  // The next offer still resumes the same agent with the same conversation, and nobody is retired.
  const third = await f.offer(unit.id, 'runner-c');
  assert.equal(third.session.threadId, first.session.threadId);
  assert.deepEqual(third.session.continuity?.resume, { sessionId: first.session.id, ...facts });
  await f.release(third.session);
  assert.equal((await f.agent(first.session.threadId!)).status, 'active');
  // The last session to close may still declare what it kept; an earlier one of it may not.
  await f.keep(third.session, third.control);
  const stale = await f.http('POST', `/sessions/${second.session.id}/conversation`, f.token, {
    ...second.control,
    ...facts,
  });
  assert.deepEqual([stale.status, stale.body.error.code], [409, 'conversation_superseded']);
  const fourth = await f.offer(unit.id, 'runner-a');
  assert.equal(fourth.session.threadId, first.session.threadId);
  assert.equal(fourth.session.continuity?.resume?.sessionId, third.session.id);
});

test('a conversation its harness could not take up is dropped: the next offer, on any machine, starts afresh', async (t) => {
  const f = await fixture(t);
  const unit = await f.start();
  const first = await f.offer(unit.id, 'runner-a');
  await f.release(first.session);
  const { facts } = await f.keep(first.session, first.control);
  const deferred = (session: Session, cause: string) =>
    f.ok('POST', `/sessions/${session.id}/release`, f.token, {
      runnerId: session.runnerId,
      outcome: 'preparation_deferred',
      deferral: { cause, code: cause },
    });
  // Another deferral leaves the conversation: the next offer resumes it.
  const second = await f.offer(unit.id, 'runner-b');
  await deferred(second.session, 'workspace_busy');
  const third = await f.offer(unit.id, 'runner-c');
  assert.deepEqual(third.session.continuity?.resume, { sessionId: first.session.id, ...facts });
  // A hosted machine whose harness could not resume it: its ledger leaves with it, so Sessions
  // drops the conversation, and a fresh machine's offer of the key launches fresh.
  const release = deferred(third.session, 'resume_failed');
  // A retry racing the first release changes nothing more.
  await Promise.all([release, deferred(third.session, 'resume_failed')]);
  // The first runner's confirming call, arriving late, cannot declare it again.
  const late = await f.http('POST', `/sessions/${first.session.id}/conversation`, f.token, {
    ...first.control,
    ...facts,
    deliver: true,
  });
  assert.deepEqual([late.status, late.body.error?.code], [409, 'conversation_superseded']);
  const fourth = await f.offer(unit.id, 'runner-d');
  assert.equal(fourth.session.continuity?.key, first.session.continuity!.key);
  assert.equal(fourth.session.continuity?.resume, undefined);
  // What the fresh launch keeps is what the key resumes next; the earlier agent is superseded.
  await f.release(fourth.session);
  const kept = await f.keep(fourth.session, fourth.control);
  const fifth = await f.offer(unit.id, 'runner-e');
  assert.deepEqual(fifth.session.continuity?.resume, {
    sessionId: fourth.session.id,
    ...kept.facts,
  });
  assert.equal(fifth.session.threadId, fourth.session.threadId);
  assert.equal((await f.agent(first.session.threadId!)).status, 'retired');
  // A resume failure of a conversation the key no longer holds drops nothing newer.
  await f.release(fifth.session);
  const sixth = await f.offer(unit.id, 'runner-f');
  await f.keep(fifth.session, fifth.control);
  await deferred(sixth.session, 'resume_failed');
  const seventh = await f.offer(unit.id, 'runner-g');
  assert.equal(seventh.session.continuity?.resume?.sessionId, fifth.session.id);
});

test('a late declaration of the agent’s session newer than the row’s conversation is taken, even after a later one lapsed', async (t) => {
  const f = await fixture(t);
  const unit = await f.start();
  const first = await f.offer(unit.id, 'runner-a');
  await f.release(first.session);
  await f.keep(first.session, first.control);
  // The second session hands off; its runner declares only later. The third lapses with nothing.
  const second = await f.offer(unit.id, 'runner-b');
  await f.release(second.session);
  const third = await f.offer(unit.id, 'runner-c');
  await f.release(third.session);
  const late = await f.keep(second.session, second.control);
  const fourth = await f.offer(unit.id, 'runner-d');
  assert.equal(fourth.session.threadId, first.session.threadId);
  assert.deepEqual(fourth.session.continuity?.resume, {
    sessionId: second.session.id,
    ...late.facts,
  });
  await f.release(fourth.session);
  // The third's own late declaration is newer still; after it, the second's is refused.
  const latest = await f.keep(third.session, third.control);
  const stale = await f.http('POST', `/sessions/${second.session.id}/conversation`, f.token, {
    ...second.control,
    ...late.facts,
    sha256: createHash('sha256').update('other').digest('hex'),
  });
  assert.deepEqual([stale.status, stale.body.error.code], [409, 'conversation_superseded']);
  const fifth = await f.offer(unit.id, 'runner-e');
  assert.deepEqual(fifth.session.continuity?.resume, {
    sessionId: third.session.id,
    ...latest.facts,
  });
});

test('a conversation declared but not yet stamped as delivered is still resumed by its agent', async (t) => {
  const f = await fixture(t);
  const unit = await f.start();
  const first = await f.offer(unit.id);
  await f.release(first.session);
  const facts = {
    harness: 'claude',
    conversationId: '0199a0b2-1111-7222-8333-944445555666',
    sha256: createHash('sha256').update('x').digest('hex'),
    size: 1,
  };
  await f.ok('POST', `/sessions/${first.session.id}/conversation`, f.token, {
    ...first.control,
    ...facts,
  });
  // The work came back before the runner's upload: the same agent takes it, never a fresh one.
  const second = await f.offer(unit.id);
  assert.equal(second.session.threadId, first.session.threadId);
  assert.deepEqual(second.session.continuity?.resume, { sessionId: first.session.id, ...facts });
  await f.release(second.session);
  assert.equal((await f.agent(first.session.threadId!)).status, 'active');
});

test('a provider keys a workflow: across instances, or never', async (t) => {
  const f = await fixture(t);
  const keys: (string | null)[] = ['shared', null];
  const dispose = f.sessions.threads.register('continuity-test', ({ role }) =>
    keys.length ? keys.shift()! : `${role}:last`,
  );
  t.after(dispose);
  assert.throws(() => f.sessions.threads.register('continuity-test', () => null), {
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
  assert.equal((await f.agent(b.session.threadId!)).status, 'retired');
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
  assert.equal(c.session.threadId, a.session.threadId);
  assert.equal(c.session.continuity?.resume?.sessionId, a.session.id);
});

test('research keys: a lens by wave and perspective across restarts, an experiment across attempts', async (t) => {
  const f = await fixture(t);
  const { threads } = f.sessions as unknown as LeasedSessions;
  const lens = (instanceId: string, attempt: number, perspective: string, role = 'producer') =>
    threads.key({
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
    threads.key({
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

/** A stand-in Claude Code: resumes the named conversation or starts one; or, by a marker, fails. */
const standIn = (root: string) => {
  const path = join(root, 'claude-stand-in.cjs');
  writeFileSync(
    path,
    `#!${process.execPath}
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const args = process.argv.slice(2), at = args.indexOf('--resume'), root = process.env.CLAUDE_CONFIG_DIR;
fs.readFileSync(0, 'utf8');
if (fs.existsSync(path.join(root, 'crash'))) { console.error('Invalid API key'); process.exit(1); }
if (at >= 0 && fs.existsSync(path.join(root, 'refuse-resume'))) { console.error('No conversation found with session ID: ' + args[at + 1]); process.exit(1); }
const id = at >= 0 ? args[at + 1] : crypto.randomUUID();
fs.mkdirSync(path.join(root, 'projects', '-fresh'), { recursive: true });
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: id }));
fs.appendFileSync(path.join(root, 'projects', '-fresh', id + '.jsonl'), JSON.stringify({ type: 'user', resumed: at >= 0 }) + '\\n');
`,
  );
  chmodSync(path, 0o755);
  return path;
};

test('real runners: a hosted machine that cannot resume puts it off once; a fresh machine then launches fresh', async (t) => {
  const f = await fixture(t);
  const root = await mkdtemp(join(tmpdir(), 'merv-continuity-runner-'));
  const claudeHome = join(root, 'claude');
  mkdirSync(claudeHome);
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  const credentialEnv = `MERV_CONTINUITY_RUNNER_${randomUUID().replaceAll('-', '')}`;
  process.env[credentialEnv] = f.token;
  const runners: MachineRunner[] = [];
  t.after(async () => {
    for (const runner of runners) await runner.stop();
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
    delete process.env[credentialEnv];
    await rm(root, { recursive: true, force: true });
  });
  const executable = standIn(root);
  /** A machine with its own empty ledger, as a hosted one starts; it takes one launch at most. */
  const machine = (name: string) => {
    let leases = 0;
    const directory = join(root, name);
    const runner = new MachineRunner(
      {
        directory,
        baseUrl: f.app.ctx.api.url!,
        projectId: f.owner.projectId,
        credentialEnv,
        profiles: [
          { name: 'claude', harness: 'claude', executable, enabled: true, parallelism: 1 },
        ],
        capacity: 1,
        pollIntervalMs: 100,
        requestTimeoutMs: 2000,
      },
      {
        autoPoll: false,
        fetch: async (input, init) =>
          String(input instanceof Request ? input.url : input).endsWith('/sessions/lease') &&
          leases++ > 0
            ? Response.json({ error: { code: 'offline', message: 'offline' } }, { status: 503 })
            : await fetch(input, init),
      },
    );
    runners.push(runner);
    return { runner, directory };
  };
  const closed = async () =>
    (await f.sessions.list(f.owner)).filter((s) => s.status !== 'offered' && s.status !== 'active');
  const drive = async (runner: MachineRunner, count: number, label: string) => {
    await runner.start();
    for (let end = Date.now() + 20_000; (await closed()).length < count;) {
      assert.ok(Date.now() < end, `${label}: ${JSON.stringify(runner.snapshot())}`);
      await runner.tick();
      await delay(50);
    }
    return (await closed()).find((s) => !seen.has(s.id) && seen.add(s.id))!;
  };
  const seen = new Set<string>();

  const unit = await f.start();
  const first = await f.offer(unit.id, 'runner-hand');
  await f.release(first.session);
  seen.add(first.session.id);
  const { facts } = await f.keep(first.session, first.control, undefined, 'claude');
  await f.sessions.dispatch.setDispatch(f.owner, { enabled: true });

  // A harness that crashes before it starts, for some other reason, is an ordinary failure:
  // counted, and the conversation is kept for the next offer.
  writeFileSync(join(claudeHome, 'crash'), '');
  const crashed = await drive(machine('a').runner, 2, 'crash');
  assert.equal(crashed.continuity?.resume?.sha256, facts.sha256);
  assert.ok(['crash_loop', 'host_failed'].includes(crashed.outcome!), crashed.outcome!);
  assert.equal(crashed.deferral ?? undefined, undefined);
  rmSync(join(claudeHome, 'crash'));

  // A harness that finds no conversation to resume is put off, uncounted.
  writeFileSync(join(claudeHome, 'refuse-resume'), '');
  const refused = await drive(machine('b').runner, 3, 'refused resume');
  assert.equal(refused.continuity?.resume?.sha256, facts.sha256);
  assert.deepEqual(
    [refused.outcome, refused.deferral],
    ['preparation_deferred', { cause: 'resume_failed', code: 'resume_failed' }],
  );

  // A fresh machine, with an empty ledger, is offered the key without the conversation and runs.
  const fresh = machine('c');
  const third = await drive(fresh.runner, 4, 'fresh launch');
  assert.equal(third.continuity?.key, first.session.continuity!.key);
  assert.equal(third.continuity?.resume, undefined);
  const record = fresh.runner.snapshot().launches[0]!;
  assert.equal(record.sessionId, third.id);
});

test('a work item’s threads: each stage’s worker with its visits, and its conversation from stream or stored transcript', async (t) => {
  const f = await fixture(t);
  const unit = await f.start();
  const first = await f.offer(unit.id, 'runner-a');
  // The agent printed a few events, which the runner streamed.
  await f.ok('POST', `/sessions/${first.session.id}/stream`, f.token, {
    ...first.control,
    from: 0,
    to: 10,
    events: [{ kind: 'text', id: 't1', delta: 'Working on it', done: true }],
  });
  await f.release(first.session);
  // Its runner kept the transcript of what Claude Code printed.
  const transcript = [
    { type: 'system', subtype: 'init', model: 'claude-x', session_id: 'c1' },
    {
      type: 'assistant',
      message: {
        id: 'm1',
        content: [
          { type: 'text', text: 'Reading the plan' },
          { type: 'tool_use', id: 'u1', name: 'mcp__merv__workflow.assignment', input: {} },
        ],
      },
    },
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'ok' }] },
    },
    { type: 'result', subtype: 'success', num_turns: 2 },
  ]
    .map((line) => JSON.stringify(line))
    .join('\n');
  const bytes = Buffer.from(`${transcript}\n`);
  const facts = {
    ...first.control,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    logBytes: bytes.length,
    truncated: false,
  };
  const path = `/sessions/${first.session.id}/transcript`;
  const { upload } = (await f.ok('POST', path, f.token, { ...facts, deliver: true })).transcript;
  assert.equal(
    (
      await fetch(upload.url, {
        method: 'PUT',
        headers: upload.headers,
        body: new Uint8Array(bytes),
      })
    ).status,
    200,
  );
  await f.ok('POST', path, f.token, { ...facts, deliver: true });
  await f.keep(first.session, first.control);
  await f.move(unit.id, 'submit');
  const review = await f.offer(unit.id, 'runner-a');
  await f.release(review.session);
  await f.move(unit.id, 'revise');
  // A launch that failed before the agent ran, then the resumed producer, still live.
  const failed = await f.offer(unit.id, 'runner-b');
  await f.ok('POST', `/sessions/${failed.session.id}/release`, f.token, {
    runnerId: 'runner-b',
    reason: 'local_process_exit_code_70',
    outcome: 'launch_failed',
  });
  const live = await f.offer(unit.id, 'runner-c');
  assert.equal(live.session.threadId, first.session.threadId);

  const { threads } = await f.ok('GET', `/sessions/threads?instanceId=${unit.id}`, f.token);
  assert.deepEqual(
    threads.map((thread: ThreadView) => [thread.id, thread.state, thread.role, thread.status]),
    [
      [first.session.threadId, 'working', 'producer', 'live'],
      [review.session.threadId, 'review', 'reviewer', 'retired'],
    ],
  );
  const visits: VisitView[] = threads[0].visits;
  assert.deepEqual(
    visits.map((visit) => [
      visit.sessionId,
      visit.status,
      visit.launched,
      visit.resumed,
      visit.hasConversation,
      visit.runnerId,
    ]),
    [
      [first.session.id, 'released', true, false, true, 'runner-a'],
      [failed.session.id, 'released', false, true, false, 'runner-b'],
      [live.session.id, 'offered', false, true, false, 'runner-c'],
    ],
  );
  assert.deepEqual(
    [visits[1]!.outcome, visits[1]!.why, visits[1]!.harness],
    ['launch_failed', 'local_process_exit_code_70', 'codex'],
  );
  assert.equal(visits[2]!.liveness?.verdict, 'offered');
  assert.equal(visits[0]!.liveness, undefined);
  // The same as a tool, for anyone who may read the work; never for a leased worker.
  const tool = await f.app.ctx.tools.invoke('session.threads', f.owner, { instanceId: unit.id });
  assert.deepEqual((tool.value as { threads: ThreadView[] }).threads, threads);
  const worker = await f.sessions.authenticate(live.input.secret);
  await assert.rejects(f.sessions.threads.list(worker, unit.id), { code: 'session_forbidden' });

  // An operator reads what the agent did: the stream while it is kept, then the transcript.
  const conversation = `/sessions/threads/${first.session.threadId}/conversation`;
  let read: ThreadConversation = await f.ok('GET', conversation, f.token);
  assert.deepEqual(
    read.visits.map((visit) => [visit.sessionId, visit.from, visit.events.length]),
    [
      [first.session.id, 'stream', 1],
      [failed.session.id, 'none', 0],
      [live.session.id, 'live', 0],
    ],
  );
  await f.app.ctx.state.transaction((tx) =>
    tx.run('DELETE FROM session_events WHERE session_id=?', first.session.id),
  );
  read = await f.ok('GET', conversation, f.token);
  assert.equal(read.visits[0]!.from, 'transcript');
  assert.deepEqual(
    read.visits[0]!.events.map(({ event }) => event),
    [
      { kind: 'status', id: 'status-0', text: 'Started · claude-x' },
      { kind: 'text', id: 'm1.whole1-0', delta: 'Reading the plan', done: true },
      { kind: 'tool_call', id: 'u1', name: 'workflow.assignment', input: '{}' },
      { kind: 'tool_result', id: 'u1', output: 'ok' },
      { kind: 'status', id: 'status-3', text: 'Finished · success · 2 turns' },
    ],
  );
  // Only an operator: a reader may list the threads but not read the conversation.
  const reader = await f.app.ctx.scope.credentials.issueActor(f.owner, {
    name: 'Reader',
    role: 'reader',
  });
  assert.equal(
    (await f.http('GET', `/sessions/threads?instanceId=${unit.id}`, reader.token)).status,
    200,
  );
  const refused = await f.http('GET', conversation, reader.token);
  assert.deepEqual([refused.status, refused.body.error.code], [403, 'forbidden']);
  const missing = await f.http('GET', '/sessions/threads/thr_missing/conversation', f.token);
  assert.deepEqual([missing.status, missing.body.error.code], [404, 'thread_not_found']);
  const unknown = await f.http('GET', `/sessions/threads?instanceId=${unit.id}&x=1`, f.token);
  assert.equal(unknown.status, 400);
});

test('a conversation read takes only a large transcript’s end, and a visit it cannot read is unavailable', async (t) => {
  const f = await fixture(t);
  const unit = await f.start();
  /** A Codex transcript of `count` padded answers, uploaded for `session` as its runner does. */
  const transcript = async (
    { session, control }: { session: Session; control: { runnerId: string; hostRef: string } },
    name: string,
    count: number,
  ) => {
    const bytes = Buffer.from(
      Array.from(
        { length: count },
        (_, index) =>
          `${JSON.stringify({ type: 'item.completed', item: { id: `${name}${index}`, type: 'agent_message', text: `${name} ${index} ${'x'.repeat(220)}` } })}\n`,
      ).join(''),
    );
    const facts = {
      ...control,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
      logBytes: bytes.length,
      truncated: false,
    };
    const path = `/sessions/${session.id}/transcript`;
    const { upload } = (await f.ok('POST', path, f.token, { ...facts, deliver: true })).transcript;
    const put = await fetch(upload.url, {
      method: 'PUT',
      headers: upload.headers,
      body: new Uint8Array(bytes),
    });
    assert.equal(put.status, 200);
    await f.ok('POST', path, f.token, { ...facts, deliver: true });
    return {
      bytes,
      key: [...f.s3.server.objects.keys()].find((key) => key.endsWith(facts.sha256))!,
    };
  };
  // Two visits of one thread: the first keeps its conversation, so the second resumes it.
  const first = await f.offer(unit.id, 'runner-a');
  await f.keep(first.session, first.control);
  await f.release(first.session);
  const second = await f.offer(unit.id, 'runner-a');
  assert.equal(second.session.threadId, first.session.threadId);
  await f.release(second.session);
  const big = await transcript(first, 'a', 14_000);
  assert.ok(big.bytes.length > 3_500_000, String(big.bytes.length));
  const lost = await transcript(second, 'b', 10);
  f.s3.server.objects.delete(lost.key);
  f.s3.server.requests.length = 0;

  const read: ThreadConversation = await f.ok(
    'GET',
    `/sessions/threads/${first.session.threadId}/conversation`,
    f.token,
  );
  assert.deepEqual(
    read.visits.map(({ sessionId, from, events }) => [
      sessionId,
      from,
      events.length,
      events[0]?.event.id,
      events.at(-1)?.event.id,
    ]),
    [
      [first.session.id, 'transcript', 500, 'a13500', 'a13999'],
      [second.session.id, 'unavailable', 0, undefined, undefined],
    ],
  );
  // Only the big transcript's end crossed the wire.
  const sent = f.s3.server.requests.filter(
    (request) => request.method === 'GET' && request.key === big.key,
  );
  assert.equal(sent.length, 1);
  assert.match(String(sent[0]!.headers.range), /^bytes=\d+-$/);
});

/**
 * A conversation read over `visits` (oldest first), with stores standing in for Sessions': each
 * visit's kept stream, and transcripts served by a signed download that answers ranged GETs.
 * Says which streams and transcripts it read, and how many lines it parsed.
 */
async function converse(
  t: TestContext,
  visits: { id: string; status?: string; streamed?: boolean; sha256?: string }[],
  {
    streams = {},
    stored = {},
  }: {
    streams?: Record<string, AgentStreamEvent[]>;
    stored?: Record<string, Buffer>;
  },
) {
  const gets: string[] = [];
  const streamed: string[] = [];
  const threads = new SessionThreads(
    {
      snapshotTransaction: async (run: (tx: unknown) => unknown) =>
        run({
          get: async () => ({}),
          all: async () =>
            visits.map(({ id, status = 'released', streamed = false, sha256 = null }) => ({
              id,
              project_id: 'prj_1',
              status,
              streamed,
              sha256,
              size: sha256 && String(stored[sha256]!.length),
              declared_at: sha256 && '2026-10-06T00:00:00.000Z',
            })),
        }),
    } as unknown as State,
    { require: async () => ({ role: 'operator' }) } as unknown as Scope,
    Date.now,
    {
      controlled: async () => assert.fail(),
      readable: async () => assert.fail(),
      stream: async (id) => (streamed.push(id), streams[id] ?? []),
      available: () => {},
    },
  );
  threads.blobs = {
    get: async () => assert.fail('a transcript is never read whole'),
    download: async (_namespace: string, hash: string, size: number) => {
      assert.equal(size, stored[hash]!.length);
      gets.push(hash);
      return { url: `https://blobs.test/${hash}`, expiresAt: '' };
    },
  } as unknown as Blobs;
  const fetching = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = fetching;
  });
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const bytes = stored[String(url).split('/').at(-1)!];
    if (!bytes) return new Response('missing', { status: 404 });
    const from = Number(/^bytes=(\d+)-$/.exec(new Headers(init.headers).get('range')!)![1]);
    return new Response(new Uint8Array(bytes.subarray(from)), { status: 206 });
  }) as typeof fetch;
  const parse = JSON.parse;
  let parsed = 0;
  JSON.parse = ((...args: Parameters<typeof parse>) => (parsed++, parse(...args))) as typeof parse;
  try {
    const out = await threads.conversation({ actorId: 'act_op', projectId: 'prj_1' }, 'thr_1');
    return { out, gets, streamed, parsed };
  } finally {
    JSON.parse = parse;
  }
}
/** Codex lines of one answer each, padded: `count` of them, ids `${name}0`… */
const codexTranscript = (name: string, count: number, pad = 0) =>
  Buffer.from(
    Array.from(
      { length: count },
      (_, index) =>
        `${JSON.stringify({
          type: 'item.completed',
          item: { id: `${name}${index}`, type: 'agent_message', text: `${name} ${index}` },
          pad: 'x'.repeat(pad),
        })}\n`,
    ).join(''),
  );
const said = (name: string, count: number): AgentStreamEvent[] =>
  Array.from({ length: count }, (_, index) => ({
    seq: index + 1,
    at: '2026-10-06T00:00:00.000Z',
    event: { kind: 'text', id: `${name}${index}`, delta: `${name} ${index}`, done: true },
  }));

test('a conversation read leaves live visits to their stream and reads nothing once its room is spent', async (t) => {
  const visit = (id: string, more: object = {}) => ({ id, ...more });
  // A busy live visit takes no room: the ended visits before it are read.
  const busy = await converse(
    t,
    [
      visit('ses_old', { sha256: 'a' }),
      visit('ses_streamed', { streamed: true }),
      visit('ses_live', { status: 'active', streamed: true }),
    ],
    {
      streams: { ses_streamed: said('s', 100), ses_live: said('l', 500) },
      stored: { a: codexTranscript('a', 50) },
    },
  );
  assert.deepEqual(
    busy.out.visits.map(({ sessionId, from, events }) => [sessionId, from, events.length]),
    [
      ['ses_old', 'transcript', 50],
      ['ses_streamed', 'stream', 100],
      ['ses_live', 'live', 0],
    ],
  );
  assert.deepEqual(busy.streamed, ['ses_streamed']);
  // Once a newer visit spends the room, an older one's stream or transcript is not read.
  const spent = await converse(
    t,
    [
      visit('ses_oldest', { sha256: 'a' }),
      visit('ses_older', { streamed: true }),
      visit('ses_new', { streamed: true }),
    ],
    {
      streams: { ses_older: said('o', 10), ses_new: said('n', 600) },
      stored: { a: codexTranscript('a', 50) },
    },
  );
  assert.deepEqual(
    spent.out.visits.map(({ sessionId, from, events }) => [sessionId, from, events.length]),
    [
      ['ses_oldest', 'transcript', 0],
      ['ses_older', 'stream', 0],
      ['ses_new', 'stream', 500],
    ],
  );
  assert.deepEqual([spent.streamed, spent.gets], [['ses_new'], []]);
});

test('a conversation read parses only the newest transcripts, from their end, to 500 events in all', async (t) => {
  const read = async (stored: Record<string, Buffer>) =>
    await converse(
      t,
      Object.keys(stored).map((hash) => ({ id: `ses_${hash}`, sha256: hash })),
      { stored },
    );
  const transcript = codexTranscript;
  const ids = (out: ThreadConversation) =>
    out.visits.map(({ sessionId, from, events }) => [
      sessionId,
      from,
      events.length,
      events[0]?.event.id,
      events.at(-1)?.event.id,
    ]);

  // The newest visit's 20 MB transcript alone fills the read: its end is parsed, nothing older.
  const large = await read({
    a: transcript('a', 300),
    b: transcript('b', 300),
    c: transcript('c', 60_000, 250),
  });
  assert.ok(large.gets.length === 1 && large.gets[0] === 'c');
  assert.ok(large.parsed < 15_000, String(large.parsed));
  assert.deepEqual(ids(large.out), [
    ['ses_a', 'transcript', 0, undefined, undefined],
    ['ses_b', 'transcript', 0, undefined, undefined],
    ['ses_c', 'transcript', 500, 'c59500', 'c59999'],
  ]);
  const events = large.out.visits[2]!.events;
  assert.deepEqual(events.at(-1), {
    seq: events.at(-1)!.seq,
    at: '2026-10-06T00:00:00.000Z',
    event: { kind: 'text', id: 'c59999', delta: 'c 59999', done: true },
  });
  assert.ok(events.every((event, index) => index === 0 || event.seq > events[index - 1]!.seq));

  // Newest first until 500: the newest visit whole, the one before it its newest 300.
  const spread = await read({
    a: transcript('a', 300),
    b: transcript('b', 400),
    c: transcript('c', 200),
  });
  assert.deepEqual(spread.gets, ['c', 'b']);
  assert.deepEqual(ids(spread.out), [
    ['ses_a', 'transcript', 0, undefined, undefined],
    ['ses_b', 'transcript', 300, 'b100', 'b399'],
    ['ses_c', 'transcript', 200, 'c0', 'c199'],
  ]);
});

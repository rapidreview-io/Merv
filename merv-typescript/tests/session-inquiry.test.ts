/**
 * Inquiry visits (`session.ask_thread`): a person asks any thread's agent, live, dormant or
 * retired, and a short read-only visit resumes its saved conversation, replies and stops. It
 * holds no lease on the work, never saves its conversation back, and spends a budget of its own.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { MervError, type Caller, type WorkflowPolicy } from '@merv/contracts';
import { MachineRunner } from '@merv/runner';
import { codexModelRelay, hostedGrant } from '../packages/fleet/src/codex-relay.js';
import { dormantMs } from '../packages/sessions/src/threads.js';
import {
  INQUIRY_DAILY_TOKENS,
  INQUIRY_TOKENS,
  INQUIRY_VISIT_SECONDS,
} from '../packages/sessions/src/inquiries.js';
import type { LeasedSessions } from '../packages/sessions/src/index.js';
import type {
  Session,
  SessionMessage,
  ThreadInquiry,
  ThreadMessages,
} from '../packages/sessions/src/types.js';
import type { ApplicationConfig } from '../src/config.js';
import { createApp } from './fixtures/app.js';
import { s3Blobs } from './fixtures/s3-blobs.js';

const secret = () => `ms_${randomBytes(32).toString('base64url')}`;
const CONVERSATION = '0199a0b2-1111-7222-8333-944445555666';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'merv-inquiry-'));
  const env = `MERV_INQUIRY_TEST_${randomUUID().replaceAll('-', '')}`;
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
      name: 'inquiry-test',
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
  const boot = await scope.credentials.bootstrap({ projectName: 'Inquiry', actorName: 'Owner' });
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
  const release = async (session: Session, body: object = {}) =>
    await ok('POST', `/sessions/${session.id}/release`, token, {
      runnerId: session.runnerId,
      ...body,
    });
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
    harness: 'claude' | 'codex' = 'claude',
  ) => {
    const bytes = Buffer.from(text);
    const facts = {
      harness,
      conversationId: CONVERSATION,
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
    await ok('POST', path, token, { ...control, ...facts, deliver: true });
    return { bytes, facts };
  };
  const start = async () =>
    await handle.start(owner, { workflow: 'inquiry-test', requestId: randomUUID() });
  /** A thread whose producer visit kept and delivered its conversation, then closed. */
  const worked = async (runnerId = 'runner-hand', harness: 'claude' | 'codex' = 'claude') => {
    const unit = await start();
    const first = await offer(unit.id, runnerId);
    await release(first.session);
    const kept = await keep(first.session, first.control, undefined, harness);
    return { unit, first, ...kept, threadId: first.session.threadId };
  };
  const threadRow = async (id: string) =>
    (await app.ctx.state.read((sql) =>
      sql.get<{
        status: string;
        sha256: string | null;
        latest_session_id: string | null;
        updated_at: string;
      }>('SELECT status,sha256,latest_session_id,updated_at FROM session_threads WHERE id=?', id),
    ))!;
  const ask = async (threadId: string, body: string, requestId: string = randomUUID()) =>
    (await ok('POST', `/sessions/threads/${threadId}/ask`, token, { body, requestId }))
      .inquiry as ThreadInquiry;
  /** A machine of the owner's that runs inquiry visits (or not), present to dispatch. */
  const present = async (
    runnerId: string,
    capabilities = ['inquiry.1', 'runner.2'],
    harness: 'claude' | 'codex' = 'claude',
  ) =>
    await ok('POST', '/sessions/runners/heartbeat', token, {
      runnerId,
      capabilities,
      machine: { hostname: 'Test host', system: 'Darwin', architecture: 'arm64' },
      platforms: [{ name: harness, harness, enabled: true, parallelism: 2 }],
      capacity: 2,
    });
  const lease = async (runnerId: string, harness: 'claude' | 'codex' = 'claude') => {
    const input = {
      runnerId,
      requestId: randomUUID(),
      secret: secret(),
      platform: { name: harness, harness },
    };
    const leased = (await ok('POST', '/sessions/lease', token, input)) as {
      session: Session | null;
      reason: string;
    };
    return { ...leased, input };
  };
  const messages = async (threadId: string) =>
    (await ok('GET', `/sessions/threads/${threadId}/messages`, token)) as ThreadMessages;
  const inquiry = async (id: string) =>
    (await app.ctx.state.read((sql) =>
      sql.get<{ status: string; tokens: number | string; session_id: string | null }>(
        'SELECT status,tokens,session_id FROM session_inquiries WHERE id=?',
        id,
      ),
    ))!;
  return {
    app,
    sessions,
    leased: sessions as unknown as LeasedSessions,
    token,
    owner,
    http,
    ok,
    offer,
    release,
    move,
    keep,
    start,
    worked,
    threadRow,
    ask,
    present,
    lease,
    messages,
    inquiry,
    age: async (ms: number) =>
      await app.ctx.state.transaction((tx) =>
        tx.run(
          "UPDATE session_threads SET updated_at=? WHERE status<>'retired'",
          new Date(Date.now() - ms).toISOString(),
        ),
      ),
    dispatch: async () => await sessions.dispatch.setDispatch(owner, { enabled: true }),
  };
}

test('an inquiry on a retired thread resumes its conversation read-only, replies, and leaves the thread as it was', async (t) => {
  const f = await fixture(t);
  const { unit, first, bytes, facts, threadId } = await f.worked();
  // The work ends and the thread retires: nothing will ever visit it again.
  await f.move(unit.id, 'submit');
  await f.move(unit.id, 'approve');
  await f.age(dormantMs + 1);
  await f.sessions.sweep();
  const before = await f.threadRow(threadId);
  assert.equal(before.status, 'retired');
  // It takes no message, since no visit will read one, but it may still be asked, once dispatch
  // is on to launch the visit that answers.
  const [listed] = await f.sessions.threads.list(f.owner, unit.id);
  assert.deepEqual([listed!.takesMessage, listed!.asks], [false, undefined]);
  await f.dispatch();
  const [askable] = await f.sessions.threads.list(f.owner, unit.id);
  assert.deepEqual([askable!.takesMessage, askable!.asks], [false, true]);

  const question = 'Which seed did you settle on, and why?';
  const asked = await f.ask(threadId, question, 'ask-1');
  assert.deepEqual(
    [asked.status, asked.threadId, asked.instanceId, asked.sessionId, asked.tokenBudget],
    ['queued', threadId, unit.id, null, INQUIRY_TOKENS],
  );
  // The same requestId answers the same inquiry; another body under it is refused.
  assert.equal((await f.ask(threadId, question, 'ask-1')).id, asked.id);
  const conflict = await f.http('POST', `/sessions/threads/${threadId}/ask`, f.token, {
    body: 'Something else',
    requestId: 'ask-1',
  });
  assert.deepEqual([conflict.status, conflict.body.error.code], [409, 'request_conflict']);

  // A machine that does not run inquiry visits is never offered one.
  await f.present('old-runner', ['runner.2']);
  assert.equal((await f.lease('old-runner')).session, null);
  // One that does takes it: the thread's actor and conversation, a short deadline, no lease.
  await f.present('runner-q');
  const leased = await f.lease('runner-q');
  const visit = leased.session!;
  assert.deepEqual(
    [visit.inquiry?.id, visit.inquiry?.messageId, visit.threadId, visit.actorId, visit.role],
    [asked.id, asked.messageId, threadId, first.session.actorId, 'reader'],
  );
  assert.deepEqual(visit.continuity?.resume, { sessionId: first.session.id, ...facts });
  assert.equal(visit.execution.policy.readOnly, true);
  assert.deepEqual(visit.execution.policy.tools, []);
  assert.ok(
    Date.parse(visit.hardDeadline) - Date.parse(visit.createdAt) <= INQUIRY_VISIT_SECONDS * 1000,
  );
  assert.equal((await f.inquiry(asked.id)).status, 'running');
  // Its runner attaches, is told it is an inquiry, and fetches the conversation it resumes.
  const control = { runnerId: 'runner-q', hostRef: `launch-${randomUUID()}` };
  const attached = await f.ok('POST', `/sessions/${visit.id}/attach`, f.token, control);
  assert.match(attached.prompt, /inquiry visit, not a work visit/);
  assert.doesNotMatch(attached.prompt, /session\.ask_owner/);
  const { download } = await f.ok('POST', `/sessions/${visit.id}/resume`, f.token, control);
  assert.deepEqual(Buffer.from(await (await fetch(download.url)).arrayBuffer()), bytes);

  // As its worker: the question, the project's reads, and nothing that writes but its reply.
  const worker = await f.sessions.authenticate(leased.input.secret);
  assert.equal(worker.session?.inquiry, true);
  const tools = (await f.app.ctx.tools.describe(worker)).map((tool) => tool.name);
  for (const name of ['session.message.ack', 'session.messages', 'workflow.status_and_next'])
    assert.ok(tools.includes(name), name);
  for (const name of ['session.ask_owner', 'session.message', 'usage.set_budget', 'submit'])
    assert.equal(tools.includes(name), false, name);
  const inbox = (await f.app.ctx.tools.invoke('session.messages', worker, {}))
    .value as SessionMessage[];
  assert.deepEqual(
    inbox.map((item) => [item.id, item.body]),
    [[asked.messageId, question]],
  );
  // It reads the project as the thread's actor, whom the retired thread no longer lets act.
  const status = (await f.app.ctx.tools.invoke('workflow.status_and_next', worker, {
    instanceId: unit.id,
  })) as { value: unknown };
  assert.ok(status.value);
  // A write is refused wherever it is tried, by the tool policy and by its authority alike.
  await assert.rejects(
    f.app.ctx.tools.invoke('session.message', worker, {
      threadId,
      body: 'x',
      requestId: 'x',
    }),
  );
  await assert.rejects(
    f.app.ctx.state.transaction((tx) => f.app.ctx.scope.require(worker, 'write', tx)),
    { code: 'inquiry_read_only' },
  );
  await assert.rejects(f.app.ctx.tools.invoke('session.ask_owner', worker, { question: 'x' }));
  // Its conversation is a fork: its runner may not declare it as the thread's.
  const declared = await f.http('POST', `/sessions/${visit.id}/conversation`, f.token, {
    ...control,
    ...facts,
  });
  assert.deepEqual([declared.status, declared.body.error.code], [409, 'conversation_unkept']);

  // The reply is the answer, and ends the visit by its own hand.
  const answer = 'Seed 17: the other two diverged in the first epoch.';
  const acked = (
    await f.app.ctx.tools.invoke('session.message.ack', worker, {
      messageId: asked.messageId,
      reply: answer,
      requestId: 'reply-1',
    })
  ).value as SessionMessage & { ended: boolean };
  assert.deepEqual([acked.reply, acked.ended], [answer, true]);
  const closed = await f.sessions.get(f.owner, visit.id);
  assert.deepEqual(
    [closed.status, closed.outcome, closed.closeReason],
    ['released', 'completed', 'inquiry_answered'],
  );
  assert.equal((await f.inquiry(asked.id)).status, 'answered');
  // The thread shows the question with its answer, as any message and its reply.
  const read = await f.messages(threadId);
  assert.deepEqual(
    read.messages.map((item) => [item.id, item.body, item.reply, item.inquiry]),
    [[asked.messageId, question, answer, { id: asked.id, status: 'answered' }]],
  );
  // Its visit is listed as an inquiry; the thread is exactly as it was: retired, its
  // conversation and latest visit unchanged, and no work ended nor any count against it.
  const [thread] = await f.sessions.threads.list(f.owner, unit.id);
  assert.deepEqual(
    thread!.visits.map((item) => [item.sessionId, item.inquiry ?? false]),
    [
      [first.session.id, false],
      [visit.id, true],
    ],
  );
  assert.deepEqual(await f.threadRow(threadId), before);
  const usage = await f.app.ctx.state.read((sql) =>
    sql.all('SELECT 1 FROM session_usage WHERE session_id=?', visit.id),
  );
  assert.deepEqual(usage, []);
  // Its runner's report of what it spent is charged to the inquiry, its asker's, not the work's.
  await f.release(visit, { usage: { inputTokens: 1200, outputTokens: 300 } });
  assert.equal(Number((await f.inquiry(asked.id)).tokens), 1500);
  assert.equal((await f.sessions.usage(f.owner, { instanceId: unit.id })).totals.sessions, 1);
});

test('an inquiry is refused for a thread with no saved conversation, and one at a time per thread', async (t) => {
  const f = await fixture(t);
  await f.dispatch();
  // A producer visit that kept nothing: a fresh agent would know nothing to answer with.
  const unit = await f.start();
  const fresh = await f.offer(unit.id);
  await f.release(fresh.session);
  const unkept = await f.http('POST', `/sessions/threads/${fresh.session.threadId}/ask`, f.token, {
    body: 'What did you do?',
    requestId: randomUUID(),
  });
  assert.deepEqual([unkept.status, unkept.body.error.code], [409, 'inquiry_unkept']);
  assert.equal((await f.sessions.threads.list(f.owner, unit.id))[0]!.asks, undefined);
  // A reviewer keeps no conversation either.
  await f.move(unit.id, 'submit');
  const review = await f.offer(unit.id);
  await f.release(review.session);
  const reviewer = await f.http(
    'POST',
    `/sessions/threads/${review.session.threadId}/ask`,
    f.token,
    { body: 'Why?', requestId: randomUUID() },
  );
  assert.deepEqual([reviewer.status, reviewer.body.error.code], [409, 'inquiry_unkept']);
  const missing = await f.http('POST', '/sessions/threads/thr_missing/ask', f.token, {
    body: 'Hello?',
    requestId: randomUUID(),
  });
  assert.deepEqual([missing.status, missing.body.error.code], [404, 'thread_not_found']);

  // One at a time: a second question waits for the first to be answered.
  const { threadId } = await f.worked();
  const asked = await f.ask(threadId, 'First question?');
  const busy = await f.http('POST', `/sessions/threads/${threadId}/ask`, f.token, {
    body: 'Second question?',
    requestId: randomUUID(),
  });
  assert.deepEqual([busy.status, busy.body.error.code], [409, 'inquiry_busy']);
  await f.present('runner-q');
  const leased = await f.lease('runner-q');
  assert.equal(leased.session?.inquiry?.id, asked.id);
  // Its thread has one live inquiry visit; the next lease finds no other question.
  assert.equal((await f.lease('runner-q')).session?.inquiry, undefined);
  const stillBusy = await f.http('POST', `/sessions/threads/${threadId}/ask`, f.token, {
    body: 'Second question?',
    requestId: randomUUID(),
  });
  assert.equal(stillBusy.body.error.code, 'inquiry_busy');
  const worker = await f.sessions.authenticate(leased.input.secret);
  await f.app.ctx.tools.invoke('session.message.ack', worker, {
    messageId: asked.messageId,
    reply: 'Answered.',
    requestId: 'r',
  });
  assert.equal((await f.ask(threadId, 'Second question?')).status, 'queued');
  // Only a person who may write asks; a leased worker may not.
  const work = await f.offer((await f.start()).id);
  const refused = await f.http('POST', `/sessions/threads/${threadId}/ask`, work.input.secret, {
    body: 'x',
    requestId: 'x',
  });
  assert.equal(refused.status, 403);
});

test('an inquiry has a deadline: unclaimed it expires, and its visit ends at its own', async (t) => {
  const f = await fixture(t);
  await f.dispatch();
  const { threadId } = await f.worked();
  const unclaimed = await f.ask(threadId, 'Anyone there?');
  assert.ok(Date.parse(unclaimed.waitUntil) - Date.parse(unclaimed.askedAt) <= 10 * 60_000);
  // As though nobody had taken it in its time.
  const lapse = (sql: string) =>
    f.app.ctx.state.transaction(async (tx) => {
      await tx.run('ALTER TABLE session_inquiries DISABLE TRIGGER session_inquiries_immutable');
      await tx.run('ALTER TABLE worker_sessions DISABLE TRIGGER worker_sessions_immutable');
      await tx.run(sql);
      await tx.run('ALTER TABLE session_inquiries ENABLE TRIGGER session_inquiries_immutable');
      await tx.run('ALTER TABLE worker_sessions ENABLE TRIGGER worker_sessions_immutable');
    });
  const past = new Date(Date.now() - 1000).toISOString();
  await lapse(`UPDATE session_inquiries SET wait_until='${past}' WHERE id='${unclaimed.id}'`);
  await f.present('runner-q');
  assert.equal((await f.lease('runner-q')).session?.inquiry, undefined);
  await f.sessions.sweep();
  assert.equal((await f.inquiry(unclaimed.id)).status, 'expired');
  // A visit past its hard deadline is closed by the sweep, its question unanswered by then.
  const asked = await f.ask(threadId, 'And now?');
  const leased = await f.lease('runner-q');
  const visit = leased.session!;
  assert.equal(visit.inquiry?.id, asked.id);
  await lapse(
    `UPDATE worker_sessions SET session_json=(session_json::jsonb || '{"expiresAt":"${past}","hardDeadline":"${past}"}'::jsonb)::text WHERE id='${visit.id}'`,
  );
  await f.sessions.sweep();
  const closed = await f.sessions.get(f.owner, visit.id);
  assert.deepEqual([closed.status, closed.closeReason], ['expired', 'session_expired']);
  assert.equal((await f.inquiry(asked.id)).status, 'expired');
  const read = await f.messages(threadId);
  assert.deepEqual(
    read.messages.map((item) => [item.reply, item.inquiry?.status]),
    [
      [null, 'expired'],
      [null, 'expired'],
    ],
  );
  // The thread may be asked again.
  assert.equal((await f.ask(threadId, 'Third time?')).status, 'queued');
});

test("an inquiry never blocks its work: the work's visit is offered alongside, resumes the head as it was, and reads the exchange", async (t) => {
  const f = await fixture(t);
  await f.dispatch();
  const { unit, first, facts, threadId } = await f.worked();
  const before = await f.threadRow(threadId);
  const question = 'What is left to do?';
  const asked = await f.ask(threadId, question);
  await f.present('runner-q');
  // The question goes first on a lease: a person waits on it, and it is short.
  const leased = await f.lease('runner-q');
  assert.equal(leased.session?.inquiry?.id, asked.id);
  // The work's own visit is offered meanwhile, on the same thread and the same conversation.
  const next = await f.lease('runner-q');
  const work = next.session!;
  assert.equal(work.inquiry, undefined);
  assert.deepEqual(
    [work.instanceId, work.threadId, work.actorId, work.continuity?.resume],
    [unit.id, threadId, first.session.actorId, { sessionId: first.session.id, ...facts }],
  );
  const [thread] = await f.sessions.threads.list(f.owner, unit.id);
  assert.equal(thread!.status, 'live');
  // The inquiry answers while the work runs; the work is unaffected.
  const inquirer = await f.sessions.authenticate(leased.input.secret);
  const answer = 'The ablation on the second dataset.';
  await f.app.ctx.tools.invoke('session.message.ack', inquirer, {
    messageId: asked.messageId,
    reply: answer,
    requestId: 'r',
  });
  assert.equal((await f.sessions.get(f.owner, work.id)).status, 'offered');
  // The head is not advanced by the inquiry: the thread still holds the first visit's
  // conversation for whatever visit comes next.
  const after = await f.threadRow(threadId);
  assert.deepEqual(
    [after.sha256, after.latest_session_id],
    [before.sha256, before.latest_session_id],
  );
  // The work's visit reads the exchange as a message to its thread, at its next Merv call, and
  // never the question itself, which was the inquiry's to answer.
  const worker = await f.sessions.authenticate(next.input.secret);
  await assert.rejects(f.app.ctx.tools.invoke('session.ask_owner', worker, { question: 'Now?' }), {
    code: 'session_message_pending',
  });
  const inbox = (await f.app.ctx.tools.invoke('session.messages', worker, {}))
    .value as SessionMessage[];
  assert.equal(inbox.length, 1);
  assert.ok(inbox[0]!.body.includes(question) && inbox[0]!.body.includes(answer));
  await f.app.ctx.tools.invoke('session.message.ack', worker, {
    messageId: inbox[0]!.id,
    reply: 'Noted.',
    requestId: 'noted',
  });
  // The person's read of the thread shows the question and its answer once.
  assert.deepEqual(
    (await f.messages(threadId)).messages.map((item) => [item.id, item.reply]),
    [[asked.messageId, answer]],
  );
});

test('an inquiry visit spends a budget of its own, charged to its asker through the model relay', async (t) => {
  const f = await fixture(t);
  await f.dispatch();
  const { threadId } = await f.worked();
  const asked = await f.ask(threadId, 'How much did it cost?');
  await f.present('runner-q');
  const visit = (await f.lease('runner-q')).session!;
  // Server-side, as Fleet's relay charges each call at its most and settles it.
  assert.equal(await f.sessions.inquiries.reserve(visit.id, INQUIRY_TOKENS + 1), false);
  assert.equal(await f.sessions.inquiries.reserve(visit.id, 100_000), true);
  await f.sessions.inquiries.settle(visit.id, -40_000);
  assert.equal(Number((await f.inquiry(asked.id)).tokens), 60_000);
  assert.equal(await f.sessions.inquiries.reserve(visit.id, INQUIRY_TOKENS - 60_000), true);
  assert.equal(await f.sessions.inquiries.reserve(visit.id, 1), false);
  // Any other session is not held to an inquiry's budget.
  const other = await f.offer((await f.start()).id);
  assert.equal(await f.sessions.inquiries.reserve(other.session.id, INQUIRY_TOKENS * 10), true);

  // Fleet's relay: an inquiry visit's grant charges its asker, and its own budget, call by call.
  const bound = {
    sessionId: visit.id,
    projectId: visit.projectId,
    allocationId: 'allocation_test',
    expiresAt: visit.hardDeadline,
    inquiry: { id: asked.id, asker: { kind: 'human' } as never },
  };
  const grant = hostedGrant(bound, 'person_asker', Date.now());
  assert.deepEqual([grant.person, grant.inquiry], ['person_asker', true]);
  const budget: string[] = [];
  const relay = codexModelRelay(f.app.ctx.state, {
    providerKey: () => 'key',
    dailyTokensPerPerson: 10_000_000,
    authorize: async () => grant,
    inquiries: {
      reserve: async (id, tokens) => (budget.push(`reserve ${id} ${tokens}`), false),
      settle: async (id, delta) => void budget.push(`settle ${id} ${delta}`),
    },
  });
  await assert.rejects(relay.reserve!(grant, { input: [] }), { code: 'inquiry_budget_spent' });
  assert.equal(budget.length, 1);
  assert.match(budget[0]!, new RegExp(`^reserve ${visit.id} \\d+$`));
});

test('a question holds its thread among those that want attention only while it is open, and the card says how it ended', async (t) => {
  const f = await fixture(t);
  await f.dispatch();
  const { threadId } = await f.worked();
  const listed = async () =>
    (await f.sessions.threads.project(f.owner)).threads.find((item) => item.id === threadId)!;
  assert.equal((await listed()).asks, true);
  const asked = await f.ask(threadId, 'Anyone there?');
  // Waiting for a machine: listed first, with no cursor, and asked no second question.
  const waiting = await listed();
  assert.equal(waiting.seq, undefined);
  assert.deepEqual(waiting.message?.inquiry, { id: asked.id, status: 'queued' });
  assert.equal(waiting.asks, undefined);
  // Nobody took it in time: its thread goes back among the rest, saying the question expired.
  const past = new Date(Date.now() - 1000).toISOString();
  await f.app.ctx.state.transaction(async (tx) => {
    await tx.run('ALTER TABLE session_inquiries DISABLE TRIGGER session_inquiries_immutable');
    await tx.run(`UPDATE session_inquiries SET wait_until='${past}' WHERE id='${asked.id}'`);
    await tx.run('ALTER TABLE session_inquiries ENABLE TRIGGER session_inquiries_immutable');
  });
  await f.sessions.sweep();
  const ended = await listed();
  assert.notEqual(ended.seq, undefined);
  assert.deepEqual(
    [ended.message?.id, ended.message?.acknowledgedAt, ended.message?.inquiry?.status],
    [asked.messageId, null, 'expired'],
  );
  assert.equal(ended.asks, true);
  // With dispatch off no machine would take a question, so none is offered.
  await f.sessions.dispatch.setDispatch(f.owner, { enabled: false });
  assert.equal((await listed()).asks, undefined);
});

test('a person’s questions spend at most a day’s tokens, and the project’s budget holds them back as it holds work', async (t) => {
  const f = await fixture(t);
  await f.dispatch();
  const a = await f.worked();
  const b = await f.worked();
  const asked = await f.ask(a.threadId, 'What did that cost?');
  await f.present('runner-q');
  const visit = (await f.lease('runner-q')).session!;
  assert.equal(visit.inquiry?.id, asked.id);
  assert.equal(visit.inquiry?.tokenBudget, INQUIRY_TOKENS);
  // A machine of the owner's reports what the visit spent once it ends.
  await f.release(visit, { usage: { inputTokens: INQUIRY_DAILY_TOKENS - 1000, outputTokens: 0 } });
  const spent = await f.http('POST', `/sessions/threads/${b.threadId}/ask`, f.token, {
    body: 'And this one?',
    requestId: randomUUID(),
  });
  assert.deepEqual([spent.status, spent.body.error.code], [429, 'inquiry_tokens_spent']);

  // A day later the person may ask again; a project budget that withholds work withholds it too.
  await f.app.ctx.state.transaction(async (tx) => {
    await tx.run('ALTER TABLE session_inquiries DISABLE TRIGGER session_inquiries_immutable');
    await tx.run(
      `UPDATE session_inquiries SET asked_at='${new Date(Date.now() - 86_400_001).toISOString()}' WHERE id='${asked.id}'`,
    );
    await tx.run('ALTER TABLE session_inquiries ENABLE TRIGGER session_inquiries_immutable');
  });
  const second = await f.ask(b.threadId, 'And this one?');
  const work = await f.offer((await f.start()).id);
  await f.sessions.authenticate(work.input.secret);
  await f.release(work.session, { usage: { inputTokens: 5, outputTokens: 5 } });
  await f.sessions.dispatch.setBudget(f.owner, { maxTokens: 1 });
  assert.equal((await f.lease('runner-q')).session, null);
  assert.equal((await f.inquiry(second.id)).status, 'queued');
  await f.sessions.dispatch.setBudget(f.owner, { maxTokens: null });
  assert.equal((await f.lease('runner-q')).session?.inquiry?.id, second.id);
});

test('a machine of the owner’s that runs Codex is offered no question: only Fleet’s relay holds its budget', async (t) => {
  const f = await fixture(t);
  await f.dispatch();
  const { threadId } = await f.worked('runner-hand', 'codex');
  const asked = await f.ask(threadId, 'Which seed?');
  await f.present('runner-codex', ['inquiry.1', 'runner.2'], 'codex');
  assert.equal((await f.lease('runner-codex', 'codex')).session?.inquiry, undefined);
  assert.equal((await f.inquiry(asked.id)).status, 'queued');
});

test('a refused question holds up no other, and a retried reply is told that it landed', async (t) => {
  const f = await fixture(t);
  await f.dispatch();
  const a = await f.worked();
  const b = await f.worked();
  const first = await f.ask(a.threadId, 'First?');
  const second = await f.ask(b.threadId, 'Second?');
  // This machine is refused the oldest question (as it would be by a check on that one alone).
  const leased = f.sessions as unknown as {
    inquireTransaction(...args: unknown[]): Promise<unknown>;
  };
  const inquire = leased.inquireTransaction.bind(leased);
  leased.inquireTransaction = async (...args: unknown[]) =>
    (args[1] as { id: string }).id === first.id
      ? { refused: new MervError('inquiry_refused', 'Refused for the test', 409) }
      : await inquire(...args);
  t.after(() => void (leased.inquireTransaction = inquire));
  await f.present('runner-q');
  const visit = await f.lease('runner-q');
  assert.equal(visit.session?.inquiry?.id, second.id);
  assert.equal((await f.inquiry(first.id)).status, 'queued');

  // Its reply ends the visit; the same reply again, its response lost, is told that it landed.
  const worker = await f.sessions.authenticate(visit.input.secret);
  const ack = { messageId: second.messageId, reply: 'Because.', requestId: 'reply' };
  await f.app.ctx.tools.invoke('session.message.ack', worker, ack);
  await assert.rejects(f.app.ctx.tools.invoke('session.message.ack', worker, ack), {
    code: 'inquiry_answered',
  });
});

test('the live feed shows a thread’s work, and its inquiry visit only while no work visit is live', async (t) => {
  const f = await fixture(t);
  await f.dispatch();
  const { threadId } = await f.worked();
  await f.ask(threadId, 'What is left?');
  await f.present('runner-q');
  const inquiry = (await f.lease('runner-q')).session!;
  const live = async () =>
    (await f.sessions.streams.feed(f.owner.projectId, new Map()))!.live.filter(
      (visit) => visit.threadId === threadId,
    );
  assert.deepEqual(
    (await live()).map((visit) => visit.sessionId),
    [inquiry.id],
  );
  const work = (await f.lease('runner-q')).session!;
  assert.equal(work.inquiry, undefined);
  assert.deepEqual(
    (await live()).map((visit) => visit.sessionId),
    [work.id],
  );
});

/** A stand-in Claude Code that answers an inquiry over Merv's MCP, as a resumed agent would. */
const inquiryAgent = (root: string) => {
  const path = join(root, 'inquiry-agent');
  writeFileSync(
    path,
    `#!/bin/sh\nexec "${process.execPath}" "${new URL('./fixtures/inquiry-agent.mjs', import.meta.url).pathname}" "$@"\n`,
  );
  chmodSync(path, 0o755);
  return path;
};

/** A machine of the owner's whose Claude Code is the stand-in, ticked until a question ends. */
async function machine(t: TestContext, f: Awaited<ReturnType<typeof fixture>>) {
  const root = await mkdtemp(join(tmpdir(), 'merv-inquiry-runner-'));
  const claudeHome = join(root, 'claude');
  mkdirSync(claudeHome);
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  const credentialEnv = `MERV_INQUIRY_RUNNER_${randomUUID().replaceAll('-', '')}`;
  process.env[credentialEnv] = f.token;
  const runner = new MachineRunner(
    {
      directory: join(root, 'machine'),
      baseUrl: f.app.ctx.api.url!,
      projectId: f.owner.projectId,
      credentialEnv,
      profiles: [
        {
          name: 'claude',
          harness: 'claude',
          executable: inquiryAgent(root),
          enabled: true,
          parallelism: 1,
        },
      ],
      capacity: 1,
      pollIntervalMs: 100,
      requestTimeoutMs: 5000,
    },
    { autoPoll: false },
  );
  t.after(async () => {
    await runner.stop();
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
    delete process.env[credentialEnv];
    await rm(root, { recursive: true, force: true });
  });
  const settled = async (inquiryId: string) => {
    for (let end = Date.now() + 30_000; ;) {
      await runner.tick();
      const snapshot = runner.snapshot();
      const { status } = await f.inquiry(inquiryId);
      if (
        status !== 'running' &&
        status !== 'queued' &&
        snapshot.launches.length &&
        snapshot.launches.every((launch) => !launch.releasePending)
      )
        return;
      assert.ok(Date.now() < end, JSON.stringify(snapshot));
      await delay(50);
    }
  };
  return { runner, claudeHome, settled };
}

test('real runners: a machine resumes a retired thread’s conversation read-only, answers, and keeps nothing', async (t) => {
  const f = await fixture(t);
  const { runner, claudeHome, settled } = await machine(t, f);
  const text = `{"type":"user","message":"the work so far ${randomUUID()}"}\n`;
  const unit = await f.start();
  const first = await f.offer(unit.id, 'runner-hand');
  await f.release(first.session);
  const { bytes } = await f.keep(first.session, first.control, text);
  await f.move(unit.id, 'submit');
  await f.move(unit.id, 'approve');
  await f.age(dormantMs + 1);
  await f.sessions.sweep();
  const threadId = first.session.threadId;
  const before_ = await f.threadRow(threadId);
  assert.equal(before_.status, 'retired');
  await f.dispatch();
  const asked = await f.ask(threadId, 'What did you conclude?');

  await runner.start();
  await settled(asked.id);
  const row = await f.inquiry(asked.id);
  assert.equal(row.status, 'answered');
  // What the agent saw: a resumed conversation, the bytes the thread kept, read-only tools and
  // a catalog that writes nothing but its reply, which it gave.
  const seen = JSON.parse(readFileSync(join(claudeHome, 'inquiry-agent.json'), 'utf8'));
  assert.equal(seen.resume, CONVERSATION);
  assert.equal(seen.restored, bytes.toString());
  assert.equal(seen.tools, 'Read,Glob,Grep');
  assert.equal(seen.forked, true);
  assert.equal(seen.inquiryPrompt, true);
  assert.equal(seen.writeRefused, true);
  assert.equal(seen.catalogWrites, false);
  const read = await f.messages(threadId);
  assert.deepEqual(
    read.messages.map((item) => [item.id, item.reply, item.inquiry?.status]),
    [[asked.messageId, 'I concluded the second method is better.', 'answered']],
  );
  // Nothing was saved back: the thread's conversation is the one it had, and the runner's
  // report of the spend is the inquiry's.
  assert.deepEqual(await f.threadRow(threadId), before_);
  assert.equal(Number(row.tokens), 4321);
  const record = runner.snapshot().launches[0]!;
  assert.equal(record.sessionId, row.session_id);
});

test('real runners: a machine stops an inquiry visit once what its agent printed of its spend passes the budget', async (t) => {
  const f = await fixture(t);
  const { runner, settled } = await machine(t, f);
  // Its work has ended, so the machine is offered nothing but the question.
  const { unit, threadId } = await f.worked();
  await f.move(unit.id, 'submit');
  await f.move(unit.id, 'approve');
  await f.dispatch();
  const asked = await f.ask(threadId, 'Spend as much as you like: why?');
  await runner.start();
  await settled(asked.id);
  const row = await f.inquiry(asked.id);
  assert.equal(row.status, 'unanswered');
  // What it spent so far, each model call's once, is reported to its asker's budget.
  assert.equal(Number(row.tokens), 401_050);
  const visit = await f.sessions.get(f.owner, row.session_id!);
  assert.deepEqual([visit.status, visit.closeReason], ['released', 'inquiry_budget_spent']);
});

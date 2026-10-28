/**
 * What Sessions says of what went wrong, once, where it happens: a worker's question to its
 * owner, a responder that failed one, a launch that failed, an offer passed over and a hold; and
 * what a case pins of a visit (`running.platformTrace`), read through a fake `issues` on ctx.
 */
import type { Caller } from '@merv/contracts';
import type { IssueReport, IssueTarget } from '@merv/contracts/issues';
import { PLATFORM_ACTOR } from '@merv/contracts/scope-models';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import type { LeasedSessions } from '../packages/sessions/src/index.js';
import type { Session, ThreadQuestion } from '../packages/sessions/src/types.js';
import { secret, twoStepWorkflow } from './fixtures/session-workflow.js';

async function fixture(t: TestContext) {
  const f = await twoStepWorkflow(t, 'issues', undefined, ['issues']);
  const reports: IssueReport[] = [];
  const resolved: IssueTarget[] = [];
  f.app.ctx.provide('issues', {
    report: (issue: IssueReport) => reports.push(issue),
    resolve: (target: IssueTarget) => resolved.push(target),
  });
  const sessions = f.sessions as LeasedSessions;
  const control = (visit: { session: Session; control: { runnerId: string } }) => ({
    sessionId: visit.session.id,
    runnerId: visit.control.runnerId,
  });
  /** A visit of new work whose agent asks its owner. */
  const asks = async (question: string) => {
    const unit = await f.start();
    const visit = await f.offer(unit.id);
    const worker = await sessions.authenticate(visit.input.secret);
    const value = (await f.app.ctx.tools.invoke('session.ask_owner', worker, { question }))
      .value as { question: ThreadQuestion };
    return { unit, visit, question: value.question };
  };
  /** A visit of new work that its runner reports failed, with the reason it gives. */
  const fails = async (reason: string, unit?: { id: string }) => {
    unit ??= await f.start();
    const visit = await f.offer(unit.id);
    await sessions.release(f.owner, { ...control(visit), outcome: 'launch_failed', reason });
    return { unit, visit };
  };
  /** The runner's declaration and delivery of a conversation, through its signed PUT. */
  const keep = async (visit: Awaited<ReturnType<typeof f.offer>>, text: string) => {
    const bytes = Buffer.from(text);
    const facts = {
      ...visit.control,
      harness: 'codex',
      conversationId: '0199a0b2-1111-7222-8333-944445555666',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
    };
    const path = `/sessions/${visit.session.id}/conversation`;
    await f.ok('POST', path, f.token, facts);
    const { upload } = (await f.ok('POST', path, f.token, { ...facts, deliver: true }))
      .conversation;
    await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: bytes });
    await f.ok('POST', path, f.token, { ...facts, deliver: true });
    return { sha256: facts.sha256, size: facts.size };
  };
  const at = (where: string) => reports.filter((issue) => issue.where === where);
  const said = (where: string) =>
    at(where).map((issue) => [issue.code, issue.level, issue.key ?? issue.subject]);
  return { ...f, sessions, reports, resolved, asks, fails, keep, control, at, said };
}
const settled = (id: string) =>
  ['asked', 'needs_you'].map((code) => ({
    class: 'question',
    where: 'session.ask_owner',
    code,
    key: id,
  }));

test('a question is said once to its owner, a notice while a responder takes it, and resolved by the answer', async (t) => {
  const f = await fixture(t);
  const { unit, visit, question } = await f.asks('Which cohort?');
  assert.deepEqual(f.at('session.ask_owner'), [
    {
      class: 'question',
      where: 'session.ask_owner',
      code: 'asked',
      key: question.id,
      level: 'severe',
      note: 'Which cohort?',
      refs: {
        projectId: f.owner.projectId,
        sessionId: visit.session.id,
        threadId: visit.session.threadId,
        instanceId: unit.id,
        revision: question.revision,
        questionId: question.id,
      },
    },
  ]);
  await f.ok('POST', `/sessions/threads/${question.threadId}/messages`, f.token, {
    body: 'The 2024 one.',
    requestId: randomUUID(),
  });
  assert.deepEqual(f.resolved, settled(question.id));

  const dispose = f.sessions.messaging.registerResponder({
    name: 'fixture',
    label: 'Fixture',
    start: async () => {},
    inspect: async () => null,
  });
  const taken = await f.asks('Which split?');
  assert.deepEqual(f.said('session.ask_owner').at(-1), ['asked', 'notice', taken.question.id]);
  await dispose();
});

test('a question its work moved past is settled by the next pass, whether it reached its owner or no responder took it', async (t) => {
  const f = await fixture(t);
  const unanswered = await f.asks('Which cohort?');
  const dispose = f.sessions.messaging.registerResponder({
    name: 'fixture',
    label: 'Fixture',
    start: async () => {
      throw new Error('The responder broke');
    },
    inspect: async () => null,
  });
  const sweep = () => f.sessions.messaging.responders.sweep();
  const failed = await f.asks('Which split?');
  await sweep();
  await dispose();
  assert.deepEqual(f.said('session.ask_owner').at(-1), ['needs_you', 'severe', failed.question.id]);
  await sweep();
  assert.deepEqual(f.resolved, [], 'a question that stands stays open');
  for (const { unit } of [unanswered, failed]) await f.move(unit.id, 'submit');
  await sweep();
  await sweep();
  const order = (targets: { key?: string; code: string }[]) =>
    targets.map((target) => `${target.key} ${target.code}`).sort();
  assert.deepEqual(
    order(f.resolved),
    order([...settled(unanswered.question.id), ...settled(failed.question.id)]),
  );
});

test('each responder fallback brings the question to its owner and says why; Pi’s own needs_you says no fault', async (t) => {
  const f = await fixture(t);
  const conversations = new Set<string>();
  t.after(
    f.app.ctx.scope.registerConversationAuthority({
      require: async () => ({
        actorId: f.owner.actorId,
        projectId: f.owner.projectId,
        kind: 'actor',
        credentialId: f.owner.credentialId!,
        expiresAt: null,
      }),
    }),
  );
  const dispose = f.sessions.messaging.registerResponder({
    name: 'fixture',
    label: 'Fixture',
    start: async ({ question, attach }) => {
      if (question.question === 'fails') throw new Error('The responder broke');
      if (question.question === 'silent') {
        // Ten silent seconds, at once: the race's timer is the only one made before it ticks.
        t.mock.timers.enable({ apis: ['setTimeout'] });
        setImmediate(() => (t.mock.timers.tick(10_000), t.mock.timers.reset()));
        return await new Promise<void>(() => {});
      }
      conversations.add(question.id);
      await attach({ id: question.id, route: `/fixture/${question.id}` });
    },
    inspect: async () => null,
  });
  const sweep = () => f.sessions.messaging.responders.sweep();
  const ids: string[] = [];
  for (const asked of ['fails', 'silent', 'late', 'pi', 'kept']) {
    const { question } = await f.asks(asked);
    ids.push(question.id);
    await sweep();
    if (asked === 'late') {
      const past = new Date(Date.now() - 1000).toISOString();
      await f.app.ctx.state.transaction((tx) =>
        tx.run(
          'UPDATE session_question_responses SET deadline=?,check_at=? WHERE question_id=?',
          past,
          past,
          question.id,
        ),
      );
      await sweep();
    }
    if (asked === 'pi')
      await f.sessions.messaging.resolve(
        {
          actorId: f.owner.actorId,
          projectId: f.owner.projectId,
          conversation: { id: question.id, epoch: 1, commandId: 'command', runtimeId: 'runtime' },
        },
        {
          questionId: question.id,
          expectedRevision: question.revision,
          outcome: 'needs_you',
          body: 'Only you can choose.',
          requestId: randomUUID(),
        },
      );
  }
  await dispose();
  assert.deepEqual(
    f.said('session.ask_owner').filter(([code]) => code === 'needs_you'),
    ids.map((id) => ['needs_you', 'severe', id]),
  );
  assert.deepEqual(
    f.at('sessions.question_responder').map((issue) => [issue.code, issue.level, issue.subject]),
    [
      ['responder_failed', 'severe', ids[0]],
      ['responder_silent', 'severe', ids[1]],
      ['responder_deadline', 'severe', ids[2]],
      ['responder_unloaded', 'severe', ids[4]],
    ],
  );
});

test('a failed launch is said by its code, a stop without a handoff is its owner’s question, and a stream outlives only an uploaded transcript', async (t) => {
  const f = await fixture(t);
  const failed = await f.fails('exit code 1: the worker died');
  const stopped = await f.fails('local_process_exit_code_0_without_handoff');
  assert.deepEqual(f.at('sessions.launch'), [
    {
      class: 'platform',
      where: 'sessions.launch',
      code: 'launch_failed',
      key: 'other',
      subject: `${failed.unit.id}@0`,
      refs: {
        projectId: f.owner.projectId,
        sessionId: failed.visit.session.id,
        threadId: failed.visit.session.threadId,
        instanceId: failed.unit.id,
        revision: 0,
        runnerId: 'runner',
        hostRef: failed.visit.control.hostRef,
      },
    },
  ]);
  assert.deepEqual(f.said('session.stopped'), [
    ['stopped_without_handoff', undefined, `${stopped.unit.id}@0`],
  ]);

  // Both ended over 30 days ago, as the sweep's clock has it; only one's transcript reached the store.
  await f.app.ctx.state.transaction(async (tx) => {
    for (const { visit } of [failed, stopped])
      await tx.run(
        `INSERT INTO session_events(session_id,seq,at,until,event) VALUES(?,1,?,0,'{"kind":"text"}'::jsonb)`,
        visit.session.id,
        new Date().toISOString(),
      );
    await tx.run(
      `INSERT INTO session_transcripts(session_id,project_id,workflow,role,runner_id,host_ref,sha256,size,log_bytes,truncated,declared_at,uploaded_at)
        VALUES(?,?,'issues-test','producer','runner',?,?,1,1,0,?,?)`,
      failed.visit.session.id,
      f.owner.projectId,
      failed.visit.control.hostRef,
      'a'.repeat(64),
      new Date().toISOString(),
      new Date().toISOString(),
    );
  });
  Object.assign(f.sessions.streams, { clock: () => Date.now() + 31 * 86_400_000 });
  await f.sessions.streams.prune();
  assert.deepEqual(
    await f.app.ctx.state.read((sql) => sql.all('SELECT session_id FROM session_events')),
    [{ session_id: stopped.visit.session.id }],
  );
});

test('a hold is said by its last code, never its message, and resolved by its release and by the dispatch switch', async (t) => {
  const f = await fixture(t);
  const unit = await f.start();
  const hold = async () => {
    for (let attempt = 0; attempt < 5; attempt++) await f.fails('exit code 1: secret', unit);
  };
  await hold();
  const [held] = f.at('dispatch.launch_held');
  assert.deepEqual(held, {
    class: 'platform',
    where: 'dispatch.launch_held',
    code: 'launch_held',
    key: unit.id,
    level: 'severe',
    subject: `${unit.id}@0`,
    refs: {
      projectId: f.owner.projectId,
      instanceId: unit.id,
      revision: 0,
      sessionId: held!.refs!.sessionId,
      subjectId: 'launch_failed',
    },
  });
  assert.doesNotMatch(JSON.stringify(f.reports), /secret/);
  const target = {
    class: 'platform',
    where: 'dispatch.launch_held',
    code: 'launch_held',
    key: unit.id,
  };
  await f.sessions.dispatch.releaseHold(f.owner, {
    instanceId: unit.id,
    expectedRevision: 0,
    reason: 'Fixed the image',
    requestId: randomUUID(),
  });
  assert.deepEqual(f.resolved, [target]);
  await hold();
  assert.equal(f.at('dispatch.launch_held').length, 2);
  // A boot says again a hold that stands, and withdraws one its work has moved past.
  await f.sessions.dispatch.initialize();
  assert.equal(f.at('dispatch.launch_held').length, 3);
  await f.move(unit.id, 'submit');
  await f.sessions.dispatch.initialize();
  assert.equal(f.at('dispatch.launch_held').length, 3);
  assert.deepEqual(f.resolved, [target, target]);
  await hold();
  await f.sessions.dispatch.setDispatch(f.owner, { enabled: true });
  await f.sessions.dispatch.setDispatch(f.owner, { enabled: false });
  assert.deepEqual(f.resolved, [target, target, target]);
});

test('an offer that cannot be built for a server fault is said once from its lease, then passed over', async (t) => {
  const f = await fixture(t);
  const runnerId = 'machine';
  const platform = { name: 'codex', harness: 'codex' as const, model: 'fixture-model' };
  await f.sessions.dispatch.heartbeatRunner(f.owner, {
    runnerId,
    machine: { hostname: 'fixture', system: 'test', architecture: 'test' },
    platforms: [{ ...platform, enabled: true, parallelism: 1 }],
    capacity: 1,
  });
  await f.sessions.dispatch.setDispatch(f.owner, { enabled: true });
  const unit = await f.start();
  t.mock.method(f.sessions.dispatch.hooks, 'offer', async () => {
    throw new TypeError('Cannot read the recipe');
  });
  for (let poll = 0; poll < 3; poll++)
    await f.sessions.dispatch.lease(f.owner, {
      runnerId,
      requestId: randomUUID(),
      secret: secret(),
      platform,
    });
  assert.deepEqual(
    f.at('dispatch.offer_failed').map(({ error: _error, ...issue }) => issue),
    [
      {
        class: 'platform',
        where: 'dispatch.offer_failed',
        code: 'unexpected',
        status: 500,
        subject: unit.id,
        refs: { projectId: f.owner.projectId, instanceId: unit.id, revision: 0 },
      },
    ],
  );
});

test('a case pins a visit’s conversation after the next visit took it over, and a platform reader reads it', async (t) => {
  const f = await fixture(t);
  const { unit, visit: first, question } = await f.asks('Which cohort?');
  const conversation = await f.keep(first, '{"type":"user","text":"first"}\n');
  await f.sessions.release(f.owner, f.control(first));
  await f.ok('POST', `/sessions/threads/${question.threadId}/messages`, f.token, {
    body: 'The 2024 one.',
    requestId: randomUUID(),
  });
  const second = await f.offer(unit.id);
  assert.equal(second.session.continuity?.resume?.sessionId, first.session.id);
  const pinned = async () => await f.sessions.running.platformTrace([first.session.id]);
  const before = (await pinned()).get(first.session.id)!;
  const later = await f.keep(second, '{"type":"user","text":"second"}\n');
  // Its checkout as attached, and as captured.
  await f.app.ctx.state.transaction((tx) =>
    tx.run(
      'INSERT INTO session_workspaces(session_id,attachment_json,result_json) VALUES(?,?,?)',
      first.session.id,
      JSON.stringify({ branch: 'merv/work', baseOid: 'a'.repeat(40), headOid: 'a'.repeat(40) }),
      JSON.stringify({ headOid: 'b'.repeat(40), treeOid: 'c'.repeat(40) }),
    ),
  );
  const traces = await f.sessions.running.platformTrace([first.session.id, second.session.id]);
  const { createdAt, closedAt, ...trace } = traces.get(first.session.id)!;
  assert.ok(createdAt && closedAt);
  assert.deepEqual(trace, {
    projectId: f.owner.projectId,
    threadId: first.session.threadId,
    instanceId: unit.id,
    revision: 0,
    role: 'producer',
    harness: 'codex',
    status: 'released',
    outcome: 'asked_owner',
    closeReason: 'asked_owner',
    runnerId: 'runner',
    hostRef: first.control.hostRef,
    conversation,
    workspace: {
      branch: 'merv/work',
      baseOid: 'a'.repeat(40),
      headOid: 'b'.repeat(40),
      treeOid: 'c'.repeat(40),
    },
  });
  assert.deepEqual(before.conversation, conversation, 'the thread’s own while it is the latest');
  assert.deepEqual(traces.get(second.session.id)!.conversation, later);
  assert.deepEqual(await f.sessions.running.platformTrace([]), new Map());
  // A halt's reason in words is not pinned.
  await f.sessions.dispatch.halt(f.owner, { sessionId: second.session.id, reason: 'Stop sk-1' });
  const [halted] = (await f.sessions.running.platformTrace([second.session.id])).values();
  assert.deepEqual([halted!.outcome, halted!.closeReason], ['halted', undefined]);

  // A platform administrator reads what agents say, as an operator does; a reader does not.
  const require = f.app.ctx.scope.require.bind(f.app.ctx.scope);
  t.mock.method(f.app.ctx.scope, 'require', async (...args: Parameters<typeof require>) =>
    args[0].actorId === PLATFORM_ACTOR
      ? { id: PLATFORM_ACTOR, projectId: args[0].projectId, name: 'Platform', role: 'reader' }
      : await require(...args),
  );
  const platform: Caller = {
    actorId: PLATFORM_ACTOR,
    projectId: f.owner.projectId,
    platform: { issuer: 'fixture', subject: 'admin', expiresAt: new Date().toISOString() },
  };
  const read = await f.sessions.threads.conversation(platform, first.session.threadId!);
  assert.deepEqual(
    read.visits.map((item) => item.sessionId),
    [first.session.id, second.session.id],
  );
  const reader = await f.app.ctx.scope.credentials.issueActor(f.owner, {
    name: 'Reader',
    role: 'reader',
  });
  await assert.rejects(
    f.sessions.threads.conversation(
      {
        actorId: reader.actor.id,
        projectId: f.owner.projectId,
        credentialId: reader.credential.id,
      },
      first.session.threadId!,
    ),
    { code: 'forbidden' },
  );
});

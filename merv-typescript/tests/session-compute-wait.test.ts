/**
 * A worker's wait for its Sandboxes compute (`session.await_compute`) on the default composition:
 * its visit ends uncounted, dispatch withholds the work until the wait settles, and the work comes
 * back to the same conversation, its next visit told first how the wait went. A fake waiter
 * stands in for Sandboxes.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { runningKey, type Caller, type Data } from '@merv/contracts';
import type { LeasedSessions } from '../packages/sessions/src/index.js';
import type {
  ComputeStates,
  ComputeTarget,
  ComputeTargetState,
  ComputeWaitView,
  Session,
} from '../packages/sessions/src/types.js';
import { secret, twoStepWorkflow } from './fixtures/session-workflow.js';

type Answer = Omit<ComputeTargetState, 'kind' | 'id'>;
const succeeded: Answer = { status: 'succeeded', state: 'succeeded', exitCode: 0 };
const reason = 'Seeds 1 and 2 train on the A100; I compare their curves next.';

async function fixture(t: TestContext) {
  /** What the working step grants; its review only checks. */
  let granted: Record<string, string> = { computeKind: 'experiment', computeProfile: 'execute' };
  const base = await twoStepWorkflow(t, 'compute', (state) =>
    state === 'working' ? granted : { computeKind: 'experiment', computeProfile: 'check' },
  );
  const { app, sessions, token, owner, ok } = base;
  const leased = sessions as unknown as LeasedSessions;
  /** What the waiter says of each id; one it was not told of still runs. */
  const answers = new Map<string, Answer>();
  const asked: ComputeTarget[][] = [];
  let bounds: Omit<ComputeStates, 'targets'> = { idle: [] };
  let failure: Error | undefined;
  let linked: boolean | 'hung' = true;
  const waiter = {
    offers: async () => (linked === 'hung' ? await new Promise<boolean>(() => {}) : linked),
    states: async ({ targets }: { targets: readonly ComputeTarget[] }): Promise<ComputeStates> => {
      assert.equal(
        app.ctx.state.ambient,
        undefined,
        'Sandboxes is asked outside every transaction',
      );
      asked.push([...targets]);
      if (failure) throw failure;
      return {
        ...bounds,
        targets: targets.map((target) => ({
          ...target,
          ...(answers.get(target.id) ?? { status: 'running', state: 'running' }),
        })),
      };
    },
  };
  let unregister = sessions.computeWaits.register(waiter);
  const release = async (session: Session) =>
    await ok('POST', `/sessions/${session.id}/release`, token, { runnerId: session.runnerId });
  /** The runner's declaration and delivery of the conversation it kept. */
  const keep = async (session: Session, control: { runnerId: string; hostRef: string }) => {
    const bytes = Buffer.from(`{"type":"user","text":"${randomUUID()}"}\n`);
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
    await ok('POST', path, token, { ...control, ...facts, deliver: true });
  };
  /** A hand offer of the work's current step, attached, with the prompt its runner is sent. */
  const attach = async (instanceId: string, runnerId = 'runner') => {
    const { revision } = await app.ctx.workflows.get(owner, instanceId);
    const input = {
      instanceId,
      expectedRevision: revision,
      runnerId,
      requestId: randomUUID(),
      secret: secret(),
    };
    const session = await sessions.offer(owner, input);
    const control = { runnerId, hostRef: `launch-${randomUUID()}` };
    const { prompt } = await ok('POST', `/sessions/${session.id}/attach`, token, control);
    const worker = await sessions.authenticate(input.secret);
    return { session, control, prompt: prompt as string, worker };
  };
  const awaitCompute = async (worker: Caller, input: Data) =>
    (await app.ctx.tools.invoke('session.await_compute', worker, input)).value as {
      wait: ComputeWaitView;
      ended: true;
      next: string;
    };
  return {
    ...base,
    leased,
    answers,
    asked,
    release,
    keep,
    attach,
    awaitCompute,
    grant: (value: Record<string, string>) => {
      granted = value;
    },
    bound: (value: Omit<ComputeStates, 'targets'>) => {
      bounds = value;
    },
    fail: (error?: Error) => {
      failure = error;
    },
    link: (value: boolean | 'hung') => {
      linked = value;
    },
    unregister: () => unregister(),
    register: () => {
      unregister = sessions.computeWaits.register(waiter);
    },
    /** The revisions of the work automatic dispatch would offer now. */
    queued: async (instanceId: string) =>
      await app.ctx.state.transaction(async (tx) =>
        (await leased.dispatch.candidates(owner, tx)).queue
          .filter((item) => item.instanceId === instanceId)
          .map((item) => item.expectedRevision),
      ),
    waits: async (instanceId: string) =>
      await app.ctx.state.read((sql) =>
        sql.all<{
          session_id: string;
          targets_json: string;
          created_at: string;
          wait_until: string;
          settled_at: string | null;
          outcome: string | null;
        }>(
          'SELECT * FROM session_compute_waits WHERE instance_id=? ORDER BY _merv_rowid',
          instanceId,
        ),
      ),
    settled: async () =>
      (await app.ctx.state.events(owner.projectId)).filter(
        (event) => event.type === 'session.compute_settled',
      ),
    /** As though a wait had been made, or had been due, `ms` ago: its row refuses that. */
    age: async (column: 'created_at' | 'wait_until', sessionId: string, ms = 3_600_000) =>
      await app.ctx.state.transaction(async (tx) => {
        await tx.run(
          'ALTER TABLE session_compute_waits DISABLE TRIGGER session_compute_waits_immutable',
        );
        await tx.run(
          `UPDATE session_compute_waits SET ${column}=? WHERE session_id=?`,
          new Date(Date.now() - ms).toISOString(),
          sessionId,
        );
        await tx.run(
          'ALTER TABLE session_compute_waits ENABLE TRIGGER session_compute_waits_immutable',
        );
      }),
    blockers: async (instanceId: string) =>
      (await app.ctx.workflows.blockers(owner, instanceId)).map((item) => [
        item.provider,
        item.key,
        item.code,
        item.whose,
      ]),
    /** The owner's move on the work, as its gate answers Needs you. */
    yours: async (instanceId: string) =>
      (await app.ctx.workflows.overview(owner, undefined, { open: true })).workflows.find(
        (item) => item.instanceId === instanceId,
      )?.yours,
  };
}

test('a worker awaits its compute: its visit ends uncounted, the work is withheld, and it comes back to the same conversation told how its runs ended', async (t) => {
  const f = await fixture(t);
  const unit = await f.start();
  const { revision } = await f.app.ctx.workflows.get(f.owner, unit.id);
  const first = await f.attach(unit.id, 'runner-a');
  const threadId = first.session.threadId;
  const answer = await f.awaitCompute(first.worker, {
    jobIds: ['job_a'],
    workflowIds: ['pipe_b'],
    reason,
  });
  assert.equal(answer.ended, true);
  assert.deepEqual(answer.wait.targets, [
    { kind: 'job', id: 'job_a', status: 'running', state: 'running' },
    { kind: 'workflow', id: 'pipe_b', status: 'running', state: 'running' },
  ]);
  assert.equal(answer.wait.why, 'the default 1440 minutes');
  assert.ok(Math.abs(Date.parse(answer.wait.until) - Date.now() - 86_400_000) < 60_000);
  assert.deepEqual(f.asked, [
    [
      { kind: 'job', id: 'job_a' },
      { kind: 'workflow', id: 'pipe_b' },
    ],
  ]);
  // The visit ended as released, by its own hand, and nothing counts it against the work.
  const closed = await f.sessions.get(f.owner, first.session.id);
  assert.deepEqual(
    [closed.status, closed.outcome, closed.closeReason],
    ['released', 'awaited_compute', 'awaited_compute'],
  );
  const close = (await f.app.ctx.state.events(f.owner.projectId)).find(
    (event) => event.type === 'session.closed' && event.subjectId === first.session.id,
  )!;
  assert.equal((close.data as { ownEnd?: boolean }).ownEnd, true);
  assert.deepEqual(
    await f.app.ctx.state.read((sql) =>
      sql.all('SELECT * FROM session_dispatch_holds WHERE instance_id=?', unit.id),
    ),
    [],
  );
  // The work waits: withheld from dispatch, its gate and session.stuck say so (uncounted), the
  // Running board marks it, and it is nobody's move.
  assert.deepEqual(await f.queued(unit.id), []);
  assert.deepEqual(await f.blockers(unit.id), [
    ['session-compute', threadId, 'compute_wait', 'nobody'],
  ]);
  assert.equal(await f.yours(unit.id), undefined);
  const stuck = await f.sessions.dispatch.stuck(f.owner);
  assert.deepEqual(
    stuck.items.filter((item) => item.instanceId === unit.id).map((item) => item.kind),
    ['work_waiting'],
  );
  assert.deepEqual([stuck.total, stuck.counts.work_waiting], [0, 1]);
  const { marks } = await f.sessions.running.marks(f.owner);
  assert.deepEqual(
    marks.filter((mark) => mark.key === runningKey('work', unit.id)),
    [
      {
        key: runningKey('work', unit.id),
        says: ['Waiting for its compute'],
        quiet: true,
        to: { route: `/sessions?thread=${encodeURIComponent(threadId)}`, text: 'Open its thread' },
      },
    ],
  );
  // Its runner delivers the conversation and releases; one run ends, which the sweep records.
  await f.keep(first.session, first.control);
  await f.release(first.session);
  f.answers.set('job_a', succeeded);
  await f.sessions.sweep();
  const [open] = await f.waits(unit.id);
  assert.equal(open!.settled_at, null);
  assert.deepEqual(JSON.parse(open!.targets_json)[0], {
    kind: 'job',
    id: 'job_a',
    ...succeeded,
  });
  assert.deepEqual(f.asked.at(-1), [
    { kind: 'job', id: 'job_a' },
    { kind: 'workflow', id: 'pipe_b' },
  ]);
  // Then the other: the wait settles, and only what still ran was asked about.
  f.answers.set('pipe_b', { status: 'succeeded', state: 'completed' });
  await f.sessions.sweep();
  assert.deepEqual(f.asked.at(-1), [{ kind: 'workflow', id: 'pipe_b' }]);
  const [row] = await f.waits(unit.id);
  assert.equal(row!.outcome, 'ended');
  assert.equal((await f.settled()).length, 1);
  assert.deepEqual(await f.blockers(unit.id), []);
  assert.deepEqual(await f.queued(unit.id), [revision]);
  // The work comes back to the same thread and conversation, told first how its runs ended.
  const second = await f.attach(unit.id, 'runner-b');
  assert.deepEqual(
    [second.session.threadId, second.session.continuity?.resume?.sessionId],
    [threadId, first.session.id],
  );
  assert.equal(second.session.awaited?.outcome, 'ended');
  assert.equal(
    second.prompt.split('\n')[0],
    `Before anything else, read the results of the compute your last visit ended to wait for (session.await_compute at ${row!.created_at}: ${reason}): everything it named has ended, or one ended without succeeding: job job_a succeeded (exit 0); workflow pipe_b completed.`,
  );
  // It may wait again, and is told how.
  assert.match(second.prompt, /call session\.await_compute with their ids, and stop/);
  assert.match(
    second.prompt,
    /Do not end your turn without the handoff, session\.ask_owner or session\.await_compute\./,
  );
  assert.ok(
    (await f.app.ctx.tools.describe(second.worker)).some(
      (tool) => tool.name === 'session.await_compute',
    ),
  );
  await f.release(second.session);
  // A later visit at the same revision is told nothing of a wait it did not follow.
  const third = await f.attach(unit.id, 'runner-c');
  assert.equal(third.session.awaited, undefined);
  assert.doesNotMatch(third.prompt.split('\n')[0]!, /session\.await_compute/);
});

test('a wait withholds only its own revision: work moved on by any hand is offered, and the wait settles as moved', async (t) => {
  const f = await fixture(t);
  const unit = await f.start();
  const first = await f.attach(unit.id, 'runner-a');
  await f.awaitCompute(first.worker, { jobIds: ['job_a'], reason });
  await f.keep(first.session, first.control);
  assert.deepEqual(await f.queued(unit.id), []);
  await f.move(unit.id, 'submit');
  const { revision } = await f.app.ctx.workflows.get(f.owner, unit.id);
  assert.deepEqual(await f.queued(unit.id), [revision]);
  assert.deepEqual(await f.blockers(unit.id), []);
  const review = await f.attach(unit.id, 'runner-b');
  assert.equal(review.session.awaited, undefined);
  const before = f.asked.length;
  await f.leased.computeWaits.sweep();
  assert.equal((await f.waits(unit.id))[0]!.outcome, 'moved');
  assert.equal(f.asked.length, before, 'a moved wait asks Sandboxes nothing');
});

test('a settled wait waits for the visit’s conversation, or for the bound', async (t) => {
  const f = await fixture(t);
  const unit = await f.start();
  const { revision } = await f.app.ctx.workflows.get(f.owner, unit.id);
  const first = await f.attach(unit.id, 'runner-a');
  await f.awaitCompute(first.worker, { jobIds: ['job_a'], reason });
  f.answers.set('job_a', succeeded);
  await f.leased.computeWaits.sweep();
  assert.equal((await f.waits(unit.id))[0]!.outcome, 'ended');
  // Offered now, the work would resume a conversation that never called the wait.
  assert.deepEqual(await f.queued(unit.id), []);
  await f.keep(first.session, first.control);
  assert.deepEqual(await f.queued(unit.id), [revision]);
  // A visit whose conversation never arrives holds the work only for the bound.
  const second = await f.attach(unit.id, 'runner-b');
  await f.awaitCompute(second.worker, { jobIds: ['job_c'], reason });
  f.answers.set('job_c', succeeded);
  await f.leased.computeWaits.sweep();
  assert.deepEqual(await f.queued(unit.id), []);
  await f.age('created_at', second.session.id);
  assert.deepEqual(await f.queued(unit.id), [revision]);
});

test('its until brings the work back with its runs still running, and the visit is told so', async (t) => {
  const f = await fixture(t);
  const unit = await f.start();
  const { revision } = await f.app.ctx.workflows.get(f.owner, unit.id);
  const first = await f.attach(unit.id, 'runner-a');
  const { wait } = await f.awaitCompute(first.worker, {
    jobIds: ['job_a'],
    reason: 'Training.',
    minutes: 120,
  });
  assert.equal(wait.why, 'the 120 minutes asked for');
  await f.keep(first.session, first.control);
  assert.deepEqual(await f.queued(unit.id), []);
  // Its until is judged in dispatch's own read: the hold lifts at once, before any sweep.
  await f.age('wait_until', first.session.id, 1000);
  assert.deepEqual(await f.queued(unit.id), [revision]);
  const second = await f.attach(unit.id, 'runner-b');
  const [row] = await f.waits(unit.id);
  assert.equal(row!.outcome, 'deadline');
  assert.equal(second.session.awaited?.outcome, 'deadline');
  assert.equal(
    second.prompt.split('\n')[0],
    `Before anything else, check the compute your last visit ended to wait for (session.await_compute at ${row!.created_at}: Training.): its until, ${row!.wait_until}, came first, and at the last check job job_a running. Then go on, or await what still runs again.`,
  );
  assert.deepEqual(await f.blockers(unit.id), []);
});

test('a message to its thread ends the wait at once, and the next visit reads it first', async (t) => {
  const f = await fixture(t);
  const unit = await f.start();
  const { revision } = await f.app.ctx.workflows.get(f.owner, unit.id);
  const first = await f.attach(unit.id, 'runner-a');
  await f.awaitCompute(first.worker, { jobIds: ['job_a'], reason });
  await f.keep(first.session, first.control);
  await f.ok('POST', `/sessions/threads/${first.session.threadId}/messages`, f.token, {
    body: 'Stop the run: its data changed.',
    requestId: 'stop',
  });
  assert.equal((await f.waits(unit.id))[0]!.outcome, 'woken');
  assert.deepEqual(await f.queued(unit.id), [revision]);
  assert.deepEqual(await f.blockers(unit.id), []);
  const second = await f.attach(unit.id, 'runner-b');
  assert.equal(second.session.awaited?.outcome, 'woken');
  assert.match(
    second.prompt.split('\n')[0]!,
    /^Before anything else, read any message to your thread, then check the compute your last visit ended to wait for .*a person ended the wait at .*, with a message or by starting this visit, and at the last check job job_a running\./,
  );
  await assert.rejects(f.awaitCompute(second.worker, { jobIds: ['job_a'], reason }), {
    code: 'session_message_pending',
  });
});

test('a hand offer while the work waits ends the wait, and its visit is told how', async (t) => {
  const f = await fixture(t);
  const unit = await f.start();
  const first = await f.attach(unit.id, 'runner-a');
  await f.awaitCompute(first.worker, { jobIds: ['job_a'], reason });
  await f.keep(first.session, first.control);
  const second = await f.attach(unit.id, 'runner-b');
  assert.equal((await f.waits(unit.id))[0]!.outcome, 'woken');
  assert.equal(second.session.awaited?.outcome, 'woken');
  assert.deepEqual(await f.blockers(unit.id), []);
});

test('a message, the sweep and an offer that each find one wait give it one outcome and one event', async (t) => {
  const f = await fixture(t);
  const unit = await f.start();
  const first = await f.attach(unit.id, 'runner-a');
  await f.awaitCompute(first.worker, { jobIds: ['job_a'], reason });
  await f.keep(first.session, first.control);
  f.answers.set('job_a', succeeded);
  await f.ok('POST', `/sessions/threads/${first.session.threadId}/messages`, f.token, {
    body: 'Look at the loss curve first.',
    requestId: 'look',
  });
  await f.leased.computeWaits.sweep();
  await f.attach(unit.id, 'runner-b');
  assert.deepEqual(
    (await f.waits(unit.id)).map((row) => row.outcome),
    ['woken'],
  );
  assert.deepEqual(
    (await f.settled()).map((event) => (event.data as { outcome: string }).outcome),
    ['woken'],
  );
});

test('one run that fails ends the wait at once, and the visit it wakes is told which ended which way', async (t) => {
  const f = await fixture(t);
  const unit = await f.start();
  const first = await f.attach(unit.id, 'runner-a');
  await f.awaitCompute(first.worker, {
    jobIds: ['job_a', 'job_b'],
    workflowIds: ['pipe_c'],
    reason,
  });
  await f.keep(first.session, first.control);
  f.answers.set('job_a', { status: 'failed', state: 'failed', exitCode: 137 });
  await f.leased.computeWaits.sweep();
  assert.equal((await f.waits(unit.id))[0]!.outcome, 'ended');
  const second = await f.attach(unit.id, 'runner-b');
  assert.match(
    second.prompt.split('\n')[0]!,
    /: job job_a failed \(exit 137\); job job_b running; workflow pipe_c running\.$/,
  );
});

test('a wait lasts its minutes at most, ending 15 minutes before a machine its runs need is deleted or 10 after they must have ended', async (t) => {
  const f = await fixture(t);
  const unit = await f.start();
  const lease = new Date(Date.now() + 2 * 3_600_000).toISOString();
  f.bound({ idle: [], lease: { machine: 'sbx_a100', endsAt: lease } });
  let visit = await f.attach(unit.id);
  let { wait } = await f.awaitCompute(visit.worker, { jobIds: ['job_a'], reason });
  assert.deepEqual(
    [wait.until, wait.why],
    [
      new Date(Date.parse(lease) - 15 * 60_000).toISOString(),
      `15 minutes before machine sbx_a100 is deleted at ${lease}, as its lease ends`,
    ],
  );
  // The minutes asked for, where they come first.
  visit = await f.attach(unit.id);
  ({ wait } = await f.awaitCompute(visit.worker, { jobIds: ['job_a'], reason, minutes: 30 }));
  assert.equal(wait.why, 'the 30 minutes asked for');
  assert.ok(Math.abs(Date.parse(wait.until) - Date.now() - 30 * 60_000) < 60_000);
  // The latest deadline of what runs, where that comes first.
  const deadline = new Date(Date.now() + 3_600_000).toISOString();
  f.bound({
    idle: [],
    lease: { machine: 'sbx_a100', endsAt: lease },
    deadline: { target: { kind: 'job', id: 'job_a' }, at: deadline },
  });
  visit = await f.attach(unit.id);
  ({ wait } = await f.awaitCompute(visit.worker, { jobIds: ['job_a'], reason }));
  assert.deepEqual(
    [wait.until, wait.why],
    [
      new Date(Date.parse(deadline) + 10 * 60_000).toISOString(),
      `10 minutes after job job_a must have ended, at ${deadline}`,
    ],
  );
});

test('refusals leave the visit live and write nothing', async (t) => {
  const f = await fixture(t);
  const unit = await f.start();
  const visit = await f.attach(unit.id);
  const refused = async (
    input: Data,
    expected: { code: string; details?: unknown },
    setup?: () => unknown,
  ) => {
    f.answers.clear();
    f.bound({ idle: [] });
    f.fail();
    await setup?.();
    const head = await f.app.ctx.state.eventHead();
    await assert.rejects(f.awaitCompute(visit.worker, input), expected);
    assert.equal(await f.app.ctx.state.eventHead(), head, `${expected.code} wrote nothing`);
    assert.equal((await f.sessions.get(f.owner, visit.session.id)).status, 'active');
  };
  const invalid = { code: 'invalid_compute_wait' };
  await refused({ reason }, invalid);
  await refused({ jobIds: ['job_a'], workflowIds: ['job_a'], reason }, invalid);
  await refused(
    {
      jobIds: Array.from({ length: 11 }, (_, i) => `job_${i}`),
      workflowIds: Array.from({ length: 10 }, (_, i) => `pipe_${i}`),
      reason,
    },
    invalid,
  );
  await refused({ jobIds: ['job_a'], reason: '   ' }, invalid);
  await refused(
    { jobIds: ['job_x'], reason },
    { code: 'compute_target_unknown', details: { unknown: ['job_x'] } },
    () => f.answers.set('job_x', { status: 'unknown' }),
  );
  await refused({ jobIds: ['job_a'], reason }, { code: 'compute_ended' }, () =>
    f.answers.set('job_a', succeeded),
  );
  // One that already failed ends nothing to wait for: the rest are awaited by name.
  await refused({ jobIds: ['job_a', 'job_b'], reason }, { code: 'compute_ended' }, () =>
    f.answers.set('job_a', { status: 'failed', state: 'timed_out' }),
  );
  await refused(
    { jobIds: ['job_a'], reason },
    { code: 'compute_machines_idle', details: { machines: ['sbx_idle'] } },
    () => f.bound({ idle: ['sbx_idle'] }),
  );
  await refused({ jobIds: ['job_a'], reason }, { code: 'compute_lease_ending' }, () =>
    f.bound({
      idle: [],
      lease: { machine: 'sbx_a', endsAt: new Date(Date.now() + 19 * 60_000).toISOString() },
    }),
  );
  await refused({ jobIds: ['job_a'], reason }, { code: 'compute_overdue' }, () =>
    f.bound({
      idle: [],
      deadline: {
        target: { kind: 'job', id: 'job_a' },
        at: new Date(Date.now() - 6 * 60_000).toISOString(),
      },
    }),
  );
  await refused({ jobIds: ['job_a'], reason, minutes: 4 }, { code: 'compute_wait_short' });
  await refused({ jobIds: ['job_a'], reason }, { code: 'compute_unreachable' }, () =>
    f.fail(new Error('Sandboxes is away')),
  );
  // A message waiting refuses the call before Sandboxes is asked about anything.
  const asked = f.asked.length;
  await refused({ jobIds: ['job_a'], reason }, { code: 'session_message_pending' }, () =>
    f.ok('POST', `/sessions/threads/${visit.session.threadId}/messages`, f.token, {
      body: 'Wait for my review first.',
      requestId: 'review',
    }),
  );
  assert.equal(f.asked.length, asked);
});

test('a retry of a wait or a question whose answer was lost is told it was recorded, and to stop', async (t) => {
  const f = await fixture(t);
  const unit = await f.start();
  const first = await f.attach(unit.id, 'runner-a');
  await f.awaitCompute(first.worker, { jobIds: ['job_a'], reason });
  await assert.rejects(f.awaitCompute(first.worker, { jobIds: ['job_a'], reason }), {
    code: 'awaited_compute',
    status: 401,
    message: 'Your wait was recorded and this visit has ended; stop now',
  });
  const second = await f.attach(unit.id, 'runner-b');
  const ask = () =>
    f.app.ctx.tools.invoke('session.ask_owner', second.worker, { question: 'Which cohort?' });
  await ask();
  await assert.rejects(ask(), {
    code: 'asked_owner',
    status: 401,
    message: 'Your question was recorded and this visit has ended; stop now',
  });
});

test('only a work visit that keeps a conversation and executes on a project Sandboxes serves is offered session.await_compute, in its tools and its prompt', async (t) => {
  const f = await fixture(t);
  const offered = async (instanceId: string, runnerId: string) => {
    const visit = await f.attach(instanceId, runnerId);
    const tools = (await f.app.ctx.tools.describe(visit.worker)).map((tool) => tool.name);
    return {
      visit,
      offered: [
        tools.includes('session.await_compute'),
        visit.prompt.includes('session.await_compute'),
      ],
    };
  };
  const unit = await f.start();
  const producer = await offered(unit.id, 'runner-a');
  assert.deepEqual(producer.offered, [true, true]);
  await f.release(producer.visit.session);
  // A reviewer only checks: it is told nothing of it, and called by name it is refused.
  await f.move(unit.id, 'submit');
  const reviewer = await offered(unit.id, 'runner-b');
  assert.deepEqual(reviewer.offered, [false, false]);
  await assert.rejects(f.awaitCompute(reviewer.visit.worker, { jobIds: ['job_a'], reason }), {
    code: 'compute_wait_unavailable',
  });
  // A design's probes, a step with no compute kind, and a workflow that keeps the wait inside
  // its visits (`computeWait: 'inside'`) are offered nothing either.
  for (const granted of <Record<string, string>[]>[
    { computeKind: 'experiment', computeProfile: 'plan' },
    { computeProfile: 'execute' },
    { computeKind: 'experiment', computeProfile: 'execute', computeWait: 'inside' },
  ]) {
    f.grant(granted);
    assert.deepEqual((await offered((await f.start()).id, 'runner-c')).offered, [false, false]);
  }
  f.grant({ computeKind: 'experiment', computeProfile: 'execute' });
  // Nor is a project Sandboxes does not serve, or a deployment without a waiter.
  f.link(false);
  assert.deepEqual((await offered((await f.start()).id, 'runner-d')).offered, [false, false]);
  // Nor one whose Sandboxes does not answer: its attach and listing wait two seconds at most.
  f.link('hung');
  const asked = Date.now();
  assert.deepEqual((await offered((await f.start()).id, 'runner-g')).offered, [false, false]);
  assert.ok(Date.now() - asked < 8_000, 'the attach and the listing waited 2 s each at most');
  f.link(true);
  f.unregister();
  assert.deepEqual((await offered((await f.start()).id, 'runner-e')).offered, [false, false]);
  f.register();
  assert.throws(() => f.sessions.computeWaits.register({} as never), {
    code: 'compute_waiter_registered',
  });
  // A visit that keeps no conversation cannot wait.
  f.sessions.threads.register('compute-test', () => null);
  const unkept = await offered((await f.start()).id, 'runner-f');
  assert.deepEqual(unkept.offered, [false, false]);
  await assert.rejects(f.awaitCompute(unkept.visit.worker, { jobIds: ['job_a'], reason }), {
    code: 'compute_wait_unkept',
  });
});

test('the sweep goes on past a waiter that fails, and an unloaded one leaves every wait as it is', async (t) => {
  const f = await fixture(t);
  const unit = await f.start();
  const { revision } = await f.app.ctx.workflows.get(f.owner, unit.id);
  const first = await f.attach(unit.id, 'runner-a');
  await f.awaitCompute(first.worker, { jobIds: ['job_a'], reason });
  await f.keep(first.session, first.control);
  f.answers.set('job_a', succeeded);
  f.fail(new Error('Sandboxes is away'));
  await f.sessions.sweep();
  assert.equal((await f.waits(unit.id))[0]!.settled_at, null);
  f.fail();
  await f.sessions.sweep();
  assert.equal((await f.waits(unit.id))[0]!.outcome, 'ended');
  // Unloaded, the waiter settles nothing, and none is woken; until still brings the work back.
  const second = await f.attach(unit.id, 'runner-b');
  await f.awaitCompute(second.worker, { jobIds: ['job_c'], reason });
  await f.keep(second.session, second.control);
  f.unregister();
  f.answers.set('job_c', succeeded);
  await f.sessions.sweep();
  assert.equal((await f.waits(unit.id))[1]!.settled_at, null);
  assert.deepEqual(await f.queued(unit.id), []);
  await f.age('wait_until', second.session.id, 1000);
  assert.deepEqual(await f.queued(unit.id), [revision]);
});

test('Fleet’s demand leaves a waiting work out until its wait ends', async (t) => {
  const f = await fixture(t);
  await f.sessions.dispatch.setDispatch(f.owner, { enabled: true });
  const unit = await f.start();
  const demand = async () =>
    (
      await f.sessions.dispatch.dispatchDemand(f.owner, {
        platform: {
          name: 'codex',
          harness: 'codex',
          model: 'gpt',
          effort: 'medium',
          enabled: true,
          parallelism: 1,
        },
      })
    ).candidates.map((candidate) => candidate.instanceId);
  assert.deepEqual(await demand(), [unit.id]);
  const first = await f.attach(unit.id, 'runner-a');
  await f.awaitCompute(first.worker, { jobIds: ['job_a'], reason });
  await f.keep(first.session, first.control);
  assert.deepEqual(await demand(), []);
  f.answers.set('job_a', succeeded);
  await f.leased.computeWaits.sweep();
  assert.deepEqual(await demand(), [unit.id]);
});

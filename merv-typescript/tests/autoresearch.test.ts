/**
 * Autoresearch end to end on the default composition, with fake agents: each manager visit is a
 * real Sessions offer of the manager's `autoresearch` instance, and the test plays its agent by
 * calling the tools a leased manager is granted. Runs end by their owner's own moves.
 */
import type { AutoresearchService, AutoresearchStatus } from '@merv/autoresearch';
import type { Caller } from '@merv/contracts';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import type { LeasedSessions } from '../packages/sessions/src/index.js';
import type { Session, WorkerQueue } from '../packages/sessions/src/types.js';
import { waitForManagedCode } from './fixtures/managed-code.js';
import { twoStepWorkflow } from './fixtures/session-workflow.js';

async function fixture(t: TestContext) {
  const f = await twoStepWorkflow(t, 'autoresearch');
  const { app, owner, token, ok, sessions } = f;
  const service = app.ctx.autoresearch as unknown as AutoresearchService;
  // What Sandboxes says the round's compute has cost: the test sets it.
  // null: Sandboxes does not answer.
  let spent: number | null = 0;
  service.spendSource = {
    since: async () => {
      if (spent === null) throw new Error('Sandboxes is unreachable');
      return { usd: spent };
    },
  };
  await waitForManagedCode(app.ctx.codeWork, owner);
  const pump = async () => {
    await app.ctx.domainEvents.drain();
    const status = (await app.ctx.domainEvents.status()).find(
      (item) => item.id === 'autoresearch.wakes.v1',
    );
    assert.equal(status?.error ?? null, null, JSON.stringify(status));
  };
  const status = async (): Promise<AutoresearchStatus> =>
    (await app.ctx.tools.call('autoresearch.read:status', owner, {})) as AutoresearchStatus;
  const write = async (action: string, input: Record<string, unknown> = {}) =>
    (await app.ctx.tools.call(`autoresearch.write:${action}`, owner, {
      ...input,
      requestId: randomUUID(),
    })) as AutoresearchStatus;
  const queued = async (instanceId: string) =>
    await app.ctx.state.transaction(async (tx) =>
      (await (sessions as LeasedSessions).dispatch.candidates(owner, tx)).queue.some(
        (item) => item.instanceId === instanceId,
      ),
    );
  /** The runner's delivery of the visit's conversation, which the next visit resumes. */
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
    const put = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: bytes });
    assert.equal(put.status, 200);
    await ok('POST', path, token, { ...control, ...facts, deliver: true });
  };
  /**
   * One visit of the manager: offered as dispatch offers it, its agent played by `act` with the
   * manager's own credential, its conversation kept and its lease released.
   */
  const visit = async (
    managerId: string,
    act: (worker: Caller, session: Session) => Promise<void>,
  ) => {
    assert.equal(await queued(managerId), true, 'dispatch offers the manager');
    const offered = await f.offer(managerId);
    const worker = await sessions.authenticate(offered.input.secret);
    await act(worker, offered.session);
    await keep(offered.session, offered.control);
    await ok('POST', `/sessions/${offered.session.id}/release`, token, {
      runnerId: offered.session.runnerId,
    });
    await pump();
    return offered.session;
  };
  const experiment = async (worker: Caller, name: string) =>
    (await app.ctx.tools.call('experiment.create', worker, {
      name,
      intent: `Test ${name}.`,
      requestId: randomUUID(),
    })) as { id: string };
  const decide = async (
    worker: Caller,
    session: Session,
    note: string,
    next: 'wait' | 'end' = 'wait',
  ) =>
    await app.ctx.tools.call('autoresearch.decide', worker, {
      autoresearchId: session.instanceId,
      expectedRevision: session.expectedRevision,
      note,
      next,
      requestId: randomUUID(),
    });
  /** A run ends by its owner's hand: the experiment is marked failed, a final state. */
  const finish = async (experimentId: string) => {
    await app.ctx.experiments.transition(owner, {
      experimentId,
      expectedRevision: (await app.ctx.experiments.get(owner, experimentId)).workflow.revision,
      transition: 'mark_failed',
      evidence: { reason: 'The baseline did not reproduce on this data.' },
      requestId: randomUUID(),
    });
    await pump();
  };
  const yours = async (instanceId: string) =>
    (await app.ctx.workflows.overview(owner, undefined, { open: true })).workflows.find(
      (item) => item.instanceId === instanceId,
    )?.yours;
  return {
    ...f,
    service,
    setSpent: (usd: number | null) => void (spent = usd),
    pump,
    status,
    write,
    queued,
    visit,
    experiment,
    decide,
    finish,
    yours,
  };
}

test('autoresearch: the manager starts work, wakes on its end, stops at the cap and the wake limit', async (t) => {
  const f = await fixture(t);
  const { app, owner } = f;

  // Off by default: no manager, and nothing it would run.
  const before = await f.status();
  assert.equal(before.enabled, false);
  assert.equal(before.managerId, null);
  assert.equal(before.spend.capUsd, 20);
  assert.equal(before.wakes.limit, 20);

  const on = await f.write('configure', {
    enabled: true,
    goal: 'Find whether the baseline reproduces.',
    capUsd: 10,
    runEstimateUsd: 3,
    wakeLimit: 2,
  });
  assert.equal(on.enabled, true);
  assert.equal(on.state, 'managing');
  const managerId = on.managerId!;

  // 1. The manager's first visit starts an experiment and waits for it.
  let first!: Session;
  let firstRun!: string;
  first = await f.visit(managerId, async (worker, session) => {
    first = session;
    assert.match(session.assignment.brief, /autoresearch manager/);
    assert.match(session.assignment.brief, /This round starts now/);
    assert.match(session.assignment.brief, /Spent \$0\.00 of the \$10\.00 cap/);
    firstRun = (await f.experiment(worker, 'Baseline')).id;
    await f.decide(worker, session, 'Started the baseline experiment; waiting for it.');
  });
  let now = await f.status();
  assert.equal(now.state, 'waiting');
  assert.deepEqual(
    now.runs.map((run) => [run.id, run.workflow, run.finalState]),
    [[firstRun, 'experiment', null]],
  );
  assert.equal(await f.queued(managerId), false, 'a waiting manager is not dispatched');

  // 2. It finishes: the manager wakes in the same thread with the result, and schedules the next.
  f.setSpent(4);
  await f.finish(firstRun);
  now = await f.status();
  assert.equal(now.state, 'managing');
  assert.equal(now.wakes.used, 1);
  assert.equal(now.lines[0]!.kind, 'wake');
  let secondRun!: string;
  const second = await f.visit(managerId, async (worker, session) => {
    assert.equal(session.threadId, first.threadId, 'the same manager thread is resumed');
    assert.equal(session.actorId, first.actorId);
    assert.equal(session.continuity?.resume?.sessionId, first.id);
    assert.match(session.assignment.brief, /What woke you \(1 run ended\)/);
    assert.match(
      session.assignment.brief,
      new RegExp(`Experiment "Baseline" \\(${firstRun}\\) ended without success: state failed`),
    );
    assert.match(session.assignment.brief, /did not reproduce/);
    assert.match(session.assignment.brief, /Spent \$4\.00 of the \$10\.00 cap/);
    secondRun = (await f.experiment(worker, 'Ablation')).id;
    await f.decide(worker, session, 'Baseline failed to reproduce; started an ablation.');
  });
  assert.equal(second.threadId, first.threadId);
  now = await f.status();
  assert.equal(now.state, 'waiting');
  assert.equal(now.spend.committedUsd, 7);
  assert.deepEqual(
    now.lines.filter((line) => line.kind === 'decide').map((line) => line.text),
    [
      'Baseline failed to reproduce; started an ablation.',
      'Started the baseline experiment; waiting for it.',
    ],
  );

  // 3. The cap blocks a further run: nothing is created, and once nothing runs, Needs you asks.
  f.setSpent(8);
  await f.finish(secondRun);
  assert.equal((await f.status()).state, 'managing');
  await f.visit(managerId, async (worker, session) => {
    assert.match(session.assignment.brief, /No further run fits under the cap/);
    const experiments = (await app.ctx.experiments.list(owner)).length;
    await assert.rejects(f.experiment(worker, 'Third'), (error: Error & { code?: string }) => {
      assert.equal(error.code, 'autoresearch_cap_reached');
      assert.match(error.message, /Spent \$8\.00 of the \$10\.00 cap/);
      return true;
    });
    assert.equal((await app.ctx.experiments.list(owner)).length, experiments, 'nothing created');
    await f.decide(
      worker,
      session,
      'The ablation failed too; the cap leaves no room for a third run.',
    );
  });
  now = await f.status();
  assert.equal(now.state, 'paused');
  assert.equal(now.paused, 'cap');
  assert.equal(now.lines[0]!.kind, 'cap');
  assert.equal(await f.queued(managerId), false);
  const capAsk = await f.yours(managerId);
  assert.ok(capAsk, 'the cap is in Needs you');
  assert.equal(capAsk.blocker?.provider, 'autoresearch');
  assert.match(capAsk.ask ?? '', /raise the cap .* or end the round/);
  // Home reads the same: the manager's record, paused at the cap.
  const home = (await app.ctx.tools.call('ui.home', owner, {})) as {
    autoresearch: { id: string; paused: string }[];
  };
  assert.deepEqual(
    home.autoresearch.map((item) => [item.id, item.paused]),
    [[managerId, 'cap']],
  );

  // The person raises the cap, which is their answer: the manager goes on.
  now = await f.write('configure', { capUsd: 100, wakeLimit: 1 });
  assert.equal(now.state, 'managing');
  assert.equal(now.paused, null);
  assert.equal(await f.yours(managerId), undefined, 'answered, so no longer in Needs you');

  // 4. The wake limit: one automatic wake, then the loop waits for the person.
  let thirdRun!: string;
  await f.visit(managerId, async (worker, session) => {
    assert.match(session.assignment.brief, /One more run fits under the cap/);
    thirdRun = (await f.experiment(worker, 'Third')).id;
    await f.decide(worker, session, 'Cap raised; started a third experiment.');
  });
  await f.finish(thirdRun);
  now = await f.status();
  assert.equal(now.state, 'managing');
  assert.equal(now.wakes.used, 1);
  let fourthRun!: string;
  await f.visit(managerId, async (worker, session) => {
    fourthRun = (await f.experiment(worker, 'Fourth')).id;
    await f.decide(worker, session, 'Third done; started a fourth.');
  });
  await f.finish(fourthRun);
  now = await f.status();
  assert.equal(now.state, 'paused');
  assert.equal(now.paused, 'wake_limit');
  assert.equal(now.wakes.pending, 1, 'the update waits for the manager');
  assert.equal(await f.queued(managerId), false);
  assert.match((await f.yours(managerId))?.ask ?? '', /resume .* or write to the manager/);

  // The person speaks to the manager's thread: the count starts again and it reads the update.
  const sent = await f.ok('POST', `/sessions/threads/${first.threadId}/messages`, f.token, {
    body: 'Go on, but summarize after the next result.',
    requestId: randomUUID(),
  });
  await f.pump();
  now = await f.status();
  assert.equal(now.state, 'managing');
  assert.equal(now.wakes.used, 0);
  await f.visit(managerId, async (worker, session) => {
    assert.equal(session.threadId, first.threadId);
    assert.match(session.assignment.brief, new RegExp(`Experiment "Fourth" \\(${fourthRun}\\)`));
    const queue = (await app.ctx.tools.call('session.messages', worker, {})) as WorkerQueue;
    assert.equal(queue.messages[0]?.body, 'Go on, but summarize after the next result.');
    await app.ctx.tools.call('session.message.ack', worker, {
      messageId: sent.message.id,
      requestId: randomUUID(),
    });
    await app.ctx.tools.call('autoresearch.decide', worker, {
      autoresearchId: managerId,
      expectedRevision: session.expectedRevision,
      note: 'Four runs, none reproduced the baseline; ending the round.',
      next: 'end',
      summary: 'The baseline does not reproduce on this data under any of four variants.',
      requestId: randomUUID(),
    });
  });
  now = await f.status();
  assert.equal(now.state, 'idle');
  assert.equal(now.lines[0]!.kind, 'end');
  assert.match(now.lines[0]!.text, /does not reproduce/);
});

test('autoresearch: only the manager decides, and a person pauses and resumes it', async (t) => {
  const f = await fixture(t);
  // Turning it on takes a goal.
  await assert.rejects(f.write('configure', { enabled: true }), /goal/);
  const on = await f.write('configure', { enabled: true, goal: 'Map the failure modes.' });
  const managerId = on.managerId!;
  // A person cannot hand in the manager's decision.
  await assert.rejects(
    f.app.ctx.tools.call('autoresearch.decide', f.owner, {
      autoresearchId: managerId,
      expectedRevision: 0,
      note: 'x',
      next: 'wait',
      requestId: randomUUID(),
    }),
    /manager|not granted|session|worker/i,
  );
  // The manager cannot wait on nothing.
  let task!: string;
  await f.visit(managerId, async (worker, session) => {
    await assert.rejects(
      f.decide(worker, session, 'Nothing yet.'),
      /Nothing you started is running/,
    );
    // A task is scheduled through its own tool, as an experiment is.
    task = (
      (await f.app.ctx.tools.call('task.create', worker, {
        title: 'Collect the failing inputs',
        goal: 'Gather every input the model fails on.',
        checks: ['Every failing input is listed'],
        requestId: randomUUID(),
      })) as { id: string }
    ).id;
    await f.decide(worker, session, 'Started a task to collect failing inputs.');
  });
  assert.deepEqual(
    (await f.status()).runs.map((run) => [run.id, run.workflow]),
    [[task, 'task']],
  );
  // The task ends without success: its reason reaches the manager's next visit.
  await f.app.ctx.tasks.markFailed(f.owner, {
    taskId: task,
    expectedRevision: (await f.app.ctx.tasks.get(f.owner, task)).workflow.revision,
    reason: 'The failing inputs were never logged.',
    requestId: randomUUID(),
  });
  await f.pump();
  assert.equal((await f.status()).state, 'managing');
  // A real decision goes to the person: the visit ends with a question, and Needs you asks it.
  const asking = await f.visit(managerId, async (worker, session) => {
    assert.match(session.assignment.brief, /Task "Collect the failing inputs"/);
    assert.match(session.assignment.brief, /never logged/);
    await f.app.ctx.tools.call('session.ask_owner', worker, {
      question:
        'The inputs were never logged. Should I log them first, or probe the model directly?',
    });
  });
  assert.equal((await f.status()).state, 'managing');
  assert.equal(await f.queued(managerId), false, 'it waits for the answer');
  assert.equal((await f.yours(managerId))?.blocker?.provider, 'session-question');
  const answer = await f.ok('POST', `/sessions/threads/${asking.threadId}/messages`, f.token, {
    body: 'Probe it directly.',
    requestId: randomUUID(),
  });
  await f.pump();
  await f.visit(managerId, async (worker, session) => {
    assert.equal(session.threadId, asking.threadId);
    await f.app.ctx.tools.call('session.message.ack', worker, {
      messageId: answer.message.id,
      requestId: randomUUID(),
    });
    const run = (await f.experiment(worker, 'Probe')).id;
    assert.ok(run);
    await f.decide(worker, session, 'The person chose a direct probe; started it.');
  });
  let now = await f.write('pause');
  assert.equal(now.state, 'paused');
  assert.equal(now.paused, 'person');
  assert.equal(await f.yours(managerId), undefined, 'a person’s own pause asks nobody');
  now = await f.write('resume');
  assert.equal(now.state, 'managing');
  now = await f.write('configure', { enabled: false });
  assert.equal(now.enabled, false);
  assert.equal(now.managerId, null);
});

test('autoresearch: a run that ends while the manager waits on the person reaches its next visit', async (t) => {
  const f = await fixture(t);
  const on = await f.write('configure', { enabled: true, goal: 'Compare two baselines.' });
  const managerId = on.managerId!;
  let a!: string;
  let b!: string;
  await f.visit(managerId, async (worker, session) => {
    a = (await f.experiment(worker, 'Alpha')).id;
    b = (await f.experiment(worker, 'Beta')).id;
    await f.decide(worker, session, 'Started both baselines.');
  });
  await f.finish(a);
  // The manager asks the person; B ends meanwhile, while it is still managing.
  const asking = await f.visit(managerId, async (worker, session) => {
    assert.match(session.assignment.brief, /Experiment "Alpha"/);
    assert.doesNotMatch(session.assignment.brief, /Experiment "Beta"/);
    await f.app.ctx.tools.call('session.ask_owner', worker, { question: 'A failed. Keep B?' });
  });
  await f.finish(b);
  assert.equal((await f.status()).wakes.pending, 1);
  const answer = await f.ok('POST', `/sessions/threads/${asking.threadId}/messages`, f.token, {
    body: 'Yes, keep B.',
    requestId: randomUUID(),
  });
  await f.pump();
  await f.visit(managerId, async (worker, session) => {
    // Its brief reports B, which ended while it waited, not "no work ended".
    assert.match(session.assignment.brief, /What woke you \(2 runs ended\)/);
    assert.match(session.assignment.brief, new RegExp(`Experiment "Beta" \\(${b}\\) ended`));
    assert.doesNotMatch(session.assignment.brief, /No work ended/);
    await f.app.ctx.tools.call('session.message.ack', worker, {
      messageId: answer.message.id,
      requestId: randomUUID(),
    });
    // Both reports were read here, so nothing is left to wait for.
    await assert.rejects(f.decide(worker, session, 'Waiting.'), /Nothing you started is running/);
    await f.app.ctx.tools.call('autoresearch.decide', worker, {
      autoresearchId: managerId,
      expectedRevision: session.expectedRevision,
      note: 'Both baselines failed; ending the round.',
      next: 'end',
      summary: 'Neither baseline reproduced.',
      requestId: randomUUID(),
    });
  });
  const now = await f.status();
  assert.equal(now.state, 'idle');
  assert.equal(now.wakes.pending, 0);
});

test('autoresearch: when Sandboxes does not report the spend, the loop pauses and asks the person', async (t) => {
  const f = await fixture(t);
  const on = await f.write('configure', { enabled: true, goal: 'Probe the model.' });
  const managerId = on.managerId!;
  f.setSpent(null);
  await f.visit(managerId, async (worker, session) => {
    assert.match(session.assignment.brief, /an unknown amount/);
    await assert.rejects(f.experiment(worker, 'Probe'), (error: Error & { code?: string }) => {
      assert.equal(error.code, 'autoresearch_spend_unavailable');
      return true;
    });
    await f.decide(worker, session, 'Sandboxes did not report the spend; waiting for the person.');
  });
  let now = await f.status();
  assert.equal(now.state, 'paused');
  assert.equal(now.paused, 'cap');
  const ask = await f.yours(managerId);
  assert.equal(ask?.blocker?.provider, 'autoresearch');
  assert.match(ask?.ask ?? '', /resume .* once Sandboxes answers again/);
  // Sandboxes answers again; the person resumes and the manager goes on.
  f.setSpent(0);
  now = await f.write('resume');
  assert.equal(now.state, 'managing');
  assert.equal(await f.yours(managerId), undefined);
});

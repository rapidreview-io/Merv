import { currentTask, currentWork } from './fixtures/current-work.js';
import { confirmedDelivery, reviewedFindings } from './fixtures/task-evidence.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from './fixtures/app.js';
import { storedContext } from './fixtures/state.js';
import {
  check,
  type Caller,
  type Transaction,
  type WorkflowDefinition,
  type WorkflowPolicy,
} from '@merv/contracts';

test('a new program registers guidance and guards without engine cases; reads, preflight, disposal and revision fences agree', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-guidance-program-'));
  const app = await createApp({ directory });
  try {
    const a = await app.ctx.scope.bootstrap({ projectName: 'Calibration', actorName: 'Operator' });
    const caller = { actorId: a.actor.id, projectId: a.project.id };
    const graph: WorkflowDefinition = {
      name: 'calibration',
      version: 1,
      initial: 'setup',
      states: ['setup', 'done'],
      terminal: ['done'],
      edges: [{ from: 'setup', action: 'calibrate', to: 'done' }],
    };
    let instrumentReady = false;
    const policy: WorkflowPolicy = {
      actions: [
        {
          name: 'calibrate',
          states: ['setup'],
          transitions: ['calibrate'],
          tool: 'instrument.calibrate',
          instruction: 'Measure the instrument and submit its reading.',
          requiredInput: ['reading'],
          check: ({ input }) => {
            check(instrumentReady, 'instrument_missing', 'Connect the instrument first.', 409);
            if (input) check(input.reading === 10, 'bad_reading', 'The reference must read 10.');
          },
        },
      ],
    };
    const registration = await app.ctx.workflows.register(graph, policy);
    const instance = await registration.start(caller, {
      workflow: graph.name,
      requestId: 'start',
    });
    const before = await app.ctx.state.eventHead();
    const evaluate = async () => await app.ctx.workflows.evaluate(caller, instance.id);
    assert.equal((await evaluate()).nextAction, null);
    assert.equal((await evaluate()).blockers[0].code, 'instrument_missing');
    instrumentReady = true;
    assert.equal((await evaluate()).nextAction?.status, 'needs_input');
    const proposal = { reading: 10, expectedRevision: 0 };
    const query = { action: 'calibrate', input: { ...proposal } };
    const preflight = app.ctx.workflows.evaluate(caller, instance.id, query);
    query.action = 'changed';
    query.input.reading = 99;
    assert.equal((await preflight).nextAction?.status, 'ready');
    assert.equal(
      await app.ctx.state.eventHead(),
      before,
      'Guidance and preflight must not mutate state',
    );
    instrumentReady = false;
    await assert.rejects(
      async () =>
        await registration.transition(caller, {
          instanceId: instance.id,
          expectedRevision: 0,
          action: 'calibrate',
          requestId: 'act',
          input: proposal,
        }),
      { code: 'instrument_missing' },
    );
    assert.equal((await app.ctx.workflows.get(caller, instance.id)).revision, 0);
    assert.equal(await app.ctx.state.eventHead(), before);
    registration.dispose();
    assert.equal((await evaluate()).available, false);
    assert.equal((await evaluate()).currentGate, 'workflow_unavailable');
    assert.deepEqual((await app.ctx.workflows.overview(caller)).unavailable, [instance.id]);
    const reloaded = await app.ctx.workflows.register(graph, policy);
    registration.dispose(); // An old disposer cannot remove the new registration.
    instrumentReady = true;
    assert.equal((await evaluate()).available, true);
    const other = await app.ctx.scope.bootstrap({ projectName: 'Other', actorName: 'Other' });
    await assert.rejects(
      async () =>
        await app.ctx.workflows.evaluate(
          { actorId: other.actor.id, projectId: other.project.id },
          instance.id,
        ),
      { code: 'not_found' },
    );
    assert.deepEqual(
      (await app.ctx.workflows.overview({ actorId: other.actor.id, projectId: other.project.id }))
        .workflows,
      [],
    );
    await reloaded.transition(caller, {
      instanceId: instance.id,
      expectedRevision: 0,
      action: 'calibrate',
      requestId: 'act',
      input: proposal,
    });
    assert.equal((await evaluate()).currentGate, 'terminal');
    assert.equal((await evaluate()).nextAction, null);
    await assert.rejects(
      async () =>
        await app.ctx.workflows.evaluate(caller, instance.id, {
          action: 'calibrate',
          input: proposal,
        }),
      { code: 'revision_conflict' },
    );
    await assert.rejects(
      async () =>
        await app.ctx.workflows.register({ ...graph, name: 'unguarded' }, { actions: [] }),
      /every graph transition/,
    );
    const asyncGraph = { ...graph, name: 'async_policy' };
    let description: unknown;
    let descriptionReads = 0;
    const asyncHandle = await app.ctx.workflows.register(asyncGraph, {
      actions: [
        {
          ...policy.actions[0],
          check: async ({ snapshot, tx }) => {
            const stored = await tx.get<{ revision: number }>(
              'SELECT revision FROM wf_instances WHERE id=?',
              snapshot.id,
            );
            check(
              stored?.revision === snapshot.revision,
              'revision_conflict',
              'Changed while checking',
              409,
            );
          },
        },
      ],
      describe: async ({ snapshot, tx }) => {
        const row = await tx.get<{ workflow: string }>(
          'SELECT workflow FROM wf_instances WHERE id=?',
          snapshot.id,
        );
        return (
          description === undefined
            ? {
                label: `Async ${row!.workflow}`,
                references: [],
                gate: undefined,
                waiting: undefined,
              }
            : description
        ) as any;
      },
    });
    const asyncInstance = await asyncHandle.start(caller, {
      workflow: asyncGraph.name,
      requestId: 'async-start',
    });
    assert.equal(
      (await app.ctx.workflows.evaluate(caller, asyncInstance.id)).label,
      'Async async_policy',
    );
    const unexpectedDescriptionRead = () => {
      descriptionReads++;
      return [];
    };
    for (description of [
      Object.defineProperty({ references: [] }, 'label', {
        enumerable: true,
        get: () => {
          descriptionReads++;
          return 'Changed';
        },
      }),
      null,
      { label: 'Invalid reference', references: [null] },
      {
        label: 'Proxy',
        references: [
          new Proxy(
            { kind: 'test', id: 'id', label: 'Reference' },
            { ownKeys: unexpectedDescriptionRead },
          ),
        ],
      },
      {
        label: 'Custom array',
        references: Object.setPrototypeOf([], {
          every: () => true,
          map: unexpectedDescriptionRead,
        }),
      },
      {
        label: 'Undefined reference metadata',
        references: [{ kind: 'test', id: 'id', label: 'Reference', extra: undefined }],
      },
    ]) {
      await assert.rejects(() => app.ctx.workflows.evaluate(caller, asyncInstance.id), {
        code: 'invalid_workflow_policy',
        status: 500,
      });
      assert.equal(descriptionReads, 0);
    }
    const broken = { ...graph, name: 'broken_arguments' };
    let args: any;
    const brokenHandle = await app.ctx.workflows.register(broken, {
      actions: [{ ...policy.actions[0], arguments: () => args }],
    });
    const brokenInstance = await brokenHandle.start(caller, {
      workflow: broken.name,
      requestId: 'broken-start',
    });
    let callbacks = 0;
    const unexpected = () => {
      callbacks++;
      return [];
    };
    for (args of [
      null,
      Object.defineProperty({}, 'value', { enumerable: true, get: unexpected }),
      { value: NaN },
      new Proxy({}, { ownKeys: unexpected }),
      { value: Object.setPrototypeOf([1], { map: unexpected }) },
    ]) {
      await assert.rejects(
        async () => await app.ctx.workflows.evaluate(caller, brokenInstance.id),
        {
          code: 'invalid_workflow_policy',
          status: 500,
        },
      );
      await assert.rejects(
        async () =>
          await brokenHandle.transition(caller, {
            instanceId: brokenInstance.id,
            expectedRevision: 0,
            action: 'calibrate',
            requestId: 'broken-act',
            input: { reading: 10 },
          }),
        { code: 'invalid_workflow_policy', status: 500 },
      );
      assert.equal(callbacks, 0);
    }
    assert.equal((await app.ctx.workflows.get(caller, brokenInstance.id)).revision, 0);
  } finally {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a guard, begin check or lease role that writes under a read fails the read instead of blocking the work', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-guidance-fault-'));
  const app = await createApp({ directory });
  try {
    const a = await app.ctx.scope.bootstrap({ projectName: 'Faults', actorName: 'Operator' });
    const caller = { actorId: a.actor.id, projectId: a.project.id };
    const graph: WorkflowDefinition = {
      name: 'scribbling',
      version: 1,
      initial: 'open',
      states: ['open', 'done'],
      terminal: ['done'],
      edges: [{ from: 'open', action: 'finish', to: 'done' }],
    };
    /** Which callback writes. */
    let writer: 'guard' | 'begin' | 'role' | null = null;
    const scribble = async (by: typeof writer, tx: Transaction, id: string) => {
      if (writer === by)
        await tx.run('UPDATE wf_instances SET updated_at=updated_at WHERE id=?', id);
    };
    const scribbled = await app.ctx.workflows.register(graph, {
      actions: [
        {
          name: 'finish',
          states: ['open'],
          transitions: ['finish'],
          tool: 'scribble.finish',
          instruction: 'Finish.',
          check: async ({ tx, snapshot }) => await scribble('guard', tx, snapshot.id),
        },
      ],
      assignments: [
        {
          state: 'open',
          check: async ({ tx, snapshot }) => await scribble('begin', tx, snapshot.id),
          build: () => ({
            role: 'producer',
            label: 'Scribble',
            brief: 'Scribble',
            references: [],
            handoff: { instruction: 'Finish', tools: ['scribble.finish'] },
            execution: { readOnly: true, tools: [] },
            context: null,
          }),
          execution: { readOnly: true, tools: [] },
          lease: {
            role: async ({ tx, snapshot }) => {
              await scribble('role', tx, snapshot.id);
              return 'producer' as const;
            },
            acquire: ({ leaseId }) => ({ leaseId }),
            check: () => {},
            release: () => {},
          },
        },
      ],
    });
    const instance = await scribbled.start(caller, {
      workflow: graph.name,
      requestId: 'start',
    });
    const read = async <T>(fn: () => Promise<T>) => await app.ctx.state.snapshot(fn);
    // Unfaulted, the work is offered and dispatchable.
    assert.equal(
      (await read(() => app.ctx.workflows.evaluate(caller, instance.id))).nextAction?.action,
      'begin',
    );
    assert.equal((await read(() => app.ctx.workflows.dispatchCandidates(caller))).length, 1);
    // State refuses each write with a 409, which a callback's refusal would be read as: the
    // work would show as blocked, or be skipped, because of its own program's bug.
    for (const by of ['guard', 'begin'] as const) {
      writer = by;
      await assert.rejects(
        async () => await read(() => app.ctx.workflows.evaluate(caller, instance.id)),
        { code: 'invalid_workflow_policy', status: 500 },
        by,
      );
    }
    writer = 'role';
    await assert.rejects(
      async () => await read(() => app.ctx.workflows.dispatchCandidates(caller)),
      { code: 'invalid_workflow_policy', status: 500 },
    );
  } finally {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('current task guidance follows leased delivery, independent review, revision fences and terminal restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-task-guidance-'));
  let app = await createApp({ directory });
  let work: ReturnType<typeof currentWork> | undefined;
  try {
    const boot = await app.ctx.scope.bootstrap({
      projectName: 'Task guidance',
      actorName: 'Operator',
    });
    const source: Caller = {
      actorId: boot.actor.id,
      projectId: boot.project.id,
      credentialId: boot.credential.id,
    };
    work = currentWork(app.ctx, { directory: join(directory, 'work'), source });
    const task = await currentTask(app.ctx, source, {
      title: 'Guided task',
      goal: 'Retain verified evidence.',
      checks: ['Check.'],
      requestId: 'create',
    });
    const guidance = () => app.ctx.workflows.evaluate(source, task.id);
    assert.deepEqual(task.guidance, await guidance());
    assert.equal((await guidance()).currentGate, 'delivery_required');
    assert.equal((await guidance()).nextAction?.tool, 'workflow.begin');
    const producer = await work.lease(task);
    assert.equal(
      (await app.ctx.workflows.evaluate(producer.worker, task.id)).nextAction?.tool,
      'task.submit_delivery',
    );
    const evidence = await work.run(
      producer,
      'artifact.create',
      {
        title: 'Delivery',
        content: 'Check. Evidence verified.',
      },
      (caller, input) => app.ctx.artifacts.create(caller, input as never),
    );
    const commandId = await work.commit(producer);
    const pending = await work.run(
      producer,
      'task.submit_delivery',
      confirmedDelivery({
        artifactIds: [evidence.id],
        commandId,
        requestId: 'deliver',
      }),
      (caller, input) => app.ctx.tasks.submitDelivery(caller, input as never),
    );
    await work.release(producer);
    assert.equal((await guidance()).currentGate, 'review_required');
    assert.equal((await guidance()).revision, 1);
    await assert.rejects(
      app.ctx.workflows.begin(source, { instanceId: task.id, expectedRevision: 0 }),
      { code: 'revision_conflict' },
    );
    const reviewer = await work.lease(pending);
    assert.notEqual(reviewer.worker.actorId, producer.worker.actorId);
    const claim = await app.ctx.reviews.get(source, pending.reviewId!);
    const decision = await app.ctx.workflows.evaluate(reviewer.worker, task.id);
    assert.equal(decision.nextAction?.tool, 'review.submit');
    assert.equal(decision.nextAction?.arguments.claimId, claim.claimId);
    const reviewContext = await work.run(
      reviewer,
      'task.context',
      { requestId: 'context' },
      (caller, input) => app.ctx.tasks.context(caller, input as never),
    );
    assert.ok(reviewContext.prompt.includes(JSON.stringify(decision)));
    await work.run(
      reviewer,
      'review.submit',
      {
        ...reviewedFindings(claim),
        verdict: 'pass',
        notes: 'Checked the delivered commit.',
        requestId: 'pass',
      },
      (caller, input) => app.ctx.tasks.submitReview(caller, input as never),
    );
    await work.release(reviewer);
    const finished = await guidance();
    assert.equal(finished.terminal, true);
    assert.equal(finished.nextAction, null);
    await work.close();
    work = undefined;
    await app.stop();
    app = await createApp({ directory });
    assert.deepEqual(await guidance(), finished);
    assert.deepEqual(await storedContext(app.ctx.state, reviewContext.id), reviewContext);
    await app.setEnabled('tasks', false);
    assert.equal((await guidance()).terminal, true);
    await app.setEnabled('tasks', true);
    assert.deepEqual(await guidance(), finished);
  } finally {
    await work?.close();
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

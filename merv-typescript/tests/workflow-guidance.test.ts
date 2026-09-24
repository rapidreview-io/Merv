import { confirmedDelivery, reviewedFindings } from './fixtures/task-evidence.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from './fixtures/app.js';
import { storedContext } from './fixtures/state.js';
import { check, type Caller, type WorkflowDefinition, type WorkflowPolicy } from '@merv/contracts';

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
    const instance = await app.ctx.workflows.start(caller, {
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
        await app.ctx.workflows.transition(caller, {
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
    await app.ctx.workflows.register(graph, policy);
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
    await app.ctx.workflows.transition(caller, {
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
    await app.ctx.workflows.register(asyncGraph, {
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
    const asyncInstance = await app.ctx.workflows.start(caller, {
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
    await app.ctx.workflows.register(broken, {
      actions: [{ ...policy.actions[0], arguments: () => args }],
    });
    const brokenInstance = await app.ctx.workflows.start(caller, {
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
          await app.ctx.workflows.transition(caller, {
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

test('task guidance follows caller, evidence, review claims, recovery, context, revision and terminal outcomes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-task-guidance-'));
  let app = await createApp({ directory });
  try {
    const a = await app.ctx.scope.bootstrap({
      projectName: 'Task guidance',
      actorName: 'Operator',
    });
    const operator = { actorId: a.actor.id, projectId: a.project.id };
    const issue = async (role: 'producer' | 'reviewer' | 'reader'): Promise<Caller> => ({
      actorId: (await app.ctx.scope.issueActor(operator, { role, name: role })).actor.id,
      projectId: a.project.id,
    });
    const producer = await issue('producer'),
      reviewer = await issue('reviewer'),
      replacement = await issue('reviewer'),
      reader = await issue('reader');
    const brief = await app.ctx.artifacts.create(producer, {
      title: 'Brief',
      content: 'Goal. Check.',
    });
    const task = await app.ctx.tasks.create(producer, {
      title: 'Guided task',
      goal: 'Goal.',
      checks: ['Check.'],
      briefId: brief.id,
      requestId: 'create',
    });
    const guidance = async (caller: Caller) => await app.ctx.workflows.evaluate(caller, task.id);
    assert.deepEqual(task.guidance, await guidance(producer));
    assert.equal((await guidance(producer)).currentGate, 'delivery_required');
    assert.equal((await guidance(producer)).nextAction?.tool, 'workflow.begin');
    await app.ctx.workflows.begin(producer, { instanceId: task.id, expectedRevision: 0 });
    assert.equal((await guidance(producer)).nextAction?.tool, 'task.submit_delivery');
    assert.equal((await guidance(producer)).nextAction?.status, 'needs_input');
    assert.equal((await guidance(reader)).nextAction, null);
    assert.deepEqual((await app.ctx.workflows.overview(producer)).ready, [task.id]);
    assert.deepEqual((await app.ctx.workflows.overview(reader)).blocked, [task.id]);
    const context = await app.ctx.tasks.context(producer, {
      taskId: task.id,
      purpose: 'work',
      expectedRevision: 0,
      requestId: 'context',
    });
    assert.ok(
      context.prompt.includes(JSON.stringify(await guidance(producer))),
      'Context consumes the canonical decision',
    );
    const bad = {
      taskId: task.id,
      artifactIds: [brief.id],
      expectedRevision: 0,
      requestId: 'deliver',
    };
    const preflight = await app.ctx.workflows.evaluate(producer, task.id, {
      action: 'submit_delivery',
      input: bad,
    });
    assert.equal(preflight.actions[0].blockers[0].code, 'invalid_delivery');
    await assert.rejects(
      async () => await app.ctx.tasks.submitDelivery(producer, confirmedDelivery(bad)),
      {
        code: preflight.actions[0].blockers[0].code,
      },
    );
    const delivery = await app.ctx.artifacts.create(producer, {
      title: 'Delivery',
      content: 'Check. Evidence verified.',
    });
    const good = confirmedDelivery({ ...bad, artifactIds: [delivery.id] });
    assert.equal(
      (
        await app.ctx.workflows.evaluate(producer, task.id, {
          action: 'submit_delivery',
          input: good,
        })
      ).nextAction?.status,
      'ready',
    );
    const pending = await app.ctx.tasks.submitDelivery(producer, confirmedDelivery(good));
    assert.equal((await guidance(producer)).currentGate, 'review_required');
    assert.equal((await guidance(producer)).nextAction, null);
    assert.equal((await guidance(reviewer)).nextAction?.tool, 'workflow.begin');
    await app.ctx.workflows.begin(reviewer, { instanceId: task.id, expectedRevision: 1 });
    assert.equal((await guidance(reviewer)).nextAction?.tool, 'review.start');
    const claim = await app.ctx.reviews.start(reviewer, pending.reviewId!);
    assert.equal((await guidance(reviewer)).nextAction?.tool, 'review.submit');
    assert.equal((await guidance(reviewer)).nextAction?.arguments.claimId, claim.claimId);
    assert.equal((await guidance(replacement)).nextAction, null);
    assert.equal((await guidance(producer)).currentGate, 'independent_review');
    const reviewContext = await app.ctx.tasks.context(reviewer, {
      taskId: task.id,
      purpose: 'review',
      claimId: claim.claimId!,
      expectedRevision: 1,
      requestId: 'review-context',
    });
    assert.ok(reviewContext.prompt.includes(JSON.stringify(await guidance(reviewer))));
    await app.ctx.scope.revokeActor(operator, reviewer.actorId);
    assert.equal((await guidance(producer)).currentGate, 'review_recovery_pending');
    await assert.rejects(async () => await guidance(reviewer), { code: 'forbidden' });
    await app.ctx.domainEvents.drain();
    assert.equal((await guidance(replacement)).nextAction?.tool, 'review.start');
    const fresh = await app.ctx.reviews.start(replacement, claim.id);
    const verdict = {
      ...reviewedFindings(claim),
      reviewId: fresh.id,
      claimId: claim.claimId!,
      verdict: 'needs_changes' as const,
      notes: 'Correct the evidence.',
      expectedRevision: 1,
      requestId: 'verdict',
    };
    const stale = await app.ctx.workflows.evaluate(replacement, task.id, {
      action: 'submit_review',
      input: verdict,
    });
    assert.equal(stale.currentGate, 'stale_claim');
    await assert.rejects(async () => await app.ctx.tasks.submitReview(replacement, verdict), {
      code: 'stale_claim',
    });
    await app.ctx.tasks.submitReview(replacement, { ...verdict, claimId: fresh.claimId! });
    assert.equal((await guidance(producer)).currentGate, 'delivery_required');
    assert.equal((await guidance(producer)).revision, 2);
    await assert.rejects(
      async () =>
        await app.ctx.tasks.submitDelivery(
          producer,
          confirmedDelivery({ ...good, requestId: 'stale' }),
        ),
      {
        code: 'revision_conflict',
      },
    );
    const next = await app.ctx.tasks.submitDelivery(
      producer,
      confirmedDelivery({
        ...good,
        expectedRevision: 2,
        requestId: 'revise',
      }),
    );
    const last = await app.ctx.reviews.start(replacement, next.reviewId!);
    await app.ctx.tasks.submitReview(replacement, {
      ...reviewedFindings(last),
      reviewId: last.id,
      claimId: last.claimId!,
      expectedRevision: 3,
      verdict: 'pass',
      notes: 'Rechecked all evidence.',
      requestId: 'pass',
    });
    assert.equal((await guidance(producer)).terminal, true);
    assert.equal((await guidance(producer)).nextAction, null);
    const finished = await guidance(producer);
    await app.stop();
    app = await createApp({ directory });
    assert.deepEqual(await guidance(producer), finished);
    assert.deepEqual(await storedContext(app.ctx.state, context.id), context);
    await app.setEnabled('tasks', false);
    // Historical terminal records remain terminal without inventing active checks.
    assert.equal((await guidance(producer)).terminal, true);
    await app.setEnabled('tasks', true);
    assert.deepEqual(await guidance(producer), finished);
    const failed = await app.ctx.tasks.create(producer, {
      title: 'Fail case',
      goal: 'Goal.',
      checks: ['Check.'],
      briefId: brief.id,
      requestId: 'fail-create',
    });
    const failPending = await app.ctx.tasks.submitDelivery(
      producer,
      confirmedDelivery({
        taskId: failed.id,
        artifactIds: [delivery.id],
        expectedRevision: 0,
        requestId: 'fail-deliver',
      }),
    );
    const failClaim = await app.ctx.reviews.start(replacement, failPending.reviewId!);
    await app.ctx.tasks.submitReview(replacement, {
      ...reviewedFindings(failClaim),
      reviewId: failClaim.id,
      claimId: failClaim.claimId!,
      expectedRevision: 1,
      verdict: 'fail',
      notes: 'Goal cannot be achieved.',
      requestId: 'fail-verdict',
    });
    assert.equal((await app.ctx.workflows.evaluate(producer, failed.id)).currentGate, 'terminal');
  } finally {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

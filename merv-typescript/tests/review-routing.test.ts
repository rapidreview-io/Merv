import { currentTask, currentWork } from './fixtures/current-work.js';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller, ReviewApplication, ReviewSubmitOwner, Transaction } from '@merv/contracts';
import { createApp } from './fixtures/app.js';
import type { ToolDefinition } from '../packages/api/src/types.js';
import { confirmedDelivery } from './fixtures/task-evidence.js';
import { assessment, claimUnowned } from './fixtures/review-verdict.js';

async function fixture(t: TestContext, api = false) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-review-routing-'));
  const app = await createApp({
    directory,
    api,
    port: 0,
    components: [
      'state',
      'scope',
      'blobs',
      'artifacts',
      'domain-events',
      'workflows',
      'context-builder',
      'reviews',
      'paper',
      'tasks',
      'sessions',
      'code',
      'code-work',
    ],
  });
  let work: ReturnType<typeof currentWork> | undefined;
  t.after(async () => {
    await work?.close();
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const boot = await app.ctx.scope.credentials.bootstrap({
    projectName: 'Review routing',
    actorName: 'Operator',
  });
  const operator: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const issue = async (role: 'producer' | 'reviewer' | 'reader' | 'operator') => {
    const result = await app.ctx.scope.credentials.issueActor(operator, { name: role, role });
    return {
      token: result.token,
      caller: {
        actorId: result.actor.id,
        projectId: boot.project.id,
        credentialId: result.credential.id,
      } as Caller,
    };
  };
  const producer = await issue('producer'),
    reviewer = await issue('operator'),
    reader = await issue('reader');
  const reviewerSource = { ...reviewer.caller };
  const reviewerSourceToken = reviewer.token;
  const proof = await app.ctx.artifacts.create(producer.caller, {
    title: 'Proof',
    content: 'The verified value is 42.',
  });
  let sequence = 0;
  // A review some registered domain owns is claimed as it is; any other through a stand-in.
  const request = async (subjectId = `unowned-${++sequence}`, owned = false) => {
    const { id } = await app.ctx.reviews.request(producer.caller, {
      subjectId,
      subjectRevision: 0,
      producerId: producer.caller.actorId,
      artifactIds: [proof.id],
      criteria: ['The result is correct.'],
      requestId: `request-${++sequence}`,
    });
    return owned
      ? await app.ctx.reviews.start(reviewer.caller, id)
      : await claimUnowned(app.ctx.reviews, reviewer.caller, id);
  };
  const input = (review: Awaited<ReturnType<typeof request>>): ReviewApplication => ({
    reviewId: review.id,
    claimId: review.claimId!,
    expectedRevision: review.subjectRevision,
    verdict: 'pass',
    notes: 'Independently verified the retained result.',
    ...assessment(review),
    requestId: `submit-${++sequence}`,
  });
  const durable = async () =>
    await app.ctx.state.read(async (tx) => ({
      reviews: await tx.all('SELECT * FROM reviews ORDER BY id'),
      reviewCommands: await tx.all('SELECT * FROM review_commands ORDER BY actor_id,request_id'),
      tasks: await tx.all('SELECT * FROM tasks ORDER BY id'),
      taskCommands: await tx.all('SELECT * FROM task_commands ORDER BY actor_id,request_id'),
      workflows: await tx.all('SELECT * FROM wf_instances ORDER BY id'),
      history: await tx.all('SELECT * FROM wf_history ORDER BY instance_id,revision'),
      events: await app.ctx.state.events(operator.projectId),
    }));
  const pendingTask = async () => {
    const task = await currentTask(app.ctx, producer.caller, {
      title: 'Verified arithmetic',
      goal: 'Verify the result.',
      checks: ['The result is correct.'],
      requestId: `task-${++sequence}`,
    });
    work ??= currentWork(app.ctx, {
      directory: join(directory, 'workers'),
      source: producer.caller,
    });
    const held = await work.lease(task);
    const commandId = await work.commit(held);
    const retained = await work.run(
      held,
      'artifact.create',
      { title: 'Proof', content: 'The verified value is 42.' },
      (by, value) => app.ctx.artifacts.create(by, value as any),
    );
    const pending = await work.run(
      held,
      'task.submit_delivery',
      confirmedDelivery({
        taskId: task.id,
        expectedRevision: 0,
        artifactIds: [retained.id],
        commandId,
        requestId: `delivery-${++sequence}`,
      }),
      (by, value) => app.ctx.tasks.submitDelivery(by, value as any),
    );
    await work.release(held);
    const reviewLease = await work.lease(pending, reviewerSource);
    reviewer.caller = reviewLease.worker;
    reviewer.token = reviewLease.token;
    const review = await app.ctx.reviews.get(reviewer.caller, pending.reviewId!);
    return {
      task: pending,
      review,
      held: reviewLease,
      input: {
        ...input(review),
        synopsis:
          'The retained result was independently recomputed and satisfies the requested goal.',
        findings: [
          {
            criterionNumber: 1,
            status: 'met' as const,
            evidenceIds: [retained.id],
            notes: 'Recomputed independently.',
          },
          {
            criterionNumber: 2,
            status: 'met' as const,
            evidenceIds: [retained.id],
            notes: 'The report has the required parts.',
          },
        ],
      },
    };
  };
  const http = async (data: unknown, token = reviewer.token) => {
    const response = await fetch(`${app.ctx.api.url}/tools/review.submit`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(data),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  return {
    app,
    operator,
    producer,
    reviewer,
    reader,
    reviewerSource,
    reviewerSourceToken,
    request,
    input,
    durable,
    pendingTask,
    http,
    runReview: (
      held: Awaited<ReturnType<ReturnType<typeof currentWork>['lease']>>,
      input: ReviewApplication,
    ) =>
      work!.run(
        held,
        'review.submit',
        input as unknown as import('@merv/contracts').Data,
        (caller, bound) => app.ctx.reviews.apply(caller, bound as unknown as ReviewApplication),
      ),
  };
}

test('review owner registration is closed, copied, unique and safe against stale disposers', async (t) => {
  const f = await fixture(t),
    reviews = f.app.ctx.reviews;
  const valid: ReviewSubmitOwner = {
    id: 'custom',
    owns: async () => true,
    submit: async () => ({ accepted: true }),
  };
  // The contract types the rest; an owner needs a valid identifier of its own.
  for (const value of [null, { ...valid, id: '../bad' }, { ...valid, id: 7 }]) {
    assert.throws(() => reviews.registerSubmitOwner(value as never), {
      code: 'invalid_review_owner',
    });
  }
  const input = f.input(await f.request());
  const drop = reviews.registerSubmitOwner(valid);
  assert.throws(() => reviews.registerSubmitOwner(valid), { code: 'review_owner_conflict' });
  valid.owns = async () => false;
  assert.deepEqual(await reviews.apply(f.reviewer.caller, input), { accepted: true });
  drop();
  reviews.registerSubmitOwner({
    ...valid,
    owns: async () => true,
    submit: async () => 'replacement',
  });
  drop();
  assert.equal(await reviews.apply(f.reviewer.caller, input), 'replacement');
});

test('an owner states its verdict guidance and the extra verdict fields it validates itself', async (t) => {
  const f = await fixture(t, true),
    reviews = f.app.ctx.reviews;
  const received: ReviewApplication[] = [];
  const review = await f.request('guided-subject');
  const drop = reviews.registerSubmitOwner({
    id: 'guided',
    owns: async (owned) => owned.subjectId === 'guided-subject',
    submit: async (_caller, input) => received.push(input),
    guidance: 'Pass rejects returnTo; include ownerInput when it applies.',
    fields: ['ownerInput'],
  });
  t.after(drop);
  for (const tool of ['review.get', 'review.start'])
    assert.equal(
      ((await f.app.ctx.tools.call(tool, f.reviewer.caller, { reviewId: review.id })) as any)
        .guidance,
      'Pass rejects returnTo; include ownerInput when it applies.',
    );
  const other = await f.request();
  // No owner, no guidance: only Reviews' own word that its claimer may hand it back.
  assert.deepEqual(await reviews.guide(f.reviewer.caller, other.id), { releasable: true });
  assert.equal(
    'guidance' in
      ((await f.app.ctx.tools.call('review.get', f.reviewer.caller, {
        reviewId: other.id,
      })) as object),
    false,
  );
  const input = { ...f.input(review), ownerInput: { opaque: [1, 'two'] } };
  await assert.rejects(
    reviews.apply(f.reviewer.caller, { ...input, unexpected: true } as ReviewApplication),
    { code: 'invalid_review_input' },
  );
  assert.equal(received.length, 0);
  await f.app.ctx.tools.call('review.submit', f.reviewer.caller, input);
  assert.deepEqual((received[0] as ReviewApplication & { ownerInput: unknown }).ownerInput, {
    opaque: [1, 'two'],
  });
});

test('missing, ambiguous and throwing ownership never submit and roll back selection writes', async (t) => {
  const f = await fixture(t),
    reviews = f.app.ctx.reviews;
  const input = f.input(await f.request());
  let submissions = 0;
  const write = async (tx: Transaction) =>
    await f.app.ctx.state.appendEvent(tx, {
      projectId: f.operator.projectId,
      actorId: f.reviewer.caller.actorId,
      type: 'fixture.owner_probe',
      subjectId: input.reviewId,
      data: {},
    });
  const before = await f.durable();
  let drop = reviews.registerSubmitOwner({
    id: 'probe',
    owns: async (_, tx) => {
      await write(tx);
      return false;
    },
    submit: async () => submissions++,
  });
  await assert.rejects(async () => await reviews.apply(f.reviewer.caller, input), {
    code: 'review_owner_unavailable',
  });
  assert.deepEqual(await f.durable(), before);
  drop();
  drop = reviews.registerSubmitOwner({
    id: 'first',
    owns: async (_, tx) => {
      await write(tx);
      return true;
    },
    submit: async () => submissions++,
  });
  const other = reviews.registerSubmitOwner({
    id: 'second',
    owns: async () => true,
    submit: async () => submissions++,
  });
  await assert.rejects(async () => await reviews.apply(f.reviewer.caller, input), {
    code: 'review_owner_ambiguous',
  });
  assert.deepEqual(await f.durable(), before);
  drop();
  other();
  drop = reviews.registerSubmitOwner({
    id: 'throws',
    owns: async (_, tx) => {
      await write(tx);
      throw new Error('Owner lookup failed');
    },
    submit: async () => submissions++,
  });
  await assert.rejects(
    async () => await reviews.apply(f.reviewer.caller, input),
    /Owner lookup failed/,
  );
  assert.deepEqual(await f.durable(), before);
  drop();
  reviews.registerSubmitOwner({
    id: 'nonboolean',
    owns: async () => 'yes' as never,
    submit: async () => submissions++,
  });
  await assert.rejects(async () => await reviews.apply(f.reviewer.caller, input), {
    code: 'invalid_review_owner',
  });
  assert.equal(submissions, 0);
});

test('two domain owners route independently in the existing writer and preserve delegated results', async (t) => {
  const f = await fixture(t),
    reviews = f.app.ctx.reviews;
  const calls: string[] = [];
  for (const id of ['alpha', 'beta'])
    reviews.registerSubmitOwner({
      id,
      owns: async (review) => {
        assert.ok(Object.isFrozen(review));
        assert.ok(Object.isFrozen(review.artifactIds));
        return review.subjectId === id;
      },
      submit: async (caller, input, tx) => {
        f.app.ctx.state.assertTransaction(tx);
        assert.deepEqual(caller, f.reviewer.caller);
        calls.push(id);
        return { owner: id, review: await reviews.submit(caller, input, tx) };
      },
    });
  for (const id of ['alpha', 'beta']) {
    const input = f.input(await f.request(id, true));
    const result = await f.app.ctx.state.transaction(
      async (tx) => await reviews.apply(f.reviewer.caller, input, tx),
    );
    assert.equal((result as any).owner, id);
    assert.equal((result as any).review.status, 'submitted');
    assert.deepEqual(await reviews.apply(f.reviewer.caller, input), result);
    await assert.rejects(async () => await reviews.apply(f.reader.caller, input), {
      code: 'forbidden',
    });
  }
  assert.deepEqual(calls, ['alpha', 'alpha', 'beta', 'beta']);
});

test('async ownership and submission failures roll back all writes without escaping rejections', async (t) => {
  const f = await fixture(t),
    reviews = f.app.ctx.reviews;
  const input = f.input(await f.request()),
    before = await f.durable();
  for (const stage of ['owns', 'submit']) {
    const drop = reviews.registerSubmitOwner({
      id: 'async',
      owns: async (_review, tx) => {
        await f.app.ctx.state.appendEvent(tx, {
          projectId: f.operator.projectId,
          actorId: f.reviewer.caller.actorId,
          type: 'fixture.async_owner_probe',
          subjectId: input.reviewId,
          data: {},
        });
        await Promise.resolve();
        if (stage === 'owns') throw new Error('Async owner rejection');
        return true;
      },
      submit: async (caller, input, tx) => {
        await reviews.submit(caller, input, tx);
        await Promise.resolve();
        throw new Error('Async submit rejection');
      },
    });
    await assert.rejects(reviews.apply(f.reviewer.caller, input), {
      message: stage === 'owns' ? 'Async owner rejection' : 'Async submit rejection',
    });
    assert.deepEqual(await f.durable(), before);
    drop();
  }
  await new Promise((resolve) => setImmediate(resolve));
});

test('registration changes during selection or submission invalidate the operation and roll back verdicts', async (t) => {
  const f = await fixture(t),
    reviews = f.app.ctx.reviews;
  const input = f.input(await f.request()),
    before = await f.durable();
  let called = false,
    drop = () => {};
  drop = reviews.registerSubmitOwner({
    id: 'change',
    owns: async () => {
      drop();
      return true;
    },
    submit: async () => {
      called = true;
    },
  });
  await assert.rejects(async () => await reviews.apply(f.reviewer.caller, input), {
    code: 'review_owner_changed',
  });
  assert.equal(called, false);
  assert.deepEqual(await f.durable(), before);
  drop = reviews.registerSubmitOwner({
    id: 'change',
    owns: async () => true,
    submit: async (caller, input, tx) => {
      const result = await reviews.submit(caller, input, tx);
      drop();
      return result;
    },
  });
  await assert.rejects(async () => await reviews.apply(f.reviewer.caller, input), {
    code: 'review_owner_changed',
  });
  assert.deepEqual(await f.durable(), before);
});

test('HTTP review routing preserves its schema and verdict replay across owner withdrawal and restoration', async (t) => {
  const f = await fixture(t, true);
  const review = await f.request('http-owned');
  const input = f.input(review);
  const owner = {
    id: 'http-owner',
    owns: async (review: { subjectId: string }) => review.subjectId === 'http-owned',
    submit: (caller: Caller, input: ReviewApplication, tx: Transaction) =>
      f.app.ctx.reviews.submit(caller, input, tx),
  };
  const drop = f.app.ctx.reviews.registerSubmitOwner(owner);
  assert.equal((await f.http({ ...input, owner: 'http-owner' })).status, 400);
  drop();
  const missing = await f.http(input);
  assert.equal(missing.status, 503);
  assert.equal(missing.body.error.code, 'review_owner_unavailable');
  f.app.ctx.reviews.registerSubmitOwner(owner);
  const submitted = await f.http(input);
  assert.equal(submitted.status, 200, JSON.stringify(submitted));
  assert.equal(submitted.body.result.id, review.id);
  assert.equal(submitted.body.result.status, 'submitted');
  assert.deepEqual((await f.http(input)).body, submitted.body);
});

test('task routed verdict and transition roll back together when assessment persistence fails', async (t) => {
  const f = await fixture(t);
  const { input, held } = await f.pendingTask(),
    before = await f.durable();
  const original = f.app.ctx.reviews.submit.bind(f.app.ctx.reviews);
  f.app.ctx.reviews.submit = async (caller, input, tx) => {
    await original(caller, input, tx);
    throw new Error('Injected after verdict persistence');
  };
  await assert.rejects(
    async () => await f.runReview(held, input),
    /Injected after verdict persistence/,
  );
  assert.deepEqual(await f.durable(), before);
  f.app.ctx.reviews.submit = original;
  assert.equal(((await f.runReview(held, input)) as any).workflow.state, 'done');
});

test('the review owner withdraws before Tasks consumers finish draining on workflow unload', async (t) => {
  const f = await fixture(t, true),
    task = await currentTask(f.app.ctx, f.producer.caller, {
      title: 'Drain current task read',
      goal: 'Read',
      checks: ['Read'],
      requestId: 'drain-create',
    }),
    input = f.input(await f.request());
  let enter = () => {},
    release = () => {};
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tool = (await f.app.ctx.tools.list()).find(
    (tool) => tool.name === 'task.get',
  ) as ToolDefinition;
  const original = tool.handler;
  tool.handler = async (caller, input) => {
    const result = await original(caller, input);
    enter();
    await held;
    return result;
  };
  const pending = fetch(`${f.app.ctx.api.url}/tools/task.get`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${f.reviewerSourceToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ taskId: task.id }),
  });
  let unloading: Promise<void> | undefined,
    complete = false;
  try {
    await entered;
    unloading = f.app.setEnabled('workflows', false).then(() => {
      complete = true;
    });
    const deadline = Date.now() + 3000;
    while (
      (await f.app.ctx.tools.list()).some((tool) => tool.name === 'task.get') &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(
      (await f.app.ctx.tools.list()).some((tool) => tool.name === 'task.get'),
      false,
    );
    assert.equal(complete, false, 'The admitted task response still holds the drain open');
    const response = await f.http(input);
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, 'review_owner_unavailable');
    assert.equal((await f.app.ctx.reviews.get(f.operator, input.reviewId)).status, 'started');
  } finally {
    release();
    await pending;
    await unloading;
  }
  await f.app.setEnabled('workflows', true);
  assert.equal((await f.http(input)).body.error.code, 'review_owner_unavailable');
  assert.equal((await f.app.ctx.reviews.get(f.operator, input.reviewId)).status, 'started');
});

test('routing does not authorize fabricated task reviews, wrong projects, revoked reviewers or stale claims', async (t) => {
  const f = await fixture(t),
    { task, review, input } = await f.pendingTask();
  const fabricated = f.input(await f.request(task.id, true));
  await assert.rejects(async () => await f.app.ctx.reviews.apply(f.reviewer.caller, fabricated), {
    code: 'stale_review',
  });
  await assert.rejects(
    async () => await f.app.ctx.reviews.apply(f.reviewer.caller, { ...input, claimId: 'old' }),
    {
      code: 'stale_claim',
    },
  );
  const foreign = await f.app.ctx.scope.credentials.bootstrap({
    projectName: 'Other project',
    actorName: 'Other',
  });
  await assert.rejects(
    async () =>
      await f.app.ctx.reviews.apply(
        { actorId: foreign.actor.id, projectId: foreign.project.id },
        input,
      ),
    { code: 'not_found' },
  );
  assert.equal((await f.app.ctx.reviews.get(f.operator, review.id)).status, 'started');
  await f.app.ctx.scope.credentials.revokeActor(f.operator, f.reviewerSource.actorId);
  await f.app.ctx.domainEvents.drain();
  const before = await f.durable();
  await assert.rejects(async () => await f.app.ctx.reviews.apply(f.reviewer.caller, input));
  assert.deepEqual(await f.durable(), before);
});

test('review routing keeps the selected subject while owner lookup is pending', async (t) => {
  const f = await fixture(t),
    reviews = f.app.ctx.reviews;
  const original = await f.request('original-subject'),
    other = await f.request('different-subject');
  const input = f.input(original);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  reviews.registerSubmitOwner({
    id: 'original-owner',
    owns: async (review) => {
      enter();
      await waiting;
      return review.id === original.id;
    },
    submit: (caller, input, tx) => reviews.submit(caller, input, tx),
  });
  const caller = { ...f.reviewer.caller };
  const pending = reviews.apply(caller, input);
  try {
    await entered;
    input.reviewId = other.id;
    input.claimId = other.claimId!;
    Object.assign(caller, f.reader.caller);
  } finally {
    release();
  }
  await pending;
  assert.equal((await reviews.get(f.reviewer.caller, original.id)).status, 'submitted');
  assert.equal((await reviews.get(f.reviewer.caller, other.id)).status, 'started');
});

test('a review is claimed only when exactly one active domain owns it', async (t) => {
  const f = await fixture(t),
    reviews = f.app.ctx.reviews;
  const proof = await f.app.ctx.artifacts.create(f.producer.caller, {
    title: 'Proof',
    content: 'The verified value is 42.',
  });
  const { id } = await reviews.request(f.producer.caller, {
    subjectId: 'orphan',
    subjectRevision: 0,
    producerId: f.producer.caller.actorId,
    artifactIds: [proof.id],
    criteria: ['The result is correct.'],
    requestId: 'orphan',
  });
  // With its domain unloaded, a claim would only wait on a verdict nothing can apply.
  await assert.rejects(reviews.start(f.reviewer.caller, id), {
    code: 'review_owner_unavailable',
  });
  const owner = (name: string) =>
    reviews.registerSubmitOwner({
      id: name,
      owns: async () => true,
      submit: async () => name,
    });
  const drops = [owner('first'), owner('second')];
  await assert.rejects(reviews.start(f.reviewer.caller, id), { code: 'review_owner_ambiguous' });
  assert.equal((await reviews.get(f.operator, id)).status, 'requested');
  drops.pop()!();
  assert.equal((await reviews.start(f.reviewer.caller, id)).status, 'started');
});

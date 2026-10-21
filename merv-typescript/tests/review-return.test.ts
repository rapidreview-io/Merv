import type { CodeService } from '@merv/code-work/service';
import { createService, migrationList } from '@merv/contracts';
import { Context } from 'cordis';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { currentTask, currentWork } from './fixtures/current-work.js';

import { ApiServer, ToolRegistry } from '@merv/api';
import { ArtifactStore } from '@merv/artifacts';
import { DiskBlobs } from '@merv/blobs';
import {
  check,
  type ReviewApplication,
  type ReviewRequest,
  type ReviewSubmit,
} from '@merv/contracts';
import { ReviewService } from '@merv/reviews';
import { reviewToolsPlugin } from '@merv/reviews/tools';
import { ProjectScope } from '@merv/scope';
import { DELIVERY_REPORT_CRITERION } from '@merv/tasks/definitions';
import { createApp } from './fixtures/app.js';
import { assessment, claimUnowned } from './fixtures/review-verdict.js';
import { openState } from './fixtures/state.js';
import { confirmedDelivery } from './fixtures/task-evidence.js';

async function fixture(maximumMigration = Infinity) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-review-return-'));
  const path = directory;
  const state = await openState(path);
  const scope = await createService(new ProjectScope(state));
  const boot = await scope.credentials.bootstrap({
    projectName: 'Return route',
    actorName: 'Operator',
  });
  const operator = { actorId: boot.actor.id, projectId: boot.project.id };
  const issue = async (role: 'producer' | 'reviewer' | 'reader') => {
    const actor = await scope.credentials.issueActor(operator, { name: role, role });
    return { token: actor.token, caller: { actorId: actor.actor.id, projectId: boot.project.id } };
  };
  const producer = await issue('producer'),
    reviewer = await issue('reviewer'),
    reader = await issue('reader');
  const artifacts = await createService(
    new ArtifactStore(state, scope, new DiskBlobs(join(directory, 'blobs'))),
  );
  const proof = await artifacts.create(producer.caller, {
    title: 'Proof',
    content: 'A retained observation.',
  });
  const migrate = state.migrate.bind(state);
  state.migrate = async (component, migrations) =>
    await migrate(
      component,
      component === 'reviews'
        ? migrationList(migrations).filter((item) => item.version <= maximumMigration)
        : migrations,
    );
  const reviews = await createService(new ReviewService(state, scope, artifacts));
  state.migrate = migrate;
  let sequence = 0;
  const request = async () =>
    await reviews.request(producer.caller, {
      subjectId: `domain-${++sequence}`,
      subjectRevision: 0,
      producerId: producer.caller.actorId,
      artifactIds: [proof.id],
      criteria: ['The observation is reproducible.'],
      requestId: `request-${sequence}`,
    });
  const claim = async () => await claimUnowned(reviews, reviewer.caller, (await request()).id);
  const input = (review: ReviewRequest): ReviewSubmit => ({
    reviewId: review.id,
    claimId: review.claimId!,
    verdict: 'needs_changes',
    notes: 'The observation needs another independent check.',
    ...assessment(review),
    requestId: `submit-${++sequence}`,
  });
  const durable = async () =>
    await state.read(async (sql) => ({
      reviews: await sql.all('SELECT * FROM reviews ORDER BY id'),
      commands: await sql.all('SELECT * FROM review_commands ORDER BY actor_id,request_id'),
      events: await state.events(operator.projectId),
    }));
  return {
    directory,
    path,
    state,
    scope,
    reviews,
    artifacts,
    operator,
    producer,
    reviewer,
    reader,
    request,
    claim,
    input,
    durable,
    async close() {
      await state.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('selected review routes are immutable verdict evidence, included in replay identity, and survive restart', async () => {
  const f = await fixture();
  try {
    const review = await f.claim();
    assert.equal(Object.hasOwn(review, 'returnTo'), false);
    const input = { ...f.input(review), returnTo: 'repair.check-1' };
    const before = await f.durable();
    assert.equal(
      (await f.reviews.checkSubmit(f.reviewer.caller, review.id, input)).status,
      'started',
    );
    assert.deepEqual(await f.durable(), before);
    const result = await f.reviews.submit(f.reviewer.caller, input);
    assert.equal(result.returnTo, input.returnTo);
    assert.equal(result.snapshotHash, review.snapshotHash);
    assert.deepEqual(await f.reviews.get(f.reader.caller, result.id), result);
    assert.equal((await f.reviews.list(f.reader.caller))[0].returnTo, input.returnTo);
    // A record's page reads only its own reviews.
    assert.deepEqual(
      (await f.reviews.list(f.reader.caller, { subjectId: review.subjectId })).map(
        (item) => item.id,
      ),
      [review.id],
    );
    assert.deepEqual(await f.reviews.list(f.reader.caller, { subjectId: 'wf_other' }), []);
    assert.equal(
      (await f.state.events(f.operator.projectId)).at(-1)?.data.returnTo,
      input.returnTo,
    );
    const committed = await f.durable();
    assert.deepEqual(await f.reviews.submit(f.reviewer.caller, input), result);
    for (const returnTo of ['other', undefined])
      await assert.rejects(
        async () => await f.reviews.submit(f.reviewer.caller, { ...input, returnTo }),
        {
          code: 'request_conflict',
        },
      );
    assert.deepEqual(await f.durable(), committed);
    for (const replacement of ['other', null])
      await assert.rejects(
        async () =>
          await f.state.transaction(
            async (tx) =>
              await tx.run('UPDATE reviews SET return_to=? WHERE id=?', replacement, result.id),
          ),
        { code: 'state_constraint' },
      );
    await f.state.close();
    const state = await openState(f.path);
    try {
      const scope = await createService(new ProjectScope(state));
      const reviews = await createService(
        new ReviewService(
          state,
          scope,
          await createService(
            new ArtifactStore(state, scope, new DiskBlobs(join(f.directory, 'blobs'))),
          ),
        ),
      );
      assert.deepEqual(await reviews.get(f.reader.caller, result.id), result);
      assert.deepEqual(await reviews.submit(f.reviewer.caller, input), result);
      assert.equal(
        (await state.events(f.operator.projectId)).filter(
          (event) => event.type === 'review.submitted',
        ).length,
        1,
      );
    } finally {
      await state.close();
    }
  } finally {
    await f.close();
  }
});

test('the current review owner chooses required routes and rolls back route, receipt, event and domain transition together', async () => {
  const f = await fixture();
  try {
    const review = await f.claim();
    await f.state.transaction(async (tx) => {
      await tx.run('CREATE TABLE return_fixture (id TEXT PRIMARY KEY,state TEXT)');
      await tx.run('INSERT INTO return_fixture VALUES(?,?)', review.subjectId, 'review');
    });
    let failLate = false;
    const install = () =>
      f.reviews.registerSubmitOwner({
        id: 'return-fixture',
        owns: async (request) => request.id === review.id,
        async submit(caller, input, tx) {
          check(
            input.verdict === 'needs_changes' && ['repair', 'retry'].includes(input.returnTo ?? ''),
            'domain_return_required',
            'Choose a domain return destination',
          );
          const submitted = await f.reviews.submit(caller, input, tx);
          await tx.run(
            'UPDATE return_fixture SET state=? WHERE id=?',
            input.returnTo!,
            review.subjectId,
          );
          if (failLate) throw new Error('Owner transition failed');
          return submitted;
        },
      });
    const dispose = install();
    const input: ReviewApplication = { ...f.input(review), expectedRevision: 0 };
    const before = await f.durable();
    for (const returnTo of [undefined, 'elsewhere'])
      await assert.rejects(
        async () => await f.reviews.apply(f.reviewer.caller, { ...input, returnTo }),
        {
          code: 'domain_return_required',
        },
      );
    failLate = true;
    await assert.rejects(
      async () => await f.reviews.apply(f.reviewer.caller, { ...input, returnTo: 'repair' }),
      /Owner transition failed/,
    );
    assert.deepEqual(await f.durable(), before);
    assert.equal(
      await f.state.read(
        async (sql) =>
          (await sql.get<{ state: string }>('SELECT state FROM return_fixture'))!.state,
      ),
      'review',
    );
    dispose();
    await assert.rejects(
      async () => await f.reviews.apply(f.reviewer.caller, { ...input, returnTo: 'repair' }),
      {
        code: 'review_owner_unavailable',
      },
    );
    install();
    failLate = false;
    const result = (await f.reviews.apply(f.reviewer.caller, {
      ...input,
      returnTo: 'retry',
    })) as ReviewRequest;
    assert.equal(result.returnTo, 'retry');
    assert.equal(
      await f.state.read(
        async (sql) =>
          (await sql.get<{ state: string }>('SELECT state FROM return_fixture'))!.state,
      ),
      'retry',
    );
  } finally {
    await f.close();
  }
});

test('owners may require explicit destinations for both negative verdicts and forbid them for pass', async () => {
  const f = await fixture();
  try {
    f.reviews.registerSubmitOwner({
      id: 'verdict-policy-fixture',
      owns: async () => true,
      async submit(caller, input, tx) {
        if (input.verdict === 'pass')
          check(
            input.returnTo === undefined,
            'domain_return_forbidden',
            'Passing does not take a return route',
          );
        else {
          check(input.returnTo !== undefined, 'domain_return_required', 'Choose the return route');
          check(
            ['planned', 'running'].includes(input.returnTo),
            'domain_return_invalid',
            'Choose a valid return route',
          );
        }
        return await f.reviews.submit(caller, input, tx);
      },
    });
    for (const verdict of ['needs_changes', 'fail'] as const) {
      for (const returnTo of ['planned', 'running']) {
        const input: ReviewApplication = {
          ...f.input(await f.reviews.start(f.reviewer.caller, (await f.request()).id)),
          expectedRevision: 0,
          verdict,
        };
        const before = await f.durable();
        await assert.rejects(async () => await f.reviews.apply(f.reviewer.caller, input), {
          code: 'domain_return_required',
        });
        await assert.rejects(
          async () => await f.reviews.apply(f.reviewer.caller, { ...input, returnTo: 'finished' }),
          { code: 'domain_return_invalid' },
        );
        assert.deepEqual(await f.durable(), before);
        const result = (await f.reviews.apply(f.reviewer.caller, {
          ...input,
          returnTo,
        })) as ReviewRequest;
        assert.equal(result.verdict, verdict);
        assert.equal(result.returnTo, returnTo);
      }
    }
    const passing: ReviewApplication = {
      ...f.input(await f.reviews.start(f.reviewer.caller, (await f.request()).id)),
      verdict: 'pass',
      expectedRevision: 0,
    };
    const before = await f.durable();
    await assert.rejects(
      async () => await f.reviews.apply(f.reviewer.caller, { ...passing, returnTo: 'planned' }),
      {
        code: 'domain_return_forbidden',
      },
    );
    assert.deepEqual(await f.durable(), before);
    const result = (await f.reviews.apply(f.reviewer.caller, passing)) as ReviewRequest;
    assert.equal(result.verdict, 'pass');
    assert.equal(Object.hasOwn(result, 'returnTo'), false);
  } finally {
    await f.close();
  }
});

test('public review.submit exposes a strict optional route and carries it through the owner', async () => {
  const f = await fixture();
  const tools = new ToolRegistry(f.scope);
  const ctx = new Context();
  ctx.provide('tools', tools);
  ctx.provide('reviews', f.reviews);
  await ctx.plugin(reviewToolsPlugin);
  const api = new ApiServer(f.scope, tools);
  try {
    const url = await api.start();
    const review = await f.claim();
    f.reviews.registerSubmitOwner({
      id: 'transport-fixture',
      owns: async (request) => request.id === review.id,
      submit: async (caller, input, tx) => await f.reviews.submit(caller, input, tx),
    });
    const input = { ...f.input(review), expectedRevision: 0, returnTo: 'repair' };
    const post = async (value: unknown, token = f.reviewer.token) => {
      const response = await fetch(`${url}/tools/review.submit`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(value),
      });
      return { status: response.status, body: (await response.json()) as any };
    };
    const before = await f.durable();
    for (const returnTo of [null, '', 'a/b', 'a'.repeat(129)])
      assert.equal((await post({ ...input, returnTo })).status, 400);
    assert.equal((await post({ ...input, extra: true })).status, 400);
    assert.equal((await post(input, f.reader.token)).status, 403);
    assert.deepEqual(await f.durable(), before);
    const saved = await post(input);
    assert.equal(saved.status, 200);
    assert.equal(saved.body.result.returnTo, 'repair');
    assert.deepEqual(await post(input), saved);
    assert.equal((await post({ ...input, returnTo: 'retry' })).body.error.code, 'request_conflict');
  } finally {
    await api.stop();
    await ctx.fiber.dispose();
    await tools.close();
    await f.close();
  }
});

test('Tasks reject supplied routes before command replay and agree with workflow preflight', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-task-return-'));
  const app = await createApp({ directory, api: false });
  let closeWork = async () => {};
  try {
    const boot = await app.ctx.scope.credentials.bootstrap({
      projectName: 'Task fixed routes',
      actorName: 'Operator',
    });
    const operator = {
      actorId: boot.actor.id,
      projectId: boot.project.id,
      credentialId: boot.credential.id,
    };
    const producer = operator;
    const work = currentWork(app.ctx, { directory: join(directory, 'work'), source: operator });
    closeWork = () => work.close();
    const task = await currentTask(app.ctx, producer, {
      title: 'Verify',
      goal: 'Verify the result.',
      checks: ['The result is correct.'],
      requestId: 'task',
    });
    const writer = await work.lease(task);
    const proof = await work.run(
      writer,
      'artifact.create',
      { title: 'Proof', content: '42 was independently verified.' },
      (caller, input) => app.ctx.artifacts.create(caller, input as never),
    );
    await work.commit(writer);
    const pending = await work.run(
      writer,
      'task.submit_delivery',
      confirmedDelivery({
        artifactIds: [proof.id],
        requestId: 'delivery',
      }),
      (caller, input) => app.ctx.tasks.submitDelivery(caller, input as never),
    );
    await work.release(writer);
    const reviewLease = await work.lease(pending);
    const reviewer = reviewLease.worker;
    const review = await app.ctx.reviews.get(operator, pending.reviewId!);
    // A new task's delivery is also reviewed for its report's format, after its own check.
    assert.deepEqual(review.criteria.slice(1), [DELIVERY_REPORT_CRITERION]);
    const input: ReviewApplication = {
      reviewId: review.id,
      claimId: review.claimId!,
      verdict: 'pass',
      notes: 'Verified independently.',
      synopsis: 'The retained result was independently checked and satisfies the requested goal.',
      findings: [
        {
          criterionNumber: 1,
          status: 'met',
          evidenceIds: [proof.id],
          notes: 'Recomputed the result.',
        },
        {
          criterionNumber: 2,
          status: 'met',
          evidenceIds: [proof.id],
          notes: 'The report has the required parts.',
        },
      ],
      expectedRevision: pending.workflow.revision,
      requestId: 'submit',
    };
    const durable = async () =>
      await app.ctx.state.read(async (sql) => ({
        reviews: await sql.all('SELECT * FROM reviews'),
        tasks: await sql.all('SELECT * FROM tasks'),
        commands: await sql.all('SELECT * FROM task_commands'),
        reviewCommands: await sql.all('SELECT * FROM review_commands'),
        workflows: await sql.all('SELECT * FROM wf_instances'),
        events: await app.ctx.state.events(operator.projectId),
      }));
    const before = await durable();
    for (const returnTo of ['in_progress', 'done', null]) {
      const invalid = { ...input, returnTo } as ReviewApplication;
      // A verdict goes through Reviews.apply, which refuses a route that is no identifier first.
      await assert.rejects(async () => await app.ctx.tasks.submitReview(reviewer, invalid), {
        code: returnTo === null ? 'invalid_return_to' : 'invalid_review_return',
      });
      const decision = await app.ctx.workflows.evaluate(reviewer, task.id, {
        action: 'submit_review',
        input: { ...invalid },
      });
      assert.ok(decision.blockers.some((blocker) => blocker.code === 'invalid_review_return'));
    }
    await assert.rejects(
      async () => await app.ctx.reviews.apply(reviewer, { ...input, returnTo: 'in_progress' }),
      {
        code: 'invalid_review_return',
      },
    );
    let routeReads = 0;
    const accessor = Object.defineProperty({ ...input }, 'returnTo', {
      enumerable: true,
      get() {
        routeReads++;
        throw new Error('Task route accessor was evaluated');
      },
    });
    // Reviews.apply refuses an accessor or an odd prototype before reading any route.
    await assert.rejects(async () => await app.ctx.tasks.submitReview(reviewer, accessor), {
      code: 'invalid_return_to',
    });
    const proxyPrototype = new Proxy(
      {},
      {
        get() {
          routeReads++;
          throw new Error('No Task inherited getter');
        },
      },
    );
    const inherited = Object.create(proxyPrototype, Object.getOwnPropertyDescriptors(input));
    await assert.rejects(async () => await app.ctx.tasks.submitReview(reviewer, inherited), {
      code: 'invalid_return_to',
    });
    assert.equal(routeReads, 0);
    // A verdict through Tasks is one through Reviews.apply: a field no review takes is refused.
    await assert.rejects(
      async () => await app.ctx.tasks.submitReview(reviewer, { ...input, surprise: 1 } as never),
      { code: 'invalid_review_input' },
    );
    assert.deepEqual(await durable(), before);
    const result = await work.run(reviewLease, 'review.submit', input as never, (caller, bound) =>
      app.ctx.reviews.apply(caller, bound as never),
    );
    await work.release(reviewLease);
    // Whether or not a sweep has closed the session and retired its actor yet, the retry
    // learns the same thing; the sweep runs first here so the order is fixed.
    await app.ctx.sessions.sweep();
    await (app.ctx.codeWork as CodeService).submissions.reconcile();
    const committed = await durable();
    assert.equal((result as { workflow: { state: string } }).workflow.state, 'done');
    // This worker handed off its lease; a fresh transport cannot revive its successful command.
    await assert.rejects(app.ctx.reviews.apply(reviewer, { ...input, returnTo: undefined }), {
      code: 'session_completed',
    });
    await assert.rejects(
      app.ctx.reviews.apply(reviewer, Object.assign(Object.create(null), input)),
      { code: 'session_completed' },
    );
    await assert.rejects(
      async () => await app.ctx.reviews.apply(operator, { ...input, returnTo: 'done' }),
      {
        code: 'invalid_review_return',
      },
    );
    assert.deepEqual(await durable(), committed);
    assert.equal(Object.hasOwn(await app.ctx.reviews.get(operator, review.id), 'returnTo'), false);
  } finally {
    await closeWork();
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

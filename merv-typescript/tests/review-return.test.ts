import { createService } from '@merv/contracts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from 'cordis';

import { ProjectScope } from '@merv/scope';
import { DiskBlobs } from '@merv/blobs';
import { ArtifactStore } from '@merv/artifacts';
import { ReviewService } from '@merv/reviews';
import { reviewToolsPlugin } from '@merv/reviews/tools';
import { ApiServer, ToolRegistry } from '@merv/api';
import {
  check,
  digest,
  type ReviewApplication,
  type ReviewRequest,
  type ReviewSubmit,
} from '@merv/contracts';
import { createApp } from './fixtures/app.js';
import { confirmedDelivery } from './fixtures/task-evidence.js';
import { openState } from './fixtures/state.js';
import { assessment } from './fixtures/review-verdict.js';

async function fixture(maximumMigration = Infinity) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-review-return-'));
  const path = directory;
  const state = await openState(path);
  const scope = await createService(new ProjectScope(state));
  const boot = await scope.bootstrap({ projectName: 'Return route', actorName: 'Operator' });
  const operator = { actorId: boot.actor.id, projectId: boot.project.id };
  const issue = async (role: 'producer' | 'reviewer' | 'reader') => {
    const actor = await scope.issueActor(operator, { name: role, role });
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
        ? migrations.filter((item) => item.version <= maximumMigration)
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
  const claim = async () => await reviews.start(reviewer.caller, (await request()).id);
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

test('Reviews validates return route shape without coercing values or evaluating accessors', async () => {
  const f = await fixture();
  try {
    const input = f.input(await f.claim());
    let propertyReads = 0;
    const hostile = new Proxy(
      {},
      {
        get() {
          propertyReads++;
          throw new Error('No coercion');
        },
      },
    );
    const invalid: unknown[] = [
      null,
      '',
      ' leading',
      'trailing ',
      'a/b',
      '_start',
      'a'.repeat(129),
      [],
      {},
      1,
      true,
      new String('repair'),
      hostile,
    ];
    const inputs: unknown[] = invalid.map((returnTo) => ({ ...input, returnTo }));
    inputs.push(
      Object.defineProperty({ ...input }, 'returnTo', {
        enumerable: true,
        get() {
          propertyReads++;
          throw new Error('No accessor');
        },
      }),
    );
    inputs.push(
      Object.defineProperty({ ...input }, 'returnTo', { value: 'repair', enumerable: false }),
    );
    inputs.push(Object.assign(Object.create({ returnTo: 'repair' }), input));
    const before = await f.durable();
    for (const value of inputs) {
      await assert.rejects(
        async () =>
          await f.reviews.checkSubmit(f.reviewer.caller, input.reviewId, value as ReviewSubmit),
        { code: 'invalid_return_to' },
      );
      await assert.rejects(
        async () => await f.reviews.submit(f.reviewer.caller, value as ReviewSubmit),
        {
          code: 'invalid_return_to',
        },
      );
      await assert.rejects(
        async () => await f.reviews.apply(f.reviewer.caller, value as ReviewApplication),
        {
          code: 'invalid_return_to',
        },
      );
    }
    const proxiedInput = new Proxy(input, {
      get() {
        propertyReads++;
        throw new Error('No proxy get');
      },
      getOwnPropertyDescriptor() {
        propertyReads++;
        throw new Error('No proxy descriptor');
      },
      has() {
        propertyReads++;
        throw new Error('No proxy has');
      },
    });
    const revoked = Proxy.revocable(input, {});
    revoked.revoke();
    const proxyPrototype = new Proxy(
      {},
      {
        has() {
          propertyReads++;
          throw new Error('No inherited proxy has');
        },
      },
    );
    const inheritedProxy = Object.create(proxyPrototype, Object.getOwnPropertyDescriptors(input));
    const revokedPrototype = Object.create(revoked.proxy, Object.getOwnPropertyDescriptors(input));
    for (const value of [
      proxiedInput,
      revoked.proxy,
      inheritedProxy,
      revokedPrototype,
      null,
      [],
      'route',
      1,
    ]) {
      await assert.rejects(
        async () => await f.reviews.submit(f.reviewer.caller, value as ReviewSubmit),
        {
          code: 'invalid_return_to',
        },
      );
      await assert.rejects(
        async () => await f.reviews.apply(f.reviewer.caller, value as ReviewApplication),
        {
          code: 'invalid_return_to',
        },
      );
    }
    assert.equal(propertyReads, 0);
    assert.deepEqual(await f.durable(), before);
    // Generic Reviews imposes no verdict-to-route policy; an integrating owner decides that.
    const result = await f.reviews.submit(f.reviewer.caller, {
      ...input,
      verdict: 'pass',
      returnTo: `A${'b'.repeat(127)}`,
    });
    assert.equal(result.returnTo?.length, 128);
  } finally {
    await f.close();
  }
});

test('omitted or explicitly undefined return routes preserve the old wire and replay contract', async () => {
  const f = await fixture();
  try {
    const input = f.input(await f.claim());
    const result = await f.reviews.submit(f.reviewer.caller, input);
    assert.equal(Object.hasOwn(result, 'returnTo'), false);
    assert.equal(
      Object.hasOwn((await f.state.events(f.operator.projectId)).at(-1)!.data, 'returnTo'),
      false,
    );
    assert.deepEqual(
      await f.reviews.submit(f.reviewer.caller, { ...input, returnTo: undefined }),
      result,
    );
  } finally {
    await f.close();
  }
});

test('migration adds nullable route storage without rewriting old submitted rows or request receipts', async () => {
  const f = await fixture(5);
  try {
    const claim = await f.claim(),
      input = f.input(claim);
    const oldResult = {
      ...claim,
      status: 'submitted' as const,
      verdict: input.verdict,
      notes: input.notes,
    };
    await f.state.transaction(async (tx) => {
      await tx.run(
        "UPDATE reviews SET status='submitted',verdict=?,notes=? WHERE id=?",
        input.verdict,
        input.notes,
        claim.id,
      );
      await tx.run(
        'INSERT INTO review_commands VALUES(?,?,?,?,?,?)',
        f.operator.projectId,
        f.reviewer.caller.actorId,
        input.requestId,
        'submit',
        digest(input),
        JSON.stringify(oldResult),
      );
    });
    const before = await f.durable();
    const reviews = await createService(new ReviewService(f.state, f.scope, f.artifacts));
    const after = await f.durable();
    assert.deepEqual(
      after.reviews.map(
        ({
          return_to: route,
          excluded_actor_ids: exclusions,
          required_criteria: required,
          provenance_json: provenance,
          ...row
        }) => {
          assert.equal(route, null);
          assert.equal(exclusions, null);
          assert.equal(required, null);
          assert.equal(provenance, null);
          return row;
        },
      ),
      before.reviews.map((row) => ({ ...row })),
    );
    assert.deepEqual(after.commands, before.commands);
    assert.deepEqual(after.events, before.events);
    assert.deepEqual(await reviews.get(f.reader.caller, claim.id), oldResult);
    assert.deepEqual(
      await reviews.submit(f.reviewer.caller, { ...input, returnTo: undefined }),
      oldResult,
    );
    await assert.rejects(
      async () => await reviews.submit(f.reviewer.caller, { ...input, returnTo: 'repair' }),
      {
        code: 'request_conflict',
      },
    );
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
          ...f.input(await f.claim()),
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
      ...f.input(await f.claim()),
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
  const app = await createApp({
    directory,
    api: false,
    components: [
      'state',
      'scope',
      'blobs',
      'artifacts',
      'domain-events',
      'workflows',
      'context-builder',
      'reviews',
      'tasks',
    ],
  });
  try {
    const boot = await app.ctx.scope.bootstrap({
      projectName: 'Task fixed routes',
      actorName: 'Operator',
    });
    const operator = { actorId: boot.actor.id, projectId: boot.project.id };
    const actor = async (role: 'producer' | 'reviewer') => ({
      actorId: (await app.ctx.scope.issueActor(operator, { name: role, role })).actor.id,
      projectId: boot.project.id,
    });
    const producer = await actor('producer'),
      reviewer = await actor('reviewer');
    const proof = await app.ctx.artifacts.create(producer, {
      title: 'Proof',
      content: '42 was independently verified.',
    });
    const task = await app.ctx.tasks.create(producer, {
      title: 'Verify',
      goal: 'Verify the result.',
      checks: ['The result is correct.'],
      requestId: 'task',
    });
    const pending = await app.ctx.tasks.submitDelivery(
      producer,
      confirmedDelivery(
        { taskId: task.id, expectedRevision: 0, artifactIds: [proof.id], requestId: 'delivery' },
        1,
      ),
    );
    const review = await app.ctx.reviews.start(reviewer, pending.reviewId!);
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
      await assert.rejects(async () => await app.ctx.tasks.submitReview(reviewer, invalid), {
        code: 'invalid_review_return',
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
    await assert.rejects(async () => await app.ctx.tasks.submitReview(reviewer, accessor), {
      code: 'invalid_review_return',
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
      code: 'invalid_review_return',
    });
    assert.equal(routeReads, 0);
    assert.deepEqual(await durable(), before);
    const result = await app.ctx.reviews.apply(reviewer, input);
    const committed = await durable();
    assert.deepEqual(
      await app.ctx.reviews.apply(reviewer, { ...input, returnTo: undefined }),
      result,
    );
    assert.deepEqual(
      await app.ctx.reviews.apply(reviewer, Object.assign(Object.create(null), input)),
      result,
    );
    await assert.rejects(
      async () => await app.ctx.tasks.submitReview(reviewer, { ...input, returnTo: 'done' }),
      {
        code: 'invalid_review_return',
      },
    );
    await assert.rejects(
      async () => await app.ctx.reviews.apply(reviewer, { ...input, returnTo: 'done' }),
      {
        code: 'invalid_review_return',
      },
    );
    assert.deepEqual(await durable(), committed);
    assert.equal(Object.hasOwn(await app.ctx.reviews.get(reviewer, review.id), 'returnTo'), false);
  } finally {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

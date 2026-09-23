import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { childRequest, type Caller, type TaskReview } from '@merv/contracts';
import { createApp } from './fixtures/app.js';
import type { ApplicationConfig } from '../src/config.js';
import { confirmedDelivery, reviewedFindings } from './fixtures/task-evidence.js';
import { s3Server } from './fixtures/s3-server.js';
import { postgresUrl, schemaFor } from './fixtures/state.js';

const production = async (): Promise<ApplicationConfig> =>
  JSON.parse(await readFile(new URL('../config/production.example.json', import.meta.url), 'utf8'));

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'merv-production-storage-'));
  const envName = `MERV_STORAGE_TEST_${randomUUID().replaceAll('-', '').toUpperCase()}`;
  process.env[envName] = postgresUrl;
  const server = await s3Server();
  const config = await production();
  config.plugins.find((entry) => entry.id === 'state')!.config = {
    backend: 'postgres',
    connectionStringEnv: envName,
    schema: schemaFor(),
    maxConnections: 5,
    connectionTimeoutMs: 3000,
    lockTimeoutMs: 3000,
  };
  const blobs = config.plugins.find((entry) => entry.id === 'blobs')!;
  // The production provider schema intentionally cannot enable HTTP. A test-only
  // module composes the same S3 provider against our fake loopback endpoint.
  const module = join(directory, 'test-blobs.mjs');
  const source = new URL('../packages/blobs/src/index.ts', import.meta.url).href;
  await writeFile(
    module,
    `import { S3Blobs } from ${JSON.stringify(source)};
export default {
  name: 'merv-blobs',
  apply(ctx, config) {
    const blobs = new S3Blobs({ bucket: 'merv-artifacts', endpoint: config.endpoint,
      accessKeyId: 'fixture-access-key', secretAccessKey: 'fixture-secret-key',
      prefix: 'integration', allowHttpLoopbackForTests: true, timeoutMs: 5000, maxAttempts: 1 });
    ctx.effect(function* () { yield () => blobs.close(); yield ctx.provide('blobs', blobs); });
  }
};
`,
  );
  blobs.name = pathToFileURL(module).href;
  blobs.config = { endpoint: server.endpoint };
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  t.after(async () => {
    await app?.stop();
    await server.close();
    delete process.env[envName];
    await rm(directory, { recursive: true, force: true });
  });
  const start = async () => {
    app = await createApp({ directory, config, port: 0 });
    return app;
  };
  return {
    server,
    start,
    restart: async () => {
      await app!.stop();
      return start();
    },
  };
}

test('production example preserves the full composition and changes only storage provider config', async () => {
  const baseline: ApplicationConfig = JSON.parse(
    await readFile(new URL('../config/default.json', import.meta.url), 'utf8'),
  );
  const selected = await production();
  assert.deepEqual(
    selected.plugins.map((p) => p.id),
    baseline.plugins.map((p) => p.id),
  );
  for (const plugin of selected.plugins) {
    const previous = baseline.plugins.find((p) => p.id === plugin.id)!;
    if (plugin.id === 'state' || plugin.id === 'blobs')
      assert.deepEqual({ ...plugin, config: undefined }, { ...previous, config: undefined });
    else assert.deepEqual(plugin, previous);
  }
  assert.deepEqual(selected.plugins.find((p) => p.id === 'state')!.config?.ssl, {
    rejectUnauthorized: true,
  });
  assert.equal(
    selected.plugins.find((p) => p.id === 'state')!.config?.connectionStringEnv,
    'MERV_DB_URL',
  );
  assert.equal(
    selected.plugins.find((p) => p.id === 'blobs')!.config?.secretAccessKeyEnv,
    'MERV_BLOB_SECRET_ACCESS_KEY',
  );
});

test(
  `assembled PostgreSQL + S3 preserves artifact, review, event and replay atomicity across restarts`,
  { timeout: 90_000 },
  async (t) => {
    const f = await fixture(t);
    let app = await f.start();
    assert.ok(
      app
        .status()
        .filter((p) => p.required)
        .every((p) => p.state === 'active'),
    );
    const identity = await app.ctx.scope.bootstrap({
      projectName: 'Production storage',
      actorName: 'Operator',
    });
    const operator: Caller = { actorId: identity.actor.id, projectId: identity.project.id };
    const producerIdentity = await app.ctx.scope.issueActor(operator, {
      name: 'Producer',
      role: 'producer',
    });
    const reviewerIdentity = await app.ctx.scope.issueActor(operator, {
      name: 'Reviewer',
      role: 'reviewer',
    });
    const producer: Caller = {
      actorId: producerIdentity.actor.id,
      projectId: operator.projectId,
    };
    const reviewer: Caller = {
      actorId: reviewerIdentity.actor.id,
      projectId: operator.projectId,
    };
    assert.equal((await app.ctx.scope.authenticate(identity.token)).id, operator.actorId);
    const artifact = await app.ctx.artifacts.create(producer, {
      title: 'Evidence',
      content: 'The verified sum is 20.',
    });
    assert.equal(
      (await app.ctx.artifacts.read(producer, artifact.id)).content,
      'The verified sum is 20.',
    );
    const eventsBefore = await app.ctx.state.events(operator.projectId);
    const beforeArtifacts = await app.ctx.artifacts.list(operator);
    f.server.fail(503);
    try {
      await assert.rejects(
        app.ctx.artifacts.create(producer, {
          title: 'Rejected bytes',
          content: 'Storage has not acknowledged these bytes.',
        }),
        { code: 'blob_unavailable' },
      );
    } finally {
      f.server.fail();
    }
    assert.deepEqual(await app.ctx.artifacts.list(operator), beforeArtifacts);
    assert.deepEqual(await app.ctx.state.events(operator.projectId), eventsBefore);
    const create = {
      title: 'Arithmetic',
      goal: 'Verify the sum.',
      checks: ['The sum is 20.'],
      requestId: 'create-task',
    };
    const task = await app.ctx.tasks.create(producer, create);
    assert.deepEqual(await app.ctx.tasks.create(producer, create), task);
    await assert.rejects(app.ctx.tasks.create(producer, { ...create, title: 'Changed input' }), {
      code: 'request_conflict',
    });
    const assignment = await app.ctx.workflows.begin(producer, {
      instanceId: task.id,
      expectedRevision: task.workflow.revision,
    });
    assert.ok(assignment.context?.prompt.includes('Verify the sum.'));
    const pending = await app.ctx.tasks.submitDelivery(
      producer,
      confirmedDelivery({
        taskId: task.id,
        artifactIds: [artifact.id],
        expectedRevision: task.workflow.revision,
        requestId: 'delivery',
      }),
    );
    assert.equal(pending.workflow.state, 'in_review');
    const claim = await app.ctx.reviews.start(reviewer, pending.reviewId!);
    const verdict: TaskReview = {
      ...reviewedFindings(claim),
      reviewId: claim.id,
      claimId: claim.claimId!,
      expectedRevision: pending.workflow.revision,
      verdict: 'pass',
      notes: 'Verified independently.',
      requestId: 'verdict',
    };
    const before = await app.ctx.state.events(operator.projectId);
    const append = app.ctx.state.appendEvent.bind(app.ctx.state);
    app.ctx.state.appendEvent = async (tx, event) => {
      const stored = await append(tx, event);
      if (event.type === 'task.review_applied')
        throw new Error('injected failure after verdict and transition');
      return stored;
    };
    try {
      await assert.rejects(app.ctx.tasks.submitReview(reviewer, verdict), /injected failure/);
    } finally {
      app.ctx.state.appendEvent = append;
    }
    assert.equal((await app.ctx.tasks.get(operator, task.id)).workflow.state, 'in_review');
    assert.equal((await app.ctx.reviews.get(operator, claim.id)).status, 'started');
    assert.deepEqual(await app.ctx.state.events(operator.projectId), before);
    assert.equal(
      await app.ctx.state.read(
        async (sql) =>
          (await sql.get<{ count: number }>(
            'SELECT COUNT(*) AS count FROM task_commands WHERE project_id=? AND actor_id=? AND request_id=?',
            operator.projectId,
            reviewer.actorId,
            verdict.requestId,
          ))!.count,
      ),
      0,
    );
    assert.equal(
      await app.ctx.state.read(
        async (sql) =>
          (await sql.get<{ count: number }>(
            'SELECT COUNT(*) AS count FROM review_commands WHERE project_id=? AND actor_id=? AND request_id=?',
            operator.projectId,
            reviewer.actorId,
            childRequest(reviewer, 'task', 'review', verdict.requestId),
          ))!.count,
      ),
      0,
    );
    app = await f.restart();
    assert.equal((await app.ctx.tasks.get(operator, task.id)).workflow.state, 'in_review');
    assert.equal((await app.ctx.reviews.get(operator, claim.id)).claimId, claim.claimId);
    const done = await app.ctx.tasks.submitReview(reviewer, verdict);
    assert.equal(done.workflow.state, 'done');
    const committed = await app.ctx.state.events(operator.projectId);
    assert.equal(
      committed.filter((event) => event.type === 'review.submitted' && event.subjectId === claim.id)
        .length,
      1,
    );
    assert.equal(
      committed.filter(
        (event) => event.type === 'task.review_applied' && event.subjectId === task.id,
      ).length,
      1,
    );
    assert.deepEqual(await app.ctx.tasks.submitReview(reviewer, verdict), done);
    assert.deepEqual(await app.ctx.state.events(operator.projectId), committed);
    app = await f.restart();
    assert.deepEqual(await app.ctx.tasks.submitReview(reviewer, verdict), done);
    assert.equal((await app.ctx.tasks.get(operator, task.id)).workflow.state, 'done');
    const response = await fetch(`${app.ctx.api.url}/tools/artifact.read`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${identity.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ artifactId: artifact.id }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).result.content, 'The verified sum is 20.');
    assert.ok(
      f.server.requests.some(
        (request) => request.method === 'PUT' && request.headers['if-none-match'] === '*',
      ),
    );
    const held = f.server.holdNext('GET');
    const reading = app.ctx.artifacts.read(operator, artifact.id);
    await held.started;
    let unloaded = false;
    const unloading = app.setEnabled('blobs', false).then(() => {
      unloaded = true;
    });
    try {
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(unloaded, false);
    } finally {
      held.release();
    }
    assert.equal((await reading).content, 'The verified sum is 20.');
    await unloading;
    assert.equal(app.ctx.get('artifacts'), undefined);
    await app.setEnabled('blobs', true);
    assert.equal(
      (await app.ctx.artifacts.read(operator, artifact.id)).content,
      'The verified sum is 20.',
    );
  },
);

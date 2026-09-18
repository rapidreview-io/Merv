import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignJWT } from 'jose';
import { Pool } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  Artifact,
  Caller,
  ContextPackage,
  IssuedUserKey,
  Project,
  ReviewRequest,
  Task,
} from '@merv/contracts';
import type { Session } from '@merv/sessions/types';
import type {} from '@merv/reflections/types';
import { createApp } from '../src/app.js';
import type { ApplicationConfig } from '../src/config.js';
import { confirmedDelivery, reviewedFindings } from './fixtures/task-evidence.js';

const freshSecret = () => `ms_${randomBytes(32).toString('base64url')}`;

async function fixture(t: TestContext, postgres = false) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-sessions-integrated-'));
  const env = `MERV_SESSIONS_TEST_${randomUUID().replaceAll('-', '')}`;
  const signingSecret = 'synthetic-session-integration-signing-secret-at-least-32-bytes';
  process.env[env] = signingSecret;
  const config = JSON.parse(
    readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
  ) as ApplicationConfig;
  // The UI's tools nest other reads; the page shell serves no assets here.
  config.plugins = config.plugins.filter((entry) => entry.id !== 'ui-web');
  config.plugins.find((entry) => entry.id === 'identity')!.config = {
    supabaseUrl: 'https://sessions.example.test',
    mode: 'hs256',
    secretEnv: env,
  };
  const schema = `merv_integrated_${randomUUID().replaceAll('-', '')}`;
  if (postgres)
    config.plugins.find((entry) => entry.id === 'state')!.config = {
      backend: 'postgres',
      connectionStringEnv: 'MERV_TEST_POSTGRES_URL',
      schema,
    };
  let app = await createApp({ directory, config, port: 0 });
  const clients = new Set<Client>();
  t.after(async () => {
    await Promise.allSettled([...clients].map((client) => client.close()));
    await app.stop();
    delete process.env[env];
    rmSync(directory, { recursive: true, force: true });
    if (postgres) {
      const pool = new Pool({ connectionString: process.env.MERV_TEST_POSTGRES_URL });
      try {
        await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await pool.end();
      }
    }
  });
  const human = await new SignJWT({ role: 'authenticated', is_anonymous: false })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('https://sessions.example.test/auth/v1')
    .setSubject('session-owner')
    .setAudience('authenticated')
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(signingSecret));
  async function http<T>(
    path: string,
    bearer: string,
    body?: unknown,
    projectId?: string,
    method?: string,
  ) {
    const response = await fetch(`${app.ctx.api.url}${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: {
        authorization: `Bearer ${bearer}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(projectId === undefined ? {} : { 'x-merv-project-id': projectId }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as T };
  }
  const created = await http<{ project: Project }>('/projects', human, {
    name: 'Session integration',
    requestId: 'project',
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const project = created.body.project;
  const issued = await http<IssuedUserKey>('/account/keys', human, {
    projectId: project.id,
    label: 'One shared source for independent workers',
  });
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  const key = issued.body;
  const source = async (): Promise<Caller> =>
    await app.ctx.scope.caller(
      { kind: 'key', key: await app.ctx.scope.authenticateKey(key.token) },
      project.id,
    );
  const taskInput = {
    title: 'Independent worker delivery',
    goal: 'Produce independently reviewed evidence.',
    checks: ['The evidence records an independently verifiable result.'],
    requestId: 'create-task',
  };
  const createdTask = await http<{ result: Task }>(
    '/tools/task.create',
    key.token,
    taskInput,
    project.id,
  );
  assert.equal(createdTask.status, 200, JSON.stringify(createdTask.body));
  const task = createdTask.body.result;
  async function offer(target = task, requestId = randomUUID(), secret = freshSecret()) {
    const input = {
      instanceId: target.id,
      expectedRevision: target.workflow.revision,
      runnerId: 'test-runner',
      requestId,
      secret,
    };
    const result = await http<{ session: Session }>(
      '/sessions/offer',
      key.token,
      input,
      project.id,
    );
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return { session: result.body.session, secret, input };
  }
  async function connect(secret: string) {
    const client = new Client({ name: 'real-session-integration', version: '1' });
    clients.add(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${app.ctx.api.url}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${secret}` } },
      }),
    );
    return client;
  }
  async function call<T>(
    client: Client,
    name: string,
    input: Record<string, unknown> = {},
  ): Promise<T> {
    const result = await client.callTool({ name, arguments: input });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return JSON.parse((result.content as { type: string; text: string }[])[0].text) as T;
  }
  async function restart() {
    await Promise.allSettled([...clients].map((client) => client.close()));
    clients.clear();
    await app.stop();
    app = await createApp({ directory, config, port: 0 });
  }
  return {
    get app() {
      return app;
    },
    directory,
    project,
    task,
    human,
    key,
    source,
    http,
    offer,
    connect,
    call,
    restart,
  };
}

async function reviewFlow(t: TestContext, postgres = false) {
  const f = await fixture(t, postgres);
  const work = await f.offer();
  assert.equal(work.session.status, 'offered');
  assert.equal(work.session.activatedAt, null);
  assert.notEqual(work.session.actorId, (await f.source()).actorId);
  assert.equal(work.session.source.kind, 'key');
  assert.equal(work.session.source.actorId, (await f.source()).actorId);
  assert.deepEqual(await f.app.ctx.workflows.workStarts(await f.source(), f.task.id), []);
  const worker = await f.connect(work.secret);
  const catalog = (await worker.listTools()).tools.map((tool) => tool.name);
  assert.ok(catalog.includes('artifact.create'));
  // Reads are open to every session; writes are only what the policy grants.
  assert.ok(catalog.includes('task.list'));
  for (const name of ['actor.create', 'task.create', 'workflow.begin'])
    assert.ok(!catalog.includes(name), name);
  // A worker's page reads nest other reads inside one snapshot; they answer, unrecorded.
  const shell = await f.call<{ project: { id: string } }>(worker, 'ui.shell', {});
  assert.equal(shell.project.id, f.project.id);
  const home = await f.call<{ tasks: unknown[] | null }>(worker, 'ui.home', {});
  assert.ok(Array.isArray(home.tasks) && home.tasks.length >= 1);
  const artifact = await f.call<Artifact>(worker, 'artifact.create', {
    title: 'Worker result',
    content: 'The evidence records an independently verifiable result: 7 × 6 = 42.',
  });
  assert.equal(artifact.createdBy, work.session.actorId);
  const read = await f.call<{ content: string }>(worker, 'artifact.read', {
    artifactId: artifact.id,
  });
  assert.match(read.content, /42/);
  await f.call(worker, 'task.checkpoint', {
    notes: 'Arithmetic verified before submission.',
    artifactIds: [artifact.id],
    requestId: 'checkpoint',
  });
  const delivered = await f.call<Task>(
    worker,
    'task.submit_delivery',
    confirmedDelivery({ artifactIds: [artifact.id], requestId: 'delivery' }),
  );
  assert.equal(
    delivered.workflow.state,
    'in_review',
    'Transition and its hydration commit within one invocation',
  );
  const pinned = await f.app.ctx.reviews.get(await f.source(), delivered.reviewId!);
  assert.equal(pinned.producerId, work.session.actorId);
  assert.ok(pinned.artifactIds.includes(f.task.briefId));
  assert.ok(pinned.artifactIds.includes(artifact.id));
  // A poll right after the handoff runs on a read snapshot and still reports the closure.
  const polled = await f.http<{ session: Session }>(
    `/sessions/${work.session.id}`,
    f.key.token,
    undefined,
    f.project.id,
  );
  assert.equal(polled.status, 200, JSON.stringify(polled.body));
  assert.equal(polled.body.session.status, 'released');
  assert.equal(polled.body.session.outcome, 'completed');

  const review = await f.offer(delivered);
  assert.equal(review.session.source.actorId, work.session.source.actorId);
  assert.equal(review.session.source.kind, 'key');
  if (review.session.source.kind === 'key' && work.session.source.kind === 'key')
    assert.equal(review.session.source.keyId, work.session.source.keyId);
  assert.notEqual(review.session.actorId, work.session.actorId);
  const reviewer = await f.connect(review.secret);
  const reviewerCatalog = (await reviewer.listTools()).tools.map((tool) => tool.name);
  assert.ok(reviewerCatalog.includes('review.submit'));
  assert.ok(!reviewerCatalog.includes('artifact.create'));
  const claim = await f.call<ReviewRequest>(reviewer, 'review.start');
  assert.equal(claim.reviewerId, review.session.actorId);
  const completed = await f.call<Task>(reviewer, 'review.submit', {
    verdict: 'pass',
    notes: 'Independently checked that multiplication produces the claimed result.',
    ...reviewedFindings(claim),
    requestId: 'verdict',
  });
  assert.equal(completed.workflow.state, 'done');
  const starts = await f.app.ctx.workflows.workStarts(await f.source(), f.task.id);
  assert.equal(starts.length, 2);
  assert.deepEqual(
    new Set(starts.map((start) => start.actorId)),
    new Set([work.session.actorId, review.session.actorId]),
  );
  const finalReview = await f.app.ctx.reviews.get(await f.source(), delivered.reviewId!);
  assert.equal(finalReview.producerId, work.session.actorId);
  assert.equal(finalReview.reviewerId, review.session.actorId);
  assert.equal(finalReview.verdict, 'pass');
  return f;
}

test('one user key can authorize independent producer and reviewer sessions through the real HTTP and MCP surfaces', async (t) => {
  await reviewFlow(t);
});

test(
  'PostgreSQL full application retains task delivery, independent review and live reflection metadata',
  {
    skip: !process.env.MERV_TEST_POSTGRES_URL,
  },
  async (t) => {
    const f = await reviewFlow(t, true);
    assert.equal((await f.http('/account/keys', f.human)).status, 200);
    const caller = await f.source();
    const wave = (await f.app.ctx.tools.call('reflection.create', caller, {
      title: 'Native PostgreSQL reflection',
      requestId: 'postgres-reflection',
    })) as { id: string; lenses: unknown[] };
    assert.equal(wave.lenses.length, 5);
    const loaded = await f.app.ctx.reflections.get(caller, wave.id);
    assert.equal(loaded.lenses.length, 5);
    const originalTask = await f.app.ctx.tasks.get(caller, f.task.id);
    assert.equal(originalTask.workflow.state, 'done');
    await f.restart();
    assert.equal((await f.app.ctx.reflections.get(await f.source(), wave.id)).lenses.length, 5);
  },
);

test('a real session survives restart and a released worker yields bounded context to its successor', async (t) => {
  const f = await fixture(t);
  const work = await f.offer();
  let worker = await f.connect(work.secret);
  const artifact = await f.call<Artifact>(worker, 'artifact.create', {
    title: 'Unfinished evidence',
    content: 'PREDECESSOR_RESULT_7_BY_6_IS_42',
  });
  await f.call(worker, 'task.checkpoint', {
    notes: 'I verified the arithmetic; independently check and submit it.',
    artifactIds: [artifact.id],
    requestId: 'checkpoint',
  });
  await f.restart();
  worker = await f.connect(work.secret);
  assert.equal((await f.call<Task>(worker, 'task.get')).id, f.task.id);
  assert.equal(
    (await f.app.ctx.workflows.workStarts(await f.source(), f.task.id)).length,
    1,
    'Restart must not record a second first-start',
  );
  const released = await f.http<{ session: Session }>(
    `/sessions/${work.session.id}/release`,
    f.key.token,
    { runnerId: work.input.runnerId, reason: 'Replace the worker and preserve progress' },
    f.project.id,
  );
  assert.equal(released.status, 200, JSON.stringify(released.body));
  assert.equal(released.body.session.status, 'released');
  assert.equal(
    (await f.app.ctx.scope.actors(await f.source())).find(
      (actor) => actor.id === work.session.actorId,
    )!.active,
    false,
  );
  assert.equal(
    (await f.app.ctx.scope.require(await f.source(), 'write')).active,
    true,
    'Worker retirement leaves its source usable',
  );
  const refused = await f.http(`/mcp`, work.secret, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'task.checkpoint', arguments: { notes: 'Stale worker', requestId: 'stale' } },
  });
  assert.ok([401, 403, 409].includes(refused.status), JSON.stringify(refused));
  await f.app.ctx.domainEvents.drain();
  const successor = await f.offer();
  assert.notEqual(successor.session.actorId, work.session.actorId);
  const next = await f.connect(successor.secret);
  const context = await f.call<ContextPackage>(next, 'task.context', {
    requestId: 'successor-context',
  });
  assert.match(context.prompt, /PREDECESSOR_RESULT_7_BY_6_IS_42/);
  assert.match(context.prompt, /verified the arithmetic/);
  assert.equal(
    (await f.app.ctx.workflows.workStarts(await f.source(), f.task.id)).length,
    1,
    'Replacement preserves historical first-start',
  );
});

test('ordinary checkpoint attachments after offer cannot enlarge a running worker context', async (t) => {
  const f = await fixture(t);
  const work = await f.offer();
  const worker = await f.connect(work.secret);
  const unrelated = await f.app.ctx.artifacts.create(await f.source(), {
    title: 'Outside the frozen assignment',
    content: 'UNRELATED_AFTER_OFFER_PRIVATE_BYTES_19834',
  });
  await f.app.ctx.tasks.checkpoint(await f.source(), {
    taskId: f.task.id,
    purpose: 'work',
    expectedRevision: f.task.workflow.revision,
    notes: 'An ordinary account attached extra material.',
    artifactIds: [unrelated.id],
    requestId: 'ordinary-checkpoint',
  });
  // The worker may read it, as it may read anything in the project; its context stays
  // what the offer froze.
  const read = await worker.callTool({
    name: 'artifact.read',
    arguments: { artifactId: unrelated.id },
  });
  assert.equal(read.isError, undefined, JSON.stringify(read));
  const context = await f.call<ContextPackage>(worker, 'task.context', {
    requestId: 'bounded-context',
  });
  assert.ok(!context.prompt.includes('UNRELATED_AFTER_OFFER_PRIVATE_BYTES_19834'));
  const assignment = await f.call<Record<string, unknown>>(worker, 'workflow.assignment');
  assert.ok(!JSON.stringify(assignment).includes('UNRELATED_AFTER_OFFER_PRIVATE_BYTES_19834'));
});

test('source revocation after transport admission still refuses the native write transaction', async (t) => {
  const f = await fixture(t);
  const work = await f.offer();
  const worker = await f.connect(work.secret);
  const definition = (await f.app.ctx.tools.list()).find(
    (tool) => tool.name === 'task.checkpoint',
  )!;
  const original = definition.handler;
  let entered!: () => void;
  let resume!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const continueHandler = new Promise<void>((resolve) => {
    resume = resolve;
  });
  definition.handler = async (caller, input) => {
    entered();
    await continueHandler;
    return original(caller, input);
  };
  try {
    const call = worker.callTool({
      name: 'task.checkpoint',
      arguments: {
        notes: 'Must never commit after source revocation.',
        requestId: 'queued-native-write',
      },
    });
    await waiting;
    const revoked = await f.http(
      `/account/keys/${f.key.key.id}`,
      f.human,
      undefined,
      undefined,
      'DELETE',
    );
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    resume();
    const result = await call;
    assert.equal(result.isError, true, JSON.stringify(result));
    const events = await f.app.ctx.state.events(f.project.id);
    assert.equal(events.filter((event) => event.type === 'task.checkpointed').length, 0);
    const checkpoints = await f.app.ctx.state.read(
      async (sql) =>
        (await sql.get<{ count: number }>(
          'SELECT COUNT(*) AS count FROM task_checkpoints WHERE task_id=?',
          f.task.id,
        ))!.count,
    );
    assert.equal(
      checkpoints,
      0,
      'Transport admission must not survive revoked source authority at the writer',
    );
  } finally {
    resume();
    definition.handler = original;
  }
});

test('reviewer replacement preserves evidence and replaces the exact claim without restarting the gate', async (t) => {
  const f = await fixture(t);
  const work = await f.offer();
  const worker = await f.connect(work.secret);
  const artifact = await f.call<Artifact>(worker, 'artifact.create', {
    title: 'Reviewable result',
    content: 'The independently checked result is 42.',
  });
  const delivered = await f.call<Task>(
    worker,
    'task.submit_delivery',
    confirmedDelivery({ artifactIds: [artifact.id], requestId: 'delivery' }),
  );
  const first = await f.offer(delivered);
  const reviewer = await f.connect(first.secret);
  const initial = await f.call<ReviewRequest>(reviewer, 'review.start');
  await f.call(reviewer, 'task.checkpoint', {
    notes: 'Check the multiplication result before deciding the verdict.',
    artifactIds: [artifact.id],
    requestId: 'review-progress',
  });
  const release = await f.http<{ session: Session }>(
    `/sessions/${first.session.id}/release`,
    f.key.token,
    { runnerId: first.input.runnerId, reason: 'Review worker interrupted' },
    f.project.id,
  );
  assert.equal(release.status, 200, JSON.stringify(release.body));
  await f.app.ctx.domainEvents.drain();
  const replacement = await f.offer(delivered);
  const next = await f.connect(replacement.secret);
  const claim = await f.call<ReviewRequest>(next, 'review.start');
  assert.equal(claim.id, initial.id);
  assert.notEqual(claim.claimId, initial.claimId);
  assert.deepEqual(claim.artifactIds, initial.artifactIds);
  assert.equal(claim.snapshotHash, initial.snapshotHash);
  assert.notEqual(claim.reviewerId, initial.reviewerId);
  const context = await f.call<ContextPackage>(next, 'task.context', {
    requestId: 'successor-review-context',
  });
  assert.match(context.prompt, /Check the multiplication result/);
  const rejected = await next.callTool({
    name: 'review.submit',
    arguments: {
      reviewId: claim.id,
      claimId: initial.claimId!,
      verdict: 'pass',
      notes: 'Trying an old ownership handle.',
      ...reviewedFindings(claim),
      requestId: 'old-handle',
    },
  });
  assert.equal(rejected.isError, true);
  const done = await f.call<Task>(next, 'review.submit', {
    verdict: 'pass',
    notes: 'I independently checked the retained evidence.',
    ...reviewedFindings(claim),
    requestId: 'replacement-verdict',
  });
  assert.equal(done.workflow.state, 'done');
  assert.equal((await f.app.ctx.workflows.workStarts(await f.source(), f.task.id)).length, 2);
});

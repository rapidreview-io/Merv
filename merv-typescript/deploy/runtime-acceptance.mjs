/**
 * Run inside the candidate image with its production PG/S3 credentials, but only
 * against a precreated EMPTY merv_ts_smoke_* schema and matching storage prefix.
 * This creates synthetic data. It never imports, dispatches work, mounts tools,
 * changes production routes, or deletes retained test data.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client as PostgresClient } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../dist/src/app.js';

let stage = 'preflight';
function checkpoint(value) {
  stage = value;
  console.log(JSON.stringify({ acceptance: 'running', stage }));
}

/** Reuses the established task, agent-assignment, and research test scenarios. */
export async function exerciseRuntime(start) {
  let app;
  const clients = new Set();
  const closeClients = async () => {
    const results = await Promise.allSettled([...clients].map((client) => client.close()));
    clients.clear();
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
  };
  const connect = async (token) => {
    const client = new Client({ name: 'merv-runtime-acceptance', version: '1' });
    clients.add(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${app.ctx.api.url}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    return client;
  };
  const call = async (client, name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, `MCP ${name} failed`);
    const text = result.content?.find((item) => item.type === 'text')?.text;
    assert.equal(typeof text, 'string', `MCP ${name} had no JSON response`);
    return JSON.parse(text);
  };
  const http = async (path, token, body) => {
    const response = await fetch(`${app.ctx.api.url}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(response.status, 200, `HTTP ${path} failed`);
    return response.json();
  };
  try {
    checkpoint('activate');
    app = await start();
    assert.ok(
      app.status().every((entry) => entry.state === 'active'),
      'Every default plugin must activate',
    );
    assert.ok(app.ctx.artifacts.downloadSupported, 'Acceptance requires the actual S3 provider');
    const pluginCount = app.status().length;
    const page = await fetch(`${app.ctx.api.url}/ui/`, { signal: AbortSignal.timeout(30_000) });
    assert.equal(page.status, 200, 'Compiled UI entrypoint must be served');
    const html = await page.text();
    const asset = html.match(/src="([^"]+\.js)"/)?.[1];
    assert.ok(asset, 'Compiled UI must reference its JavaScript bundle');
    const bundle = await fetch(new URL(asset, `${app.ctx.api.url}/ui/`), {
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(bundle.status, 200, 'Compiled UI bundle must be served');
    assert.match(bundle.headers.get('content-type') ?? '', /javascript/);
    await bundle.arrayBuffer();

    const boot = await app.ctx.scope.bootstrap({
      projectName: 'Synthetic runtime acceptance',
      actorName: 'Smoke operator',
    });
    const owner = {
      projectId: boot.project.id,
      actorId: boot.actor.id,
      credentialId: boot.credential.id,
    };
    const operator = await connect(boot.token);

    // Code keeps one Git repository per project on the data volume. This image must carry a
    // Git the server can run, and the repository root must be writable where the volume is.
    checkpoint('code-repository');
    const codeStatus = await call(operator, 'code.status');
    assert.ok(codeStatus.store, 'This image must keep Code repositories');
    assert.equal(codeStatus.store.hosted, false, 'A synthetic project imports nothing');
    assert.ok(codeStatus.store.quotaBytes > 0);
    assert.equal(codeStatus.mirror.state, 'off', 'Nothing is published for a synthetic project');
    console.log(
      JSON.stringify({
        acceptance: 'running',
        stage: 'code-repository',
        git: execFileSync('/usr/bin/git', ['--version'], { encoding: 'utf8' }).trim(),
      }),
    );

    const secret = `ms_${randomBytes(32).toString('base64url')}`;
    const { agent } = await http('/sessions/agents', boot.token, {
      name: 'Smoke continuing agent',
      runnerId: 'external',
      requestId: 'register',
      secret,
    });
    const createTask = (requestId) =>
      call(operator, 'task.create', {
        title: `Synthetic ${requestId}`,
        goal: 'Verify the sum.',
        checks: ['Two plus three equals five.'],
        requestId,
      });
    const assign = (task, requestId) =>
      http('/sessions/self/assignment', secret, {
        instanceId: task.id,
        expectedRevision: task.workflow.revision,
        requestId,
      });
    const release = (execution) =>
      http('/sessions/self/release', secret, { executionId: execution.id });

    checkpoint('task-delivery');
    const first = await createTask('first-task');
    const { execution: firstExecution } = await assign(first, 'first-assignment');
    const worker = await connect(secret);
    const callerA = await app.ctx.sessions.authenticate(secret);
    const artifact = await call(worker, 'artifact.create', {
      title: 'Synthetic arithmetic evidence',
      content: 'Observed 2 + 3 = 5.',
    });
    assert.equal(
      (await call(worker, 'artifact.read', { artifactId: artifact.id })).content,
      'Observed 2 + 3 = 5.',
    );
    const pending = await call(worker, 'task.submit_delivery', {
      taskId: first.id,
      expectedRevision: first.workflow.revision,
      artifactIds: [artifact.id],
      confirmations: [
        {
          checkNumber: 1,
          status: 'met',
          evidenceIds: [artifact.id],
          notes: 'The synthetic runtime check evaluated 2 + 3 and verified the retained result.',
        },
      ],
      requestId: 'deliver-first',
    });
    assert.equal(pending.workflow.state, 'in_review');
    await release(firstExecution);

    checkpoint('agent-continuity');
    const second = await createTask('second-task');
    const { execution: secondExecution } = await assign(second, 'second-assignment');
    const callerB = await app.ctx.sessions.authenticate(secret);
    assert.equal(
      callerA.actorId,
      callerB.actorId,
      'Agent identity must survive assignment changes',
    );
    assert.equal(callerB.actorId, agent.actorId);
    assert.equal(firstExecution.agentId, secondExecution.agentId);
    assert.notEqual(firstExecution.id, secondExecution.id);
    const secondArtifact = await call(worker, 'artifact.create', {
      title: 'Second assignment output',
      content: 'Synthetic second assignment observation.',
    });
    await call(worker, 'artifact.read', { artifactId: secondArtifact.id });
    const live = await http(`/sessions/agents/${agent.id}/observation`, boot.token);
    assert.equal(
      live.assignments.find((entry) => entry.id === secondExecution.id)?.instanceId,
      second.id,
    );
    assert.equal(live.agent.currentExecutionId, secondExecution.id);
    await release(secondExecution);
    assert.equal((await http('/sessions/self', secret)).current, null);
    const observation = await http(`/sessions/agents/${agent.id}/observation`, boot.token);
    assert.equal(observation.assignments.length, 2);
    assert.equal(observation.tokenStats.totalCalls, 5);
    assert.equal(observation.tokenStats.completedCalls, 5);
    assert.ok(Object.values(observation.tokenStats).every(Number.isSafeInteger));
    assert.ok(observation.tokenStats.inputTokens > 0 && observation.tokenStats.outputTokens > 0);
    assert.equal(observation.tokenAccounting.kind, 'estimate');
    assert.ok(observation.toolCalls.every((entry) => entry.status === 'succeeded'));
    assert.equal(new Set(observation.toolCalls.map((entry) => entry.executionId)).size, 2);
    assert.ok(
      !JSON.stringify(observation).includes(secret),
      'Observation must not expose agent credentials',
    );

    checkpoint('independent-review');
    const issued = await app.ctx.scope.issueActor(owner, {
      name: 'Smoke independent reviewer',
      role: 'reviewer',
    });
    const reviewer = await connect(issued.token);
    const claim = await call(reviewer, 'review.start', { reviewId: pending.reviewId });
    for (const artifactId of claim.artifactIds)
      await call(reviewer, 'artifact.read', { artifactId });
    const verdict = {
      reviewId: claim.id,
      claimId: claim.claimId,
      expectedRevision: pending.workflow.revision,
      verdict: 'pass',
      notes: 'Independently evaluated 2 + 3 and read the pinned evidence.',
      synopsis:
        'The synthetic result was independently recomputed and the pinned evidence satisfies its acceptance criterion.',
      findings: claim.criteria.map((_, index) => ({
        criterionNumber: index + 1,
        status: 'met',
        evidenceIds: [artifact.id],
        notes: 'Independently recomputed the sum and verified the immutable evidence.',
      })),
      requestId: 'review-first',
    };
    await call(reviewer, 'review.submit', verdict);
    assert.equal((await call(operator, 'task.get', { taskId: first.id })).workflow.state, 'done');
    const events = await app.ctx.state.events(owner.projectId);
    const reviewed = events.filter(
      (event) => event.type === 'task.review_applied' && event.subjectId === first.id,
    );
    assert.equal(reviewed.length, 1);
    await call(reviewer, 'review.submit', verdict);
    assert.equal(
      (await app.ctx.state.events(owner.projectId)).length,
      events.length,
      'Verdict replay must not add events',
    );

    checkpoint('private-download');
    const download = await call(operator, 'artifact.read', {
      artifactId: artifact.id,
      mode: 'download',
    });
    const bytes = await fetch(download.download.url, {
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    });
    assert.equal(bytes.status, 200, 'Signed download must read the exact stored object');
    assert.match(bytes.headers.get('content-disposition') ?? '', /attachment/);
    assert.match(bytes.headers.get('cache-control') ?? '', /no-store/);
    assert.equal(await bytes.text(), 'Observed 2 + 3 = 5.');

    checkpoint('research-reflection');
    await app.ctx.paper.patch(owner, {
      kind: 'problem',
      expectedRevision: (await app.ctx.paper.read(owner)).documents.problem.current.revision,
      requestId: 'define-research',
      changes: [
        { id: 'problem', content: 'Can synthetic retained evidence support a reflection wave?' },
        { id: 'scope', content: 'One isolated runtime acceptance project.' },
        { id: 'goals', content: 'Create a persisted five-lens reflection from a research cycle.' },
        { id: 'constraints', content: 'No external agents, dispatch, tools or empirical claims.' },
      ],
    });
    let research = await call(operator, 'research.create', {
      name: 'Synthetic research cycle',
      requestId: 'research-create',
    });
    assert.equal(research.workflow.state, 'defining');
    research = await call(operator, 'research.advance', {
      researchId: research.id,
      expectedRevision: research.workflow.revision,
      requestId: 'research-start',
    });
    assert.equal(research.workflow.state, 'researching');
    research = await call(operator, 'research.advance', {
      researchId: research.id,
      expectedRevision: research.workflow.revision,
      requestId: 'research-reflect',
    });
    assert.equal(research.workflow.state, 'reflecting');
    const reflection = await app.ctx.reflections.get(owner, research.reflectionId);
    assert.equal(reflection.lenses.length, 5);
    await assert.rejects(
      app.ctx.research.advance(owner, {
        researchId: research.id,
        expectedRevision: research.workflow.revision,
        requestId: 'blocked-until-reflected',
      }),
      { code: 'reflection_not_approved' },
    );

    checkpoint('restart-persistence');
    await closeClients();
    await app.stop();
    app = await start();
    assert.ok(app.status().every((entry) => entry.state === 'active'));
    const restarted = await connect(boot.token);
    assert.equal((await call(restarted, 'task.get', { taskId: first.id })).workflow.state, 'done');
    assert.equal(
      (await call(restarted, 'artifact.read', { artifactId: artifact.id })).content,
      'Observed 2 + 3 = 5.',
    );
    assert.equal((await http('/sessions/self', secret)).agent.id, agent.id);
    const retained = await http(`/sessions/agents/${agent.id}/observation`, boot.token);
    assert.deepEqual(retained.tokenStats, observation.tokenStats);
    assert.equal(retained.assignments.length, 2);
    assert.equal((await app.ctx.research.get(owner, research.id)).reflectionId, reflection.id);
    assert.equal((await app.ctx.reflections.get(owner, reflection.id)).lenses.length, 5);
    const dispatch = (await app.ctx.sessions.projectStatus(owner)).dispatch;
    assert.equal(dispatch.enabled, false, 'Synthetic project must never enable dispatch');
    return {
      projectId: owner.projectId,
      pluginCount,
      taskState: 'done',
      reviewReplay: 'idempotent',
      agentId: agent.id,
      assignments: 2,
      toolCalls: retained.tokenStats.totalCalls,
      tokenAccounting: 'payload estimates, not model billing',
      tokenStats: retained.tokenStats,
      researchState: 'reflecting',
      reflectionLenses: 5,
      signedDownload: 'verified',
      restart: 'verified',
      compiledUiAssets: 'verified',
      dispatch: 'disabled',
    };
  } finally {
    try {
      await closeClients();
    } finally {
      await app?.stop();
    }
  }
}

export async function main() {
  const schema = process.env.MERV_TS_DB_SCHEMA;
  assert.ok(
    /^merv_ts_smoke_[a-z0-9_]{1,49}$/.test(schema ?? ''),
    'An explicit smoke schema is required',
  );
  assert.ok(schema.length <= 63);
  const prefix = `merv-ts/${schema}`;
  assert.equal(
    process.env.MERV_BLOB_PREFIX,
    prefix,
    'Storage prefix must exactly match the smoke schema',
  );
  assert.ok(process.env.MERV_DB_URL, 'MERV_DB_URL is required');
  const db = new PostgresClient({
    connectionString: process.env.MERV_DB_URL,
    connectionTimeoutMillis: 5000,
    statement_timeout: 30_000,
  });
  const directory = await mkdtemp(join(tmpdir(), 'merv-runtime-acceptance-'));
  try {
    await db.connect();
    assert.equal(
      (await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired', [schema]))
        .rows[0].acquired,
      true,
    );
    const namespace = await db.query(
      'SELECT oid,nspowner::regrole::text=current_user AS owned FROM pg_namespace WHERE nspname=$1',
      [schema],
    );
    assert.equal(namespace.rowCount, 1, 'Administrator must precreate the empty smoke schema');
    assert.equal(namespace.rows[0].owned, true, 'Runtime role must directly own the smoke schema');
    const contents = await db.query(
      `SELECT (SELECT COUNT(*) FROM pg_class WHERE relnamespace=$1)
       +(SELECT COUNT(*) FROM pg_proc WHERE pronamespace=$1)
       +(SELECT COUNT(*) FROM pg_type WHERE typnamespace=$1) AS objects`,
      [namespace.rows[0].oid],
    );
    assert.equal(
      Number(contents.rows[0].objects),
      0,
      'Smoke schema must be empty; choose a new one',
    );
    const config = JSON.parse(
      await readFile(new URL('../dist/config/default.json', import.meta.url), 'utf8'),
    );
    assert.ok(
      config.plugins.every((entry) => !/mount|runner|dispatch|legacy-history/.test(entry.id)),
      'No external execution or imported history plugins are permitted',
    );
    for (const entry of config.plugins) entry.required = true;
    config.plugins.find((entry) => entry.id === 'state').config = {
      backend: 'postgres',
      connectionStringEnv: 'MERV_DB_URL',
      schema,
      maxConnections: 10,
      connectionTimeoutMs: 5000,
      statementTimeoutMs: 30_000,
      lockTimeoutMs: 5000,
    };
    config.plugins.find((entry) => entry.id === 'blobs').config = { backend: 's3' };
    config.plugins.find((entry) => entry.id === 'api').config = { host: '127.0.0.1', port: 0 };
    // Actor/session bearer auth is exercised; this does not test external Supabase login.
    config.plugins.find((entry) => entry.id === 'identity').config = {};
    const result = await exerciseRuntime(() => createApp({ directory, config }));
    console.log(
      JSON.stringify({
        acceptance: 'passed',
        schema,
        prefix,
        ...result,
        cleanup:
          'Retained synthetic schema and prefix; remove these exact targets only after review.',
      }),
    );
  } finally {
    await db.end();
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const deadline = setTimeout(() => {
    console.error(
      JSON.stringify({
        acceptance: 'failed',
        stage,
        code: 'deadline',
        retained: 'Inspect the designated smoke schema/prefix.',
      }),
    );
    process.exit(1);
  }, 10 * 60_000);
  try {
    await main();
  } catch (error) {
    const code =
      typeof error?.code === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(error.code)
        ? error.code
        : 'acceptance_failure';
    // Never print response bodies, authorization headers, credentials or signed URLs.
    console.error(
      JSON.stringify({
        acceptance: 'failed',
        stage,
        code,
        retained: 'Inspect the designated smoke schema/prefix.',
      }),
    );
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
  }
}

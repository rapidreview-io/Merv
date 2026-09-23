import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createApp } from '../src/app.js';
import type { ApplicationConfig } from '../src/config.js';
import { CredentialServer } from '../tests/fixtures/credential-server.js';

const rawTools = ['search', 'paper', 'excerpts', 'qa.ask', 'qa.get', 'qa.cancel'];
const mounted = (name: string) => `_nisa.${name}`;

interface ProcessHost {
  child: ChildProcess;
  url: string;
  stop(): Promise<void>;
}

/** Whitelist only execution settings. No inherited login, API-key or model credentials. */
function childEnvironment(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
    ...extra,
  };
}

async function host(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<ProcessHost> {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let exited = false;
  let failure: Error | undefined;
  let ready: string | undefined;
  let output = '';
  // Do not retain backend transcripts. Failure messages expose only exit status.
  child.stderr?.resume();
  const ended = new Promise<void>((done) => {
    child.once('error', (error) => {
      failure = error;
      exited = true;
      done();
    });
    child.once('exit', () => {
      exited = true;
      done();
    });
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
    if (output.length > 16_384) output = output.slice(-16_384);
    const lines = output.split('\n');
    output = lines.pop() ?? '';
    for (const line of lines) {
      try {
        const value = JSON.parse(line) as { url?: unknown };
        if (typeof value.url !== 'string') continue;
        const url = new URL(value.url);
        if (url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))
          ready = value.url;
      } catch {
        /* Readiness is the single JSON URL line; other logs are discarded. */
      }
    }
  });
  const stop = async () => {
    if (!exited) child.kill('SIGTERM');
    await Promise.race([ended, delay(3000, undefined, { ref: false })]);
    if (!exited) {
      child.kill('SIGKILL');
      await Promise.race([ended, delay(2000, undefined, { ref: false })]);
    }
    assert.ok(exited, 'Controlled child process did not stop');
  };
  try {
    const deadline = Date.now() + 15_000;
    while (!ready) {
      assert.ok(
        !exited,
        `Controlled process exited before readiness (${child.exitCode ?? failure?.name ?? 'signal'})`,
      );
      assert.ok(Date.now() < deadline, 'Controlled process readiness timed out');
      await delay(10);
    }
    return { child, url: ready, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  return client.request(
    { method: 'tools/call', params: { name, arguments: args } },
    CallToolResultSchema,
  );
}
function payload(result: CallToolResult): Record<string, any> {
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  if (result.structuredContent) return result.structuredContent;
  const item = result.content.find((part) => part.type === 'text');
  assert.ok(item && item.type === 'text', 'Expected JSON tool result');
  return JSON.parse(item.text) as Record<string, any>;
}
function errorCode(result: CallToolResult): string {
  assert.equal(result.isError, true, 'Expected a refused tool call');
  const item = result.content.find((part) => part.type === 'text');
  assert.ok(item && item.type === 'text', 'Expected a sanitized error result');
  const value = (result.structuredContent ?? JSON.parse(item.text)) as {
    error?: { code?: unknown };
  };
  assert.equal(typeof value.error?.code, 'string');
  return value.error!.code as string;
}
async function eventually(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 8000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, label);
    await delay(20);
  }
}

/**
 * Run actual Nisa Python operations + its MCP server through Merv generic Mounts.
 * Only the corpus/index, identity verifier and model runner are synthetic fixtures.
 * No real Nisa/sandbox service, saved credential, or model invocation is used. Merv's state
 * goes to the PostgreSQL that MERV_DB_URL and MERV_DB_SCHEMA select (scripts/database.ts).
 */
export async function runNisaMcpScenario(directory: string, checkout: string) {
  checkout = resolve(checkout);
  for (const path of ['project/backend/plugin_api/fixture_host.py', 'project/mcp/src/cli.ts'])
    assert.ok(existsSync(join(checkout, path)), `Nisa integration checkout is missing ${path}`);
  mkdirSync(directory, { recursive: true });
  const release = join(directory, 'release-operation');
  const runLog = join(directory, 'runner-entries.jsonl');
  rmSync(release, { force: true });
  rmSync(runLog, { force: true });
  const suffix = randomUUID().replaceAll('-', '_');
  const aliceEnv = `MERV_NISA_MCP_ALICE_${suffix}`;
  const bobEnv = `MERV_NISA_MCP_BOB_${suffix}`;
  const sandboxEnv = `MERV_NISA_MCP_SANDBOX_${suffix}`;
  process.env[aliceEnv] = 'alice-token';
  process.env[bobEnv] = 'bob-token';
  process.env[sandboxEnv] = 'synthetic-independent-sandbox-token';
  const sandbox = new CredentialServer([
    {
      id: 'sandbox-fixture',
      token: process.env[sandboxEnv]!,
      namespace: 'fixture',
      subject: 'consumer',
    },
  ]);
  let backend: ProcessHost | undefined;
  let facade: ProcessHost | undefined;
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  const clients: Client[] = [];
  const checks: Record<string, boolean> = {};
  try {
    backend = await host(
      process.env.MERV_NISA_PYTHON ?? 'python3',
      ['-m', 'plugin_api.fixture_host'],
      checkout,
      childEnvironment({
        PYTHONPATH: join(checkout, 'project/backend'),
        PYTHONUNBUFFERED: '1',
        PYTHONPYCACHEPREFIX: join(directory, 'pycache'),
        NISA_FIXTURE_DB: join(directory, 'operations.sqlite'),
        NISA_FIXTURE_RELEASE: release,
        NISA_FIXTURE_RUN_LOG: runLog,
      }),
    );
    facade = await host(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts'],
      join(checkout, 'project/mcp'),
      childEnvironment({
        NISA_BACKEND_ORIGIN: backend.url,
        NISA_HOST: '127.0.0.1',
        NISA_PORT: '0',
      }),
    );
    const upstreamUrl = facade.url.endsWith('/mcp') ? facade.url : facade.url + '/mcp';
    const connect = async (url: string, token: string, account?: string) => {
      const client = new Client({ name: 'merv-nisa-composition-fixture', version: '1' });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(url), {
          requestInit: {
            headers: {
              authorization: `Bearer ${token}`,
              ...(account ? { 'x-nisa-account-id': account } : {}),
            },
          },
        }),
      );
      return client;
    };
    const direct = await connect(upstreamUrl, 'alice-token', 'alice');
    const directCatalog = (await direct.listTools()).tools;
    assert.deepEqual(directCatalog.map(({ name }) => name).sort(), [...rawTools].sort());
    checks.actualNisaOwnedMcpCatalog = true;
    const seed = await createApp({
      directory: join(directory, 'merv'),
      components: ['state', 'scope'],
    });
    const identity = await (async () => {
      try {
        const admin = await seed.ctx.scope.bootstrap({
          projectName: 'Nisa MCP composition',
          actorName: 'Operator',
        });
        const operator = { actorId: admin.actor.id, projectId: admin.project.id };
        return {
          operator,
          alice: await seed.ctx.scope.issueActor(operator, { name: 'Alice', role: 'producer' }),
          bob: await seed.ctx.scope.issueActor(operator, { name: 'Bob', role: 'producer' }),
          observer: await seed.ctx.scope.issueActor(operator, {
            name: 'Observer',
            role: 'reviewer',
          }),
        };
      } finally {
        await seed.stop();
      }
    })();
    const alice = { actorId: identity.alice.actor.id, projectId: identity.operator.projectId };
    const bob = { actorId: identity.bob.actor.id, projectId: identity.operator.projectId };
    await sandbox.start();
    const config = JSON.parse(
      readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
    ) as ApplicationConfig;
    config.plugins.find((entry) => entry.id === 'scope')!.config = {
      grants: [
        ...[identity.operator, alice, bob].map((who) => ({
          ...who,
          mountId: 'nisa',
          tools: rawTools,
        })),
        ...[identity.operator, alice].map((who) => ({
          ...who,
          mountId: 'sandbox',
          tools: ['inspect'],
        })),
      ],
    };
    const credentialConfig = {
      bindings: [
        ...[identity.operator, alice].map((who, index) => ({
          ...who,
          id: `nisa-alice-${index}`,
          mountId: 'nisa',
          secretRef: `env:${aliceEnv}`,
          headers: { 'x-nisa-account-id': 'alice' },
        })),
        {
          ...bob,
          id: 'nisa-bob',
          mountId: 'nisa',
          secretRef: `env:${bobEnv}`,
          headers: { 'x-nisa-account-id': 'bob' },
        },
        ...[identity.operator, alice].map((who, index) => ({
          ...who,
          id: `sandbox-${index}`,
          mountId: 'sandbox',
          secretRef: `env:${sandboxEnv}`,
          headers: { 'x-sandbox-namespace': 'fixture', 'x-sandbox-subject': 'consumer' },
        })),
      ],
    };
    config.plugins.unshift({
      id: 'mounts',
      name: '@merv/mounts',
      required: false,
      config: {
        ...credentialConfig,
        mounts: [
          {
            id: 'nisa',
            url: upstreamUrl,
            tools: rawTools,
            discovery: identity.operator,
            timeoutMs: 10000,
            reconnectMs: 60000,
          },
          {
            id: 'sandbox',
            url: sandbox.url,
            tools: ['inspect'],
            discovery: identity.operator,
            timeoutMs: 10000,
            reconnectMs: 60000,
          },
        ],
      },
    });
    app = await createApp({ directory: join(directory, 'merv'), config, port: 0 });
    const running = app;
    const apiUrl = running.ctx.api.url!;
    const aliceClient = await connect(apiUrl + '/mcp', identity.alice.token);
    const bobClient = await connect(apiUrl + '/mcp', identity.bob.token);
    const observer = await connect(apiUrl + '/mcp', identity.observer.token);
    const before = (await aliceClient.listTools()).tools;
    assert.equal(before.length, 56);
    assert.ok(rawTools.every((name) => before.some((tool) => tool.name === mounted(name))));
    assert.equal((await observer.listTools()).tools.length, 49);
    assert.equal((await call(observer, mounted('search'), { query: 'attention' })).isError, true);
    for (const tool of directCatalog)
      assert.deepEqual(
        before.find(({ name }) => name === mounted(tool.name))?.inputSchema,
        tool.inputSchema,
      );
    checks.callerGrantsFilterCatalog = checks.genericMountSchemaParity = true;

    for (const [name, args] of [
      ['search', { query: ['attention', 'inference'], max_results: 2 }],
      ['paper', { arxiv_id: '2305.12345' }],
      ['excerpts', { arxiv_id: '2305.12345', query: 'attention', max_excerpts: 2 }],
    ] as const) {
      const fromDirect = await call(direct, name, args);
      const fromMerv = await call(aliceClient, mounted(name), args);
      payload(fromDirect);
      assert.deepEqual(fromMerv, fromDirect, `${name} lost MCP result fields`);
    }
    checks.threeRetrievalToolsFullResultParity = true;
    const sandboxBefore = payload(await call(aliceClient, '_sandbox.inspect'));
    const sandboxConnections = structuredClone(sandbox.connections);
    assert.equal(sandboxConnections.length, 2, 'Discovery and actor calls have separate clients');
    const originals = Object.fromEntries(
      [
        'state',
        'scope',
        'tools',
        'api',
        'feed',
        'tasks',
        'artifacts',
        'blobs',
        'workflows',
        'reviews',
        'mounts',
      ].map((name) => [name, running.ctx.get(name)]),
    );
    const askInput = { question: 'hold for unload', requestId: 'fixture-alice-question' };
    const operation = payload(await call(aliceClient, mounted('qa.ask'), askInput));
    assert.equal(typeof operation.operationId, 'string');
    await eventually(
      async () =>
        payload(await call(direct, 'qa.get', { operationId: operation.operationId })).status ===
        'running',
      'Nisa operation did not start',
    );
    for (const name of ['qa.get', 'qa.cancel']) {
      const result = await call(bobClient, mounted(name), {
        operationId: operation.operationId,
        ...(name === 'qa.cancel' ? { requestId: 'bob-cross-account' } : {}),
      });
      assert.equal(errorCode(result), 'operation_not_found');
    }
    checks.otherAccountCannotObserveOrCancel = true;
    await running.ctx.mounts.setEnabled('nisa', false);
    const during = (await aliceClient.listTools()).tools.map(({ name }) => name);
    assert.equal(during.length, 50);
    assert.ok(during.every((name) => !name.startsWith('_nisa.')));
    assert.equal(
      errorCode(await call(aliceClient, mounted('qa.get'), { operationId: operation.operationId })),
      'unknown_tool',
    );
    assert.equal(
      payload(await call(direct, 'qa.get', { operationId: operation.operationId })).status,
      'running',
    );
    const post = payload(
      await call(aliceClient, 'feed.post', {
        body: 'Native work continues while the Nisa mount is absent.',
        requestId: 'nisa-mcp-feed',
      }),
    );
    assert.equal(typeof post.id, 'string');
    const brief = payload(
      await call(aliceClient, 'artifact.create', {
        title: 'Native work during Nisa Q&A',
        content:
          'Goal: Complete native work while accepted Nisa Q&A continues independently.\nDone when: Independent review passes pinned delivery evidence.',
      }),
    );
    const task = payload(
      await call(aliceClient, 'task.create', {
        title: 'Reviewed work without the Nisa mount',
        goal: 'Complete native work while accepted Nisa Q&A continues independently.',
        checks: ['Independent review passes pinned delivery evidence.'],
        briefId: brief.id,
        requestId: 'nisa-mcp-native-task',
      }),
    );
    const delivery = payload(
      await call(aliceClient, 'artifact.create', {
        title: 'Native completion evidence',
        content:
          'Check: Independent review passes pinned delivery evidence.\nCreated this delivery while all six Nisa tools were absent. The independent reviewer can read both immutable documents and finish the task through the native review workflow.',
      }),
    );
    const submitted = payload(
      await call(aliceClient, 'task.submit_delivery', {
        taskId: task.id,
        artifactIds: [delivery.id],
        confirmations: [
          {
            checkNumber: 1,
            status: 'met',
            evidenceIds: [delivery.id],
            notes:
              'Native review evidence was saved while Nisa tools were absent; the independent verdict verifies completion.',
          },
        ],
        expectedRevision: 0,
        requestId: 'nisa-mcp-native-delivery',
      }),
    );
    await call(observer, 'artifact.read', { artifactId: brief.id }).then(payload);
    for (const artifactId of submitted.deliveryIds)
      await call(observer, 'artifact.read', { artifactId }).then(payload);
    const claim = await call(observer, 'review.start', { reviewId: submitted.reviewId }).then(
      payload,
    );
    const done = payload(
      await call(observer, 'review.submit', {
        reviewId: submitted.reviewId,
        claimId: claim.claimId,
        verdict: 'pass',
        synopsis:
          'Native task work and independent review completed while the Nisa mount was absent.',
        findings: [
          {
            criterionNumber: 1,
            status: 'met',
            evidenceIds: [delivery.id],
            notes: 'The pinned delivery records native task operations continuing without Nisa.',
          },
        ],
        notes: 'Checked the pinned brief and delivery while the Nisa mount was absent.',
        expectedRevision: 1,
        requestId: 'nisa-mcp-native-review',
      }),
    );
    assert.equal(done.workflow.state, 'done');
    const reviewedPost = payload(
      await call(observer, 'feed.post', {
        body: 'Independent native review completed while Nisa Q&A remains owned by Nisa.',
        artifactIds: [delivery.id],
        requestId: 'nisa-mcp-native-reviewed',
      }),
    );
    assert.equal(
      payload(await call(direct, 'qa.get', { operationId: operation.operationId })).status,
      'running',
    );
    assert.ok(
      (await aliceClient.listTools()).tools.every(({ name }) => !name.startsWith('_nisa.')),
    );
    checks.nativeTaskReviewFeedCompletedWhileNisaAbsent = true;
    const sandboxDuring = payload(await call(aliceClient, '_sandbox.inspect'));
    assert.equal(sandboxDuring.connectionId, sandboxBefore.connectionId);
    assert.deepEqual(sandbox.connections, sandboxConnections);
    assert.equal((await fetch(apiUrl + '/health')).status, 200);
    checks.acceptedOperationSurvivesLocalUnmount = checks.nativeAndSandboxRemainAvailable = true;
    writeFileSync(release, 'release controlled operation\n');
    let complete: Record<string, any> = {};
    await eventually(async () => {
      complete = payload(await call(direct, 'qa.get', { operationId: operation.operationId }));
      return complete.terminal === true;
    }, 'Released Nisa operation did not complete');
    assert.equal(complete.status, 'completed');
    assert.equal(complete.result.operationId, operation.operationId);
    assert.equal(complete.result.answer, 'Fixture answer supported by arXiv:2305.12345.');
    assert.equal(complete.result.contextPapers[0].fixture_extra.retained, true);
    assert.equal(complete.result.sources[0].paper.fixture_extra.retained, true);
    assert.deepEqual(complete.result.usage, { input_tokens: 20, output_tokens: 10, cost_usd: 0 });
    await running.ctx.mounts.setEnabled('nisa', true);
    const after = (await aliceClient.listTools()).tools;
    assert.deepEqual(after, before);
    const recovered = payload(
      await call(aliceClient, mounted('qa.get'), { operationId: operation.operationId }),
    );
    assert.deepEqual(recovered, complete);
    assert.deepEqual(payload(await call(aliceClient, mounted('qa.ask'), askInput)), complete);
    assert.equal(
      errorCode(
        await call(aliceClient, mounted('qa.ask'), {
          question: 'A new question',
          requestId: 'new-quota-request',
        }),
      ),
      'quota_exceeded',
    );
    checks.reattachReturnsSameCompleteEvidence =
      checks.requestIdReplayDoesNotRerun =
      checks.finiteQuotaDeniesNewOperation =
        true;

    rmSync(release);
    const bobOperation = payload(
      await call(bobClient, mounted('qa.ask'), {
        question: 'hold for cancel',
        requestId: 'bob-cancel-question',
      }),
    );
    await eventually(
      async () =>
        payload(await call(bobClient, mounted('qa.get'), { operationId: bobOperation.operationId }))
          .status === 'running',
      'Bob operation did not start',
    );
    const cancelled = payload(
      await call(bobClient, mounted('qa.cancel'), {
        operationId: bobOperation.operationId,
        requestId: 'bob-cancel',
      }),
    );
    assert.equal(cancelled.cancelRequested, true);
    await eventually(
      async () =>
        payload(await call(bobClient, mounted('qa.get'), { operationId: bobOperation.operationId }))
          .status === 'cancelled',
      'Operation-scoped cancellation did not finish',
    );
    assert.deepEqual(
      payload(await call(aliceClient, mounted('qa.get'), { operationId: operation.operationId })),
      complete,
    );
    checks.operationScopedCancellation = true;
    assert.equal(
      payload(await call(aliceClient, 'task.get', { taskId: task.id })).workflow.state,
      'done',
    );
    const posts = payload(await call(aliceClient, 'feed.list')) as unknown as { id: string }[];
    assert.deepEqual(
      posts.map(({ id }) => id),
      [post.id, reviewedPost.id],
    );
    const activity = payload(await call(aliceClient, 'feed.activity')) as unknown as {
      type: string;
      subjectId: string;
    }[];
    assert.ok(
      activity.some((event) => event.type === 'task.review_applied' && event.subjectId === task.id),
    );
    checks.nativeTaskEvidenceAndFeedRetained = true;
    const runs = readFileSync(runLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { operationId: string; accountId: string });
    assert.deepEqual(
      runs,
      [
        { operationId: operation.operationId, accountId: 'alice' },
        { operationId: bobOperation.operationId, accountId: 'bob' },
      ],
      'Observation, replay and quota refusal must never dispatch another runner',
    );
    checks.runnerDispatchCountProvesNoReplay = true;
    for (const [name, original] of Object.entries(originals))
      assert.equal(running.ctx.get(name), original, `${name} restarted`);
    assert.equal(running.ctx.api.url, apiUrl);
    assert.deepEqual(sandbox.connections, sandboxConnections);
    checks.unrelatedProvidersAndConnectionsUnchanged = true;
    return {
      status: 'passed',
      evidence:
        'actual Nisa Python operation service and Nisa-owned MCP through generic Merv Mounts with synthetic providers',
      realNisaServiceVerified: false,
      realSandboxServiceVerified: false,
      modelInvoked: false,
      toolCounts: [before.length, during.length, after.length],
      runnerDispatches: runs.length,
      nativeTaskState: done.workflow.state,
      retainedFeedPosts: posts.length,
      checks,
    };
  } finally {
    writeFileSync(release, 'release for cleanup\n');
    const clientCleanup = await Promise.allSettled(clients.map((client) => client.close()));
    const serviceCleanup = await Promise.allSettled([app?.stop(), sandbox.close()]);
    const facadeCleanup = await Promise.allSettled([facade?.stop()]);
    const backendCleanup = await Promise.allSettled([backend?.stop()]);
    delete process.env[aliceEnv];
    delete process.env[bobEnv];
    delete process.env[sandboxEnv];
    assert.ok(
      [...clientCleanup, ...serviceCleanup, ...facadeCleanup, ...backendCleanup].every(
        (item) => item.status === 'fulfilled',
      ),
      'Controlled integration resource cleanup failed',
    );
    checks.resourcesClosed = true;
  }
}

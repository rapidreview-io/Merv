import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { FiberState } from 'cordis';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.js';
import type { ApplicationConfig } from '../src/config.js';
import { CredentialServer } from '../tests/fixtures/credential-server.js';
import {
  NisaServer,
  representativeNisaPaper,
  representativeNisaSearch,
} from '../tests/fixtures/nisa-server.js';

async function until(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await delay(5);
  }
}
async function native(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  return JSON.parse((result.content as { text: string }[])[0].text);
}
function remoteCall(client: Client, name: string, args: Record<string, unknown> = {}) {
  return client.request(
    { method: 'tools/call', params: { name, arguments: args } },
    CallToolResultSchema,
  );
}

/** Actual application loader with independent Nisa REST and authenticated sandbox MCP fixtures. */
export async function runNisaUnloadScenario(
  directory: string,
  onCheckpoint: (value: unknown) => void = () => {},
) {
  const suffix = randomUUID().replaceAll('-', '_');
  const nisaEnv = `MERV_NISA_SCENARIO_${suffix}`;
  const sandboxEnv = `MERV_NISA_SANDBOX_SCENARIO_${suffix}`;
  process.env[nisaEnv] = 'synthetic-nisa-scenario-token';
  process.env[sandboxEnv] = 'synthetic-nisa-scenario-sandbox-token';
  const literature = new NisaServer({
    identities: { [`Bearer ${process.env[nisaEnv]}`]: 'literature-consumer' },
  });
  const sandbox = new CredentialServer([
    {
      id: 'sandbox-consumer',
      token: process.env[sandboxEnv]!,
      namespace: 'fixture',
      subject: 'consumer',
    },
  ]);
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  const clients: Client[] = [];
  let held: ReturnType<NisaServer['holdNextRequest']> | undefined;
  let pending: ReturnType<typeof remoteCall> | undefined;
  let unloading: Promise<void> | undefined;
  const checks: Record<string, boolean> = {};
  try {
    const seed = await createApp({ directory, components: ['state', 'scope'] });
    const identity = await (async () => {
      try {
        const admin = seed.ctx.scope.bootstrap({
          projectName: 'Nisa unload',
          actorName: 'Operator',
        });
        const operator = { actorId: admin.actor.id, projectId: admin.project.id };
        const producer = seed.ctx.scope.issueActor(operator, {
          name: 'Producer',
          role: 'producer',
        });
        const reviewer = seed.ctx.scope.issueActor(operator, {
          name: 'Reviewer',
          role: 'reviewer',
        });
        return { operator, producer, reviewer };
      } finally {
        await seed.stop();
      }
    })();
    const caller = { actorId: identity.producer.actor.id, projectId: identity.operator.projectId };
    await Promise.all([literature.start(), sandbox.start()]);
    const config = JSON.parse(
      readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
    ) as ApplicationConfig;
    config.plugins.find((entry) => entry.id === 'access')!.config = {
      grants: [
        ...[identity.operator, caller].map((who) => ({
          ...who,
          mountId: 'sandbox',
          tools: ['inspect'],
        })),
        { ...caller, mountId: 'nisa', tools: ['search', 'paper'] },
      ],
    };
    config.plugins.find((entry) => entry.id === 'credentials')!.config = {
      bindings: [
        ...[identity.operator, caller].map((who, index) => ({
          ...who,
          id: `sandbox-fixture-${index}`,
          mountId: 'sandbox',
          secretRef: `env:${sandboxEnv}`,
          headers: { 'x-sandbox-namespace': 'fixture', 'x-sandbox-subject': 'consumer' },
        })),
        { ...caller, id: 'nisa-fixture', mountId: 'nisa', secretRef: `env:${nisaEnv}` },
      ],
    };
    config.plugins.unshift(
      {
        id: 'literature',
        name: '@merv/nisa',
        required: false,
        config: { id: 'nisa', apiOrigin: literature.url, timeoutMs: 10000 },
      },
      {
        id: 'mounts',
        name: '@merv/mounts',
        required: false,
        config: {
          mounts: [
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
      },
    );
    const running = await createApp({ directory, config, port: 0 });
    app = running;
    const url = running.ctx.api.url!;
    const connect = async (token: string) => {
      const client = new Client({ name: 'merv-nisa-unload', version: '1' });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(url + '/mcp'), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }),
      );
      return client;
    };
    const producer = await connect(identity.producer.token),
      reviewer = await connect(identity.reviewer.token);
    const checkpoints: unknown[] = [];
    const checkpoint = (phase: string, details: Record<string, unknown> = {}) => {
      const item = { phase, pid: process.pid, ...details };
      checkpoints.push(item);
      onCheckpoint(item);
    };
    const searchName = 'mount__nisa__search';
    const paperName = 'mount__nisa__paper';
    const sandboxName = 'mount__sandbox__inspect';
    const before = (await producer.listTools()).tools.map(({ name }) => name);
    assert.equal(before.length, 29);
    for (const name of [searchName, paperName, sandboxName]) assert.ok(before.includes(name));
    assert.equal(running.ctx.nisa.status().state, 'ready');
    assert.equal(running.ctx.mounts.status()[0].state, 'ready');
    assert.equal((await reviewer.listTools()).tools.length, 26);
    const denied = await remoteCall(reviewer, searchName, { query: 'attention' });
    assert.equal(denied.isError, true);
    assert.equal(literature.requestCount, 0);
    checks.ungrantedCallerRefused = true;

    const initialSandbox = await remoteCall(producer, sandboxName);
    assert.equal(initialSandbox.isError, undefined);
    assert.equal(initialSandbox.structuredContent?.identity, 'sandbox-consumer');
    const connections = structuredClone(sandbox.connections);
    assert.equal(connections.length, 2, 'Discovery and the producer must use separate clients');
    const assertSandboxRetained = async () => {
      const result = await remoteCall(producer, sandboxName);
      assert.equal(result.isError, undefined);
      assert.deepEqual(result.structuredContent, initialSandbox.structuredContent);
      assert.deepEqual(sandbox.connections, connections, 'Sandbox clients were reconnected');
    };
    const brief = await native(producer, 'artifact.create', {
      title: 'Brief',
      content: 'Goal: Keep native work available.\nCheck: Task reaches done.',
    });
    const task = await native(producer, 'task.create', {
      title: 'Work during Nisa removal',
      goal: 'Keep native work available.',
      checks: ['Task reaches done.'],
      briefId: brief.id,
      requestId: 'nisa-task',
    });
    const post = await native(producer, 'feed.post', {
      body: 'Nisa and sandbox tools are available.',
      requestId: 'nisa-before',
    });
    const cursor = running.ctx.state.events(caller.projectId).at(-1)!.id;
    const originals = Object.fromEntries(
      [
        'state',
        'scope',
        'blobs',
        'access',
        'credentials',
        'artifacts',
        'workflows',
        'reviews',
        'tasks',
        'feed',
        'tools',
        'api',
        'mounts',
      ].map((name) => [name, running.ctx.get(name)]),
    );
    const provider = running.getFiber('literature')!;
    const service = running.ctx.nisa;
    checkpoint('nisa-active', { toolCount: before.length, sandboxConnections: connections.length });

    held = literature.holdNextRequest();
    pending = remoteCall(producer, searchName, { query: 'attention', max_results: 5 });
    void pending.catch(() => undefined);
    let admitted = false;
    void held.entered.then(() => {
      admitted = true;
    });
    await until(() => admitted, 'Nisa search did not reach the independent REST fixture');
    let disposed = false;
    unloading = running.setEnabled('literature', false).then(() => {
      disposed = true;
    });
    void unloading.catch(() => undefined);
    await until(
      () => !running.ctx.tools.list().some(({ name }) => name.startsWith('mount__nisa__')),
      'Both Nisa tools were not withdrawn',
    );
    assert.equal(disposed, false);
    assert.equal(provider.state, FiberState.UNLOADING);
    const absent = (await producer.listTools()).tools.map(({ name }) => name);
    assert.equal(absent.length, 27);
    assert.deepEqual(
      absent,
      before.filter((name) => !name.startsWith('mount__nisa__')),
    );
    for (const [name, args] of [
      [searchName, { query: 'attention' }],
      [paperName, { arxiv_id: '1706.03762' }],
    ] as const) {
      const rejected = await remoteCall(producer, name, args);
      assert.equal(rejected.isError, true);
      assert.equal(
        JSON.parse((rejected.content as { text: string }[])[0].text).error.code,
        'unknown_tool',
      );
    }
    assert.equal(literature.requestCount, 1);
    await assertSandboxRetained();
    assert.equal((await fetch(url + '/health')).status, 200);
    const during = await native(producer, 'feed.post', {
      body: 'Feed and the same sandbox connection work while Nisa drains.',
      requestId: 'nisa-during',
    });
    assert.equal(
      (await native(producer, 'task.get', { taskId: task.id })).workflow.state,
      'in_progress',
    );
    checks.bothToolsWithdrawnBeforeDrain = checks.newNisaCallsRefused = true;
    checkpoint('nisa-draining', {
      toolCount: absent.length,
      newNisaCalls: 'unknown_tool',
      sandboxConnectionRetained: true,
      nativeFeedAvailable: true,
    });
    held.release();
    const result = await pending;
    const sources = [
      {
        arxivId: representativeNisaPaper.arxiv_id,
        title: representativeNisaPaper.title,
        url: representativeNisaPaper.url,
      },
    ];
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, { data: representativeNisaSearch, sources });
    await unloading;
    assert.equal(provider.state, FiberState.DISPOSED);
    assert.equal(running.ctx.get('nisa'), undefined);
    assert.equal(service.status().state, 'stopped');
    checks.admittedSearchDrained = checks.actualProviderDisposed = true;

    const delivery = await native(producer, 'artifact.create', {
      title: 'Delivery',
      content:
        'Task reaches done. Native task, review, and feed operations continue while Nisa is absent.',
    });
    const submitted = await native(producer, 'task.submit_delivery', {
      taskId: task.id,
      artifactIds: [delivery.id],
      expectedRevision: 0,
      requestId: 'nisa-delivery',
    });
    await native(reviewer, 'artifact.read', { artifactId: brief.id });
    await native(reviewer, 'artifact.read', { artifactId: delivery.id });
    await native(reviewer, 'review.start', { reviewId: submitted.reviewId });
    const done = await native(reviewer, 'review.submit', {
      reviewId: submitted.reviewId,
      verdict: 'pass',
      notes: 'Verified pinned evidence and native work while Nisa is absent.',
      expectedRevision: 1,
      requestId: 'nisa-review',
    });
    assert.equal(done.workflow.state, 'done');
    assert.equal(done.workflow.revision, 2);
    const after = await native(reviewer, 'feed.post', {
      body: 'Independent review finished while Nisa was absent.',
      artifactIds: [delivery.id],
      requestId: 'nisa-after',
    });
    assert.equal(running.ctx.get('nisa'), undefined);
    await assertSandboxRetained();
    checks.taskReviewFeedCompletedWhileNisaAbsent = true;
    checkpoint('native-work-completed-without-nisa', {
      taskState: 'done',
      revision: done.workflow.revision,
      feedPosts: 3,
      sandboxConnectionRetained: true,
    });

    await running.setEnabled('literature', true);
    assert.notEqual(running.getFiber('literature'), provider);
    assert.notEqual(running.ctx.nisa, service);
    assert.equal(running.ctx.nisa.status().state, 'ready');
    const restored = (await producer.listTools()).tools.map(({ name }) => name);
    assert.equal(restored.length, 29);
    assert.deepEqual(restored, before);
    assert.equal(new Set(restored).size, restored.length);
    const search = await remoteCall(producer, searchName, { query: 'attention' });
    assert.equal(search.isError, undefined);
    assert.deepEqual(search.structuredContent, { data: representativeNisaSearch, sources });
    const paper = await remoteCall(producer, paperName, { arxiv_id: '1706.03762' });
    assert.equal(paper.isError, undefined);
    assert.deepEqual(paper.structuredContent, { data: representativeNisaPaper, sources });
    assert.equal(literature.requestCount, 3, 'Restoration must not duplicate upstream dispatch');
    assert.ok(
      literature.requests.every(({ identityLabel }) => identityLabel === 'literature-consumer'),
    );
    const searches = literature.requests.filter(({ method }) => method === 'POST');
    assert.equal(searches.length, 2);
    for (const request of searches)
      assert.deepEqual(request.body, {
        query: 'attention',
        max_results: 5,
        offset: 0,
        enrich: false,
      });
    for (const [name, value] of Object.entries(originals))
      assert.equal(running.ctx.get(name), value, `${name} was restarted`);
    assert.equal(running.ctx.api.url, url);
    await assertSandboxRetained();
    assert.equal((await native(producer, 'task.get', { taskId: task.id })).workflow.state, 'done');
    const posts = await native(producer, 'feed.list');
    assert.deepEqual(
      posts.map((item: { id: string }) => item.id),
      [post.id, during.id, after.id],
    );
    const activity = await native(producer, 'feed.activity', { after: cursor });
    assert.ok(
      activity.some(
        (item: { type: string; subjectId: string }) =>
          item.type === 'task.review_applied' && item.subjectId === task.id,
      ),
    );
    checks.freshNisaProvider =
      checks.sourceRecordsPreserved =
      checks.searchEnrichmentDisabled =
      checks.sandboxIdentityAndConnectionsRetained =
      checks.unrelatedServicesUnchanged =
      checks.sameServerAndClients =
      checks.durableWorkRetained =
      checks.noDuplicateTools =
        true;
    checkpoint('nisa-restored', {
      toolCount: restored.length,
      retainedPosts: posts.length,
      nisaRequests: literature.requestCount,
      sandboxConnections: sandbox.connections.length,
    });
    return {
      status: 'passed',
      evidence: 'controlled Nisa REST and authenticated sandbox MCP fixtures',
      realNisaServiceVerified: false,
      realSandboxServiceVerified: false,
      cordisVersion: '4.0.0-rc.10',
      loaderVersion: '1.0.0-rc.7',
      removal: 'Disable and re-enable the literature loader entry',
      toolCounts: [before.length, absent.length, restored.length],
      nisaRequests: literature.requestCount,
      sandboxCalls: sandbox.calls.length,
      sandboxConnections: sandbox.connections.length,
      checkpoints,
      checks,
    };
  } finally {
    // Release the fixture first, including assertion failures, so admitted work can finish draining.
    held?.release();
    await Promise.allSettled([pending, unloading]);
    const downstreamCleanup = await Promise.allSettled(clients.map((client) => client.close()));
    try {
      const cleanup = await Promise.allSettled([app?.stop(), literature.close(), sandbox.close()]);
      assert.ok(
        [...downstreamCleanup, ...cleanup].every((item) => item.status === 'fulfilled'),
        'Scenario resource cleanup failed',
      );
      assert.equal(literature.activeSocketCount, 0);
      checks.resourcesClosed = true;
    } finally {
      delete process.env[nisaEnv];
      delete process.env[sandboxEnv];
    }
  }
}

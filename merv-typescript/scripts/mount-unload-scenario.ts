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

async function until(predicate: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 5000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, message);
    await delay(5);
  }
}
async function native(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  return JSON.parse((result.content as { text: string }[])[0].text);
}

function remoteCall(client: Client, name: string) {
  return client.request(
    { method: 'tools/call', params: { name, arguments: {} } },
    CallToolResultSchema,
  );
}

/** Whole application and authenticated independent MCP fixture; no external credential or service. */
export async function runMountUnloadScenario(
  directory: string,
  onCheckpoint: (value: unknown) => void = () => {},
) {
  const env = `MERV_MOUNT_SCENARIO_${randomUUID().replaceAll('-', '_')}`;
  process.env[env] = 'synthetic-mount-scenario-upstream-token';
  const upstream = new CredentialServer([
    { id: 'fixture-consumer', token: process.env[env]!, namespace: 'fixture', subject: 'consumer' },
  ]);
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  const clients: Client[] = [];
  let held: Awaited<ReturnType<CredentialServer['holdNextCall']>> | undefined;
  let pending: ReturnType<typeof remoteCall> | undefined;
  let unloading: Promise<void> | undefined;
  try {
    // Seed durable identities before loading the config that names their exact grants.
    const seed = await createApp({ directory, components: ['state', 'scope'] });
    const identity = await (async () => {
      try {
        const admin = await seed.ctx.scope.bootstrap({
          projectName: 'Mount unload',
          actorName: 'Operator',
        });
        const operator = { actorId: admin.actor.id, projectId: admin.project.id };
        const producer = await seed.ctx.scope.issueActor(operator, {
          name: 'Producer',
          role: 'producer',
        });
        const reviewer = await seed.ctx.scope.issueActor(operator, {
          name: 'Reviewer',
          role: 'reviewer',
        });
        return { operator, producer, reviewer };
      } finally {
        await seed.stop();
      }
    })();
    const caller = { actorId: identity.producer.actor.id, projectId: identity.operator.projectId };
    await upstream.start();
    const config = JSON.parse(
      readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
    ) as ApplicationConfig;
    config.plugins.find((entry) => entry.id === 'scope')!.config = {
      grants: [identity.operator, caller].map((who) => ({
        ...who,
        mountId: 'sandbox',
        tools: ['inspect'],
      })),
    };
    const credentialConfig = {
      bindings: [identity.operator, caller].map((who, index) => ({
        ...who,
        id: `fixture-${index}`,
        mountId: 'sandbox',
        secretRef: `env:${env}`,
        headers: { 'x-sandbox-namespace': 'fixture', 'x-sandbox-subject': 'consumer' },
      })),
    };
    config.plugins.unshift({
      id: 'mounts',
      name: '@merv/mounts',
      required: false,
      config: {
        ...credentialConfig,
        mounts: [
          {
            id: 'sandbox',
            url: upstream.url,
            tools: ['inspect'],
            discovery: identity.operator,
            timeoutMs: 10000,
            reconnectMs: 60000,
          },
        ],
      },
    });
    const running = await createApp({ directory, config, port: 0 });
    app = running;
    const url = running.ctx.api.url!;
    const connect = async (token: string) => {
      const client = new Client({ name: 'merv-mount-unload', version: '1' });
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
    const checks: Record<string, boolean> = {};
    const checkpoints: unknown[] = [];
    const checkpoint = (phase: string, details: Record<string, unknown> = {}) => {
      const item = { phase, pid: process.pid, ...details };
      checkpoints.push(item);
      onCheckpoint(item);
    };
    const mountedName = '_sandbox.inspect';
    const before = (await producer.listTools()).tools.map(({ name }) => name);
    assert.equal(before.length, 95);
    assert.ok(before.includes(mountedName));
    assert.equal(running.ctx.mounts.status()[0].state, 'ready');
    const denied = await reviewer.callTool({ name: mountedName, arguments: {} });
    assert.equal(denied.isError, true);
    assert.equal(upstream.calls.length, 0);
    checks.ungrantedCallerRefused = true;
    const brief = await native(producer, 'artifact.create', {
      title: 'Brief',
      content: 'Goal: Keep native work available.\nCheck: Task reaches done.',
    });
    const task = await native(producer, 'task.create', {
      title: 'Work during mount removal',
      goal: 'Keep native work available.',
      checks: ['Task reaches done.'],
      briefId: brief.id,
      requestId: 'mount-task',
    });
    const post = await native(producer, 'feed.post', {
      body: 'Remote mount ready.',
      requestId: 'mount-before',
    });
    const cursor = (await running.ctx.state.events(caller.projectId)).at(-1)!.id;
    const originals = Object.fromEntries(
      [
        'state',
        'scope',
        'blobs',
        'artifacts',
        'workflows',
        'reviews',
        'tasks',
        'feed',
        'tools',
        'api',
      ].map((name) => [name, running.ctx.get(name)]),
    );
    const provider = running.getFiber('mounts')!;
    checkpoint('mount-active', { toolCount: before.length, selectedTools: 1 });

    held = upstream.holdNextCall();
    pending = remoteCall(producer, mountedName);
    void pending.catch(() => undefined);
    let admitted = false;
    void held.entered.then(() => {
      admitted = true;
    });
    await until(() => admitted, 'Mounted request did not reach the independent upstream');
    let disposed = false;
    unloading = running.setEnabled('mounts', false).then(() => {
      disposed = true;
    });
    void unloading.catch(() => undefined);
    await until(
      async () => !(await running.ctx.tools.list()).some(({ name }) => name.startsWith('_')),
      'Mount tools were not withdrawn',
    );
    assert.equal(disposed, false);
    assert.equal(provider.state, FiberState.UNLOADING);
    const absent = (await producer.listTools()).tools.map(({ name }) => name);
    assert.deepEqual(
      absent,
      before.filter((name) => name !== mountedName),
    );
    const rejected = await remoteCall(producer, mountedName);
    assert.equal(
      JSON.parse((rejected.content as { text: string }[])[0].text).error.code,
      'unknown_tool',
    );
    assert.equal(upstream.calls.length, 1);
    assert.equal((await fetch(url + '/health')).status, 200);
    const during = await native(producer, 'feed.post', {
      body: 'Native feed works while a remote call drains.',
      requestId: 'mount-during',
    });
    assert.equal(
      (await native(producer, 'task.get', { taskId: task.id })).workflow.state,
      'in_progress',
    );
    checkpoint('mount-draining', {
      toolCount: absent.length,
      newRemoteCall: 'unknown_tool',
      nativeFeedAvailable: true,
    });
    held.release();
    const result = await pending;
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent?.identity, 'fixture-consumer');
    assert.deepEqual((result.content as { _meta?: unknown }[])[0]._meta, { retained: true });
    await unloading;
    assert.equal(provider.state, FiberState.DISPOSED);
    assert.equal(running.ctx.get('mounts'), undefined);
    checks.admittedCallDrained =
      checks.newMountedCallsRefused =
      checks.actualProviderDisposed =
        true;

    const delivery = await native(producer, 'artifact.create', {
      title: 'Delivery',
      content:
        'Task reaches done. Native task, review, and feed operations continue while the independent mount is absent.',
    });
    const submitted = await native(producer, 'task.submit_delivery', {
      taskId: task.id,
      artifactIds: [delivery.id],
      confirmations: [
        {
          checkNumber: 1,
          status: 'met',
          evidenceIds: [delivery.id],
          notes:
            'Native task, review, and feed operations remained available while the mount was absent.',
        },
      ],
      expectedRevision: 0,
      requestId: 'mount-delivery',
    });
    await native(reviewer, 'artifact.read', { artifactId: brief.id });
    for (const artifactId of submitted.deliveryIds)
      await native(reviewer, 'artifact.read', { artifactId });
    const claim = await native(reviewer, 'review.start', { reviewId: submitted.reviewId });
    const done = await native(reviewer, 'review.submit', {
      reviewId: submitted.reviewId,
      claimId: claim.claimId,
      verdict: 'pass',
      synopsis:
        'Native task, independent review, and feed operations completed while the mount was absent.',
      findings: [
        {
          criterionNumber: 1,
          status: 'met',
          evidenceIds: [delivery.id],
          notes: 'The pinned delivery records native task operations continuing without the mount.',
        },
      ],
      notes: 'Verified pinned evidence and native work with the mount absent.',
      expectedRevision: 1,
      requestId: 'mount-review',
    });
    assert.equal(done.workflow.state, 'done');
    const after = await native(reviewer, 'feed.post', {
      body: 'Independent review finished with the mount absent.',
      artifactIds: [delivery.id],
      requestId: 'mount-after',
    });
    checks.taskReviewFeedCompletedWhileMountAbsent = true;
    checkpoint('native-work-completed-without-mount', {
      taskState: 'done',
      revision: done.workflow.revision,
      feedPosts: 3,
    });

    await running.setEnabled('mounts', true);
    assert.notEqual(running.getFiber('mounts'), provider);
    assert.equal(running.ctx.mounts.status()[0].state, 'ready');
    const restored = (await producer.listTools()).tools.map(({ name }) => name);
    assert.deepEqual(restored, before);
    assert.equal(new Set(restored).size, restored.length);
    const again = await remoteCall(producer, mountedName);
    assert.equal(again.isError, undefined);
    assert.equal(upstream.calls.length, 2, 'Restoration must not duplicate upstream dispatch');
    assert.equal(again.structuredContent?.identity, result.structuredContent?.identity);
    assert.notEqual(again.structuredContent?.connectionId, result.structuredContent?.connectionId);
    for (const [name, value] of Object.entries(originals))
      assert.equal(running.ctx.get(name), value, `${name} was restarted`);
    assert.equal(running.ctx.api.url, url);
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
    checks.freshRemoteConnection =
      checks.unrelatedServicesUnchanged =
      checks.sameServerAndClients =
      checks.durableWorkRetained =
      checks.noDuplicateTools =
        true;
    checkpoint('mount-restored', { toolCount: restored.length, retainedPosts: posts.length });
    return {
      status: 'passed',
      evidence: 'controlled authenticated MCP fixture',
      realSandboxServiceVerified: false,
      cordisVersion: '4.0.0-rc.10',
      loaderVersion: '1.0.0-rc.7',
      removal: 'Disable and re-enable the mounts loader entry',
      checkpoints,
      checks,
    };
  } finally {
    held?.release();
    await Promise.allSettled([pending, unloading]);
    await Promise.allSettled(clients.map((client) => client.close()));
    try {
      const cleanup = await Promise.allSettled([app?.stop(), upstream.close()]);
      assert.ok(
        cleanup.every((item) => item.status === 'fulfilled'),
        'Scenario resource cleanup failed',
      );
    } finally {
      delete process.env[env];
    }
  }
}

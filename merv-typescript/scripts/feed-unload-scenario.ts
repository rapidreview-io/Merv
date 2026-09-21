import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { FiberState } from 'cordis';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.js';

async function until(check: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, message);
    await delay(5);
  }
}
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function connect(url: string, token: string) {
  const client = new Client({ name: 'merv-feed-unload', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url + '/mcp'), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  return JSON.parse((result.content as { type: string; text: string }[])[0].text);
}

/** Real Cordis, SQLite, HTTP and MCP. Only an explicit test latch slows the feed handler. */
export async function runFeedUnloadScenario(
  directory: string,
  onCheckpoint: (value: unknown) => void = () => {},
) {
  const app = await createApp({ directory, api: true, port: 0 });
  const clients: Client[] = [];
  const release = latch(),
    entered = latch();
  let pending: Promise<any> | undefined, unloading: Promise<unknown> | undefined;
  const checkpoints: unknown[] = [];
  const checkpoint = (phase: string, details: Record<string, unknown> = {}) => {
    const item = { phase, pid: process.pid, url: app.ctx.api.url, ...details };
    checkpoints.push(item);
    onCheckpoint(item);
  };
  try {
    const credentials = await app.ctx.scope.bootstrap({
      projectName: 'Feed unload acceptance',
      actorName: 'Operator',
    });
    const operator = { actorId: credentials.actor.id, projectId: credentials.project.id };
    const producer = await app.ctx.scope.issueActor(operator, {
      name: 'Producer',
      role: 'producer',
    });
    const reviewer = await app.ctx.scope.issueActor(operator, {
      name: 'Reviewer',
      role: 'reviewer',
    });
    const url = app.ctx.api.url!;
    const p = await connect(url, producer.token);
    clients.push(p);
    const r = await connect(url, reviewer.token);
    clients.push(r);
    const beforeTools = (await p.listTools()).tools.map((tool) => tool.name);
    assert.equal(beforeTools.length, 74);
    const post = await call(p, 'feed.post', {
      body: 'Starting a task before feed removal.',
      requestId: 'before-unload',
    });
    const brief = await call(p, 'artifact.create', {
      title: 'Brief',
      content: 'Goal: Survive feed removal.\nCheck: Task reaches done.',
    });
    const task = await call(p, 'task.create', {
      title: 'Cordis unload',
      goal: 'Survive feed removal.',
      checks: ['Task reaches done.'],
      briefId: brief.id,
      requestId: 'create-task',
    });
    const cursor = (await app.ctx.state.events(operator.projectId)).at(-1)!.id;
    const originalServices = {
      state: app.ctx.state,
      scope: app.ctx.scope,
      artifacts: app.ctx.artifacts,
      workflows: app.ctx.workflows,
      reviews: app.ctx.reviews,
      tasks: app.ctx.tasks,
      tools: app.ctx.tools,
      api: app.ctx.api,
    };
    const provider = app.getFiber('feed')!,
      adapter = app.getFiber('feed-tools')!;
    assert.equal(provider.state, FiberState.ACTIVE);
    assert.equal(adapter.state, FiberState.ACTIVE);
    checkpoint('feed-active', { toolCount: beforeTools.length, taskId: task.id, postId: post.id });

    // Pause one actual feed.post after admission but before its real handler.
    // This makes the otherwise synchronous operation overlap disposal reliably.
    const definition = (await app.ctx.tools.list()).find((tool) => tool.name === 'feed.post')!;
    const originalHandler = definition.handler;
    definition.handler = async (caller, input) => {
      entered.resolve();
      await release.promise;
      return originalHandler(caller, input);
    };
    pending = call(p, 'feed.post', {
      body: 'An admitted post finishes during removal.',
      requestId: 'during-unload',
    });
    void pending.catch(() => undefined);
    let admitted = false;
    void entered.promise.then(() => {
      admitted = true;
    });
    await until(() => admitted, 'Feed request did not enter the handler');
    let disposed = false;
    // Disable only the provider entry. Cordis suspends and drains its adapter.
    unloading = app.setEnabled('feed', false).then(() => {
      disposed = true;
    });
    await until(
      async () => !(await app.ctx.tools.list()).some((tool) => tool.name.startsWith('feed.')),
      'Cordis did not withdraw feed tools',
    );
    assert.equal(disposed, false, 'Provider disposal must wait for its admitted tool call');
    assert.equal(adapter.state, FiberState.UNLOADING);
    assert.equal(app.ctx.get('feed'), undefined);
    const absentTools = (await p.listTools()).tools.map((tool) => tool.name);
    assert.deepEqual(
      absentTools,
      beforeTools.filter((name) => !name.startsWith('feed.')),
    );
    const missing = await p.callTool({
      name: 'feed.post',
      arguments: { body: 'Must not be admitted.', requestId: 'rejected-after-withdrawal' },
    });
    assert.equal(missing.isError, true);
    assert.equal(
      JSON.parse((missing.content as { text: string }[])[0].text).error.code,
      'unknown_tool',
    );
    assert.equal((await call(p, 'task.get', { taskId: task.id })).workflow.state, 'in_progress');
    assert.equal((await fetch(url + '/health')).status, 200);
    checkpoint('feed-draining', {
      toolCount: absentTools.length,
      adapterState: 'UNLOADING',
      newFeedCall: 'unknown_tool',
      taskStillAvailable: true,
    });

    release.resolve();
    const admittedPost = await pending;
    await unloading;
    assert.equal(provider.state, FiberState.DISPOSED);
    assert.equal(adapter.state, FiberState.PENDING);
    checkpoint('feed-removed', { admittedPostId: admittedPost.id, adapterState: 'PENDING' });

    // Finish the task while the feed service and all feed tools are absent.
    const delivery = await call(p, 'artifact.create', {
      title: 'Delivery',
      content:
        'Task reaches done. The task and review tools remain available while the feed is absent.',
    });
    const submitted = await call(p, 'task.submit_delivery', {
      taskId: task.id,
      artifactIds: [delivery.id],
      confirmations: [
        {
          checkNumber: 1,
          status: 'met',
          evidenceIds: [delivery.id],
          notes: 'Native task and review tools remained available while the feed was absent.',
        },
      ],
      expectedRevision: 0,
      requestId: 'deliver-without-feed',
    });
    await call(r, 'artifact.read', { artifactId: brief.id });
    for (const artifactId of submitted.deliveryIds) await call(r, 'artifact.read', { artifactId });
    const claim = await call(r, 'review.start', { reviewId: submitted.reviewId });
    const done = await call(r, 'review.submit', {
      reviewId: submitted.reviewId,
      claimId: claim.claimId,
      verdict: 'pass',
      synopsis:
        'The task and independent review completed successfully while the feed plugin was absent.',
      findings: [
        {
          criterionNumber: 1,
          status: 'met',
          evidenceIds: [delivery.id],
          notes: 'The retained delivery records the native task path continuing without feed.',
        },
      ],
      notes:
        'Verified retained evidence and successful task routing while the feed service is absent.',
      expectedRevision: 1,
      requestId: 'review-without-feed',
    });
    assert.equal(done.workflow.state, 'done');
    for (const [name, service] of Object.entries(originalServices))
      assert.equal(app.ctx.get(name), service, `${name} was restarted or replaced`);
    assert.equal(app.ctx.api.url, url);
    checkpoint('task-completed-without-feed', {
      taskId: task.id,
      revision: done.workflow.revision,
    });

    // Re-enable only the provider; the original adapter must reactivate itself.
    await app.setEnabled('feed', true);
    const replacement = app.getFiber('feed')!;
    assert.notEqual(replacement, provider);
    assert.equal(replacement.state, FiberState.ACTIVE);
    await until(() => adapter.state === FiberState.ACTIVE, 'Feed adapter did not reactivate');
    const restoredTools = (await p.listTools()).tools.map((tool) => tool.name);
    assert.deepEqual(restoredTools, beforeTools);
    assert.equal(new Set(restoredTools).size, restoredTools.length);
    assert.equal((await call(p, 'feed.get', { postId: post.id })).body, post.body);
    assert.equal((await call(p, 'feed.get', { postId: admittedPost.id })).body, admittedPost.body);
    const after = await call(r, 'feed.post', {
      body: 'Review completed while the feed was absent.',
      artifactIds: [delivery.id],
      requestId: 'after-reload',
    });
    const posts = await call(p, 'feed.list');
    assert.deepEqual(
      posts.map((item: any) => item.id),
      [post.id, admittedPost.id, after.id],
    );
    const activity = await call(p, 'feed.activity', { after: cursor });
    assert.ok(
      activity.some(
        (event: any) => event.type === 'task.review_applied' && event.subjectId === task.id,
      ),
    );
    assert.equal((await call(p, 'task.get', { taskId: task.id })).workflow.state, 'done');
    checkpoint('feed-restored', {
      toolCount: restoredTools.length,
      adapterState: 'ACTIVE',
      retainedPosts: posts.length,
      offlineActivityRecovered: true,
    });
    return {
      status: 'passed',
      cordisVersion: '4.0.0-rc.10',
      loaderVersion: '1.0.0-rc.7',
      removal: 'Disable and re-enable the feed loader entry',
      pid: process.pid,
      url,
      taskId: task.id,
      reviewId: submitted.reviewId,
      postIds: posts.map((item: any) => item.id),
      checkpoints,
      checks: {
        actualProviderDisposed: true,
        adapterSuspendedAutomatically: true,
        admittedCallDrained: true,
        newFeedCallsRejected: true,
        taskCompletedWhileFeedAbsent: true,
        unrelatedServicesUnchanged: true,
        sameServerAndClients: true,
        adapterReactivatedAutomatically: true,
        postsRetained: true,
        activityRecovered: true,
        noDuplicateTools: true,
        currentProviderHandleUpdated: replacement !== provider,
      },
    };
  } finally {
    release.resolve();
    await Promise.allSettled([pending, unloading]);
    await Promise.allSettled(clients.map((client) => client.close()));
    await app.stop();
  }
}

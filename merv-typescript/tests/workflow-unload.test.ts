import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { FiberState } from 'cordis';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from './fixtures/app.js';

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function bounded<T>(promise: PromiseLike<T>, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), 5000);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function until(check: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, message);
    await delay(5);
  }
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  return JSON.parse((result.content as { type: string; text: string }[])[0].text);
}

test('workflow withdrawal drains task calls and restores domain and assignment tools', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-workflow-unload-'));
  const app = await createApp({ directory, api: true, port: 0 });
  const client = new Client({ name: 'workflow-unload-regression', version: '1' });
  const entered = latch(),
    release = latch();
  let pending: Promise<any> | undefined;
  let unloading: Promise<void> | undefined;
  try {
    const credentials = await app.ctx.scope.bootstrap({
      projectName: 'Workflow removal',
      actorName: 'Operator',
    });
    const caller = { actorId: credentials.actor.id, projectId: credentials.project.id };
    const url = app.ctx.api.url!;
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url + '/mcp'), {
        requestInit: { headers: { Authorization: `Bearer ${credentials.token}` } },
      }),
    );
    const definition = {
      name: 'independent',
      version: 1,
      initial: 'done',
      states: ['done'],
      terminal: ['done'],
      edges: [],
    };
    await app.ctx.workflows.register(definition);
    const instance = await app.ctx.workflows.start(caller, {
      workflow: definition.name,
      requestId: 'before-unload',
    });
    const artifact = await call(client, 'artifact.create', {
      title: 'Independent evidence',
      content: 'Retained during workflow removal.',
    });
    const brief = await call(client, 'artifact.create', {
      title: 'Task brief',
      content: 'Goal: Keep task durable.\nDone when: Survive workflow removal.',
    });
    const task = await call(client, 'task.create', {
      title: 'Durable task',
      goal: 'Keep task durable.',
      checks: ['Survive workflow removal.'],
      briefId: brief.id,
      requestId: 'task-before-unload',
    });
    const provider = app.getFiber('workflows')!;
    const adapter = app.getFiber('tasks-tools')!;
    const original = {
      state: app.ctx.state,
      scope: app.ctx.scope,
      artifacts: app.ctx.artifacts,
      reviews: app.ctx.reviews,
      feed: app.ctx.feed,
      tools: app.ctx.tools,
      api: app.ctx.api,
    };
    const toolsBefore = (await client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(
      toolsBefore.filter((name) => name.startsWith('workflow.')),
      [
        'workflow.assignment',
        'workflow.begin',
        'workflow.catalog',
        'workflow.extend_limit',
        'workflow.process',
        'workflow.status_and_next',
      ],
    );
    const taskNames = toolsBefore.filter(
      (name) => name.startsWith('task.') || name.startsWith('workflow.'),
    );
    assert.equal(taskNames.length, 14);
    assert.ok(taskNames.includes('task.mark_failed'));

    // Hold an admitted task response while Cordis suspends the engine's consumers.
    const taskGet = (await app.ctx.tools.list()).find((tool) => tool.name === 'task.get')!;
    const originalHandler = taskGet.handler;
    taskGet.handler = async (actor, input) => {
      const result = await originalHandler(actor, input);
      entered.resolve();
      await release.promise;
      return result;
    };
    pending = call(client, 'task.get', { taskId: task.id });
    void pending.catch(() => undefined);
    await bounded(entered.promise, 'Task handler was not admitted');
    let disposed = false;
    unloading = app.setEnabled('workflows', false).then(() => {
      disposed = true;
    });
    void unloading.catch(() => undefined);
    await until(
      async () => !(await app.ctx.tools.list()).some((tool) => tool.name === 'task.get'),
      'Task registration was not withdrawn',
    );
    assert.equal(disposed, false, 'Provider must retain the admitted task call');
    assert.equal(adapter.state, FiberState.UNLOADING);
    assert.equal(app.ctx.get('workflows'), undefined);

    const toolsDuring = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(toolsDuring.includes('review.submit'), 'Generic review routing stays available');
    assert.deepEqual(
      toolsDuring.filter((name) => taskNames.includes(name)),
      [],
      'Every task tool must withdraw before the admitted call finishes',
    );
    for (const name of taskNames) {
      const args = {};
      await assert.rejects(app.ctx.tools.call(name, caller, args), { code: 'unknown_tool' });
      const result = await client.callTool({
        name,
        arguments: args,
      });
      assert.equal(result.isError, true, `${name} must refuse new admission`);
      assert.equal(
        JSON.parse((result.content as { text: string }[])[0].text).error.code,
        'unknown_tool',
      );
    }
    assert.equal((await call(client, 'actor.whoami')).id, caller.actorId);
    assert.equal(
      (await call(client, 'artifact.read', { artifactId: artifact.id })).content,
      'Retained during workflow removal.',
    );
    const post = await call(client, 'feed.post', {
      body: 'Other services remain usable.',
      requestId: 'during-unload',
    });
    assert.equal(post.body, 'Other services remain usable.');
    for (const [name, service] of Object.entries(original))
      assert.equal(app.ctx.get(name), service, `${name} was replaced`);

    release.resolve();
    const result = await bounded(pending, 'Admitted task response did not finish');
    assert.deepEqual(result, task);
    await bounded(unloading, 'Workflow provider did not finish disposal');
    assert.equal(provider.state, FiberState.DISPOSED);
    assert.equal(adapter.state, FiberState.PENDING);

    await bounded(app.setEnabled('workflows', true), 'Workflow replacement did not activate');
    assert.notEqual(app.getFiber('workflows'), provider);
    await until(
      () => adapter.state === FiberState.ACTIVE,
      'Existing task adapter did not reactivate',
    );
    await until(
      async () => (await app.ctx.tools.list()).some((tool) => tool.name === 'task.get'),
      'Task tools did not reactivate',
    );
    const restored = (await client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(restored, toolsBefore);
    assert.equal(new Set(restored).size, restored.length);
    assert.deepEqual(await call(client, 'task.get', { taskId: task.id }), task);
    assert.deepEqual(await app.ctx.workflows.get(caller, instance.id), instance);
    assert.equal(app.ctx.api.url, url);
  } finally {
    release.resolve();
    try {
      await bounded(
        Promise.allSettled([pending, unloading]),
        'Workflow test operations did not settle',
      );
    } finally {
      try {
        await bounded(client.close(), 'Workflow test client did not close');
      } finally {
        try {
          await bounded(app.stop(), 'Workflow test application did not close');
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      }
    }
  }
});

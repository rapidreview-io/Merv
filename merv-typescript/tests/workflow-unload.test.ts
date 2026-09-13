import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { FiberState } from 'cordis';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.js';

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

async function until(check: () => boolean, message: string) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < deadline, message);
    await delay(5);
  }
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  return JSON.parse((result.content as { type: string; text: string }[])[0].text);
}

test('workflow withdrawal removes every tool before draining a held catalog call', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-workflow-unload-'));
  const app = await createApp({ directory, api: true, port: 0 });
  const client = new Client({ name: 'workflow-unload-regression', version: '1' });
  const entered = latch(),
    release = latch();
  let pending: Promise<any> | undefined;
  let unloading: Promise<void> | undefined;
  try {
    const credentials = app.ctx.scope.bootstrap({
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
    app.ctx.workflows.register(definition);
    const instance = app.ctx.workflows.start(caller, {
      workflow: definition.name,
      requestId: 'before-unload',
    });
    const artifact = await call(client, 'artifact.create', {
      title: 'Independent evidence',
      content: 'Retained during workflow removal.',
    });
    const provider = app.getFiber('workflows')!;
    const adapter = app.getFiber('workflows-tools')!;
    const original = {
      state: app.ctx.state,
      scope: app.ctx.scope,
      artifacts: app.ctx.artifacts,
      reviews: app.ctx.reviews,
      feed: app.ctx.feed,
      tools: app.ctx.tools,
      api: app.ctx.api,
    };
    const workflowNames = ['workflow.catalog', 'workflow.get', 'workflow.history', 'workflow.list'];
    const toolsBefore = (await client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(
      toolsBefore.filter((name) => name.startsWith('workflow.')),
      workflowNames,
    );

    // Catalog is the last registration in the adapter. The old generator waited
    // for this disposer before withdrawing its other three registrations.
    const catalog = app.ctx.tools.list().find((tool) => tool.name === 'workflow.catalog')!;
    const originalHandler = catalog.handler;
    catalog.handler = async (actor, input) => {
      entered.resolve();
      await release.promise;
      return originalHandler(actor, input);
    };
    pending = call(client, 'workflow.catalog');
    void pending.catch(() => undefined);
    await bounded(entered.promise, 'Catalog handler was not admitted');
    let disposed = false;
    unloading = app.setEnabled('workflows', false).then(() => {
      disposed = true;
    });
    void unloading.catch(() => undefined);
    await until(
      () => !app.ctx.tools.list().some((tool) => tool.name === 'workflow.catalog'),
      'Catalog registration was not withdrawn',
    );
    assert.equal(disposed, false, 'Provider must retain the admitted catalog call');
    assert.equal(adapter.state, FiberState.UNLOADING);
    assert.equal(app.ctx.get('workflows'), undefined);

    const toolsDuring = (await client.listTools()).tools.map((tool) => tool.name);
    assert.deepEqual(
      toolsDuring.filter((name) => name.startsWith('workflow.')),
      [],
      'Every workflow tool must withdraw before any admitted call finishes',
    );
    for (const name of workflowNames) {
      const args =
        name === 'workflow.get' || name === 'workflow.history' ? { instanceId: instance.id } : {};
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
    const result = await bounded(pending, 'Admitted catalog did not finish');
    assert.ok(
      result.some((graph: { name: string }) => graph.name === 'independent'),
      'The held handler must finish against its original provider',
    );
    await bounded(unloading, 'Workflow provider did not finish disposal');
    assert.equal(provider.state, FiberState.DISPOSED);
    assert.equal(adapter.state, FiberState.PENDING);

    await bounded(app.setEnabled('workflows', true), 'Workflow replacement did not activate');
    assert.notEqual(app.getFiber('workflows'), provider);
    await until(
      () => adapter.state === FiberState.ACTIVE,
      'Existing workflow adapter did not reactivate',
    );
    await until(
      () => app.ctx.tools.list().some((tool) => tool.name === 'task.get'),
      'Task tools did not reactivate',
    );
    const restored = (await client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(restored, toolsBefore);
    assert.equal(new Set(restored).size, restored.length);
    assert.deepEqual(await call(client, 'workflow.get', { instanceId: instance.id }), instance);
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

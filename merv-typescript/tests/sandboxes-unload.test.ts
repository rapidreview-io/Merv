import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { Context } from 'cordis';
import { SandboxService, sandboxesPlugin } from '../packages/sandboxes/src/index.js';
import { deferred } from './fixtures/deferred.js';

const tokenEnv = 'MERV_SANDBOXES_UNLOAD_TEST_TOKEN';
const urlEnv = 'MERV_SANDBOXES_UNLOAD_TEST_URL';
const connection = { projectId: 'project_unload', namespace: 'unload', tokenEnv };
const caller = { actorId: 'actor_unload', projectId: connection.projectId };
const config = { urlEnv, connections: [connection] };

function fixture(t: TestContext, handle: (url: URL, options: RequestInit) => Promise<Response>) {
  for (const [key, value] of [
    [tokenEnv, 'sbxt_unload_fixture'],
    [urlEnv, 'https://sandbox.invalid'],
  ]) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  t.mock.method(globalThis, 'fetch', async (url: URL, options: RequestInit) =>
    url.pathname === '/v1/auth/me'
      ? Response.json({ role: 'consumer', namespace: connection.namespace })
      : handle(url, options),
  );
}

test('an old sandbox subscription disposer cannot remove a resubscribed listener', async (t) => {
  fixture(t, async () => Response.json({ version: 1, rows: [] }));
  const service = new SandboxService(config);
  t.after(() => service.close());
  let notifications = 0;
  const listener = () => {
    notifications++;
  };
  const old = service.subscribe(listener);
  old();
  const current = service.subscribe(listener);
  old();
  await service.refresh();
  assert.equal(notifications, 1);
  current();
});

test('overlapping sandbox subscriptions of one callback have independent owners', async (t) => {
  fixture(t, async () => Response.json({ version: 1, rows: [] }));
  const service = new SandboxService(config);
  t.after(() => service.close());
  let notifications = 0;
  const listener = () => {
    notifications++;
  };
  const old = service.subscribe(listener);
  const current = service.subscribe(listener);
  old();
  await service.refresh();
  assert.equal(notifications, 1);
  current();
});

test('Cordis unload retires captured sandbox service handles', async (t) => {
  const requests: string[] = [];
  fixture(t, async (url, options) => {
    requests.push(`${options.method} ${url.pathname}`);
    return Response.json(
      url.pathname === '/v1/ui/manifest'
        ? { version: 1, rows: [] }
        : {
            id: 'sbx_test',
            revision: 0,
            lease_expires_at: new Date().toISOString(),
          },
    );
  });
  const ctx = new Context();
  const fiber = ctx.plugin(sandboxesPlugin, config)!;
  t.after(() => ctx.fiber.dispose());
  await fiber.await();
  const retired = ctx.sandboxes;
  await retired.refresh();
  await fiber.dispose();
  const before = requests.length;
  for (const operation of [
    () => retired.release(caller, { id: 'sbx_test' }),
    () => retired.extend(caller, { id: 'sbx_test', seconds: 60 }),
    () => retired.refresh(),
    () => retired.read(caller, 'sandboxes-test'),
  ])
    await assert.rejects(async () => operation(), { code: 'sandboxes_closed' });
  assert.equal(requests.length, before, 'retired handles must not dispatch any more requests');
  assert.equal(retired.status().state, 'degraded');

  const replacement = ctx.plugin(sandboxesPlugin, config)!;
  await replacement.await();
  assert.notEqual(ctx.sandboxes, retired);
  await ctx.sandboxes.refresh();
  assert.equal(ctx.sandboxes.status().state, 'ready');
});

test('sandbox shutdown waits for an active refresh without publishing or starting another connection', async (t) => {
  const entered = deferred(),
    release = deferred();
  let requests = 0,
    notifications = 0;
  fixture(t, async () => {
    requests++;
    entered.resolve();
    await release.promise;
    return Response.json({ version: 1, rows: [] });
  });
  const service = new SandboxService({
    ...config,
    connections: [connection, { ...connection, projectId: 'project_other' }],
  });
  service.subscribe(() => notifications++);
  const stop = service.start();
  t.after(async () => {
    release.resolve();
    await stop();
  });
  await entered.promise;
  let stopped = false;
  const stopping = Promise.resolve(stop()).then(() => {
    stopped = true;
  });
  await nextTurn();
  assert.equal(stopped, false, 'shutdown must wait for the admitted response to settle');
  release.resolve();
  await stopping;
  assert.equal(requests, 1, 'shutdown must not start the next connection refresh');
  assert.equal(notifications, 0, 'a retired service must not publish rows');
});

test('sandbox shutdown drains a release through its follow-up read', async (t) => {
  const entered = deferred(),
    release = deferred();
  const methods: string[] = [];
  fixture(t, async (url, options) => {
    if (url.pathname === '/v1/ui/manifest') return Response.json({ version: 1, rows: [] });
    methods.push(options.method!);
    if (options.method === 'DELETE') {
      entered.resolve();
      await release.promise;
    }
    return Response.json({ id: 'sbx_test', state: 'stopped' });
  });
  const service = new SandboxService(config);
  const stop = service.start();
  t.after(async () => {
    release.resolve();
    await stop();
  });
  await service.refresh();
  const active = service.release(caller, { id: 'sbx_test' });
  await entered.promise;
  let stopped = false;
  const stopping = Promise.resolve(stop()).then(() => {
    stopped = true;
  });
  await nextTurn();
  assert.equal(stopped, false, 'shutdown must not strand an admitted operation');
  release.resolve();
  assert.deepEqual(await active, { id: 'sbx_test', state: 'stopped' });
  await stopping;
  assert.deepEqual(methods, ['GET', 'DELETE', 'GET']);
});

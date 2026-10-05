import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from 'cordis';
import { ArtifactStore } from '@merv/artifacts';
import { DurableEvents } from '@merv/domain-events';
import { DiskBlobs } from '@merv/blobs';
import { createService, type ArtifactFileProvider } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import type { LaunchConnectionsProvider } from '@merv/sessions/types';
import { ApiServer } from '../packages/api/src/http.js';
import { ToolRegistry } from '../packages/api/src/registry.js';
import { sandboxesPlugin } from '../packages/sandboxes/src/index.js';
import { NativeConnections } from '../packages/sandboxes/src/native-connections.js';
import { NativeWorkService } from '../packages/sandboxes/src/native-work.js';
import { openState } from './fixtures/state.js';
import { deferred } from './fixtures/deferred.js';

async function foundation(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'merv-native-plugin-'));
  const state = await openState();
  const scope = await createService(new ProjectScope(state));
  const artifacts = await createService(
    new ArtifactStore(state, scope, new DiskBlobs(join(directory, 'blobs'))),
  );
  const events = await createService(new DurableEvents(state));
  const files = new Map<string, ArtifactFileProvider>();
  const register = artifacts.registerFileProvider.bind(artifacts);
  t.mock.method(
    artifacts,
    'registerFileProvider',
    (name: string, provider: ArtifactFileProvider) => {
      const dispose = register(name, provider);
      files.set(name, provider);
      return () => {
        dispose();
        files.delete(name);
      };
    },
  );
  let launcher: LaunchConnectionsProvider | undefined;
  const sessions = {
    registerLaunchConnections(provider: LaunchConnectionsProvider) {
      assert.equal(launcher, undefined);
      launcher = provider;
      return () => {
        if (launcher === provider) launcher = undefined;
      };
    },
  };
  const issuer = 'https://identity.example/auth/v1';
  const principal = await scope.acceptVerifiedIdentity({
    issuer,
    subject: 'owner',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  const project = await scope.createProject(principal, { name: 'Native plugin', requestId: 'one' });
  const tools = new ToolRegistry(scope);
  const api = new ApiServer(
    scope,
    tools,
    { port: 0 },
    {
      configuration: () => ({ enabled: true }),
      verify: async () => ({
        issuer,
        subject: 'owner',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      }),
    },
  );
  const url = await api.start();
  const ctx = new Context();
  ctx.provide('api', api);
  const native = {
    applicationId: 'merv',
    applicationSecretEnv: 'MERV_NATIVE_PLUGIN_APP',
    encryptionKeyEnv: 'MERV_NATIVE_PLUGIN_KEY',
    publicOrigin: 'http://127.0.0.1:4317',
  };
  const config = { urlEnv: 'MERV_NATIVE_PLUGIN_URL', connections: [], native };
  for (const [name, value] of Object.entries({
    MERV_NATIVE_PLUGIN_APP: 'synthetic-application-secret',
    MERV_NATIVE_PLUGIN_KEY: Buffer.alloc(32, 8).toString('base64url'),
    MERV_NATIVE_PLUGIN_URL: 'https://sandbox.invalid',
    MERV_NATIVE_PLUGIN_TOKEN: 'sbxt_native_plugin_fixture',
  })) {
    const old = process.env[name];
    process.env[name] = value;
    t.after(() => {
      if (old === undefined) delete process.env[name];
      else process.env[name] = old;
    });
  }
  const fetched: string[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    ((original) => async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const target = new URL(String(input));
      if (target.origin !== 'https://sandbox.invalid') return original(input, init);
      fetched.push(target.pathname);
      if (target.pathname === '/v1/auth/me')
        return Response.json({ role: 'consumer', namespace: 'legacy' });
      if (target.pathname === '/v1/ui/manifest') return Response.json({ version: 1, rows: [] });
      throw new Error('Unexpected synthetic native request');
    })(globalThis.fetch),
  );
  const owners = () => {
    ctx.provide('state', state);
    ctx.provide('scope', scope);
    ctx.provide('artifacts', artifacts);
    ctx.provide('sessions', sessions as never);
    ctx.provide('domainEvents', events);
  };
  t.after(async () => {
    await ctx.fiber.dispose();
    await api.stop();
    await tools.close();
    await events.close();
    await state.close();
    await rm(directory, { recursive: true, force: true });
  });
  const published = () =>
    new Promise<void>((resolve) => ctx.inject(['sandboxes'], () => resolve()));
  return {
    ctx,
    state,
    events,
    scope,
    artifacts,
    files,
    launcher: () => launcher,
    config,
    owners,
    published,
    url,
    project,
    fetched,
    headers: {
      authorization: 'Bearer owner.jwt.token',
      'x-merv-project-id': project.id,
      'content-type': 'application/json',
    },
  };
}

test('native plugin waits for all owners and migration before publishing providers or routes', async (t) => {
  const f = await foundation(t);
  const ready = f.published();
  const migrate = f.state.migrate.bind(f.state),
    entered = deferred<void>(),
    release = deferred<void>();
  t.mock.method(
    f.state,
    'migrate',
    async (name: string, migrations: Parameters<typeof migrate>[1]) => {
      if (name === 'sandboxes-native') {
        entered.resolve();
        await release.promise;
      }
      return migrate(name, migrations);
    },
  );
  const fiber = f.ctx.plugin(sandboxesPlugin, f.config);
  await fiber.await();
  assert.equal(f.ctx.sandboxes as unknown, undefined);
  assert.equal(f.launcher(), undefined);
  assert.equal(f.files.size, 0);
  f.owners();
  await entered.promise;
  assert.equal(f.ctx.sandboxes as unknown, undefined);
  assert.equal(f.launcher(), undefined);
  release.resolve();
  await ready;
  await nextTurn();
  assert.ok(f.launcher());
  // The retired compute path's ledgers stay registered with native Sandboxes, untouched.
  assert.deepEqual(
    await f.state.read((sql) =>
      sql.all(
        "SELECT component,version FROM component_migrations WHERE component IN ('sandboxes-compute','sandboxes-work-machines') ORDER BY component,version",
      ),
    ),
    [
      { component: 'sandboxes-compute', version: 1 },
      { component: 'sandboxes-compute', version: 2 },
      { component: 'sandboxes-work-machines', version: 1 },
    ],
  );
  assert.ok(f.files.has('sandboxes-native'));
  assert.ok(
    (await f.state.read((sql) => sql.get('SELECT * FROM sandbox_native_projects LIMIT 1'))) ===
      undefined,
  );
  assert.equal((await fetch(`${f.url}/sandboxes/connection`)).status, 401);
  const status = await fetch(`${f.url}/sandboxes/connection`, { headers: f.headers });
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), {
    available: true,
    connected: false,
    connectionId: null,
    accountId: null,
    memberId: null,
    connectedAt: null,
    funding: 'personal',
    managedAvailable: false,
    url: 'https://sandbox.invalid/ui',
  });
  assert.equal((await fetch(`${f.url}/sandboxes/connection/callback/finish`)).status, 404);
  await fiber.dispose();
  assert.equal(f.launcher(), undefined);
  assert.equal(f.files.size, 0);
  assert.equal((await fetch(`${f.url}/sandboxes/connection`, { headers: f.headers })).status, 503);
});

test('legacy Fleet/Code connections remain available without native owners and native UI is disabled', async (t) => {
  const f = await foundation(t);
  const config = {
    urlEnv: f.config.urlEnv,
    connections: [
      { projectId: f.project.id, namespace: 'legacy', tokenEnv: 'MERV_NATIVE_PLUGIN_TOKEN' },
    ],
    storageOrigins: ['https://bucket.invalid'],
    runtimes: [
      {
        key: 'hosted',
        provider: 'cloudflare-fleet',
        offerId: 'standard',
        releaseId: `rt1_${'a'.repeat(64)}`,
        leaseSeconds: 900,
      },
    ],
  };
  const fiber = f.ctx.plugin(sandboxesPlugin, config);
  await fiber.await();
  await nextTurn();
  assert.ok(f.ctx.sandboxes.checks);
  assert.ok(f.ctx.sandboxes.runtimes);
  assert.equal(f.ctx.sandboxes.runtimes.connected(f.project.id), true);
  assert.equal(f.launcher(), undefined);
  assert.equal(f.files.size, 0);
  await f.ctx.sandboxes.refresh();
  assert.equal(f.ctx.sandboxes.status().state, 'ready');
  const status = await fetch(`${f.url}/sandboxes/connection`, { headers: f.headers });
  assert.equal(status.status, 200);
  assert.equal(((await status.json()) as { available: boolean }).available, false);
  await fiber.dispose();
});

test('native plugin unload drains reconciliation and fences captured work handles', async (t) => {
  const f = await foundation(t);
  f.owners();
  const entered = deferred<void>(),
    release = deferred<void>();
  let workTicks = 0;
  t.mock.method(NativeConnections.prototype, 'reconcileRevocations', async () => {
    entered.resolve();
    await release.promise;
  });
  t.mock.method(NativeWorkService.prototype, 'reconcile', async () => {
    workTicks++;
  });
  const ready = f.published();
  const fiber = f.ctx.plugin(sandboxesPlugin, f.config);
  await ready;
  await entered.promise;
  const sandboxes = f.ctx.sandboxes;
  let drained = false;
  const disposing = fiber.dispose().then(() => {
    drained = true;
  });
  await nextTurn();
  assert.equal(drained, false);
  release.resolve();
  await disposing;
  assert.equal(workTicks, 0, 'stopping between reconcilers must not start the second pass');
  assert.equal(f.launcher(), undefined);
  assert.equal(f.files.size, 0);
  await assert.rejects(
    f.state.transaction((tx) => sandboxes.captures(f.project.id, 'work_after_unload', tx)),
    { code: 'sandboxes_closed' },
  );
});

test('native provider operations drain on unload and captured registrations refuse new admission', async (t) => {
  const f = await foundation(t);
  f.owners();
  const { NativeEvidence } = await import('../packages/sandboxes/src/native-evidence.js');
  const launchEntered = deferred<void>(),
    downloadEntered = deferred<void>(),
    release = deferred<void>();
  t.mock.method(NativeWorkService.prototype, 'launchConnections', async () => {
    launchEntered.resolve();
    await release.promise;
    return [];
  });
  t.mock.method(NativeEvidence.prototype, 'download', async () => {
    downloadEntered.resolve();
    await release.promise;
    return { url: 'https://bucket.invalid/fixture', expiresAt: '2099-01-01T00:00:00Z' };
  });
  const ready = f.published();
  const fiber = f.ctx.plugin(sandboxesPlugin, f.config);
  await ready;
  const launch = f.launcher()!,
    download = f.files.get('sandboxes-native')!;
  const issuing = launch({} as never),
    reading = download.download(f.project.id, 'fixture');
  await Promise.all([launchEntered.promise, downloadEntered.promise]);
  let drained = false;
  const disposing = fiber.dispose().then(() => {
    drained = true;
  });
  await nextTurn();
  assert.equal(drained, false);
  await assert.rejects(launch({} as never), { code: 'sandboxes_closed' });
  await assert.rejects(download.download(f.project.id, 'fixture'), { code: 'sandboxes_closed' });
  release.resolve();
  await Promise.all([issuing, reading, disposing]);
  assert.equal(drained, true);
  assert.equal(f.launcher(), undefined);
  assert.equal(f.files.size, 0);
});

test('unloading while native migration waits cannot publish late providers', async (t) => {
  const f = await foundation(t);
  f.owners();
  const entered = deferred<void>(),
    release = deferred<void>();
  const migrate = f.state.migrate.bind(f.state);
  t.mock.method(
    f.state,
    'migrate',
    async (name: string, migrations: Parameters<typeof migrate>[1]) => {
      if (name === 'sandboxes-native') {
        entered.resolve();
        await release.promise;
      }
      return migrate(name, migrations);
    },
  );
  const fiber = f.ctx.plugin(sandboxesPlugin, f.config);
  await entered.promise;
  const disposing = fiber.dispose();
  await nextTurn();
  release.resolve();
  await disposing;
  await nextTurn();
  assert.equal(f.ctx.sandboxes, undefined);
  assert.equal(f.launcher(), undefined);
  assert.equal(f.files.size, 0);
});

test('native plugin follows session closes and workflow transitions through its own durable consumers', async (t) => {
  const f = await foundation(t);
  f.owners();
  const ready = f.published();
  const fiber = f.ctx.plugin(sandboxesPlugin, f.config);
  await ready;
  const project = f.project.id;
  const later = new Date(Date.now() + 3_600_000).toISOString();
  await f.state.transaction(async (tx) => {
    await tx.run(
      `CREATE TABLE wf_instances (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workflow TEXT NOT NULL,
      revision INTEGER NOT NULL, data_json TEXT NOT NULL)`,
    );
    await tx.run(
      `INSERT INTO sandbox_native_connections(id,project_id,root_id,account_id,member_id,credentials,connected_at)
      VALUES('connection',?,'root','account','member','sealed',?)`,
      project,
      new Date().toISOString(),
    );
    await tx.run(
      `INSERT INTO sandbox_native_work(project_id,work_kind,work_id,connection_id,desired_attempt,epoch_revision)
      VALUES(?,'reflection','work_one','connection','1',1)`,
      project,
    );
    await tx.run(
      `INSERT INTO sandbox_native_assignments(lease_id,session_id,project_id,work_kind,work_id,attempt_ref,profile,expires_at,credentials)
      VALUES('lease_one','lease_one',?,'reflection','work_one','1','check',?,'sealed')`,
      project,
      later,
    );
    await tx.run(
      `INSERT INTO wf_instances(id,project_id,workflow,revision,data_json) VALUES('work_one',?,'reflection',2,'{}')`,
      project,
    );
    await f.state.appendEvent(tx, {
      projectId: project,
      actorId: 'system:sessions',
      type: 'session.closed',
      subjectId: 'lease_one',
      data: { sessionId: 'lease_one' },
    });
    await f.state.appendEvent(tx, {
      projectId: project,
      actorId: 'system:workflows',
      type: 'workflow.transition',
      subjectId: 'work_one',
      data: { workflow: 'reflection', revision: 2, terminal: true },
    });
  });
  await f.events.drain();
  const work = await f.state.read((sql) =>
    sql.get<{ desired_attempt: string; closed_at: string | null }>(
      "SELECT * FROM sandbox_native_work WHERE work_id='work_one'",
    ),
  );
  assert.equal(work!.desired_attempt, '2');
  assert.ok(work!.closed_at);
  const assignment = await f.state.read((sql) =>
    sql.get<{ revoke_pending: boolean }>(
      "SELECT * FROM sandbox_native_assignments WHERE lease_id='lease_one'",
    ),
  );
  assert.equal(assignment!.revoke_pending, true);
  assert.ok(
    await f.state.read((sql) =>
      sql.get("SELECT 1 FROM sandbox_native_revoked_leases WHERE lease_id='lease_one'"),
    ),
  );
  await fiber.dispose();
});

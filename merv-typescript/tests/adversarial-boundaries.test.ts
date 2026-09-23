import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SandboxClient } from '../packages/sandboxes/src/client.js';
import { SandboxService } from '../packages/sandboxes/src/index.js';
import { RecipeContextBuilder } from '../packages/context-builder/src/index.js';
import { ProjectScope } from '../packages/scope/src/index.js';
import { ArtifactStore } from '../packages/artifacts/src/index.js';
import { ToolRegistry } from '../packages/api/src/registry.js';
import { createService } from '../packages/contracts/src/index.js';
import { openState } from './fixtures/state.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const tokenEnv = 'MERV_ADVERSARIAL_TEST_TOKEN';
const connection = { projectId: 'project_test', namespace: 'test', tokenEnv };

test('rotated sandbox grants must be proved before resource access', async (t) => {
  process.env[tokenEnv] = 'sbxt_test_consumer';
  t.after(() => {
    delete process.env[tokenEnv];
  });
  let proofCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url: URL, options: RequestInit) => {
    const token = (options.headers as Record<string, string>).authorization;
    if (url.pathname === '/v1/auth/me') {
      proofCalls++;
      return json(
        token.endsWith('consumer') ? { role: 'consumer', namespace: 'test' } : { role: 'admin' },
      );
    }
    return json({ sandboxes: [], usedAdminGrant: token.endsWith('admin') });
  });
  const client = new SandboxClient('https://sandbox.test');
  await client.read(connection, '/v1/sandboxes');
  assert.equal(proofCalls, 1);
  process.env[tokenEnv] = 'sbxt_test_admin';
  // A new instance correctly refuses this exact replacement grant.
  await assert.rejects(
    new SandboxClient('https://sandbox.test').read(connection, '/v1/sandboxes'),
    { code: 'sandbox_forbidden' },
  );
  // The existing instance must enforce the same consumer-only boundary.
  await assert.rejects(client.read(connection, '/v1/sandboxes'), { code: 'sandbox_forbidden' });
});

test('rotation while a sandbox grant is being proved cannot dispatch either grant', async (t) => {
  process.env[tokenEnv] = 'sbxt_test_consumer';
  t.after(() => {
    delete process.env[tokenEnv];
  });
  const entered = deferred(),
    release = deferred();
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: URL) => {
    requests.push(url.pathname);
    entered.resolve();
    await release.promise;
    return json({ role: 'consumer', namespace: 'test' });
  });
  const client = new SandboxClient('https://sandbox.test');
  const pending = client.read(connection, '/v1/sandboxes');
  const rejected = assert.rejects(pending, { code: 'sandbox_credential_changed' });
  await entered.promise;
  process.env[tokenEnv] = 'sbxt_test_replacement';
  release.resolve();
  await rejected;
  assert.deepEqual(requests, ['/v1/auth/me']);
  await client.read(connection, '/v1/sandboxes');
  assert.deepEqual(requests, ['/v1/auth/me', '/v1/auth/me', '/v1/sandboxes']);
});

test('a sandbox grant proved for one namespace cannot prove another', async (t) => {
  process.env[tokenEnv] = 'sbxt_test_consumer';
  t.after(() => {
    delete process.env[tokenEnv];
  });
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: URL) => {
    requests.push(url.pathname);
    return json({ role: 'consumer', namespace: 'test' });
  });
  const client = new SandboxClient('https://sandbox.test');
  await client.read(connection, '/v1/sandboxes');
  await assert.rejects(
    client.write({ ...connection, namespace: 'other' }, 'DELETE', '/v1/sandboxes/sbx_test', {}),
    { code: 'sandbox_forbidden' },
  );
  assert.deepEqual(requests, ['/v1/auth/me', '/v1/sandboxes', '/v1/auth/me']);
});

test('independent sandbox clients cannot overwrite a renewal calculated from a stale read', async (t) => {
  const urlEnv = 'MERV_ADVERSARIAL_TEST_URL';
  process.env[tokenEnv] = 'sbxt_test_consumer';
  process.env[urlEnv] = 'https://sandbox.test';
  t.after(() => {
    delete process.env[tokenEnv];
    delete process.env[urlEnv];
  });
  const time = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => time);
  let expiresAt = time + 600_000,
    revision = 0,
    reads = 0;
  const bothRead = deferred(),
    longWritten = deferred();
  t.mock.method(globalThis, 'fetch', async (url: URL, options: RequestInit) => {
    if (url.pathname === '/v1/auth/me') return json({ role: 'consumer', namespace: 'test' });
    if (options.method === 'GET') {
      const snapshot = { lease_expires_at: new Date(expiresAt).toISOString(), revision };
      if (++reads === 2) bothRead.resolve();
      await bothRead.promise;
      return json(snapshot);
    }
    const body = JSON.parse(options.body as string);
    assert.equal(body.expected_revision, 0, 'the client must pin the revision of its GET');
    if (body.lease_seconds === 660) await longWritten.promise;
    if (body.expected_revision !== revision)
      return json(
        {
          error: {
            code: 'operation_state',
            message: 'sandbox changed concurrently; read it again',
          },
        },
        409,
      );
    expiresAt = time + body.lease_seconds * 1000;
    revision++;
    longWritten.resolve();
    return json({ lease_expires_at: new Date(expiresAt).toISOString(), revision });
  });
  const config = { urlEnv, connections: [connection] };
  const caller = { actorId: 'actor_test', projectId: connection.projectId };
  const results = await Promise.allSettled([
    new SandboxService(config).extend(caller, { id: 'sbx_test', seconds: 600 }),
    new SandboxService(config).extend(caller, { id: 'sbx_test', seconds: 60 }),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  if (results[1].status === 'rejected')
    assert.equal(results[1].reason.code, 'sandbox_operation_state');
  assert.equal(expiresAt, time + 1_200_000);
  assert.equal(revision, 1);
});

test('sandbox extension refuses missing revisions and never falls back on an old service', async (t) => {
  const urlEnv = 'MERV_ADVERSARIAL_TEST_URL';
  process.env[tokenEnv] = 'sbxt_test_consumer';
  process.env[urlEnv] = 'https://sandbox.test';
  t.after(() => {
    delete process.env[tokenEnv];
    delete process.env[urlEnv];
  });
  let record: Record<string, unknown> = {},
    writes = 0;
  t.mock.method(globalThis, 'fetch', async (url: URL, options: RequestInit) => {
    if (url.pathname === '/v1/auth/me') return json({ role: 'consumer', namespace: 'test' });
    if (options.method === 'GET') return json(record);
    writes++;
    assert.equal(JSON.parse(options.body as string).expected_revision, 1);
    return json({ error: { code: 'validation', message: 'Unknown expected_revision field' } }, 400);
  });
  const service = new SandboxService({ urlEnv, connections: [connection] });
  const caller = { actorId: 'actor_test', projectId: connection.projectId };
  for (const revision of [undefined, -1, '1', 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    record = { revision };
    await assert.rejects(service.extend(caller, { id: 'sbx_test', seconds: 60 }), {
      code: 'sandbox_revision_unavailable',
    });
  }
  assert.equal(writes, 0);
  record = { revision: 1 };
  await assert.rejects(service.extend(caller, { id: 'sbx_test', seconds: 60 }), {
    code: 'sandbox_validation',
  });
  assert.equal(writes, 1);
});

for (const mode of ['inline', 'download'] as const)
  test(`PostgreSQL ${mode} read must reject a caller revoked during storage access`, async (t) => {
    const state = await openState(undefined, { readConnections: 1 });
    t.after(async () => {
      await state.close();
    });
    const scope = await createService(new ProjectScope(state));
    const entered = deferred();
    const release = deferred();
    const artifacts = await createService(
      new ArtifactStore(state, scope, {
        put: async (_namespace, bytes) => ({
          hash: createHash('sha256').update(bytes).digest('hex'),
          size: bytes.length,
        }),
        get: async () => {
          entered.resolve();
          await release.promise;
          return Buffer.from('private evidence');
        },
        download: async () => {
          entered.resolve();
          await release.promise;
          return {
            url: 'https://storage.test/private-signed-url',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          };
        },
      }),
    );
    const boot = await scope.bootstrap({ projectName: 'Adversarial test', actorName: 'Owner' });
    const operator = {
      projectId: boot.project.id,
      actorId: boot.actor.id,
      credentialId: boot.credential.id,
    };
    const issued = await scope.issueActor(operator, { name: 'Reader', role: 'reader' });
    const reader = {
      projectId: boot.project.id,
      actorId: issued.actor.id,
      credentialId: issued.credential.id,
    };
    const artifact = await artifacts.create(operator, {
      title: 'Private evidence',
      content: 'private evidence',
    });
    // This is the exact snapshot wrapper used by the shipped toolsPlugin.
    const tools = new ToolRegistry(scope, scope.toolPolicy, (fn) => state.snapshot(fn));
    t.after(() => tools.close());
    const { z } = await import('zod');
    tools.register({
      name: 'artifact.read',
      description: 'Download',
      readOnly: true,
      inputSchema: z.object({ artifactId: z.string() }),
      handler: (caller, input) =>
        mode === 'download'
          ? artifacts.download(caller, input.artifactId)
          : artifacts.read(caller, input.artifactId),
    });
    const pending = tools.call('artifact.read', reader, { artifactId: artifact.id });
    const rejected = assert.rejects(pending, { code: 'forbidden' });
    await entered.promise;
    try {
      await scope.revokeActor(operator, reader.actorId);
    } finally {
      release.resolve();
    }
    await rejected;
    await assert.rejects(scope.require(reader, 'read'), { code: 'forbidden' });
  });

test('concurrent registrations of one recipe must have exactly one owner', async (t) => {
  const state = await openState(':memory:');
  t.after(() => state.close());
  const scope = await createService(new ProjectScope(state));
  const builder = await createService(new RecipeContextBuilder(state, scope, {} as never));
  t.after(() => builder.close());
  const boot = await scope.bootstrap({ projectName: 'Recipe race', actorName: 'Owner' });
  const caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  const definition = {
    name: 'test.race',
    version: 1,
    kind: 'work' as const,
    recipe: {
      instructions: 'Do the task.',
      outputInstructions: 'Return the result.',
      sections: [{ key: 'task', title: 'Task', required: true }],
      maxChars: 1200,
    },
  };
  const results = await Promise.allSettled([
    builder.register(definition),
    builder.register(definition),
  ]);
  const successful = results.filter((r) => r.status === 'fulfilled');
  const refused = results.filter((r) => r.status === 'rejected');
  assert.equal(successful.length, 1);
  assert.equal(refused.length, 1);
  assert.equal(refused[0].reason.code, 'recipe_registered');
  const input = { subject: { id: 'task_test', revision: 0 }, inputs: { task: { text: 'Work' } } };
  assert.match((await successful[0].value.preview(caller, input)).prompt, /Work/);
  successful[0].value.dispose();
  const replacement = await builder.register(definition);
  assert.match((await replacement.preview(caller, input)).prompt, /Work/);
  replacement.dispose();
  await assert.rejects(
    builder.register({ ...definition, recipe: { ...definition.recipe, instructions: 'Changed' } }),
    { code: 'recipe_changed' },
  );
  // A failed storage registration must release its reservation for the original version.
  assert.match((await (await builder.register(definition)).preview(caller, input)).prompt, /Work/);
});

test('closing Context Builder during registration cannot publish a live handle', async (t) => {
  const state = await openState(':memory:');
  t.after(() => state.close());
  const builder = await createService(new RecipeContextBuilder(state, {} as never, {} as never));
  const entered = deferred(),
    release = deferred();
  const held = state.transaction(async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const pending = builder.register({
    name: 'test.close',
    version: 1,
    kind: 'work',
    recipe: {
      instructions: 'Work',
      outputInstructions: 'Report',
      sections: [{ key: 'task', title: 'Task', required: true }],
      maxChars: 1200,
    },
  });
  const rejected = assert.rejects(pending, { code: 'context_builder_closed' });
  builder.close();
  release.resolve();
  await held;
  await rejected;
});

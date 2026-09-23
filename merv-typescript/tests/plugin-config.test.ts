import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Context, FiberState, ValidationError, type Plugin } from 'cordis';
import { statePlugin } from '@merv/state';
import { blobsPlugin } from '@merv/blobs';
import { scopePlugin } from '@merv/scope';
import { identityPlugin } from '@merv/identity';
import { apiPlugin, toolsPlugin } from '@merv/api';
import { openState, schemaFor, stateConfig } from './fixtures/state.js';

function folder(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-plugin-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function dependencies(ctx: Context, service: string) {
  if (service !== 'tools' && service !== 'api') return;
  await ctx.plugin(statePlugin, stateConfig(':memory:'));
  await ctx.plugin(scopePlugin);
  if (service === 'api') {
    await ctx.plugin(toolsPlugin);
    await ctx.plugin(identityPlugin, {});
  }
}

async function rejectsBeforePublication(
  plugin: Plugin,
  service: string,
  config: unknown,
  expected: assert.AssertPredicate = ValidationError,
) {
  const ctx = new Context();
  try {
    await dependencies(ctx, service);
    const fiber = ctx.plugin(plugin, config);
    // Cordis currently leaves state=PENDING after schema rejection. Its await()
    // rejection is authoritative; no apply() effect or service may be published.
    await assert.rejects(fiber.await(), expected);
    assert.equal(ctx.get(service), undefined);
    assert.deepEqual(fiber.getEffects(), []);
  } finally {
    await ctx.fiber.dispose();
  }
}

test('State Config rejects blank, wrong-type, retired and extra options before connecting', async (t) => {
  const directory = folder(t),
    schema = schemaFor(join(directory, 'must-not-exist'));
  const observer = await openState();
  const created = async () =>
    (
      await observer.read((sql) =>
        sql.get<{ name: string | null }>('SELECT to_regnamespace(?)::text AS name', schema),
      )
    )?.name ?? null;
  const url = 'MERV_TEST_POSTGRES_URL';
  for (const config of [
    null,
    [],
    // The retired SQLite options are unknown keys now, not a second backend.
    { path: join(directory, 'state.sqlite') },
    { backend: 'sqlite', connectionStringEnv: url, schema },
    { connectionStringEnv: '', schema },
    { connectionStringEnv: ' \t', schema },
    { connectionStringEnv: 42, schema },
    { connectionStringEnv: url, schema: '' },
    { connectionStringEnv: url, schema: '1bad' },
    { connectionStringEnv: url, schema, schemaEnv: 'not-a-name' },
    { connectionStringEnv: url, schema, maxConnections: 0 },
    { connectionStringEnv: url, schema, extra: true },
  ]) {
    await rejectsBeforePublication(statePlugin, 'state', config);
    assert.equal(await created(), null);
  }
  // A well-formed entry whose connection variable is unset is refused by apply(), still before
  // connecting or publishing the service.
  const missing = 'MERV_TEST_UNSET_DATABASE_URL';
  assert.equal(process.env[missing], undefined);
  await rejectsBeforePublication(
    statePlugin,
    'state',
    { connectionStringEnv: missing, schema },
    { code: 'invalid_config' },
  );
  assert.equal(await created(), null);
});

test('Blobs Config rejects missing, blank, wrong-type and extra options before making directories', async (t) => {
  const directory = folder(t),
    root = join(directory, 'must-not-exist');
  for (const config of [
    undefined,
    null,
    {},
    { root: '' },
    { root: ' \n' },
    { root: false },
    { root, extra: true },
  ]) {
    await rejectsBeforePublication(blobsPlugin, 'blobs', config);
    assert.equal(existsSync(root), false);
  }
});

test('Tools Config defaults to an empty object and rejects accidental resource options', async () => {
  for (const config of [null, [], 'wrong', { port: 3000 }]) {
    await rejectsBeforePublication(toolsPlugin, 'tools', config);
  }
  const ctx = new Context();
  try {
    await dependencies(ctx, 'tools');
    const fiber = await ctx.plugin(toolsPlugin);
    assert.equal(fiber.state, FiberState.ACTIVE);
    assert.deepEqual(fiber.config, {});
    assert.deepEqual(await ctx.tools.list(), []);
    const credential = await ctx.scope.bootstrap({
      projectName: 'Registry defaults',
      actorName: 'Operator',
    });
    await assert.rejects(
      ctx.tools.call(
        'missing',
        { actorId: credential.actor.id, projectId: credential.project.id },
        {},
      ),
      { code: 'unknown_tool' },
    );
  } finally {
    await ctx.fiber.dispose();
  }
});

test('API Config validates options before publishing or listening', async () => {
  const malformed = [
    null,
    [],
    { extra: true },
    { host: '' },
    { host: ' ' },
    { host: false },
    { port: -1 },
    { port: 65536 },
    { port: 0.5 },
    { port: '3081' },
    { maxBodyBytes: 0 },
    { maxBodyBytes: 1.5 },
    { maxBodyBytes: Number.MAX_SAFE_INTEGER + 1 },
    { allowedOrigins: 'https://example.com' },
    { allowedOrigins: [null] },
    { allowedOrigins: [''] },
    { allowedOrigins: ['https://example.com/path'] },
    { allowedOrigins: ['https://user:password@example.com'] },
    { allowedOrigins: ['file:///tmp'] },
  ];
  for (const config of malformed) await rejectsBeforePublication(apiPlugin, 'api', config);
});

test('valid resource locations are preserved and Cordis owns their published services', async (t) => {
  const directory = folder(t),
    config = stateConfig(directory),
    root = join(directory, 'blob directory');
  const ctx = new Context();
  try {
    const state = await ctx.plugin(statePlugin, config);
    const blobs = await ctx.plugin(blobsPlugin, { root });
    assert.equal(state.state, FiberState.ACTIVE);
    assert.equal(blobs.state, FiberState.ACTIVE);
    assert.equal(state.config.schema, config.schema);
    assert.equal(blobs.config.root, root);
    assert.equal(
      (
        await ctx.state.read(
          async (sql) => await sql.get<{ schema: string }>('SELECT current_schema() AS schema'),
        )
      )?.schema,
      config.schema,
    );
    const stored = await ctx.blobs.put(
      'config-test',
      Buffer.from('Configuration preserved bytes.'),
    );
    assert.equal(
      (await ctx.blobs.get('config-test', stored.hash)).toString(),
      'Configuration preserved bytes.',
    );
  } finally {
    await ctx.fiber.dispose();
  }
});

test('API no-config defaults remain loopback and ephemeral with a working registry', async () => {
  const ctx = new Context();
  try {
    await dependencies(ctx, 'api');
    const fiber = await ctx.plugin(apiPlugin);
    assert.equal(fiber.state, FiberState.ACTIVE);
    assert.deepEqual(fiber.config, {});
    const url = new URL(ctx.api.url!);
    assert.equal(url.hostname, '127.0.0.1');
    assert.ok(Number(url.port) > 0);
    const credentials = await ctx.scope.bootstrap({
      projectName: 'API defaults',
      actorName: 'Operator',
    });
    assert.equal((await fetch(new URL('/health', url))).status, 200);
    assert.deepEqual(await (await fetch(new URL('/auth/config', url))).json(), { enabled: false });
    const response = await fetch(new URL('/tools', url), {
      headers: { authorization: `Bearer ${credentials.token}` },
    });
    assert.deepEqual(await response.json(), { tools: [] });
  } finally {
    await ctx.fiber.dispose();
  }
});

test('API accepts explicit zero port, byte limit and exact allowed origins without changing them', async () => {
  const ctx = new Context();
  try {
    await dependencies(ctx, 'api');
    const config = {
      host: '127.0.0.1',
      port: 0,
      maxBodyBytes: 1024,
      allowedOrigins: ['https://example.com', 'http://localhost:4000', 'null'],
    };
    const fiber = await ctx.plugin(apiPlugin, config);
    assert.equal(fiber.state, FiberState.ACTIVE);
    assert.deepEqual(fiber.config, config);
    assert.equal(
      (await fetch(ctx.api.url! + '/health', { headers: { origin: 'https://example.com' } }))
        .status,
      200,
    );
    assert.equal(
      (await fetch(ctx.api.url! + '/health', { headers: { origin: 'https://unlisted.example' } }))
        .status,
      403,
    );
  } finally {
    await ctx.fiber.dispose();
  }
});

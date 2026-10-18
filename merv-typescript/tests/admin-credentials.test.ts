import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Context } from 'cordis';
import type { ZodType } from 'zod';
import {
  createService,
  MervError,
  type ConfiguredEnv,
  type Principal,
  type State,
} from '@merv/contracts';
import { adminPlugin } from '@merv/admin';
import type { AdminCredentialsV2 } from '@merv/admin/models';
import type { ApiRequest, MountHandler } from '@merv/api/types';
import type { ManagedModelGrant } from '@merv/fleet/types';
import { CredentialStore } from '@merv/identity/credentials';
import { ProjectScope } from '@merv/scope';
import { AccountSecrets } from '@merv/secrets';
import host from '@merv/sandboxes/host';
import { migrate, openDatabase } from '@sandboxes/db';
import { auditMigrations, AdminAudit } from '../packages/admin/src/audit.js';
import { credentialMigrations, credentialRoutes } from '../packages/admin/src/credentials.js';
import type { AdminEnv } from '../packages/admin/src/index.js';
import { codexModelRelay } from '../packages/fleet/src/codex-relay.js';
import { FleetService } from '../packages/fleet/src/index.js';
import { modelMigrations } from '../packages/fleet/src/schema.js';
import { createApp } from './fixtures/app.js';
import { reads } from './fixtures/env-reader.js';
import { openState, postgresUrl, schemaFor, stateConfig } from './fixtures/state.js';

/** Sets each variable for the test, and puts back what was there. */
function environment(t: TestContext, values: Record<string, string>) {
  for (const [name, value] of Object.entries(values)) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
}
const secret = () => randomBytes(24).toString('base64url');
const encryptionKey = () => randomBytes(32).toString('base64url');
/** No six characters in a row of any value appear in `said`. */
const undisclosed = (said: unknown, values: string[]) => {
  const text = JSON.stringify(said);
  for (const value of values)
    for (let i = 0; i + 6 <= value.length; i++)
      assert.ok(!text.includes(value.slice(i, i + 6)), 'a credential value was disclosed');
};

test('the composition root names each *Env field of its enabled entries by its owner’s words', async (t) => {
  environment(t, { ADMIN_TEST_FALLBACK: secret() });
  const directory = mkdtempSync(join(tmpdir(), 'merv-admin-environment-'));
  const app = await createApp({
    directory,
    config: {
      plugins: [
        { id: 'state', name: '@merv/state', config: stateConfig(directory) },
        { id: 'web', name: '@merv/web', config: { fallback: { keyEnv: 'ADMIN_TEST_FALLBACK' } } },
        { id: 'nisa', name: '@merv/nisa', disabled: true, config: { keyEnv: 'ADMIN_TEST_NISA' } },
        // A union's branch, and an object's defaults: read where the entry never started.
        { id: 'blobs', name: '@merv/blobs', required: false, config: { backend: 's3' } },
      ],
    },
  });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const blobs = (field: string, env: string, purpose: string) => ({
    plugin: 'blobs',
    field,
    env,
    purpose: `Stored files · S3 ${purpose}`,
    overridable: true,
  });
  assert.deepEqual(app.ctx.get('composition')!.environment(), [
    {
      plugin: 'state',
      field: 'connectionStringEnv',
      env: 'MERV_TEST_POSTGRES_URL',
      purpose: 'Merv database · Postgres connection URL',
      // State reads it before the stored secrets open.
      overridable: false,
    },
    {
      plugin: 'web',
      field: 'keyEnv',
      env: 'MERV_TAVILY_API_KEY',
      purpose: 'Web search for agents · Tavily API key',
      overridable: true,
    },
    {
      plugin: 'web',
      field: 'fallback.keyEnv',
      env: 'ADMIN_TEST_FALLBACK',
      purpose: 'Web search fallback for agents · OpenAI API key',
      overridable: true,
    },
    blobs('bucketEnv', 'MERV_BLOB_BUCKET', 'bucket'),
    blobs('endpointEnv', 'MERV_BLOB_ENDPOINT_URL', 'endpoint'),
    blobs('accessKeyIdEnv', 'MERV_BLOB_ACCESS_KEY_ID', 'access key id'),
    blobs('secretAccessKeyEnv', 'MERV_BLOB_SECRET_ACCESS_KEY', 'secret access key'),
    blobs('regionEnv', 'MERV_BLOB_REGION', 'region'),
    blobs('prefixEnv', 'MERV_BLOB_PREFIX', 'key prefix'),
  ]);
});

const ACCOUNT = 'a'.repeat(32);
const bearer = `ms_${'c'.repeat(43)}`;
const grant: ManagedModelGrant = {
  id: 'session_admin',
  projectId: 'project_admin',
  allocationId: 'flt_admin',
  person: 'person_admin',
  model: 'gpt-6-luna',
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};
const admin = { issuer: 'https://identity.example', subject: 'founder' };

test('GET /admin/credentials names each secret by purpose, sandbox keys apart, never a value', async (t) => {
  const [openai, rotated, managed, bridge, native, user] = Array.from({ length: 6 }, secret);
  environment(t, {
    // Pi and the web fallback name one variable, Fleet another holding the same key.
    ADMIN_TEST_PI_KEY: openai,
    ADMIN_TEST_SHARED: openai,
    ADMIN_TEST_MANAGED: managed,
    ADMIN_TEST_CF: JSON.stringify({
      bridge_url: 'https://bridge.example.test',
      bridge_token: bridge,
      cloudflare_api_token: native,
    }),
    ADMIN_TEST_VAULT_KEY: Buffer.alloc(32, 9).toString('base64url'),
  });
  // Every vendor this test reaches answers here; anything else would be the network.
  const upstream: Response[] = [];
  const asked: string[] = [];
  const { fetch: send } = globalThis;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    asked.push(url);
    if (url === 'https://bridge.example.test/health')
      return Response.json({ status: 'ok', version: '1' });
    if (/^https:\/\/api\.cloudflare\.com\/client\/v4\/.*tokens\/verify$/.test(url))
      return Response.json({ success: false, errors: [{ code: 1000 }] }, { status: 401 });
    if (url === 'https://api.openai.com/v1/responses') return upstream.shift()!;
    throw new Error(`unexpected request to ${url}`);
  }) as typeof fetch;
  t.after(() => void (globalThis.fetch = send));

  const state = await openState();
  await createService(new ProjectScope(state));
  await state.migrate('admin', { ...auditMigrations, ...credentialMigrations });
  const secrets = await createService(new AccountSecrets(state, encryptionKey()));

  // Fleet's relay keeps what the provider did with the key, per day.
  const fleet = await createService(
    new FleetService(state, {} as never, {} as never, {
      profiles: [
        {
          key: 'standard',
          provider: 'test',
          offerId: 'offer',
          releaseId: `rt1_${'0'.repeat(64)}`,
          leaseSeconds: 900,
        },
      ],
    }),
  );
  await state.migrate('fleet_workflow', modelMigrations);
  const relay = fleet.modelRelay(
    codexModelRelay(state, {
      providerKey: () => process.env.ADMIN_TEST_SHARED ?? '',
      dailyTokensPerPerson: 1_000_000,
      authorize: async () => grant,
    }),
    'ADMIN_TEST_SHARED',
  );
  const server = createServer((req, res) => void relay.handle(req, res, undefined as never));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    relay.close();
    server.close();
  });
  const call = () =>
    send(`http://127.0.0.1:${(server.address() as AddressInfo).port}/codex-model/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: grant.model,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
        store: false,
        stream: true,
      }),
    }).then((response) => response.text());
  const completed = {
    type: 'response.completed',
    response: { usage: { input_tokens: 7, output_tokens: 3 } },
  };
  upstream.push(
    new Response(`event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    }),
    Response.json({ error: { code: 'invalid_api_key' } }, { status: 401 }),
  );
  // A stream's usage is kept as it closes: each call is kept before the next one is made.
  let outcomes = await fleet.relayOutcomes();
  const recorded = async (settled: () => unknown) => {
    for (let tries = 0; tries < 100 && !settled(); tries++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      outcomes = await fleet.relayOutcomes();
    }
  };
  await call();
  await recorded(() => outcomes[0]?.lastOkAt);
  await call();
  await recorded(() => outcomes[0]?.lastFailureAt);
  assert.deepEqual(
    outcomes.map(({ lastOkAt, lastFailureAt, ...row }) => [row, !!lastOkAt, !!lastFailureAt]),
    [
      [
        {
          relay: 'codex',
          keyEnv: 'ADMIN_TEST_SHARED',
          model: 'gpt-6-luna',
          lastFailureStatus: 401,
          lastFailureCode: null,
          rejected: true,
        },
        true,
        true,
      ],
    ],
  );

  // Identity's ledger of minted credentials, summarised by owner and kind.
  const ledger = new CredentialStore(state);
  await ledger.initialize();
  const soon = new Date(Date.now() + 3_600_000).toISOString();
  const minted = [
    await ledger.issue({ owner: 'pi', subject: 'machine-1', kind: 'pi-worker', expiresAt: soon }),
    await ledger.issue({
      owner: 'pi',
      subject: 'machine-2',
      kind: 'pi-worker',
      expiresAt: new Date(Date.now() + 7_200_000).toISOString(),
    }),
    await ledger.issue({ owner: 'sessions', subject: 's-1', kind: 'managed', expiresAt: null }),
  ];
  await ledger.revoke(minted[1]!.credential.tokenHash, 'pi');

  // Sandboxes in process, with a host Cloudflare instance and one user's own saved key.
  const schema = schemaFor();
  const db = await openDatabase({ url: postgresUrl, schema });
  await migrate(db, { schemaExplicit: true });
  const dataDir = mkdtempSync(join(tmpdir(), 'merv-admin-sandboxes-'));
  const sandboxes = new Context();
  const fiber = sandboxes.plugin(
    host,
    host.Config.parse({
      databaseUrlEnv: 'MERV_TEST_POSTGRES_URL',
      schema,
      vaultKeyEnv: 'ADMIN_TEST_VAULT_KEY',
      publicOrigin: 'https://sandboxes.example',
      dataDir,
      relayEvents: false,
      settings: {
        providers: [
          {
            name: 'cf',
            plugin: 'cloudflare',
            access: 'tunnel',
            credential: 'env://ADMIN_TEST_CF',
            settings: { account_id: ACCOUNT },
          },
        ],
      },
    }),
  );
  t.after(async () => {
    await fiber.dispose();
    await db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  await fiber.await();
  await sandboxes.sbxVault.save({
    namespace: 'team-a',
    name: 'mine',
    plugin: 'cloudflare',
    fields: { bridge_url: 'https://user-bridge.example.test', bridge_token: user },
    settings: {},
    access: 'tunnel',
    verified: true,
  });
  const statements: string[] = [];
  const pool = sandboxes.sbxDb as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const method of ['query', 'get', 'all', 'run']) {
    const original = pool[method]!;
    pool[method] = (sql, ...rest) => (
      statements.push(String(sql)),
      original.call(pool, sql, ...rest)
    );
    t.after(() => void (pool[method] = original));
  }

  const ref = (plugin: string, field: string, env: string, purpose: string): ConfiguredEnv => ({
    plugin,
    field,
    env,
    purpose,
    overridable: plugin !== 'state',
  });
  const named = [
    ref('pi', 'modelApiKeyEnv', 'ADMIN_TEST_PI_KEY', 'Agent model calls · OpenAI API key'),
    ref('fleet-workflow', 'modelApiKeyEnv', 'ADMIN_TEST_SHARED', 'Fleet agent model calls'),
    ref('sessions', 'managedSecretEnv', 'ADMIN_TEST_MANAGED', 'Fleet machine runner tokens'),
    ref('web', 'fallback.keyEnv', 'ADMIN_TEST_PI_KEY', 'Web search fallback for agents'),
    ref('nisa', 'keyEnv', 'ADMIN_TEST_UNSET', 'Literature search for agents'),
    ref('state', 'connectionStringEnv', 'MERV_TEST_POSTGRES_URL', 'Merv database'),
  ];
  const services: Record<string, unknown> = {
    composition: { status: () => [], environment: () => named },
    fleet,
    secrets,
    sbxProviders: sandboxes.sbxProviders,
  };
  const env = {
    ctx: { get: (name: string) => services[name] },
    state,
    audit: new AdminAudit(state),
    admins: [admin],
  } as unknown as AdminEnv;
  const read = async () =>
    (await credentialRoutes(env)['GET /admin/credentials']!(
      {} as ApiRequest,
      admin,
    )) as AdminCredentialsV2;

  const first = await read();
  const name = ({ plugin, field, env }: ConfiguredEnv) => ({ plugin, field, env });
  assert.deepEqual(
    first.groups.map((group) => [group.purpose, group.secrets.map((s) => s.plugin)]),
    [
      ['Agent', ['pi']],
      ['Fleet agents', ['fleet-workflow']],
      ['Fleet machines', ['sessions']],
      ['Platform services', ['web', 'nisa', 'state']],
    ],
  );
  const [pi, agents, machines, platform] = first.groups;
  assert.deepEqual(
    { ...agents!.secrets[0], lastOk: agents!.secrets[0]!.lastOk?.relay },
    {
      plugin: 'fleet-workflow',
      field: 'modelApiKeyEnv',
      env: 'ADMIN_TEST_SHARED',
      purpose: 'Fleet agent model calls',
      set: true,
      // The same key under another name, and the same name in another plugin.
      sharedWith: [name(named[0]!), name(named[3]!)],
      lastChanged: null,
      lastOk: 'codex',
      lastFailure: {
        at: outcomes[0]!.lastFailureAt,
        relay: 'codex',
        model: 'gpt-6-luna',
        status: 401,
        code: null,
      },
      // Refused as invalid after its last success, and not changed since.
      dead: true,
      editable: true,
    },
  );
  assert.deepEqual(
    pi!.secrets.map((s) => [s.env, s.purpose, s.sharedWith, s.dead]),
    [
      [
        'ADMIN_TEST_PI_KEY',
        'Agent model calls · OpenAI API key',
        [name(named[1]!), name(named[3]!)],
        false,
      ],
    ],
  );
  assert.deepEqual(
    machines!.secrets.map((s) => [s.env, s.set, s.sharedWith]),
    [['ADMIN_TEST_MANAGED', true, []]],
  );
  assert.deepEqual(
    platform!.secrets.map((s) => [s.plugin, s.field, s.set, s.editable]),
    [
      ['web', 'fallback.keyEnv', true, true],
      // Named in config, unset in the process.
      ['nisa', 'keyEnv', false, true],
      // Read before the stored secrets open: shown, never revealed or changed here.
      ['state', 'connectionStringEnv', true, false],
    ],
  );
  // Sandbox provider keys are their own table: a host instance's health asks Cloudflare about
  // the native token; a user's own key stays sealed.
  assert.deepEqual(
    first.providers.map((p) => [
      p.provider,
      p.source,
      p.namespace,
      p.field,
      p.secret,
      p.present,
      p.health,
      p.healthReason,
      !!p.verifiedAt,
      p.editable,
    ]),
    [
      [
        'cf',
        'host',
        null,
        'bridge_url',
        false,
        true,
        'degraded',
        'credential_rejected',
        false,
        true,
      ],
      [
        'cf',
        'host',
        null,
        'bridge_token',
        true,
        true,
        'degraded',
        'credential_rejected',
        false,
        true,
      ],
      [
        'cf',
        'host',
        null,
        'cloudflare_api_token',
        true,
        true,
        'degraded',
        'credential_rejected',
        false,
        true,
      ],
      ['mine', 'user', 'team-a', 'bridge_url', false, true, null, null, true, true],
      ['mine', 'user', 'team-a', 'bridge_token', true, true, null, null, true, true],
      ['mine', 'user', 'team-a', 'cloudflare_api_token', true, null, null, null, true, true],
    ],
  );
  assert.equal(first.providers[1]!.description, 'Bearer token the Worker was given');
  assert.ok(statements.some((sql) => sql.includes('FROM provider_credentials')));
  assert.ok(
    statements.every((sql) => !/\bsecret\b/.test(sql)),
    'the sealed column is never read',
  );
  assert.deepEqual(
    first.minted.map(({ newestIssued, ...row }) => [row, !!newestIssued]),
    [
      [{ owner: 'pi', kind: 'pi-worker', live: 1, soonestExpiry: soon, revokedLastDay: 1 }, true],
      [
        { owner: 'sessions', kind: 'managed', live: 1, soonestExpiry: null, revokedLastDay: 0 },
        true,
      ],
    ],
  );

  // A key changed here reads as changed then, and its earlier refusal no longer marks it dead.
  process.env.ADMIN_TEST_SHARED = rotated;
  await secrets.setPlatformSecret('ADMIN_TEST_SHARED', rotated, admin);
  const [{ updatedAt }] = await secrets.platformSecrets();
  const second = await read();
  const [again] = second.groups[1]!.secrets;
  assert.deepEqual([again!.lastChanged, again!.sharedWith, again!.dead], [updatedAt, [], false]);
  assert.deepEqual(second.groups[0]!.secrets[0]!.sharedWith, [name(named[3]!)]);
  // Host health is reused within the minute: Cloudflare was asked once per token path.
  assert.equal(asked.filter((url) => url.endsWith('/tokens/verify')).length, 2);
  undisclosed(
    [first, second],
    [openai, rotated, managed, bridge, native, user, ...minted.map((m) => m.token)],
  );
  for (const { credential } of minted)
    assert.ok(!JSON.stringify(first).includes(credential.tokenHash));
});

/**
 * The real composition root over State, Secrets, Scope, two consumers and the in-process Sandboxes host
 * with one host Cloudflare instance, and the admin's `/admin` mount beside it.
 */
async function operable(t: TestContext, directory: string, schema: string, dataDir: string) {
  const app = await createApp({
    directory,
    config: {
      plugins: [
        { id: 'state', name: '@merv/state', config: stateConfig(directory) },
        { id: 'secrets', name: '@merv/secrets', config: { encryptionKeyEnv: 'ADMIN_TEST_KEY' } },
        { id: 'scope', name: '@merv/scope' },
        {
          id: 'reader',
          name: './tests/fixtures/env-reader.ts',
          config: { keyEnv: 'ADMIN_TEST_READER' },
        },
        { id: 'nisa', name: '@merv/nisa', config: { keyEnv: 'ADMIN_TEST_NISA' } },
        {
          id: 'sandboxes-host',
          name: '@merv/sandboxes/host',
          config: {
            databaseUrlEnv: 'MERV_TEST_POSTGRES_URL',
            schema,
            vaultKeyEnv: 'ADMIN_TEST_VAULT_KEY',
            publicOrigin: 'https://sandboxes.example',
            dataDir,
            relayEvents: false,
            settings: {
              providers: [
                {
                  name: 'cf',
                  plugin: 'cloudflare',
                  access: 'tunnel',
                  credential: 'env:ADMIN_TEST_CF',
                  settings: { account_id: ACCOUNT },
                },
              ],
            },
          },
        },
      ],
    },
  });
  let route: MountHandler | undefined;
  const state: State = app.ctx.state;
  app.ctx.provide('tools', { registerCallerRules: () => () => {} });
  app.ctx.provide('api', {
    mount: (_prefix: string, handler: MountHandler) => ((route = handler), () => {}),
    stop: async () => {},
  });
  await app.ctx.plugin(adminPlugin, { admins: [admin] });
  const principal: Principal = {
    kind: 'user',
    user: { ...admin, createdAt: new Date(0).toISOString() },
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
  const call = async <T = unknown>(method: string, path: string, body?: unknown) =>
    (await route!(
      { method } as IncomingMessage,
      { setHeader() {} } as unknown as ServerResponse,
      {
        url: new URL(path, 'https://merv.example'),
        principal,
        json: async (schema: ZodType) => {
          const parsed = schema.safeParse(body);
          if (!parsed.success) throw new MervError('invalid_input', 'Invalid input', 400);
          return parsed.data;
        },
      } as ApiRequest,
    )) as T;
  const audit = () =>
    state.read((sql) =>
      sql.all<Record<'action' | 'target' | 'detail_json', string>>(
        'SELECT action,target,detail_json FROM admin_audit ORDER BY at, id',
      ),
    );
  const stored = () =>
    state.read((sql) =>
      sql.all<Record<'env' | 'ciphertext' | 'updated_subject', string>>(
        'SELECT env,ciphertext,updated_subject FROM platform_secrets ORDER BY env',
      ),
    );
  return { app, call, audit, stored };
}
const refused = (code: string, status: number) => (error: unknown) =>
  error instanceof MervError && error.code === code && error.status === status;

/** A data directory, a migrated Sandboxes schema and its data directory, all removed after. */
async function places(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-admin-operable-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'merv-admin-operable-sbx-'));
  const schema = schemaFor();
  const db = await openDatabase({ url: postgresUrl, schema });
  await migrate(db, { schemaExplicit: true });
  await db.close();
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });
  return [directory, schema, dataDir] as const;
}
/** The bridges' health: each answers the one bearer it accepts, and says which it was sent. */
function bridges(t: TestContext, accepted: Record<string, string>) {
  const sent: [string, string | null][] = [];
  const { fetch: send } = globalThis;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const origin = new URL(url).origin;
    const token = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? null;
    if (!(origin in accepted) || !url.endsWith('/health'))
      throw new Error(`unexpected request to ${url}`);
    sent.push([origin, token]);
    return token === accepted[origin]
      ? Response.json({ status: 'ok', version: '1' })
      : Response.json({ error: 'unauthorized' }, { status: 401 });
  }) as typeof fetch;
  t.after(() => void (globalThis.fetch = send));
  return sent;
}

test('a platform secret is revealed and changed here: sealed, applied, its one consumer reloaded, and kept across a restart', async (t) => {
  const [first, second, nisa] = [secret(), secret(), secret()];
  environment(t, {
    ADMIN_TEST_KEY: encryptionKey(),
    ADMIN_TEST_READER: first,
    ADMIN_TEST_NISA: nisa,
    ADMIN_TEST_VAULT_KEY: Buffer.alloc(32, 5).toString('base64url'),
    ADMIN_TEST_CF: JSON.stringify({ bridge_url: 'https://bridge.example.test', bridge_token: 'h' }),
  });
  bridges(t, { 'https://bridge.example.test': 'h' });
  const [directory, schema, dataDir] = await places(t);
  const before = reads.length;
  let f = await operable(t, directory, schema, dataDir);
  let stopped = false;
  t.after(async () => {
    if (!stopped) await f.app.stop();
  });
  assert.deepEqual(reads.slice(before), [first]);

  // One click shows the value, and the audit log keeps that it was shown, never what.
  assert.deepEqual(
    await f.call('POST', '/admin/credentials/reveal', { env: 'ADMIN_TEST_READER' }),
    { value: first },
  );
  // Only a name a loaded plugin's config gives is read, and never one read before the store.
  for (const env of ['PATH', 'HOME'])
    await assert.rejects(
      f.call('POST', '/admin/credentials/reveal', { env }),
      refused('not_found', 404),
    );
  for (const env of ['MERV_TEST_POSTGRES_URL', 'ADMIN_TEST_KEY'])
    await assert.rejects(
      f.call('POST', '/admin/credentials/reveal', { env }),
      refused('credential_fixed', 409),
    );
  await assert.rejects(
    f.call('POST', '/admin/credentials/change', { env: 'NODE_OPTIONS', value: '--inspect' }),
    refused('not_found', 404),
  );
  await assert.rejects(
    f.call('POST', '/admin/credentials/change', { env: 'MERV_TEST_POSTGRES_URL', value: 'x' }),
    refused('credential_fixed', 409),
  );

  const reader = f.app.getFiber('reader');
  const unchanged = f.app.getFiber('nisa');
  assert.deepEqual(
    await f.call('POST', '/admin/credentials/change', { env: 'ADMIN_TEST_READER', value: second }),
    { ok: true, reloaded: ['reader'] },
  );
  // The new value is the process's, and only the plugin that names it started again.
  assert.equal(process.env.ADMIN_TEST_READER, second);
  assert.deepEqual(reads.slice(before), [first, second]);
  assert.notEqual(f.app.getFiber('reader'), reader);
  assert.equal(f.app.getFiber('nisa'), unchanged);
  assert.ok(f.app.status().every((entry) => entry.state === 'active'));
  const [row] = await f.stored();
  assert.deepEqual([row!.env, row!.updated_subject], ['ADMIN_TEST_READER', 'founder']);
  assert.ok(row!.ciphertext !== second && !row!.ciphertext.includes(second));

  const listed = await f.call<AdminCredentialsV2>('GET', '/admin/credentials');
  const shown = listed.groups.flatMap((group) => group.secrets);
  assert.deepEqual(
    shown.map((s) => [s.plugin, s.env, s.purpose, s.set, !!s.lastChanged, s.editable]),
    [
      [
        'state',
        'MERV_TEST_POSTGRES_URL',
        'Merv database · Postgres connection URL',
        true,
        false,
        false,
      ],
      ['secrets', 'ADMIN_TEST_KEY', 'Stored secrets · encryption key', true, false, false],
      ['reader', 'ADMIN_TEST_READER', 'Fixture calls · test service key', true, true, true],
      ['nisa', 'ADMIN_TEST_NISA', 'Literature search for agents · Nisa API key', true, false, true],
      [
        'sandboxes-host',
        'MERV_TEST_POSTGRES_URL',
        'Sandboxes database · Postgres connection URL',
        true,
        false,
        false,
      ],
      [
        'sandboxes-host',
        'ADMIN_TEST_VAULT_KEY',
        'Saved sandbox provider keys · encryption key',
        true,
        false,
        false,
      ],
    ],
  );
  assert.deepEqual(
    (await f.audit()).map((entry) => [entry.action, entry.target, entry.detail_json]),
    [
      ['credentials.reveal', 'ADMIN_TEST_READER', '{}'],
      ['credentials.change', 'ADMIN_TEST_READER', '{}'],
    ],
  );
  undisclosed([listed, await f.audit()], [first, second, nisa]);

  // Restarted with the deployment's value, the stored one is applied before the plugin reads it.
  process.env.ADMIN_TEST_READER = first;
  await f.app.stop();
  stopped = true;
  f = await operable(t, directory, schema, dataDir);
  stopped = false;
  assert.deepEqual(reads.slice(before), [first, second, second]);
  assert.equal(process.env.ADMIN_TEST_READER, second);
});

test('a sandbox provider key changes through Sandboxes: a user key verified before it is saved, a host key rebound', async (t) => {
  const [host1, host2, user1, user2] = [secret(), secret(), secret(), secret()];
  const cf = (token: string) =>
    JSON.stringify({ bridge_url: 'https://bridge.example.test', bridge_token: token });
  environment(t, {
    ADMIN_TEST_KEY: encryptionKey(),
    ADMIN_TEST_READER: secret(),
    ADMIN_TEST_NISA: secret(),
    ADMIN_TEST_VAULT_KEY: Buffer.alloc(32, 6).toString('base64url'),
    ADMIN_TEST_CF: cf(host1),
  });
  const accepted = {
    'https://bridge.example.test': host1,
    'https://user-bridge.example.test': user2,
  };
  const sent = bridges(t, accepted);
  const [directory, schema, dataDir] = await places(t);
  const f = await operable(t, directory, schema, dataDir);
  t.after(async () => await f.app.stop());
  await f.app.ctx.sbxVault.save({
    namespace: 'team-a',
    name: 'mine',
    plugin: 'cloudflare',
    fields: { bridge_url: 'https://user-bridge.example.test', bridge_token: user1 },
    settings: {},
    access: 'tunnel',
    verified: true,
  });
  const reveal = (provider: string, namespace: string | null, field = 'bridge_token') =>
    f.call<{ value: string }>('POST', '/admin/credentials/reveal', { provider, namespace, field });

  // A user's key opens for the admin route alone; the listing reads no sealed column.
  assert.deepEqual(await reveal('mine', 'team-a'), { value: user1 });
  assert.deepEqual(await reveal('cf', null), { value: host1 });
  for (const [provider, namespace, field] of [
    ['mine', 'team-b', 'bridge_token'],
    ['mine', null, 'bridge_token'],
    ['cf', 'team-a', 'bridge_token'],
    ['mine', 'team-a', 'password'],
    ['nobody', null, 'bridge_token'],
  ] as const)
    await assert.rejects(reveal(provider, namespace, field), refused('not_found', 404));

  // A key the provider refuses is not saved: Sandboxes asked the bridge with it first.
  const user = { provider: 'mine', namespace: 'team-a' };
  await assert.rejects(
    f.call('POST', '/admin/credentials/change', { ...user, fields: { bridge_token: user1 } }),
    (error) => error instanceof MervError && error.code.startsWith('sandbox_'),
  );
  assert.deepEqual(sent.at(-1), ['https://user-bridge.example.test', user1]);
  assert.deepEqual(await reveal('mine', 'team-a'), { value: user1 });
  assert.deepEqual(
    await f.call('POST', '/admin/credentials/change', { ...user, fields: { bridge_token: user2 } }),
    { ok: true, reloaded: ['mine'] },
  );
  assert.deepEqual(sent.at(-1), ['https://user-bridge.example.test', user2]);
  assert.deepEqual(await reveal('mine', 'team-a'), { value: user2 });
  // Saved in Sandboxes' vault, not as a platform secret.
  assert.deepEqual(await f.stored(), []);

  // A host key is an override of its credential env: stored sealed, applied, and the hub
  // rebinds the instance that reads it, which then calls its bridge with the new key.
  accepted['https://bridge.example.test'] = host2;
  const old = await f.app.ctx.sbxProviders.resolve('team-a', 'cf');
  assert.deepEqual(
    await f.call('POST', '/admin/credentials/change', {
      provider: 'cf',
      namespace: null,
      fields: { bridge_token: host2 },
    }),
    { ok: true, reloaded: ['cf'] },
  );
  assert.deepEqual(JSON.parse(process.env.ADMIN_TEST_CF!), JSON.parse(cf(host2)));
  assert.notEqual(await f.app.ctx.sbxProviders.resolve('team-a', 'cf'), old);
  const [row] = await f.stored();
  assert.equal(row!.env, 'ADMIN_TEST_CF');
  assert.ok(!row!.ciphertext.includes(host2));
  const listed = await f.call<AdminCredentialsV2>('GET', '/admin/credentials');
  assert.deepEqual(sent.at(-1), ['https://bridge.example.test', host2]);
  assert.deepEqual(
    listed.providers.filter((p) => p.field === 'bridge_token').map((p) => [p.provider, p.health]),
    [
      ['cf', 'ok'],
      ['mine', null],
    ],
  );
  assert.deepEqual(await reveal('cf', null), { value: host2 });
  assert.deepEqual(
    (await f.audit()).map((entry) => [entry.action, entry.target, JSON.parse(entry.detail_json)]),
    [
      ['credentials.reveal', 'mine', { namespace: 'team-a', field: 'bridge_token' }],
      ['credentials.reveal', 'cf', { namespace: null, field: 'bridge_token' }],
      ['credentials.reveal', 'mine', { namespace: 'team-a', field: 'bridge_token' }],
      ['credentials.change', 'mine', { namespace: 'team-a', fields: ['bridge_token'] }],
      ['credentials.reveal', 'mine', { namespace: 'team-a', field: 'bridge_token' }],
      ['credentials.change', 'cf', { namespace: null, fields: ['bridge_token'] }],
      ['credentials.reveal', 'cf', { namespace: null, field: 'bridge_token' }],
    ],
  );
  undisclosed([listed, await f.audit()], [host1, host2, user1, user2]);
});

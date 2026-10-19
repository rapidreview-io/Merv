import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Context } from 'cordis';
import { createService, type ConfiguredEnv, type State } from '@merv/contracts';
import type { AdminCredentials } from '@merv/admin/models';
import type { ApiRequest } from '@merv/api/types';
import type { ManagedModelGrant } from '@merv/fleet/types';
import { CredentialStore } from '@merv/identity/credentials';
import { ProjectScope } from '@merv/scope';
import { AccountSecrets } from '@merv/secrets';
import { auditMigrations, AdminAudit } from '../packages/admin/src/audit.js';
import { credentialMigrations, credentialRoutes } from '../packages/admin/src/credentials.js';
import type { AdminEnv } from '../packages/admin/src/index.js';
import { codexModelRelay } from '../packages/fleet/src/codex-relay.js';
import { FleetService } from '../packages/fleet/src/index.js';
import { modelMigrations } from '../packages/fleet/src/schema.js';
import { adminAudit, adminRoutes, hostConfig, refused, startHost } from './fixtures/admin.js';
import { createApp } from './fixtures/app.js';
import { reads } from './fixtures/env-reader.js';
import { openState, stateConfig } from './fixtures/state.js';

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

/** The Sandboxes host's one Cloudflare instance, its keys read from `credential`. */
const cloudflare = (credential: string) => ({
  settings: {
    providers: [
      {
        name: 'cf',
        plugin: 'cloudflare',
        access: 'tunnel',
        credential,
        settings: { account_id: 'a'.repeat(32) },
      },
    ],
  },
});
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
  const sandboxes = new Context();
  await startHost(t, sandboxes, 'ADMIN_TEST_VAULT_KEY', cloudflare('env://ADMIN_TEST_CF'));
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
    )) as AdminCredentials;

  const first = await read();
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
      // The same key under another name.
      sharedWith: ['ADMIN_TEST_PI_KEY'],
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
    [['ADMIN_TEST_PI_KEY', 'Agent model calls · OpenAI API key', ['ADMIN_TEST_SHARED'], false]],
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
  // Sandbox provider keys are their own table, the platform's alone: a host instance's health
  // asks Cloudflare about the native token; a key a person saved is not listed.
  assert.deepEqual(
    first.providers.map((p) => [
      p.provider,
      p.field,
      p.present,
      p.health,
      p.healthReason,
      p.editable,
    ]),
    ['bridge_url', 'bridge_token', 'cloudflare_api_token'].map((field) => [
      'cf',
      field,
      true,
      'degraded',
      'credential_rejected',
      true,
    ]),
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
  assert.deepEqual(second.groups[0]!.secrets[0]!.sharedWith, []);
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
async function operable(t: TestContext, directory: string, sandboxes: Record<string, unknown>) {
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
        { id: 'sandboxes-host', name: '@merv/sandboxes/host', config: sandboxes },
      ],
    },
  });
  const call = await adminRoutes(app.ctx, [admin]);
  const state: State = app.ctx.state;
  const stored = () =>
    state.read((sql) =>
      sql.all<Record<'env' | 'ciphertext' | 'updated_subject', string>>(
        'SELECT env,ciphertext,updated_subject FROM platform_secrets ORDER BY env',
      ),
    );
  return { app, call, audit: () => adminAudit(state), stored };
}

/** A data directory, and the Sandboxes host's config on a fresh schema and data directory. */
async function places(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-admin-operable-'));
  const host = await hostConfig('ADMIN_TEST_VAULT_KEY', cloudflare('env:ADMIN_TEST_CF'));
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
    rmSync(host.dataDir, { recursive: true, force: true });
  });
  return [directory, host.config] as const;
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
  const [directory, sandboxes] = await places(t);
  const before = reads.length;
  let f = await operable(t, directory, sandboxes);
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
  // A value its consumer will not start with is put back at once, and never stored.
  await assert.rejects(
    f.call('POST', '/admin/credentials/change', { env: 'ADMIN_TEST_READER', value: 'refused' }),
    refused('credential_rejected', 422),
  );
  assert.equal(process.env.ADMIN_TEST_READER, second);
  assert.ok(f.app.status().every((entry) => entry.state === 'active'));
  assert.deepEqual(await f.stored(), [row]);

  const listed = await f.call<AdminCredentials>('GET', '/admin/credentials');
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
  f = await operable(t, directory, sandboxes);
  stopped = false;
  assert.deepEqual(reads.slice(before), [first, second, 'refused', second, second]);
  assert.equal(process.env.ADMIN_TEST_READER, second);
});

test('a platform sandbox provider key is revealed and changed here, rebound; a key a person saved is theirs', async (t) => {
  const [host1, host2, user1] = [secret(), secret(), secret()];
  const cf = (token: string) =>
    JSON.stringify({ bridge_url: 'https://bridge.example.test', bridge_token: token });
  environment(t, {
    ADMIN_TEST_KEY: encryptionKey(),
    ADMIN_TEST_READER: secret(),
    ADMIN_TEST_NISA: secret(),
    ADMIN_TEST_VAULT_KEY: Buffer.alloc(32, 6).toString('base64url'),
    ADMIN_TEST_CF: cf(host1),
  });
  const accepted = { 'https://bridge.example.test': host1 };
  const sent = bridges(t, accepted);
  const [directory, sandboxes] = await places(t);
  const f = await operable(t, directory, sandboxes);
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
  const reveal = (provider: string, field = 'bridge_token') =>
    f.call<{ value: string }>('POST', '/admin/credentials/reveal', { provider, field });

  assert.deepEqual(await reveal('cf'), { value: host1 });
  // A person's own key, a field the provider has not, and a provider nobody configured.
  for (const [provider, field] of [
    ['mine', 'bridge_token'],
    ['cf', 'password'],
    ['nobody', 'bridge_token'],
  ] as const) {
    await assert.rejects(reveal(provider, field), refused('not_found', 404));
    await assert.rejects(
      f.call('POST', '/admin/credentials/change', { provider, fields: { [field]: host2 } }),
      refused('not_found', 404),
    );
  }

  // A host key is an override of its credential env: stored sealed, applied, and the hub
  // rebinds the instance that reads it, which then calls its bridge with the new key.
  accepted['https://bridge.example.test'] = host2;
  const old = await f.app.ctx.sbxProviders.resolve('team-a', 'cf');
  assert.deepEqual(
    await f.call('POST', '/admin/credentials/change', {
      provider: 'cf',
      fields: { bridge_token: host2 },
    }),
    { ok: true, reloaded: ['cf'] },
  );
  assert.deepEqual(JSON.parse(process.env.ADMIN_TEST_CF!), JSON.parse(cf(host2)));
  assert.notEqual(await f.app.ctx.sbxProviders.resolve('team-a', 'cf'), old);
  const [row] = await f.stored();
  assert.equal(row!.env, 'ADMIN_TEST_CF');
  assert.ok(!row!.ciphertext.includes(host2));
  const listed = await f.call<AdminCredentials>('GET', '/admin/credentials');
  assert.deepEqual(sent.at(-1), ['https://bridge.example.test', host2]);
  assert.deepEqual(
    listed.providers.filter((p) => p.field === 'bridge_token').map((p) => [p.provider, p.health]),
    [['cf', 'ok']],
  );
  assert.deepEqual(await reveal('cf'), { value: host2 });
  assert.deepEqual(
    (await f.audit()).map((entry) => [entry.action, entry.target, JSON.parse(entry.detail_json)]),
    [
      ['credentials.reveal', 'cf', { field: 'bridge_token' }],
      ['credentials.change', 'cf', { fields: ['bridge_token'] }],
      ['credentials.reveal', 'cf', { field: 'bridge_token' }],
    ],
  );
  undisclosed([listed, await f.audit()], [host1, host2, user1]);
});

test('two changes to one provider key in flight each read it inside their turn, so both fields stay', async (t) => {
  const [token, url] = [secret(), 'https://bridge2.example.test'];
  environment(t, {
    ADMIN_TEST_KEY: encryptionKey(),
    ADMIN_TEST_READER: secret(),
    ADMIN_TEST_NISA: secret(),
    ADMIN_TEST_VAULT_KEY: Buffer.alloc(32, 7).toString('base64url'),
    ADMIN_TEST_CF: JSON.stringify({ bridge_url: 'https://bridge.example.test', bridge_token: 'h' }),
  });
  bridges(t, { 'https://bridge.example.test': 'h', [url]: token });
  const [directory, sandboxes] = await places(t);
  const f = await operable(t, directory, sandboxes);
  t.after(async () => await f.app.stop());
  // Another change holds the queue until both of these have read the key and are waiting.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const held = f.app.ctx.composition.override(
    'ADMIN_TEST_READER',
    async () => (await gate, secret()),
    admin,
  );
  const change = (fields: Record<string, string>) =>
    f.call('POST', '/admin/credentials/change', { provider: 'cf', fields });
  const both = [change({ bridge_url: url }), change({ bridge_token: token })];
  await new Promise((resolve) => setTimeout(resolve, 50));
  release();
  await Promise.all([held, ...both]);
  assert.deepEqual(JSON.parse(process.env.ADMIN_TEST_CF!), {
    bridge_url: url,
    bridge_token: token,
  });
});

test('without Secrets’ key nothing offers a change, and a change is refused before anything reloads', async (t) => {
  environment(t, {
    ADMIN_TEST_KEY: '',
    ADMIN_TEST_READER: secret(),
    ADMIN_TEST_NISA: secret(),
    ADMIN_TEST_VAULT_KEY: Buffer.alloc(32, 8).toString('base64url'),
    ADMIN_TEST_CF: JSON.stringify({ bridge_url: 'https://bridge.example.test', bridge_token: 'h' }),
  });
  bridges(t, { 'https://bridge.example.test': 'h' });
  const [directory, sandboxes] = await places(t);
  const f = await operable(t, directory, sandboxes);
  t.after(async () => await f.app.stop());
  const listed = await f.call<AdminCredentials>('GET', '/admin/credentials');
  const rows = [...listed.groups.flatMap((group) => group.secrets), ...listed.providers];
  assert.ok(rows.length && rows.every((row) => !row.editable));
  // Reading a value never needed the store.
  assert.deepEqual(
    await f.call('POST', '/admin/credentials/reveal', { env: 'ADMIN_TEST_READER' }),
    { value: process.env.ADMIN_TEST_READER },
  );
  const reader = f.app.getFiber('reader');
  const before = reads.length;
  for (const body of [
    { env: 'ADMIN_TEST_READER', value: secret() },
    { provider: 'cf', fields: { bridge_token: secret() } },
  ])
    await assert.rejects(
      f.call('POST', '/admin/credentials/change', body),
      refused('secrets_unavailable', 503),
    );
  assert.equal(f.app.getFiber('reader'), reader);
  assert.equal(reads.length, before);
  assert.deepEqual(await f.stored(), []);
});

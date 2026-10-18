import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Context } from 'cordis';
import { createService, sha256Hex, type ConfiguredEnv } from '@merv/contracts';
import type { ManagedModelGrant } from '@merv/fleet/types';
import { CredentialStore } from '@merv/identity/credentials';
import { ProjectScope } from '@merv/scope';
import host from '@merv/sandboxes/host';
import { migrate, openDatabase } from '@sandboxes/db';
import { auditMigrations, AdminAudit } from '../packages/admin/src/audit.js';
import { adminCredentials, credentialMigrations } from '../packages/admin/src/credentials.js';
import type { AdminEnv } from '../packages/admin/src/index.js';
import { codexModelRelay } from '../packages/fleet/src/codex-relay.js';
import { FleetService } from '../packages/fleet/src/index.js';
import { modelMigrations } from '../packages/fleet/src/schema.js';
import { createApp } from './fixtures/app.js';
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

test('the composition root names each *Env field of its enabled entries, nested and defaulted', async (t) => {
  environment(t, { ADMIN_TEST_FALLBACK: randomBytes(24).toString('base64url') });
  const directory = mkdtempSync(join(tmpdir(), 'merv-admin-environment-'));
  const app = await createApp({
    directory,
    config: {
      plugins: [
        { id: 'state', name: '@merv/state', config: stateConfig(directory) },
        { id: 'web', name: '@merv/web', config: { fallback: { keyEnv: 'ADMIN_TEST_FALLBACK' } } },
        { id: 'nisa', name: '@merv/nisa', disabled: true, config: { keyEnv: 'ADMIN_TEST_NISA' } },
      ],
    },
  });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  assert.deepEqual(app.ctx.get('composition')!.environment(), [
    { plugin: 'state', field: 'connectionStringEnv', env: 'MERV_TEST_POSTGRES_URL' },
    { plugin: 'web', field: 'keyEnv', env: 'MERV_TAVILY_API_KEY' },
    { plugin: 'web', field: 'fallback.keyEnv', env: 'ADMIN_TEST_FALLBACK' },
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

test('GET /admin/credentials says which credential serves which purpose and never a value', async (t) => {
  const secret = () => randomBytes(24).toString('base64url');
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

  const named: ConfiguredEnv[] = [
    { plugin: 'pi', field: 'modelApiKeyEnv', env: 'ADMIN_TEST_PI_KEY' },
    { plugin: 'fleet-workflow', field: 'modelApiKeyEnv', env: 'ADMIN_TEST_SHARED' },
    { plugin: 'sessions', field: 'managedSecretEnv', env: 'ADMIN_TEST_MANAGED' },
    { plugin: 'web', field: 'fallback.keyEnv', env: 'ADMIN_TEST_PI_KEY' },
    { plugin: 'nisa', field: 'keyEnv', env: 'ADMIN_TEST_UNSET' },
  ];
  const services: Record<string, unknown> = {
    composition: { status: () => [], environment: () => named },
    fleet,
    sbxProviders: sandboxes.sbxProviders,
  };
  const env = {
    ctx: { get: (name: string) => services[name] },
    state,
    audit: new AdminAudit(state),
    admins: [],
  } as unknown as AdminEnv;

  const first = await adminCredentials(env);
  const fingerprint = (value: string) => sha256Hex(value).slice(0, 8);
  assert.deepEqual(
    first.groups.map((group) => [group.purpose, group.provider?.name ?? null]),
    [
      ['Agent', null],
      ['Fleet agents', null],
      ['Fleet machines', null],
      ['Sandbox provider', 'cf'],
      ['Sandbox provider', 'mine'],
      ['Platform services', null],
    ],
  );
  const [pi, agents, machines, cf, mine, services_] = first.groups;
  const [shared] = agents!.credentials;
  assert.deepEqual(
    { ...shared, lastOk: shared!.lastOk?.relay },
    {
      plugin: 'fleet-workflow',
      field: 'modelApiKeyEnv',
      env: 'ADMIN_TEST_SHARED',
      set: true,
      fingerprint: fingerprint(openai),
      // The same key under another name, and the same name in another plugin.
      sharedWith: [named[0], named[3]],
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
    },
  );
  assert.deepEqual(
    pi!.credentials.map((c) => [c.env, c.fingerprint, c.sharedWith, c.dead]),
    [['ADMIN_TEST_PI_KEY', fingerprint(openai), [named[1], named[3]], false]],
  );
  assert.deepEqual(
    machines!.credentials.map((c) => [c.env, c.set, c.sharedWith]),
    [['ADMIN_TEST_MANAGED', true, []]],
  );
  assert.deepEqual(
    services_!.credentials.map((c) => [c.plugin, c.field, c.set, c.fingerprint]),
    [
      ['web', 'fallback.keyEnv', true, fingerprint(openai)],
      // Named in config, unset in the process.
      ['nisa', 'keyEnv', false, null],
    ],
  );
  // A host instance names where its key is read, in Sandboxes' own reference grammar; its health
  // asks Cloudflare about the native token.
  assert.deepEqual(
    [cf!.provider!.health, cf!.provider!.health_reason, cf!.provider!.credential_env],
    [
      {
        status: 'degraded',
        message: 'bridge worker 1; Cloudflare rejected the native API token (401)',
      },
      'credential_rejected',
      'ADMIN_TEST_CF',
    ],
  );
  assert.deepEqual(
    cf!.provider!.fields.map((field) => [field.name, field.present]),
    [
      ['bridge_url', true],
      ['bridge_token', true],
      ['cloudflare_api_token', true],
    ],
  );
  assert.deepEqual(
    cf!.credentials.map((c) => [c.plugin, c.field, c.env, c.set]),
    [['cloudflare', 'providers.cf.credential', 'ADMIN_TEST_CF', true]],
  );
  // A user's own key stays sealed: the listing reads its row, never its secret column.
  assert.deepEqual(
    [mine!.provider!.source, mine!.provider!.namespaces, mine!.provider!.health, mine!.credentials],
    ['user', ['team-a'], null, []],
  );
  assert.ok(mine!.provider!.verified_at);
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

  // A rotated key reads as changed, and its earlier refusal no longer marks it dead.
  process.env.ADMIN_TEST_SHARED = rotated;
  const second = await adminCredentials(env);
  const [again] = second.groups[1]!.credentials;
  assert.deepEqual(
    [again!.fingerprint, again!.lastChanged, again!.sharedWith, again!.dead],
    [fingerprint(rotated), second.at, [], false],
  );
  assert.deepEqual(second.groups[0]!.credentials[0]!.sharedWith, [named[3]]);
  // Restored, the first key changed again then, and its old refusal does not mark it dead.
  process.env.ADMIN_TEST_SHARED = openai;
  const third = await adminCredentials(env);
  const [restored] = third.groups[1]!.credentials;
  assert.deepEqual([restored!.lastChanged, restored!.dead], [third.at, false]);
  // Host health is reused within the minute: Cloudflare was asked once per token path.
  assert.equal(asked.filter((url) => url.endsWith('/tokens/verify')).length, 2);

  // Nothing returned or kept holds a value, or more of its digest than the fingerprint.
  const kept = await state.read(async (sql) => [
    await sql.all('SELECT * FROM admin_credential_observations'),
    await sql.all('SELECT * FROM fleet_relay_outcomes'),
  ]);
  const said = JSON.stringify([first, second, kept]);
  const values = [openai, rotated, managed, bridge, native, user, ...minted.map((m) => m.token)];
  for (const value of values) {
    for (let i = 0; i + 6 <= value.length; i++)
      assert.ok(!said.includes(value.slice(i, i + 6)), 'a credential value was disclosed');
    assert.ok(
      !said.includes(sha256Hex(value).slice(0, 9)),
      'more than a fingerprint was disclosed',
    );
  }
  assert.ok(!said.includes(sha256Hex(process.env.ADMIN_TEST_CF!).slice(0, 9)));
  for (const { credential } of minted) assert.ok(!said.includes(credential.tokenHash));
});

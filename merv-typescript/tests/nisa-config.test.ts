import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { MervError, type Caller } from '@merv/contracts';
import type { CredentialProvider } from '@merv/credentials/types';
import type { NisaConfig } from '@merv/nisa/types';
import { NisaService, nisaPlugin } from '@merv/nisa';
import { ToolRegistry } from '@merv/api';
import type { ToolCatalog } from '@merv/api/types';
import { fixtureAccess } from './fixtures/access.js';

const caller = { actorId: 'operator', projectId: 'project' };
const credentials: CredentialProvider = {
  resolve() {
    throw new Error('Configuration and publication must not resolve credentials');
  },
  replace() {},
};
function registry(t: TestContext) {
  const tools = new ToolRegistry(
    {
      require(value: Caller) {
        if (value.actorId !== caller.actorId || value.projectId !== caller.projectId)
          throw new MervError('forbidden', 'Invalid caller', 403);
        return {
          id: value.actorId,
          projectId: value.projectId,
          name: 'Operator',
          role: 'operator',
          active: true,
        };
      },
    },
    fixtureAccess,
  );
  t.after(() => tools.close());
  return tools;
}

const acceptedOrigins = [
  'https://api.rapidreview.io',
  'https://nisa.example.test:8443',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
  'http://127.42.3.2:8080',
  'http://[::1]:8000',
];
const rejectedOrigins = [
  'http://nisa.example.test',
  'http://127.example.com',
  'http://127.evil.test:8000',
  'http://127.0.0.1.example.test',
  'http://192.168.1.2:8000',
  'http://0.0.0.0:8000',
  'ftp://localhost',
  'https://nisa.example.test/',
  'https://nisa.example.test/api',
  'https://nisa.example.test?query=bad',
  'https://nisa.example.test#fragment',
  'https://user:password@nisa.example.test',
  'not-a-url',
];

test('Nisa origin configuration permits HTTPS or actual loopback hosts and rejects misleading host prefixes', () => {
  for (const apiOrigin of acceptedOrigins)
    assert.equal(nisaPlugin.Config.parse({ apiOrigin }).apiOrigin, apiOrigin);
  for (const apiOrigin of rejectedOrigins)
    assert.equal(nisaPlugin.Config.safeParse({ apiOrigin }).success, false, apiOrigin);
});

test('strict Nisa configuration defaults stay bounded and invalid fields acquire no namespace', async (t) => {
  assert.deepEqual(nisaPlugin.Config.parse(undefined), {
    id: 'nisa',
    apiOrigin: 'https://api.rapidreview.io',
    timeoutMs: 10000,
    maxResponseBytes: 2 * 1024 * 1024,
  });
  assert.deepEqual(nisaPlugin.Config.parse({}), nisaPlugin.Config.parse(undefined));
  const tools = registry(t);
  const invalid: unknown[] = [
    null,
    [],
    { unknown: true },
    { id: '' },
    { id: 'Uppercase' },
    { id: 'with__separator' },
    { apiOrigin: 42 },
    ...rejectedOrigins.map((apiOrigin) => ({ apiOrigin })),
    { timeoutMs: 24 },
    { timeoutMs: 60001 },
    { timeoutMs: 100.5 },
    { timeoutMs: '1000' },
    { maxResponseBytes: 0 },
    { maxResponseBytes: 8 * 1024 * 1024 + 1 },
    { maxResponseBytes: 1.5 },
    { maxResponseBytes: '2048' },
  ];
  for (const config of invalid) {
    assert.equal(nisaPlugin.Config.safeParse(config).success, false);
    assert.throws(() => new NisaService(tools, credentials, fixtureAccess, config as NisaConfig), {
      code: 'invalid_nisa_config',
    });
    const namespace = tools.createCatalog('nisa');
    await namespace.dispose();
  }
  assert.deepEqual(tools.list(), []);
});

test('a duplicate Nisa namespace never replaces or disposes its existing catalog owner', async (t) => {
  const tools = registry(t);
  const owner = tools.createCatalog('nisa');
  await owner.replace([
    {
      kind: 'mcp',
      name: 'existing',
      inputSchema: { type: 'object', additionalProperties: false },
      handler: () => ({ content: [{ type: 'text', text: 'original owner' }] }),
    },
  ]);
  assert.throws(() => new NisaService(tools, credentials, fixtureAccess), {
    code: 'duplicate_mount',
  });
  assert.deepEqual(
    tools.list().map((entry) => entry.name),
    ['mount__nisa__existing'],
  );
  assert.deepEqual(await tools.call('mount__nisa__existing', caller, {}), {
    content: [{ type: 'text', text: 'original owner' }],
  });
  await owner.dispose();
});

test('a failed Nisa publication releases its namespace without affecting a subsequent installation', async (t) => {
  const tools = registry(t);
  const create = tools.createCatalog.bind(tools);
  const injected = t.mock.method(tools, 'createCatalog', (id: string): ToolCatalog => {
    const catalog = create(id);
    return {
      // Exercise a real registry compilation failure after the service acquires the namespace.
      replace: (definitions) =>
        catalog.replace([
          ...definitions,
          {
            kind: 'mcp',
            name: 'invalid',
            inputSchema: { type: 'object', unsupportedKeyword: true },
            handler: () => ({ content: [] }),
          },
        ]),
      dispose: () => catalog.dispose(),
    };
  });
  const failed = new NisaService(tools, credentials, fixtureAccess);
  await assert.rejects(failed.start(), { code: 'nisa_initialization_failed' });
  assert.equal(failed.status().state, 'stopped');
  assert.deepEqual(tools.list(), []);
  injected.mock.restore();

  const replacement = new NisaService(tools, credentials, fixtureAccess);
  assert.equal(replacement.status().state, 'configured');
  await replacement.start();
  assert.equal(replacement.status().state, 'ready');
  assert.deepEqual(
    tools.list().map((entry) => entry.name),
    ['mount__nisa__paper', 'mount__nisa__search'],
  );
  await failed.close();
  assert.equal(tools.list().length, 2, 'The old owner must not withdraw the replacement');
  const closing = replacement.close();
  assert.deepEqual(tools.list(), [], 'Closing withdraws the whole catalog immediately');
  await closing;
  await assert.rejects(replacement.start(), { code: 'nisa_stopped' });
});

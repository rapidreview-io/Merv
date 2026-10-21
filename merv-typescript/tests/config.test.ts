import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  loadConfiguration,
  type ApplicationConfig,
  type ConfigurationOptions,
} from '../src/config.js';

const invalid = { code: 'invalid_config' };
const configuration = (config: unknown, options: Partial<ConfigurationOptions> = {}) =>
  loadConfiguration({ directory: './data', ...options, config: config as ApplicationConfig });
function folder(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('default configuration includes session enforcement and API adds tool transports without separate control adapters', () => {
  const core = loadConfiguration({ directory: './data' });
  assert.deepEqual(
    core.entries.map((entry) => entry.id),
    [
      'research',
      'paper',
      'reports',
      'board',
      'reflections',
      'knowledge',
      'experiments',
      'code-work',
      'code',
      'admin',
      'secrets',
      'scripts',
      'sessions',
      'feed',
      'tasks',
      'reviews',
      'context-builder',
      'artifacts',
      'workflows',
      'scope',
      'blobs',
      'domain-events',
      'state',
    ],
  );
  assert.ok(
    core.entries.every(
      (entry) =>
        entry.required === (entry.id !== 'feed') && entry.disabled === (entry.id === 'feed'),
    ),
  );
  assert.deepEqual(core.entries.find((entry) => entry.id === 'state')?.config, {
    connectionStringEnv: 'MERV_DB_URL',
    schemaEnv: 'MERV_DB_SCHEMA',
    schema: 'merv',
  });
  assert.deepEqual(core.entries.find((entry) => entry.id === 'blobs')?.config, {
    root: join(resolve('./data'), 'blobs'),
  });
  const full = loadConfiguration({ directory: './data', api: true });
  assert.equal(full.entries.length, 46, 'legacy API selection excludes the browser layer');
  assert.equal(full.entries.find((entry) => entry.id === 'tools')?.name, '@merv/api/tools-plugin');
  assert.deepEqual(full.entries.find((entry) => entry.id === 'api')?.config, {
    host: '127.0.0.1',
    port: 3081,
  });
  assert.equal(full.baseUrl, new URL('../config/default.json', import.meta.url).href);
  const order = (id: string) => full.entries.findIndex((entry) => entry.id === id);
  const requirements: Record<string, string[]> = {
    api: ['tools', 'scope', 'identity'],
    code: ['state', 'scope'],
    'code-work': ['code', 'state', 'scope', 'sessions', 'artifacts', 'workflows', 'domain-events'],
    knowledge: ['state', 'scope', 'tasks', 'experiments', 'artifacts', 'reviews'],
    experiments: ['state', 'scope', 'artifacts', 'workflows', 'reviews', 'context-builder'],
    sessions: ['state', 'scope', 'workflows', 'domain-events'],
    tools: ['scope'],
    feed: ['state', 'scope', 'artifacts'],
    board: ['state', 'scope'],
    tasks: ['state', 'scope', 'artifacts', 'workflows', 'reviews', 'context-builder'],
    reviews: ['state', 'scope', 'artifacts', 'domain-events'],
    artifacts: ['state', 'scope', 'blobs'],
    workflows: ['state', 'scope'],
    scope: ['state'],
    secrets: ['state'],
    'secrets-api': ['secrets'],
    'context-builder': ['state', 'scope', 'artifacts'],
    'domain-events': ['state'],
  };
  for (const name of [
    'research',
    'paper',
    'reflections',
    'knowledge',
    'experiments',
    'code',
    'feed',
    'tasks',
    'reviews',
    'artifacts',
    'scope',
    'workflows',
  ]) {
    requirements[`${name}-tools`] = [name === 'code' ? 'code-work' : name, 'tools'];
    assert.equal(
      full.entries.find((entry) => entry.id === `${name}-tools`)?.name,
      `@merv/${name === 'code' ? 'code-work' : name}/tools`,
    );
  }
  for (const [consumer, providers] of Object.entries(requirements))
    for (const provider of providers) {
      assert.ok(
        order(consumer) < order(provider),
        `${consumer} should precede its ${provider} provider`,
      );
    }
});

test('explicit configuration validates schema, stable IDs, and option conflicts', () => {
  const entry = { id: 'custom', name: './custom.ts' };
  for (const value of [
    null,
    [],
    {},
    { plugins: {} },
    { plugins: [], extra: true },
    { plugins: [null] },
    { plugins: [{ ...entry, extra: true }] },
  ]) {
    assert.throws(() => configuration(value), invalid);
  }
  for (const id of ['', 'nested:entry', '../entry', 'contains space', 'x'.repeat(129)]) {
    assert.throws(() => configuration({ plugins: [{ ...entry, id }] }), invalid);
  }
  for (const name of ['', ' ', ' ./plugin.ts'])
    assert.throws(() => configuration({ plugins: [{ ...entry, name }] }), invalid);
  for (const value of [{ required: 'yes' }, { disabled: 0 }, { config: [] }, { config: null }]) {
    assert.throws(() => configuration({ plugins: [{ ...entry, ...value }] }), invalid);
  }
  assert.throws(
    () => configuration({ plugins: [entry, { ...entry, disabled: true }] }),
    /Duplicate plugin ID/,
  );
  assert.throws(() => configuration({ plugins: [] }, { configFile: './config.json' }), invalid);
  assert.throws(() => configuration({ plugins: [] }, { api: false }), invalid);
  assert.throws(() => configuration({ plugins: [] }, { components: [] }), invalid);
  const loaded = configuration({
    plugins: [entry, { id: 'another', name: './custom.ts', required: false, disabled: true }],
  });
  assert.deepEqual(loaded.entries, [
    { ...entry, required: true, disabled: false },
    { id: 'another', name: './custom.ts', required: false, disabled: true },
  ]);
});

test('configuration values support only explicit substitutions and remain detached from caller input', () => {
  const config: ApplicationConfig = {
    plugins: [
      {
        id: 'custom',
        name: './plugin.ts',
        config: {
          endpoint: 'http://${host}:${port}',
          directory: '${directory}',
          nested: [{ port: '${port}', file: '${directory}/state.sqlite' }, false, null],
        },
      },
    ],
  };
  const original = structuredClone(config);
  const loaded = configuration(config, {
    host: 'localhost',
    port: 0,
    directory: './isolated data',
  });
  assert.deepEqual(loaded.entries[0].config, {
    endpoint: 'http://localhost:0',
    directory: resolve('./isolated data'),
    nested: [{ port: 0, file: join(resolve('./isolated data'), 'state.sqlite') }, false, null],
  });
  assert.deepEqual(config, original);
  (loaded.entries[0].config!.nested as unknown[]).push('changed');
  assert.deepEqual(config, original);
  for (const token of ['${HOME}', '${env.API_KEY}', '${directory', '${}', '${port + 1}']) {
    assert.throws(
      () => configuration({ plugins: [{ id: 'custom', name: './plugin.ts', config: { token } }] }),
      invalid,
    );
  }
  for (const value of [NaN, Infinity, undefined, () => 'value', new Date()]) {
    assert.throws(
      () => configuration({ plugins: [{ id: 'custom', name: './plugin.ts', config: { value } }] }),
      invalid,
    );
  }
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.throws(
    () => configuration({ plugins: [{ id: 'custom', name: './plugin.ts', config: cycle }] }),
    /cycles/,
  );
});

test('malformed or unreadable files produce sanitized configuration errors', (t) => {
  const directory = folder(t),
    filename = join(directory, 'broken.json');
  writeFileSync(filename, '{"pluginSecret":"never-include-this-value",');
  assert.throws(
    () => loadConfiguration({ directory, configFile: filename }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes('never-include-this-value'));
      assert.match(error.message, /valid JSON/);
      return true;
    },
  );
  assert.throws(
    () => loadConfiguration({ directory, configFile: join(directory, 'missing.json') }),
    /could not be read/,
  );
  assert.throws(() => loadConfiguration({ directory, configFile: ' ' }), invalid);
});

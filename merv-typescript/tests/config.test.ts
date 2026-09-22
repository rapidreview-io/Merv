import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

test('default configuration includes session enforcement and API adds its control adapter and tool transports', () => {
  const core = loadConfiguration({ directory: './data' });
  assert.deepEqual(
    core.entries.map((entry) => entry.id),
    [
      'research',
      'paper',
      'reflections',
      'knowledge',
      'experiments',
      'code-research',
      'code',
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
        entry.required === !['feed', 'code', 'code-research'].includes(entry.id) &&
        entry.disabled === false,
    ),
  );
  assert.deepEqual(core.entries.find((entry) => entry.id === 'state')?.config, {
    path: join(resolve('./data'), 'state.sqlite'),
  });
  assert.deepEqual(core.entries.find((entry) => entry.id === 'blobs')?.config, {
    root: join(resolve('./data'), 'blobs'),
  });
  const full = loadConfiguration({ directory: './data', api: true });
  assert.equal(full.entries.length, 36, 'legacy API selection excludes the browser layer');
  assert.equal(full.entries.find((entry) => entry.id === 'tools')?.name, '@merv/api/tools-plugin');
  assert.deepEqual(full.entries.find((entry) => entry.id === 'api')?.config, {
    host: '127.0.0.1',
    port: 3081,
  });
  assert.equal(full.baseUrl, new URL('../config/default.json', import.meta.url).href);
  const order = (id: string) => full.entries.findIndex((entry) => entry.id === id);
  const requirements: Record<string, string[]> = {
    api: ['tools', 'scope', 'identity'],
    'sessions-api': ['sessions', 'api'],
    'code-api': ['code-research', 'api'],
    code: ['state', 'scope'],
    'code-research': [
      'code',
      'state',
      'scope',
      'sessions',
      'artifacts',
      'workflows',
      'domain-events',
    ],
    knowledge: ['state', 'scope', 'tasks', 'experiments', 'artifacts', 'reviews'],
    experiments: ['state', 'scope', 'artifacts', 'workflows', 'reviews', 'context-builder'],
    sessions: ['state', 'scope', 'workflows', 'domain-events'],
    tools: ['scope'],
    feed: ['state', 'scope', 'artifacts'],
    tasks: ['state', 'scope', 'artifacts', 'workflows', 'reviews', 'context-builder'],
    reviews: ['state', 'scope', 'artifacts', 'domain-events'],
    artifacts: ['state', 'scope', 'blobs'],
    workflows: ['state', 'scope'],
    scope: ['state'],
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
    requirements[`${name}-tools`] = [name === 'code' ? 'code-research' : name, 'tools'];
    assert.equal(
      full.entries.find((entry) => entry.id === `${name}-tools`)?.name,
      `@merv/${name === 'code' ? 'code-research' : name}/tools`,
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

test('legacy selection keeps only matching providers and adapters without adding hidden dependencies', () => {
  const selected = loadConfiguration({
    directory: './data',
    components: ['scope', 'state'],
    api: true,
    port: 0,
  });
  assert.deepEqual(
    selected.entries.map((entry) => entry.id),
    ['api', 'scope-tools', 'tools', 'identity', 'scope', 'state'],
  );
  assert.equal(selected.entries.find((entry) => entry.id === 'api')?.config?.port, 0);
  assert.deepEqual(
    loadConfiguration({ directory: './data', components: ['feed'] }).entries.map(
      (entry) => entry.id,
    ),
    ['feed'],
  );
  assert.deepEqual(loadConfiguration({ directory: './data', components: [] }).entries, []);
  assert.deepEqual(
    loadConfiguration({ directory: './data', components: ['state', 'state'] }).entries.map(
      (entry) => entry.id,
    ),
    ['state'],
  );
  assert.throws(() => loadConfiguration({ directory: './data', components: ['unknown'] }), invalid);
  assert.throws(
    () => loadConfiguration({ directory: './data', components: 'state' as unknown as string[] }),
    invalid,
  );
});

test('default Feed is optional so disabling it preserves the other declarations', () => {
  const config = JSON.parse(
    readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
  ) as ApplicationConfig;
  config.plugins.find((entry) => entry.id === 'feed')!.disabled = true;
  const loaded = configuration(config);
  assert.equal(loaded.entries.length, 49);
  assert.deepEqual(
    loaded.entries.find((entry) => entry.id === 'feed'),
    { id: 'feed', name: '@merv/feed', required: false, disabled: true },
  );
  assert.deepEqual(
    loaded.entries.find((entry) => entry.id === 'feed-tools'),
    { id: 'feed-tools', name: '@merv/feed/tools', required: false, disabled: false },
  );
  const browser = (id: string) => id === 'ui' || id.endsWith('-ui');
  assert.ok(
    loaded.entries
      .filter(
        (entry) =>
          !['feed', 'feed-tools', 'code', 'code-research', 'code-tools', 'code-api'].includes(
            entry.id,
          ) && !browser(entry.id),
      )
      .every((entry) => entry.required),
  );
  assert.ok(loaded.entries.filter((entry) => browser(entry.id)).every((entry) => !entry.required));
  assert.ok(
    loaded.entries
      .filter((entry) => ['code-tools', 'code-api'].includes(entry.id))
      .every((entry) => !entry.required),
  );
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

test('config-file modules resolve beside their JSON file and programmatic modules from workspace root', (t) => {
  const directory = folder(t),
    filename = join(directory, 'application.json');
  writeFileSync(filename, JSON.stringify({ plugins: [{ id: 'relative', name: './plugin.ts' }] }));
  const loaded = loadConfiguration({ directory: join(directory, 'data'), configFile: filename });
  assert.equal(loaded.baseUrl, pathToFileURL(filename).href);
  assert.equal(
    fileURLToPath(new URL(loaded.entries[0].name, loaded.baseUrl)),
    join(directory, 'plugin.ts'),
  );
  const programmatic = configuration({
    plugins: [{ id: 'relative', name: './plugins/custom.ts' }],
  });
  assert.equal(programmatic.baseUrl, new URL('../package.json', import.meta.url).href);
  assert.equal(
    new URL(programmatic.entries[0].name, programmatic.baseUrl).href,
    new URL('../plugins/custom.ts', import.meta.url).href,
  );
  const explicitDefault = loadConfiguration({
    directory,
    configFile: fileURLToPath(new URL('../config/default.json', import.meta.url)),
  });
  assert.equal(
    explicitDefault.entries.length,
    49,
    'Explicit config files must not be implicitly filtered by the legacy API default',
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

test('host, port, and data-directory inputs are checked without reading environment substitutions', () => {
  for (const port of [-1, 65536, 1.5, NaN, '3081']) {
    assert.throws(() => loadConfiguration({ directory: './data', port: port as number }), invalid);
  }
  for (const host of ['', ' ', false])
    assert.throws(() => loadConfiguration({ directory: './data', host: host as string }), invalid);
  assert.throws(() => loadConfiguration({ directory: ' ' }), invalid);
  assert.throws(
    () => loadConfiguration({ directory: './data', api: 'true' as unknown as boolean }),
    invalid,
  );
});

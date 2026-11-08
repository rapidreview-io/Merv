import assert from 'node:assert/strict';

import test from 'node:test';
import {
  loadConfiguration,
  type ApplicationConfig,
  type ConfigurationOptions,
} from '../src/config.js';

const invalid = { code: 'invalid_config' };
const configuration = (config: unknown, options: Partial<ConfigurationOptions> = {}) =>
  loadConfiguration({ directory: './data', ...options, config: config as ApplicationConfig });

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

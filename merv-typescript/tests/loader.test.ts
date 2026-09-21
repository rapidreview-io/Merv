import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FiberState } from 'cordis';
import { MervError } from '@merv/contracts';
import { createApp } from '../src/app.js';
import { loadConfiguration, type ApplicationConfig } from '../src/config.js';
import { resources } from './fixtures/loader-marker.js';

const provider = {
  id: 'marker',
  name: './tests/fixtures/loader-marker.ts',
  config: { value: 'a plugin installed entirely by configuration' },
};
const consumer = { id: 'consumer', name: './tests/fixtures/loader-consumer.ts' };

function temporary(t: { after(fn: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-loader-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('loader waits for an asynchronous configured dependency graph and tracks replacements by entry ID', async (t) => {
  const directory = temporary(t);
  const app = await createApp({ directory, config: { plugins: [consumer, provider] } });
  try {
    assert.equal(app.ctx.loaderConsumer.observed, provider.config.value);
    assert.ok(app.status().every((entry) => entry.state === 'active'));
    const old = app.getFiber('marker')!;
    const originalConsumer = app.getFiber('consumer')!;
    const marker = app.ctx.loaderMarker;
    for (let cycle = 0; cycle < 2; cycle++) {
      await app.setEnabled('marker', false);
      assert.equal(app.status().find((entry) => entry.id === 'marker')?.state, 'disabled');
      assert.deepEqual(app.status().find((entry) => entry.id === 'consumer')?.missingDependencies, [
        'loaderMarker',
      ]);
      assert.equal(app.ctx.get('loaderConsumer'), undefined);
      await app.setEnabled('marker', true);
      assert.equal(app.ctx.loaderConsumer.observed, provider.config.value);
      assert.equal(app.getFiber('consumer'), originalConsumer);
      assert.equal(app.getFiber('marker')?.state, FiberState.ACTIVE);
      assert.notEqual(app.getFiber('marker'), old);
      assert.equal(app.components.get('marker'), app.getFiber('marker'));
      assert.equal(app.status().length, 2);
    }
    assert.equal(marker.closed, true);
    await assert.rejects(app.setEnabled('absent-entry', false), /Plugin entry not found/);
  } finally {
    const marker = app.ctx.loaderMarker;
    await app.stop();
    assert.equal(marker.closed, true);
  }
});

test('required pending entries fail readiness with their actual missing dependencies', async (t) => {
  const directory = temporary(t);
  await assert.rejects(
    createApp({ directory, config: { plugins: [consumer] } }),
    (error: unknown) => {
      assert.ok(error instanceof MervError);
      assert.equal(error.code, 'plugin_unavailable');
      assert.match(error.message, /consumer.*pending.*loaderMarker/);
      return true;
    },
  );
  const app = await createApp({
    directory,
    config: { plugins: [{ ...consumer, required: false }] },
  });
  try {
    assert.deepEqual(app.status(), [
      { ...consumer, state: 'pending', required: false, missingDependencies: ['loaderMarker'] },
    ]);
  } finally {
    await app.stop();
  }
});

test('failed configured activation closes resources and cannot be reported as ready', async (t) => {
  const directory = temporary(t);
  const count = resources.length;
  await assert.rejects(
    createApp({
      directory,
      config: { plugins: [{ ...provider, config: { value: 'failed fixture', fail: true } }] },
    }),
    /marker.*failed/,
  );
  assert.equal(resources.length, count + 1);
  assert.equal(resources.at(-1)?.closed, true);
});

test('unknown required modules fail readiness while optional unavailable modules are visible', async (t) => {
  const directory = temporary(t);
  const absent = { id: 'unknown', name: './tests/fixtures/no-such-plugin.ts' };
  await assert.rejects(createApp({ directory, config: { plugins: [absent] } }), /unknown.*failed/);
  const app = await createApp({
    directory,
    config: { plugins: [provider, { ...absent, required: false }] },
  });
  try {
    assert.equal(app.status().find((entry) => entry.id === 'unknown')?.state, 'failed');
    assert.equal(app.ctx.loaderMarker.value, provider.config.value);
  } finally {
    await app.stop();
  }
});

test('configuration validation failures are reported as failed even when Cordis leaves the fiber pending', async (t) => {
  const directory = temporary(t);
  const invalid = { id: 'state', name: '@merv/state', config: { path: ' ' } };
  await assert.rejects(createApp({ directory, config: { plugins: [invalid] } }), /state.*failed/);
  const app = await createApp({
    directory,
    config: { plugins: [{ ...invalid, required: false }] },
  });
  try {
    assert.equal(app.status()[0].state, 'failed');
    assert.equal(app.ctx.get('state'), undefined);
  } finally {
    await app.stop();
  }
});

test('disabling only optional feed in configuration leaves the API and task program available', async (t) => {
  const directory = temporary(t);
  const config: ApplicationConfig = {
    plugins: loadConfiguration({ directory, api: true, port: 0 }).entries.map((entry) =>
      entry.id === 'feed' ? { ...entry, disabled: true } : entry,
    ),
  };
  const app = await createApp({ directory, config });
  try {
    const credentials = await app.ctx.scope.bootstrap({
      projectName: 'Configured feed removal',
      actorName: 'Operator',
    });
    const response = await fetch(`${app.ctx.api.url}/tools`, {
      headers: { Authorization: `Bearer ${credentials.token}` },
    });
    const { tools } = (await response.json()) as { tools: { name: string }[] };
    assert.equal(response.status, 200);
    assert.equal(tools.length, 75);
    assert.ok(tools.some((tool) => tool.name === 'task.create'));
    assert.ok(!tools.some((tool) => tool.name.startsWith('feed.')));
    assert.equal(app.status().find((entry) => entry.id === 'feed-tools')?.state, 'pending');
    await app.setEnabled('feed', true);
    assert.equal((await app.ctx.tools.list()).length, 79);
    assert.equal(app.status().find((entry) => entry.id === 'feed-tools')?.state, 'active');
  } finally {
    await app.stop();
  }
});

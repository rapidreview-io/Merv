import { FiberState } from 'cordis';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from './fixtures/app.js';
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

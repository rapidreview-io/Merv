import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const merv = resolve(here, '../..');
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

test('build.mjs emits executable hosted launchers and source-bound payloads', () => {
  const bundle = mkdtempSync(join(tmpdir(), 'merv-hosted-bundle-'));
  try {
    const result = spawnSync(process.execPath, ['scripts/hosted-runner/build.mjs', bundle], {
      cwd: merv,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readFileSync(join(bundle, 'start'), 'utf8'),
      '#!/bin/sh\nexec /usr/bin/python3 /opt/merv/runtime/start-runtime.py\n',
    );
    assert.match(
      readFileSync(join(bundle, 'boot'), 'utf8'),
      /^#!\/bin\/sh\n\/usr\/bin\/env -i .* \/opt\/merv\/runtime\/start-runtime\.py --prestart <\/dev\/null >\/dev\/null 2>&1 &\nexec \/usr\/local\/bin\/sandbox-entrypoint "\$@"\n$/,
    );
    for (const script of ['start', 'boot'])
      assert.equal(statSync(join(bundle, script)).mode & 0o777, 0o755);
    const worker = readFileSync(join(bundle, 'pi/worker-main.mjs'), 'utf8');
    assert.match(worker, /from "@earendil-works\/pi-coding-agent"/);
    assert.match(worker, /from "@earendil-works\/pi-ai"/);
    assert.ok(!existsSync(join(bundle, 'pi/node_modules')));
    assert.equal(
      hash(join(bundle, 'pi/package-lock.json')),
      hash(join(merv, 'packages/pi/worker-runtime/package-lock.json')),
    );
    for (const [copy, source] of [
      ['start-runtime.py', 'scripts/hosted-runner/start-runtime.py'],
      ['assignment-probed.py', 'scripts/hosted-runner/assignment-probed.py'],
      ['isolation_probe.py', 'scripts/hosted-runner/isolation_probe.py'],
      ['supervisor.mjs', 'packages/runner/src/supervisor.mjs'],
    ])
      assert.equal(hash(join(bundle, copy)), hash(join(merv, source)));
    const compiled = JSON.parse(readFileSync(join(bundle, 'input-hashes.json'), 'utf8'));
    for (const relative of [
      'packages/pi/src/worker-main.ts',
      'packages/pi/src/worker.ts',
      'packages/pi/src/checkpoint.ts',
      'scripts/hosted-runner/smoke-supervisor.ts',
    ])
      assert.equal(compiled[relative], hash(join(merv, relative)));
  } finally {
    rmSync(bundle, { recursive: true, force: true });
  }
});

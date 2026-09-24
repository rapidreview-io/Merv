import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const merv = resolve(here, '../..');
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

test('build.mjs emits the hosted payload and the Dockerfile installs it with the worker last', () => {
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

    // Every emitted file reaches the image; hosted-release.mjs builds exactly this Dockerfile.
    const dockerfile = readFileSync(join(here, 'Dockerfile'), 'utf8');
    const copied = [...dockerfile.matchAll(/^COPY (?!--from)(.+) \S+$/gm)].flatMap((m) =>
      m[1].split(' '),
    );
    const emitted = spawnSync('find', ['.', '-type', 'f'], { cwd: bundle, encoding: 'utf8' })
      .stdout.split('\n')
      .filter(Boolean)
      .map((p) => p.slice(2));
    assert.deepEqual(
      emitted.filter((p) => p !== 'input-hashes.json').sort(),
      [...new Set(copied)].sort(),
    );
    assert.match(dockerfile, /^FROM node:22\.19\.0-bookworm-slim@sha256:[0-9a-f]{64} AS pi-deps$/m);
    assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts --engine-strict/);
    assert.match(dockerfile, /COPY --from=pi-deps \/opt\/merv\/pi\/node_modules/);
    assert.match(dockerfile, /find node_modules -type d -name \.bin -prune/);
    assert.match(
      dockerfile,
      /^USER 12001:12001\nRUN .*NODE_COMPILE_CACHE=\/opt\/merv\/pi\/compile-cache/m,
    );
    assert.match(dockerfile, /chown -R 0:0 \/opt\/merv\/pi\/compile-cache/);
    assert.match(dockerfile, /^ENTRYPOINT \["\/opt\/merv\/runtime\/boot"\]$/m);
    // A worker-only change must reuse every layer before it (hosted-release's worker lane).
    const lines = dockerfile.split('\n');
    const workerCopy = lines.findIndex((l) => l.startsWith('COPY pi/worker-main.mjs'));
    const later = lines
      .slice(workerCopy + 1)
      .filter((l) => !l.startsWith('ENTRYPOINT'))
      .join('\n');
    assert.ok(workerCopy > lines.findIndex((l) => l.includes('apt-get install')));
    assert.doesNotMatch(later, /^(COPY|ADD) /m);
    assert.doesNotMatch(
      later.replace(/\/opt\/merv\/pi\/compile-cache\S*/g, ''),
      /\/opt\/merv\/(?!pi\/)/,
    );
  } finally {
    rmSync(bundle, { recursive: true, force: true });
  }
});

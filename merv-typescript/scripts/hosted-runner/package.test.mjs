import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'package.mjs');

test('finalize matches the sandbox RuntimeRelease catalog and rejects mutable images', () => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-hosted-release-'));
  try {
    const build = join(directory, 'build.json');
    const executableSha256 = 'b'.repeat(64);
    writeFileSync(
      build,
      JSON.stringify({
        schema: 'merv-hosted-image-build-v1',
        image: {
          platform: 'linux/amd64',
          executable: '/opt/merv/runtime/start-runner',
          executableSha256,
        },
      }),
    );
    const reference = `registry.cloudflare.com/test/hosted@sha256:${'a'.repeat(64)}`;
    const result = spawnSync(
      process.execPath,
      [script, 'finalize', build, reference, 'cloudflare'],
      {
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const catalog = JSON.parse(readFileSync(join(directory, 'releases.json'), 'utf8'));
    assert.equal(catalog.releases.length, 1);
    assert.equal(catalog.releases[0].image_digest, `sha256:${'a'.repeat(64)}`);
    assert.equal(catalog.releases[0].executable_sha256, executableSha256);
    const pinned = JSON.parse(readFileSync(join(directory, 'release.json'), 'utf8'));
    assert.equal(pinned.releaseId, result.stdout.trim());

    const pythonSource = resolve(here, '../../../output/fleet-sandboxes/control/src');
    const python = spawnSync(
      '/opt/homebrew/bin/python3.11',
      [
        '-c',
        'import json,sys; from merv_sandboxes.runtimes.releases import RuntimeRelease; ' +
          'd=json.load(sys.stdin)["releases"][0]; ' +
          'print(RuntimeRelease(**{**d,"arguments":tuple(d["arguments"])}).release_id)',
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, PYTHONPATH: pythonSource },
        input: JSON.stringify(catalog),
      },
    );
    assert.equal(python.status, 0, python.stderr);
    assert.equal(python.stdout.trim(), pinned.releaseId);

    const mutable = spawnSync(
      process.execPath,
      [script, 'finalize', build, 'registry.cloudflare.com/test/hosted:latest', 'cloudflare'],
      { encoding: 'utf8' },
    );
    assert.notEqual(mutable.status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('build stages explicit inputs and records the installed executable', () => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-hosted-build-'));
  try {
    const fakeDocker = join(directory, 'docker');
    const output = join(directory, 'candidate');
    writeFileSync(
      fakeDocker,
      `#!/usr/bin/env node
const fs = require('node:fs');
const crypto = require('node:crypto');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_DOCKER_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'image') {
  process.stdout.write(args.includes('{{.Architecture}}') ? 'amd64\\n' : 'sha256:${'c'.repeat(64)}\\n');
} else if (args[0] === 'run') {
  const digest = crypto.createHash('sha256').update(fs.readFileSync(process.env.MOCK_START)).digest('hex');
  process.stdout.write(digest + '  /opt/merv/runtime/start-runner\\n');
}
`,
      { mode: 0o755 },
    );
    const sandbox = resolve(here, '../../../output/fleet-sandboxes');
    const result = spawnSync(
      process.execPath,
      [script, 'build', sandbox, output, 'merv-hosted:mock'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          MOCK_DOCKER_LOG: join(directory, 'docker.log'),
          MOCK_START: join(output, 'bundle/start'),
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(join(output, 'build.json'), 'utf8'));
    assert.equal(manifest.schema, 'merv-hosted-image-build-v1');
    assert.equal(manifest.image.platform, 'linux/amd64');
    assert.match(manifest.image.executableSha256, /^[0-9a-f]{64}$/);
    const bundle = join(output, 'bundle');
    assert.equal(
      readFileSync(join(bundle, 'start'), 'utf8'),
      '#!/bin/sh\nexec /usr/bin/python3 /opt/merv/runtime/start-runtime.py\n',
    );
    const worker = readFileSync(join(bundle, 'pi/worker-main.mjs'), 'utf8');
    assert.match(worker, /from "@earendil-works\/pi-coding-agent"/);
    assert.match(worker, /from "@earendil-works\/pi-ai"/);
    assert.ok(!existsSync(join(bundle, 'pi/node_modules')));
    assert.deepEqual(
      JSON.parse(readFileSync(join(bundle, 'pi/package-lock.json'), 'utf8')),
      JSON.parse(
        readFileSync(resolve(here, '../../packages/pi/worker-runtime/package-lock.json'), 'utf8'),
      ),
    );
    const dockerfile = readFileSync(join(bundle, 'Dockerfile'), 'utf8');
    assert.match(dockerfile, /FROM node:22\.19\.0-bookworm-slim AS pi-deps/);
    assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts --engine-strict/);
    assert.match(dockerfile, /COPY --from=pi-deps \/opt\/merv\/pi\/node_modules/);
    assert.match(dockerfile, /find node_modules -type d -name \.bin -prune/);
    const compiled = JSON.parse(readFileSync(join(bundle, 'input-hashes.json'), 'utf8'));
    for (const relative of [
      'packages/pi/src/worker-main.ts',
      'packages/pi/src/worker.ts',
      'packages/pi/src/checkpoint.ts',
      'scripts/hosted-runner/smoke-supervisor.ts',
    ]) {
      assert.equal(
        compiled[relative],
        createHash('sha256')
          .update(readFileSync(resolve(here, '../..', relative)))
          .digest('hex'),
      );
    }
    assert.equal(
      manifest.source.hashes.merv['scripts/hosted-runner/start-runtime.py'],
      createHash('sha256')
        .update(readFileSync(join(bundle, 'start-runtime.py')))
        .digest('hex'),
    );
    for (const [relative, digest] of Object.entries(manifest.bundleHashes)) {
      assert.equal(
        digest,
        createHash('sha256')
          .update(readFileSync(join(bundle, relative)))
          .digest('hex'),
      );
    }
    assert.ok(
      existsSync(
        join(output, 'sandbox-context/deploy/cloudflare-sandbox/bin/sandboxes-agent-linux-amd64'),
      ),
    );
    assert.ok(!existsSync(join(output, 'sandbox-context/agent/bin/sandboxes-agent-darwin-arm64')));
    assert.equal(readFileSync(join(directory, 'docker.log'), 'utf8').trim().split('\n').length, 6);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

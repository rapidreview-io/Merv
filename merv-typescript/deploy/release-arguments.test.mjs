import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('release.mjs reaches only the VM that serves --public, and refuses a mismatched pair', () => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-release-host-'));
  try {
    // The first SSH call names the VM; record it and end the release there.
    const calls = join(directory, 'calls.log');
    writeFileSync(join(directory, 'ssh'), `#!/bin/sh\necho "$@" >> '${calls}'\nkill -9 $PPID\n`);
    chmodSync(join(directory, 'ssh'), 0o755);
    const release = (args) => {
      rmSync(calls, { force: true });
      const run = spawnSync(
        process.execPath,
        [fileURLToPath(new URL('release.mjs', import.meta.url)), '--resume', 'r', ...args],
        { cwd: directory, env: { PATH: directory }, encoding: 'utf8', timeout: 10000 },
      );
      const host = existsSync(calls) ? readFileSync(calls, 'utf8').split(' ')[2] : undefined;
      return { ...run, host };
    };
    const production = 'ResearchSuite_Control';
    const staging = 'azureuser@dev-experiments.rapidreview.io';
    for (const [args, host] of [
      [[], production],
      [['--public', 'https://experiments.rapidreview.io:443/'], production],
      [['--public', 'https://rp-control-dev.eastus2.cloudapp.azure.com'], staging],
      [
        ['--public', 'https://RP-control-dev.eastus2.cloudapp.azure.com/', '--host', staging],
        staging,
      ],
      [['--public', 'https://other.example', '--host', 'other'], 'other'],
    ])
      assert.equal(release(args).host, host, args.join(' '));
    for (const args of [
      ['--host', staging],
      ['--public', 'https://rp-control-dev.eastus2.cloudapp.azure.com', '--host', production],
      ['--public', 'https://other.example'],
      ['--public', 'https://other.example', '--host', production],
      ['--public', 'https://experiments.rapidreview.io/ui'],
      ['--public', 'https://user@experiments.rapidreview.io'],
      ['--public', 'http://experiments.rapidreview.io'],
      ['--public', 'https://experiments.rapidreview.io;id'],
    ]) {
      const refused = release(args);
      assert.equal(refused.status, 1, args.join(' '));
      assert.match(refused.stderr, /--public/);
      assert.equal(refused.host, undefined, `${args.join(' ')} reached no VM`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('prebuilt promotion requires all immutable pins and refuses overrides before external work', () => {
  const valid = [
    '--prebuilt-build',
    'reviewed-build',
    '--prebuilt-revision',
    'a'.repeat(40),
    '--prebuilt-archive',
    'b'.repeat(64),
    '--prebuilt-receipt',
    'c'.repeat(64),
    '--expected-image',
    'sha256:' + 'd'.repeat(64),
    '--skip-hosted',
    '--no-rollback',
  ];
  const run = (args) =>
    spawnSync(process.execPath, [fileURLToPath(new URL('release.mjs', import.meta.url)), ...args], {
      env: { PATH: '/nonexistent' },
      encoding: 'utf8',
      timeout: 5000,
    });
  for (let index = 0; index < valid.length; index += index < 10 ? 2 : 1) {
    const args = valid.filter((_, i) => i !== index && !(index < 10 && i === index + 1));
    const result = run(args);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, /--prebuilt-build requires/);
  }
  for (const extra of [
    ['--prebuilt-build', 'other'],
    ['--resume', 'old'],
    ['--retry-prestart', 'old'],
  ]) {
    assert.equal(run([...valid, ...extra]).status, 1);
  }
  for (const bad of ['../build', 'build\n', 'build;id']) {
    const args = [...valid];
    args[1] = bad;
    const result = run(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--prebuilt-build requires/);
  }
  const dry = run([...valid, '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).git, 'aaaaaaaa');
});

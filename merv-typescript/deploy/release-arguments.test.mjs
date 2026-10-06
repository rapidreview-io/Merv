import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

for (const script of ['release.mjs', 'hosted-release.mjs'])
  test(`${script} handles help and invalid arguments before preparing or detaching a release`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'merv-release-arguments-'));
    try {
      // No Git, SSH, SCP or shell is available. Argument handling needs none of them.
      const run = (args) =>
        spawnSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url)), ...args], {
          cwd: directory,
          env: { PATH: directory },
          encoding: 'utf8',
          timeout: 5000,
        });
      const help = run(['--help']);
      assert.equal(help.status, 0, help.stderr);
      assert.match(help.stdout, /^Usage: /);
      assert.equal(help.stderr, '');
      for (const args of [['--dry-rnu'], ['--host'], ['unexpected'], ['--host', '--dry-run']]) {
        const invalid = run(args);
        assert.equal(invalid.status, 1, invalid.stderr);
        assert.match(
          invalid.stderr,
          /Unknown option|argument missing|Unexpected argument|ambiguous/,
        );
        assert.equal(invalid.stdout, '', 'no release archive or detached child was started');
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

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

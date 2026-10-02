import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const source = readFileSync(new URL('./release.mjs', import.meta.url), 'utf8');
const definition = source.slice(
  source.indexOf('const remoteJob ='),
  source.indexOf('\nfunction upload'),
);
const render = new Function(
  'NODE_IMAGE',
  'PUBLIC',
  'noRollback',
  `${definition}\nreturn remoteJob;`,
);

for (const noRollback of [false, true])
  test(`unhealthy release ${noRollback ? 'stops without rollback' : 'restores previous image'}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'merv-release-fault-'));
    try {
      mkdirSync(join(dir, 'source', 'deploy'), { recursive: true });
      mkdirSync(join(dir, 'previous'));
      const job = render(
        'node:test',
        'https://example.test',
        noRollback,
      )({
        release: 'test',
        archiveSha256: 'a'.repeat(64),
      });
      const start = job.indexOf('if [ "$H" != healthy ]; then');
      const end = job.indexOf('\ncode() {', start);
      assert.ok(start > 0 && end > start);
      const failure = job.slice(start, end);
      const script = `
set -euo pipefail
IMG=merv-typescript:test; IMAGE_ID=sha256:123456789abc; H=unhealthy; R=3
PREV=merv-typescript:old; PREV_DIR="$PWD/previous"
COMMANDS="$PWD/commands.txt"; RESTORED="$PWD/restored"
docker() {
  if [ "$1" = logs ]; then echo 'startup failed'; return; fi
  if [ "$1" = inspect ]; then
    if [ -f "$RESTORED" ]; then echo healthy; else echo unhealthy; fi
    return
  fi
  if [ "$1" = compose ]; then
    printf '%s\\n' "$*" >> "$COMMANDS"
    if [ "${'$'}*" = 'compose -f compose.yml up -d' ]; then touch "$RESTORED"; fi
    return
  fi
  return 1
}
sleep() { :; }
${failure}
`;
      const result = spawnSync('bash', ['-c', script], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 3000,
      });
      assert.equal(result.status, 1, result.stderr);
      const commands = readFileSync(join(dir, 'commands.txt'), 'utf8');
      const status = JSON.parse(readFileSync(join(dir, 'deploy-status.json'), 'utf8'));
      if (noRollback) {
        assert.match(commands, /compose -f compose\.yml down/);
        assert.doesNotMatch(commands, /up -d/);
        assert.equal(status.noRollback, true);
        assert.equal(status.rolledBack, false);
      } else {
        assert.match(commands, /compose -f compose\.yml up -d/);
        assert.equal(status.rolledBack, true);
        assert.equal(status.previousImage, 'merv-typescript:old');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

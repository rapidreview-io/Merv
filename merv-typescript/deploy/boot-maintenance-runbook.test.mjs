import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

// Execute the documented block itself. Only host paths and external commands are replaced.
const document = readFileSync(new URL('BOOT_MAINTENANCE.md', import.meta.url), 'utf8');
const snippet = /```bash\n([\s\S]*?)\n\s*```/.exec(document)?.[1];
assert.ok(snippet, 'The reopening Bash block must exist');

for (const scenario of [
  'lock',
  'image-inspect',
  'directory-inspect',
  'empty-image',
  'invalid-image',
  'empty-directory',
  'missing-directory',
  'missing-compose',
  'recovery-pending',
  'compose-fails',
  'success',
]) {
  test(`documented reopening fails closed: ${scenario}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'merv-reopen-doc-'));
    try {
      const compose = join(dir, 'compose project');
      mkdirSync(compose);
      if (scenario !== 'missing-compose') writeFileSync(join(compose, 'compose.yml'), 'fixture');
      const pending = join(dir, 'resume.json');
      if (scenario === 'recovery-pending') writeFileSync(pending, '{}');
      const script = `
flock() { [ "$SCENARIO" != lock ]; }
docker() {
  if [ "$1" = inspect ]; then
    if [ "$3" = '{{.Image}}' ]; then
      [ "$SCENARIO" != image-inspect ] || return 1
      [ "$SCENARIO" != empty-image ] || return 0
      if [ "$SCENARIO" = invalid-image ]; then printf '%s' 'latest'; else printf '%s' "$TEST_IMAGE"; fi
    else
      [ "$SCENARIO" != directory-inspect ] || return 1
      [ "$SCENARIO" != empty-directory ] || return 0
      if [ "$SCENARIO" = missing-directory ]; then printf '%s' "$TEST_COMPOSE/missing"; else printf '%s' "$TEST_COMPOSE"; fi
    fi
  else
    printf '%s\\n' 'COMPOSE_REACHED'
    [ "$MERV_TS_IMAGE" = "$TEST_IMAGE" ] && [ "$PWD" = "$TEST_COMPOSE" ] || return 2
    [ "$SCENARIO" != compose-fails ]
  fi
}
${snippet.replace('/run/lock/merv-maintenance.lock', join(dir, 'maintenance.lock')).replace('/var/lib/merv-recovery/resume.json', pending)}
`;
      const result = spawnSync('bash', ['-c', script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          SCENARIO: scenario,
          TEST_IMAGE: `sha256:${'a'.repeat(64)}`,
          TEST_COMPOSE: compose,
        },
      });
      assert.equal(result.status, scenario === 'success' ? 0 : 1, result.stderr);
      assert.equal(
        result.stdout.includes('COMPOSE_REACHED'),
        ['success', 'compose-fails'].includes(scenario),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

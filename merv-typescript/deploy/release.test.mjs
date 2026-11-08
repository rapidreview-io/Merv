import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseArgs } from 'node:util';

const source = readFileSync(new URL('./release.mjs', import.meta.url), 'utf8');
const definition = source.slice(
  source.indexOf('const remoteJob ='),
  source.indexOf('\nfunction upload'),
);
const render = new Function(
  'NODE_IMAGE',
  'PUBLIC',
  'noRollback',
  'UI_DIR',
  `${definition}\nreturn remoteJob;`,
);

test('release.env accepts one registry digest or local image ID and rejects other values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'merv-release-image-'));
  try {
    const job = render(
      'node:test',
      'https://example.test',
      false,
    )({
      release: 'test',
      archiveSha256: 'a'.repeat(64),
    });
    const start = job.indexOf('SANDBOXES_TS_IMAGE=$(sed');
    const end = job.indexOf('\ndocker build', start);
    assert.ok(start > 0 && end > start);
    const script =
      'set -euo pipefail\n' + job.slice(start, end).replace('/etc/sandboxes/release.env', '"$1"');
    const digest = 'sha256:' + 'a'.repeat(64);
    for (const [value, valid] of [
      [digest, true],
      [`registry.example:5000/team/image@${digest}`, true],
      ['', false],
      ['registry/image:latest', false],
      [digest.slice(0, -1), false],
      [digest + 'a', false],
      [digest.toUpperCase(), false],
      [`"${digest}"`, false],
      [digest + ' ', false],
      [`@${digest}`, false],
      [`registry/image@${digest}\nSANDBOXES_TS_IMAGE=${digest}`, false],
    ]) {
      writeFileSync(join(dir, 'release.env'), `SANDBOXES_TS_IMAGE=${value}\n`);
      const result = spawnSync('bash', ['-c', script, 'test', join(dir, 'release.env')], {
        encoding: 'utf8',
      });
      assert.equal(result.status, valid ? 0 : 1, value + result.stderr);
    }
    for (const file of ['release.env', 'missing.env']) {
      writeFileSync(join(dir, 'release.env'), 'OTHER=value\n');
      const result = spawnSync('bash', ['-c', script, 'test', join(dir, file)], {
        encoding: 'utf8',
      });
      assert.notEqual(result.status, 0);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const failures = [
  { name: 'unhealthy release restores a compatible in-process image', noRollback: false },
  { name: 'unhealthy release refuses an incompatible Sandboxes image', compatible: false },
];
for (const {
  name,
  noRollback = false,
  logs = 'startup failed',
  composeFails = false,
  compatible = true,
  nativeCapable = true,
} of failures)
  test(name, () => {
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
      // From the build manifest through the health wait and its failure handling.
      const start = job.indexOf('\nALLOW_ROLLBACK=false');
      const end = job.indexOf('\ncode() {', start);
      assert.ok(start > 0 && end > start);
      const script = `
set -euo pipefail
IMG=merv-typescript:test; IMAGE_ID=sha256:123456789abc
PREV=merv-typescript:old; PREV_DIR="$PWD/previous"; PREV_ID=sha256:old
PREV_NATIVE=${nativeCapable}
SANDBOXES_TS_IMAGE=sbx@sha256:123; BK="$PWD/backup"
mkdir -p "$BK"
cp() { :; }; chmod() { :; }
COMMANDS="$PWD/commands.txt"; RESTORED="$PWD/restored"
docker() {
  if [ "$1" = run ]; then echo '{"ready":true,"alreadyNative":true}'; return 0; fi
  if [ "$1" = stop ] || [ "$1" = start ]; then return 0; fi
  # \`return 0\`, not a bare return: in a trap handler bash 5 returns the status that fired it.
  if [ "$1" = image ]; then echo '${compatible ? 'sbx@sha256:123' : '<no value>'}'; return 0; fi
  if [ "$1" = logs ]; then echo ${JSON.stringify(logs)}; return 0; fi
  if [ "$1" = inspect ]; then
    if [ "$3" = '{{.RestartCount}}' ]; then echo 3;
    elif [ -f "$RESTORED" ]; then echo healthy; else echo unhealthy; fi
    return 0
  fi
  if [ "$1" = compose ]; then
    printf '%s %s %s\\n' "$(basename "$PWD")" "$*" "$MERV_TS_IMAGE" >> "$COMMANDS"
    if [ "$4" = up ] && [ "$PWD" = "$PREV_DIR" ]; then touch "$RESTORED";
    elif [ "$4" = up ] && ${composeFails ? 'true' : 'false'}; then return 1; fi
    return 0
  fi
  return 1
}
sleep() { :; }
${job.slice(start, end)}
`;
      const result = spawnSync('bash', ['-c', script], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 3000,
      });
      assert.equal(result.status, 1, result.stderr);
      const commands = readFileSync(join(dir, 'commands.txt'), 'utf8');
      const status = JSON.parse(readFileSync(join(dir, 'deploy-status.json'), 'utf8'));
      if (noRollback || !compatible || !nativeCapable) {
        assert.match(commands, /deploy compose -f compose\.yml down/);
        assert.doesNotMatch(commands, /previous compose/);
        assert.equal(status.noRollback, true);
        assert.equal(status.rolledBack, false);
      } else {
        assert.match(commands, /previous compose -f compose\.yml up -d/);
        assert.match(commands, /previous compose -f compose\.yml up -d sha256:old/);
        assert.equal(status.rolledBack, true);
        assert.equal(status.previousImage, 'merv-typescript:old');
        assert.equal(status.previousHealth, 'healthy');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

const sandboxDefinition = source.slice(
  source.indexOf('const sandboxes ='),
  source.indexOf("const dryRun = args['dry-run'];"),
);
const validateSandboxes = new Function(
  'args',
  'tokens',
  'existsSync',
  'statSync',
  'join',
  'resolve',
  `${sandboxDefinition}\nreturn sandboxes;`,
);
const parseSandboxes = (args, ...helpers) => {
  const parsed = parseArgs({ args, tokens: true, options: { sandboxes: { type: 'string' } } });
  return validateSandboxes(parsed.values, parsed.tokens, ...helpers);
};
const hostedDefinition = source.slice(
  source.indexOf('const hosted ='),
  source.indexOf('// A hosted run left open'),
);
const hostedChild = new Function(
  'spawnSync',
  'process',
  'join',
  'root',
  'host',
  'sandboxes',
  `${hostedDefinition}\nreturn hosted;`,
);

test('expected image gates the built immutable ID before candidate execution and live mutations', () => {
  const expectedImage = 'sha256:' + 'a'.repeat(64);
  for (const expectation of [expectedImage, undefined]) {
    const job = render(
      'node:test',
      'https://example.test',
      true,
    )({
      release: 'test',
      archiveSha256: 'b'.repeat(64),
      expectedImage: expectation,
    });
    const start = job.indexOf('docker build --platform');
    const end = job.indexOf('# The served UI');
    assert.ok(start > 0 && end > start);
    // All live mutations and candidate startup remain downstream of the executed gate.
    for (const mutation of ['cp -rn ui/assets/', 'docker stop -t 60', 'touch candidate-started']) {
      assert.ok(job.indexOf(mutation) > end, mutation);
    }
    for (const actual of [expectedImage, 'sha256:' + 'c'.repeat(64)]) {
      const dir = mkdtempSync(join(tmpdir(), 'merv-expected-image-'));
      try {
        const result = spawnSync(
          'bash',
          [
            '-c',
            `set -euo pipefail
IMG=mutable-tag; SANDBOXES_TS_IMAGE=unused
docker() {
  case "$1" in
    build) return 0 ;;
    image) echo '${actual}' ;;
    run) echo "$*" >> executed ;;
    *) return 91 ;;
  esac
}
${job.slice(start, end)}
echo reached > live-mutations
`,
          ],
          { cwd: dir, encoding: 'utf8' },
        );
        const matches = !expectation || expectation === actual;
        assert.equal(result.status, matches ? 0 : 1, result.stderr);
        assert.equal(existsSync(join(dir, 'live-mutations')), matches);
        assert.equal(existsSync(join(dir, 'executed')), matches);
        if (matches) assert.match(readFileSync(join(dir, 'executed'), 'utf8'), new RegExp(actual));
        else assert.match(result.stderr, /expected-image mismatch.*Main and served UI untouched/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
});

test('prebuilt verifier rejects source, image and attestation mismatch', () => {
  const result = spawnSync(
    'python3',
    [new URL('./prebuilt-release.test.py', import.meta.url).pathname],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

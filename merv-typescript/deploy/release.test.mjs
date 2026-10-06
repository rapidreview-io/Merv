import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
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
  `${definition}\nreturn remoteJob;`,
);

const failures = [
  { name: 'unhealthy release restores previous image', noRollback: false },
  { name: 'unhealthy release stops without rollback', noRollback: true },
  // grep -v finds nothing to keep, which once ended the job under set -e before any rollback.
  {
    name: 'unhealthy release with only filtered log lines restores previous image',
    logs: 'x ExperimentalWarning',
  },
  { name: 'failed compose up restores previous image', composeFails: true },
];
for (const { name, noRollback = false, logs = 'startup failed', composeFails = false } of failures)
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
      const start = job.indexOf(
        '\nprintf \'{"release":"%s","image":"%s","imageId":"%s","nodeImage"',
      );
      const end = job.indexOf('\ncode() {', start);
      assert.ok(start > 0 && end > start);
      const script = `
set -euo pipefail
IMG=merv-typescript:test; IMAGE_ID=sha256:123456789abc
PREV=merv-typescript:old; PREV_DIR="$PWD/previous"
COMMANDS="$PWD/commands.txt"; RESTORED="$PWD/restored"
docker() {
  if [ "$1" = logs ]; then echo ${JSON.stringify(logs)}; return; fi
  if [ "$1" = inspect ]; then
    if [ "$3" = '{{.RestartCount}}' ]; then echo 3;
    elif [ -f "$RESTORED" ]; then echo healthy; else echo unhealthy; fi
    return
  fi
  if [ "$1" = compose ]; then
    printf '%s %s\\n' "$(basename "$PWD")" "$*" >> "$COMMANDS"
    if [ "$4" = up ] && [ "$PWD" = "$PREV_DIR" ]; then touch "$RESTORED";
    elif [ "$4" = up ] && ${composeFails ? 'true' : 'false'}; then return 1; fi
    return
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
      if (noRollback) {
        assert.match(commands, /deploy compose -f compose\.yml down/);
        assert.doesNotMatch(commands, /previous compose/);
        assert.equal(status.noRollback, true);
        assert.equal(status.rolledBack, false);
      } else {
        assert.match(commands, /previous compose -f compose\.yml up -d/);
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

test('selected Sandboxes checkout reaches resume, pin checks and final hosted rollout unchanged', () => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-python-checkout-'));
  try {
    const checkout = join(directory, 'Python checkout with spaces');
    mkdirSync(join(checkout, '.git'), { recursive: true });
    const selected = parseSandboxes(['--sandboxes', checkout], existsSync, statSync, join, resolve);
    const calls = [];
    const hosted = hostedChild(
      (...args) => {
        calls.push(args);
        return { status: 0 };
      },
      process,
      join,
      '/merv',
      'ResearchSuite_Control',
      selected,
    );
    assert.equal(hosted('--resume'), 0);
    assert.equal(hosted('--check'), 0);
    assert.equal(hosted(), 0);
    for (const [index, extra] of [['--resume'], ['--check'], []].entries()) {
      assert.deepEqual(calls[index], [
        process.execPath,
        [
          '/merv/deploy/hosted-release.mjs',
          '--host',
          'ResearchSuite_Control',
          '--sandboxes',
          checkout,
          ...extra,
        ],
        { stdio: 'inherit' },
      ]);
    }
    const defaultCalls = [];
    hostedChild(
      (...args) => {
        defaultCalls.push(args);
        return { status: 0 };
      },
      process,
      join,
      '/merv',
      'ResearchSuite_Control',
      undefined,
    )('--check');
    assert.deepEqual(defaultCalls[0][1], [
      '/merv/deploy/hosted-release.mjs',
      '--host',
      'ResearchSuite_Control',
      '--check',
    ]);
    assert.equal(parseSandboxes([], existsSync, statSync, join, resolve), undefined);
    for (const args of [
      ['--sandboxes'],
      ['--sandboxes', '--resume'],
      ['--sandboxes', ''],
      ['--sandboxes', checkout, '--sandboxes', checkout],
      ['--sandboxes', checkout + '\n'],
      ['--sandboxes', join(directory, 'missing')],
      ['--sandboxes', directory],
    ])
      assert.throws(() => parseSandboxes(args, existsSync, statSync, join, resolve), /--sandboxes/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

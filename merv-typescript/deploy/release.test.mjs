import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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
  { name: 'native database never authorizes rollback to an unlabeled image', nativeCapable: false },
  { name: 'unhealthy release stops without rollback', noRollback: true },
  // grep -v finds nothing to keep, which once ended the job under set -e before any rollback.
  {
    name: 'unhealthy release with only filtered log lines restores previous image',
    logs: 'x ExperimentalWarning',
  },
  { name: 'failed compose up restores previous image', composeFails: true },
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

test('Git cutover restart and rollback require exact previous image capability or proven legacy state', () => {
  for (const [
    failAt,
    native,
    migrated = false,
    noRollback = false,
    unreadable = false,
    nativeCapable = false,
  ] of [
    [1, false],
    [2, false],
    [0, false],
    [0, true],
    [2, true],
    [2, false, true],
    [2, false, false, true],
    [2, false, false, false, true],
    [2, true, true, false, false, true],
    [2, true, true, true, false, true],
    [2, true, true, false, true, true],
    [0, true, true, false, false, true],
    [0, false, false, false, false, true],
  ]) {
    const job = render(
      'node:test',
      'https://example.test',
      noRollback,
    )({ release: 'test', archiveSha256: 'a'.repeat(64) });
    const start = job.indexOf('# The first native-Git release');
    const block = job.slice(start, job.indexOf('trap rollback EXIT', start));
    const dir = mkdtempSync(join(tmpdir(), 'merv-cutover-gate-'));
    try {
      writeFileSync(join(dir, 'rollback.json'), '{"automaticRollbackAllowed":true}');
      const result = spawnSync(
        'bash',
        [
          '-c',
          `set -euo pipefail
IMG=new; PREV=old; PREV_NATIVE=${nativeCapable}; BK="$PWD"; ALLOW_ROLLBACK=${nativeCapable && !noRollback}; attempts=0
docker() {
  echo "$1" >> commands
  if [ "$1" = run ]; then
    attempts=$((attempts+1))
    if [ "$attempts" != "${failAt}" ] || ${!unreadable}; then
      echo '{"ready":true,"protocolMigrated":${migrated}${native ? ',"alreadyNative":true' : ''}}'
    fi
    [ "$attempts" != "${failAt}" ] || return 1
  fi
}
${block}
echo "$ALLOW_ROLLBACK" > allowed
`,
        ],
        { cwd: dir, encoding: 'utf8' },
      );
      assert.equal(result.status, failAt ? 1 : 0, result.stderr);
      assert.deepEqual(
        readFileSync(join(dir, 'commands'), 'utf8').trim().split('\n'),
        failAt === 1
          ? ['run']
          : failAt === 2
            ? [
                'run',
                'stop',
                'run',
                ...(!noRollback && (nativeCapable || (!native && !migrated && !unreadable))
                  ? ['start']
                  : []),
              ]
            : ['run', 'stop', 'run'],
      );
      if (!failAt)
        assert.equal(
          readFileSync(join(dir, 'allowed'), 'utf8').trim(),
          String(nativeCapable && !noRollback),
        );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('previous image capability is read by immutable container image ID, not its tag', () => {
  const job = render(
    'node:test',
    'https://example.test',
    false,
  )({ release: 'test', archiveSha256: 'a'.repeat(64) });
  const start = job.indexOf('PREV=$(docker inspect');
  const block = job.slice(start, job.indexOf('\nALLOW_ROLLBACK=false', start));
  for (const label of ['1', '<no value>', '2']) {
    const result = spawnSync(
      'bash',
      [
        '-c',
        `set -euo pipefail
docker() {
  if [ "$1" = inspect ]; then
    if [ "$3" = '{{.Config.Image}}' ]; then echo mutable-tag;
    elif [ "$3" = '{{.Image}}' ]; then echo sha256:exact-old;
    else echo /previous; fi
  elif [ "$1" = image ]; then
    [ "$5" = sha256:exact-old ] || return 77
    echo '${label}'
  fi
}
${block}
echo "$PREV_ID $PREV_NATIVE"
`,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), `sha256:exact-old ${label === '1'}`);
  }
  assert.match(
    readFileSync(new URL('./Dockerfile', import.meta.url), 'utf8'),
    /^LABEL org\.merv\.native-git-protocol=1$/m,
  );
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
  const directory = mkdtempSync(join(tmpdir(), 'merv-sandboxes-checkout-'));
  try {
    const checkout = join(directory, 'Sandboxes checkout with spaces');
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

test('cutover skips hosted resume and checks; ordinary releases retain both gates', () => {
  const gates = new Function(
    'args',
    'local',
    'PUBLIC',
    'PRODUCTION',
    'hosted',
    source.slice(
      source.indexOf('// A hosted run left open'),
      source.indexOf('const release = resume'),
    ),
  );
  const calls = [];
  const hosted = (flag) => {
    calls.push(flag);
    return 0;
  };
  gates({ 'skip-hosted': true }, {}, 'production', 'production', hosted);
  assert.deepEqual(calls, []);
  gates({}, {}, 'production', 'production', hosted);
  assert.deepEqual(calls, ['--resume', '--check']);
});

test('Main release cache cleanup is bounded, never prunes images or volumes, and is best effort', () => {
  const dir = mkdtempSync(join(tmpdir(), 'merv-release-cache-'));
  try {
    const job = render(
      'node:test',
      'https://example.test',
      false,
    )({
      release: 'test',
      archiveSha256: 'a'.repeat(64),
    });
    const start = job.indexOf('\ndocker builder prune');
    const end = job.indexOf('\ndocker build --', start);
    assert.ok(start > 0 && end > start);
    const result = spawnSync(
      'bash',
      [
        '-c',
        `set -euo pipefail
      docker() { printf '%s\\n' "$*" > commands; return 1; }
      ${job.slice(start, end)}
      echo continued
    `,
      ],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /continued/);
    assert.equal(
      readFileSync(join(dir, 'commands'), 'utf8').trim(),
      'builder prune -af --keep-storage 10GB',
    );
    assert.match(readFileSync(join(dir, 'build.log'), 'utf8'), /cleanup failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

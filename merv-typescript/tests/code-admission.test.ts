import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  admit,
  bundleHeader,
  defaultLimits,
  globPattern,
  nameFinding,
  symlinkEscapes,
  type AdmissionLimits,
} from '@merv/code/store/admission';
import { CodeRepositories } from '@merv/code/store/repository';
import { described, git, gitSource, type Bundle } from './fixtures/code-store.js';

const open: AdmissionLimits = { ...defaultLimits, denyGlobs: [], secretExemptGlobs: [] };
// Assembled here so that no file of this repository is shaped like a credential.
const secrets: Record<string, string> = {
  'credentials@1.private_key': ['-----BEGIN OPENSSH', 'PRIVATE KEY-----'].join(' '),
  'credentials@1.github_token': `gh${'p'}_${'A1b2'.repeat(9)}`,
  'credentials@1.github_pat': `github${'_pat_'}${'Z9'.repeat(41)}`,
  'credentials@1.slack_token': `xox${'b'}-${'1234567890'}-abcdef`,
  'credentials@1.anthropic_key': `sk-${'ant'}-${'k'.repeat(84)}`,
  'credentials@1.merv_session': `m${'s'}_${'q'.repeat(43)}`,
};

async function fixture(t: TestContext, format: 'sha1' | 'sha256' = 'sha1') {
  const directory = mkdtempSync(join(tmpdir(), 'merv-adm-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repositories = new CodeRepositories({
    root: join(directory, 'code'),
    quotaBytes: 1e12,
    reservedFreeBytes: 1,
  });
  t.after(() => repositories.close(1000));
  await repositories.open();
  await repositories.ensure('project', 'repository', format);
  const paths = repositories.paths('project');
  const source = gitSource(t, format);
  let runs = 0;
  return {
    source,
    repository: paths.repository,
    /** Make a commit of the source part of what the project keeps, as an earlier import did. */
    keep(tip: string) {
      source.git('update-ref', 'refs/heads/kept', tip);
      git(paths.repository, [
        'fetch',
        '--quiet',
        source.repository,
        `+refs/heads/kept:refs/merv/imports/kept-${++runs}`,
      ]);
    },
    judge: (
      bundle: Bundle,
      options: {
        head?: string;
        expectedHead?: string | null;
        prerequisites?: string[] | 'admitted';
        limits?: Partial<AdmissionLimits>;
      } = {},
    ) =>
      admit({
        git: repositories.git,
        repository: paths.repository,
        quarantine: join(paths.quarantine, `run-${++runs}`),
        bundle: bundle.file,
        head: options.head ?? bundle.tip,
        expectedHead: options.expectedHead ?? null,
        prerequisites: options.prerequisites ?? 'admitted',
        limits: { ...open, ...options.limits },
      }),
    /** A commit over a tree written entry by entry, for names and modes a checkout cannot hold. */
    crafted(entries: [mode: string, type: string, oid: string, name: string][], parent?: string) {
      const tree = git(
        source.repository,
        ['mktree', '-z', '--missing'],
        entries.map(([mode, type, oid, name]) => `${mode} ${type} ${oid}\t${name}\0`).join(''),
      );
      return git(source.repository, [
        'commit-tree',
        tree,
        ...(parent ? ['-p', parent] : []),
        '-m',
        'crafted',
      ]);
    },
    blob: (content: string) => git(source.repository, ['hash-object', '-w', '--stdin'], content),
  };
}
const rules = (findings: { rule: string }[]) => [...new Set(findings.map((x) => x.rule))].sort();

test('a whole history and a thin continuation of it are admitted, and only what is new is counted', async (t) => {
  for (const format of ['sha1', 'sha256'] as const) {
    const f = await fixture(t, format);
    const lines = Array.from({ length: 4000 }, (_, index) => `line ${index}`).join('\n');
    const one = f.source.commit({ 'big.txt': lines, 'src/a.ts': 'export const a = 1;\n' });
    const first = f.source.bundle(one);
    assert.deepEqual(await bundleHeader(first.file), {
      objectFormat: format,
      prerequisites: [],
      head: one,
      packOffset: (await bundleHeader(first.file)).packOffset,
    });
    const whole = await f.judge(first);
    assert.deepEqual(whole.findings, []);
    assert.equal(whole.head, one);
    assert.equal(whole.tree, f.source.git('rev-parse', `${one}^{tree}`));
    // Commit, root tree, src tree and two blobs.
    assert.equal(whole.objects, 5);
    assert.equal(whole.objectFormat, format);
    // Judging changes nothing in the project's repository.
    assert.equal(git(f.repository, ['count-objects', '-v']).match(/in-pack: (\d+)/)![1], '0');

    f.keep(one);
    const two = f.source.commit({ 'big.txt': `${lines}\nline 4000` });
    const thin = f.source.bundle(two, [one]);
    assert.ok(
      thin.bytes < first.bytes / 4,
      'the continuation is sent as a delta against kept history',
    );
    const continued = await f.judge(thin, { expectedHead: one, prerequisites: [one] });
    assert.deepEqual(continued.findings, []);
    // Commit, root tree and the changed blob; the base copy --fix-thin added is not new.
    assert.equal(continued.objects, 3);
    // A file restored from kept history is reached again and is neither new nor surplus.
    f.keep(two);
    const three = f.source.commit({ 'big.txt': lines });
    const restored = await f.judge(f.source.bundle(three, [two, one]), { head: three });
    assert.deepEqual(restored.findings, []);
  }
});

test('a bundle that is not what was promised is refused outright', async (t) => {
  const f = await fixture(t);
  const one = f.source.commit({ 'a.txt': 'one\n' });
  const two = f.source.commit({ 'a.txt': 'two\n' });
  const three = f.source.commit({ 'a.txt': 'three\n' });
  f.source.git('checkout', '--quiet', '-b', 'side', one);
  const side = f.source.commit({ 'b.txt': 'side\n' });
  f.keep(one);

  // It builds on a commit the project does not hold.
  await assert.rejects(f.judge(f.source.bundle(three, [two])), {
    code: 'code_bundle_prerequisite',
    status: 409,
  });
  // It builds on a kept commit other than the ones the operation named.
  f.keep(two);
  await assert.rejects(f.judge(f.source.bundle(three, [two]), { prerequisites: [one] }), {
    code: 'code_bundle_prerequisite',
  });
  // It delivers another commit than the operation was promised.
  await assert.rejects(f.judge(f.source.bundle(three, [one]), { head: two }), {
    code: 'code_bundle_head',
  });
  // It does not continue the head it must continue.
  await assert.rejects(f.judge(f.source.bundle(three, [one]), { expectedHead: side }), {
    code: 'code_bundle_lineage',
  });
  assert.deepEqual(
    (await f.judge(f.source.bundle(three, [one]), { expectedHead: one })).findings,
    [],
  );

  // A filtered bundle is a partial history, and two refs are two transfers.
  const filtered = f.source.bundle(three, [one], ['--filter=blob:none']);
  assert.match(
    readFileSync(filtered.file, 'latin1'),
    /^# v3 git bundle\n(?:@object-format=sha1\n)?@filter=blob:none\n/,
  );
  await assert.rejects(f.judge(filtered), { code: 'code_bundle_header' });
  const twoRefs = join(f.source.directory, 'two-refs');
  f.source.git('bundle', 'create', twoRefs, 'refs/heads/main', 'refs/heads/side');
  await assert.rejects(f.judge(described(twoRefs, three)), { code: 'code_bundle_header' });
  const noise = join(f.source.directory, 'noise');
  writeFileSync(noise, 'PACK this is not a bundle');
  await assert.rejects(f.judge(described(noise, three)), { code: 'code_bundle_header' });

  // A damaged pack fails strict indexing.
  const good = f.source.bundle(three, [one]);
  const damaged = Buffer.from(good.content);
  for (let at = damaged.length - 40; at < damaged.length - 30; at++) damaged[at] ^= 0xff;
  const damagedFile = join(f.source.directory, 'damaged');
  writeFileSync(damagedFile, damaged);
  await assert.rejects(f.judge(described(damagedFile, three)), { code: 'code_bundle_corrupt' });

  // A header that hides a prerequisite the project does not hold leaves the history incomplete.
  f.source.git('checkout', '--quiet', 'main');
  const four = f.source.commit({ 'a.txt': 'four\n' });
  const five = f.source.commit({ 'a.txt': 'five\n' });
  const unkept = f.source.bundle(five, [four]);
  const header = await bundleHeader(unkept.file);
  const hidden = join(f.source.directory, 'hidden');
  writeFileSync(
    hidden,
    Buffer.concat([
      Buffer.from(`# v2 git bundle\n${five} refs/heads/transfer\n\n`),
      unkept.content.subarray(header.packOffset),
    ]),
  );
  await assert.rejects(f.judge(described(hidden, five)), (error: { code: string }) =>
    /^code_bundle_(corrupt|disconnected)$/.test(error.code),
  );

  // A pack may not carry history the delivered commit does not use.
  f.source.git('checkout', '--quiet', '--orphan', 'unrelated');
  const unrelated = f.source.commit({ 'hidden/payload.bin': 'never examined\n' });
  git(
    f.source.repository,
    ['pack-objects', '--revs', '--quiet', join(f.source.directory, 'surplus')],
    `${three}\n${unrelated}\n^${one}\n`,
  );
  const written = readdirSync(f.source.directory).find((name) => /^surplus-.*\.pack$/.test(name))!;
  const surplus = join(f.source.directory, 'surplus-bundle');
  writeFileSync(
    surplus,
    Buffer.concat([
      Buffer.from(`# v2 git bundle\n-${one} base\n${three} refs/heads/transfer\n\n`),
      readFileSync(join(f.source.directory, written)),
    ]),
  );
  await assert.rejects(f.judge(described(surplus, three)), { code: 'code_bundle_surplus' });
});

test('sizes, counts, modes, paths, links and deny globs are findings that name a place', async (t) => {
  const f = await fixture(t);
  const base = f.source.commit({ 'README.md': 'base\n' });
  f.keep(base);

  const large = f.source.commit({ 'data/large.bin': 'x'.repeat(4096), 'small.txt': 's\n' });
  const sized = await f.judge(f.source.bundle(large, [base]), { limits: { blobBytes: 1024 } });
  assert.deepEqual(sized.findings, [
    { rule: 'blob_size', path: null, oid: f.source.git('rev-parse', `${large}:data/large.bin`) },
  ]);
  assert.deepEqual(
    rules((await f.judge(f.source.bundle(large, [base]), { limits: { objects: 4 } })).findings),
    ['object_count'],
  );
  assert.deepEqual(
    rules(
      (await f.judge(f.source.bundle(large, [base]), { limits: { expandedBytes: 4000 } })).findings,
    ),
    ['expanded_size'],
  );
  assert.deepEqual((await f.judge(f.source.bundle(large, [base]))).findings, []);

  const file = f.blob('content\n');
  const gitlink = f.crafted([['160000', 'commit', base, 'vendor']], base);
  assert.deepEqual((await f.judge(f.source.bundle(gitlink, [base]))).findings, [
    { rule: 'gitlink', path: 'vendor', oid: base },
  ]);

  mkdirSync(join(f.source.repository, 'links'), { recursive: true });
  symlinkSync('../README.md', join(f.source.repository, 'links/inside'));
  symlinkSync('../../outside', join(f.source.repository, 'links/escapes'));
  symlinkSync('/etc/passwd', join(f.source.repository, 'links/absolute'));
  const linked = f.source.commit({});
  assert.deepEqual(
    (await f.judge(f.source.bundle(linked, [base]))).findings.map(({ rule, path }) => [rule, path]),
    [
      ['symlink_escape', 'links/absolute'],
      ['symlink_escape', 'links/escapes'],
    ],
  );
  // A kept tree is judged again where a new commit puts it: one level up, its link climbs out.
  f.source.git('rm', '--quiet', '-r', 'links/escapes', 'links/absolute');
  const kept = f.source.commit({});
  f.keep(kept);
  const inside = f.source.git('rev-parse', `${kept}:links/inside`);
  const moved = f.crafted([['120000', 'blob', inside, 'inside']], kept);
  assert.deepEqual((await f.judge(f.source.bundle(moved, [kept]))).findings, [
    { rule: 'symlink_escape', path: null, oid: f.source.git('rev-parse', `${kept}:links`) },
  ]);
  const nested = f.crafted(
    [
      ['40000', 'tree', f.source.git('rev-parse', `${kept}:links`), 'again'],
      ['100644', 'blob', file, 'new.txt'],
    ],
    kept,
  );
  assert.deepEqual((await f.judge(f.source.bundle(nested, [kept]))).findings, []);

  const named = f.crafted(
    [
      ['100644', 'blob', file, 'Readme.MD'],
      ['100644', 'blob', file, 'a\\b'],
      ['100644', 'blob', file, 'bell\x07'],
      ['100644', 'blob', file, 'ends.'],
      ['100644', 'blob', file, 'readme.md'],
      ['100664', 'blob', file, 'group-writable'],
    ],
    base,
  );
  assert.deepEqual(
    (await f.judge(f.source.bundle(named, [base]))).findings.map(({ rule, path }) => [rule, path]),
    [
      ['path_name', 'a\\b'],
      ['path_control', 'bell\x07'],
      ['path_name', 'ends.'],
      ['mode', 'group-writable'],
      ['path_collision', 'readme.md'],
    ],
  );
  // Strict fsck refuses .git before anything else looks; the rule is also Code's own.
  const dotgit = f.crafted([['100644', 'blob', file, '.GIT']], base);
  await assert.rejects(f.judge(f.source.bundle(dotgit, [base])), { code: 'code_bundle_corrupt' });
  for (const name of [
    '.git',
    '.GiT',
    'git~1',
    '.git ',
    '.git.',
    '.',
    '..',
    '',
    'a/b',
    'x'.repeat(256),
  ])
    assert.notEqual(nameFinding(Buffer.from(name)), null, JSON.stringify(name));
  for (const name of ['.gitignore', '.github', 'git', 'a b', 'ünï.txt', 'x'.repeat(255)])
    assert.equal(nameFinding(Buffer.from(name)), null, name);
  assert.deepEqual(
    [
      ['a', '../x'],
      ['d/a', '../x'],
      ['d/a', '../../x'],
      ['a', '/x'],
      ['a', 'b/../../x'],
      ['a', './b/./c'],
      ['a', 'C:/x'],
      ['a', 'b\\..\\..\\x'],
      ['a', ''],
    ].map(([path, target]) => symlinkEscapes(path, target)),
    [true, false, true, true, true, false, true, true, true],
  );

  const deep = f.source.commit({
    [`${Array.from({ length: 64 }, (_, index) => `d${index}`).join('/')}/leaf.txt`]: 'deep\n',
  });
  assert.deepEqual(rules((await f.judge(f.source.bundle(deep, [kept]))).findings), ['path_depth']);
  f.source.git('reset', '--quiet', '--hard', kept);

  const tree = f.source.commit({
    '.env': 'MODE=test\n',
    'config/.env': 'MODE=test\n',
    'build/out/app.js': 'x\n',
    'src/app.js': 'x\n',
    'notes/a1.tmp': 'x\n',
  });
  const denied = await f.judge(f.source.bundle(tree, [kept]), {
    limits: { denyGlobs: ['**/.env', 'build/**', 'notes/a?.tmp'] },
  });
  assert.deepEqual(
    denied.findings.map(({ rule, path }) => [rule, path]).sort(),
    [
      ['deny_glob', '.env'],
      ['deny_glob', 'build/out'],
      ['deny_glob', 'config/.env'],
      ['deny_glob', 'notes/a1.tmp'],
      ['deny_glob', 'build/out/app.js'],
    ].sort(),
    JSON.stringify(denied.findings),
  );

  // What a path decides is judged where a new commit puts a kept directory, not only where it
  // was kept: moved under a denied path it is denied, and moved further down it is too deep.
  f.source.git('reset', '--quiet', '--hard', kept);
  const holding = f.source.commit({ 'lib/inner/data.txt': 'x\n' });
  f.keep(holding);
  const renamed = f.crafted(
    [['40000', 'tree', f.source.git('rev-parse', `${holding}:lib/inner`), 'secrets']],
    holding,
  );
  assert.deepEqual((await f.judge(f.source.bundle(renamed, [holding]))).findings, []);
  assert.deepEqual(
    (await f.judge(f.source.bundle(renamed, [holding]), { limits: { denyGlobs: ['secrets/**'] } }))
      .findings,
    [
      {
        rule: 'deny_glob',
        path: 'secrets/data.txt',
        oid: f.source.git('rev-parse', `${holding}:lib/inner/data.txt`),
      },
    ],
  );

  f.source.git('reset', '--quiet', '--hard', kept);
  const tall = f.source.commit({
    [`${Array.from({ length: 63 }, (_, index) => `e${index}`).join('/')}/leaf.txt`]: 'deep\n',
  });
  assert.deepEqual((await f.judge(f.source.bundle(tall, [kept]))).findings, []);
  f.keep(tall);
  const lowered = f.crafted(
    [['40000', 'tree', f.source.git('rev-parse', `${tall}^{tree}`), 'under']],
    tall,
  );
  assert.deepEqual(rules((await f.judge(f.source.bundle(lowered, [tall]))).findings), [
    'path_depth',
  ]);
});

test('the deny-glob matcher knows literals, ?, * within a segment and ** across segments', () => {
  const table: [glob: string, path: string, matches: boolean][] = [
    ['.env', '.env', true],
    ['.env', 'a/.env', false],
    ['.env', 'xenv', false],
    ['*.pem', 'key.pem', true],
    ['*.pem', 'keys/key.pem', false],
    ['**/*.pem', 'key.pem', true],
    ['**/*.pem', 'a/b/key.pem', true],
    ['secrets/**', 'secrets/a/b', true],
    ['secrets/**', 'secrets', false],
    ['secrets/**', 'nosecrets/a', false],
    ['a/**/z', 'a/z', true],
    ['a/**/z', 'a/b/c/z', true],
    ['a/**/z', 'a/bz', false],
    ['a?c', 'abc', true],
    ['a?c', 'a/c', false],
    ['a?c', 'abbc', false],
    ['a*c', 'ac', true],
    ['a*c', 'a/c', false],
    ['data(1)+[x].txt', 'data(1)+[x].txt', true],
    ['**', 'anything/at/all', true],
  ];
  for (const [glob, path, matches] of table)
    assert.equal(globPattern(glob).test(path), matches, `${glob} against ${path}`);
});

test('a credential anywhere in the delivered history is found, and never echoed', async (t) => {
  const f = await fixture(t);
  const base = f.source.commit({ 'README.md': 'base\n' });
  f.keep(base);
  // One file and one commit message per rule, all judged in one transfer: every rule is its own
  // finding, in whatever order the history walk meets them.
  const rules = Object.entries(secrets);
  const sorted = (findings: unknown[]) => findings.map((finding) => JSON.stringify(finding)).sort();
  const added = f.source.commit(
    Object.fromEntries(
      rules.map(([, secret], index) => [
        `config/settings-${index}.txt`,
        `first line\ntoken = "${secret}"\nlast\n`,
      ]),
    ),
  );
  const blobs = rules.map((_, index) =>
    f.source.git('rev-parse', `${added}:config/settings-${index}.txt`),
  );
  // Removing them again in the same transfer does not take them out of what would be kept.
  const removed = f.source.commit(
    Object.fromEntries(
      rules.map((_, index) => [`config/settings-${index}.txt`, 'first line\nlast\n']),
    ),
  );
  const bundle = f.source.bundle(removed, [base]);
  const judged = await f.judge(bundle);
  assert.deepEqual(
    sorted(judged.findings),
    sorted(
      rules.map(([rule], index) => ({
        rule,
        path: `config/settings-${index}.txt`,
        oid: blobs[index],
      })),
    ),
  );
  for (const [, secret] of rules) assert.equal(JSON.stringify(judged).includes(secret), false);
  // A path the project exempts is skipped; the same bytes at another path are not.
  assert.deepEqual(
    (await f.judge(bundle, { limits: { secretExemptGlobs: ['config/**'] } })).findings,
    [],
  );
  const copied = f.source.commit(
    Object.fromEntries(
      rules.map(([, secret], index) => [
        `elsewhere-${index}.txt`,
        `first line\ntoken = "${secret}"\nlast\n`,
      ]),
    ),
  );
  assert.deepEqual(
    sorted(
      (
        await f.judge(f.source.bundle(copied, [base]), {
          limits: { secretExemptGlobs: ['config/**'] },
        })
      ).findings,
    ),
    sorted(
      rules.map(([rule], index) => ({ rule, path: `elsewhere-${index}.txt`, oid: blobs[index] })),
    ),
  );

  f.source.git('reset', '--quiet', '--hard', base);
  const messages = rules.map(([, secret], index) =>
    f.source.commit({ [`ok-${index}.txt`]: 'fine\n' }, `rotate the key\n\nold value ${secret}`),
  );
  assert.deepEqual(
    sorted((await f.judge(f.source.bundle(messages.at(-1)!, [base]))).findings),
    sorted(rules.map(([rule], index) => ({ rule, path: null, oid: messages[index] }))),
  );
  // Text that merely resembles a credential is not one.
  f.source.git('reset', '--quiet', '--hard', base);
  const harmless = f.source.commit({
    'notes.txt': [
      'ghp_short',
      `items_${'q'.repeat(43)}`,
      'BEGIN PRIVATE KEY',
      'sk-ant-short',
      `${'m'}s_${'q'.repeat(50)}`,
      'xoxb',
    ].join('\n'),
  });
  assert.deepEqual((await f.judge(f.source.bundle(harmless, [base]))).findings, []);
});

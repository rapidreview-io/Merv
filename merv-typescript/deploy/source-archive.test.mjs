import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = (data) => createHash('sha256').update(data).digest('hex');
const git = (cwd, ...args) =>
  execFileSync(
    'git',
    ['-c', 'user.name=Archive Test', '-c', 'user.email=archive@example.invalid', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();

test('release archive rebuilds clients from pinned sources and excludes private files', async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'merv-client-release-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const repo = join(temp, 'repo'),
    app = join(repo, 'merv-typescript');
  mkdirSync(app, { recursive: true });
  for (const name of [
    'deploy/source-archive.mjs',
    'deploy/Dockerfile',
    'deploy/Dockerfile.dockerignore',
    'scripts/build-client-bundle.mjs',
    'packages/scope/src/setup.ts',
    'packages/scope/src/client-package.ts',
  ]) {
    mkdirSync(dirname(join(app, name)), { recursive: true });
    cpSync(join(source, name), join(app, name));
  }
  // A stale generated file must be rebuilt from the shipped sources, never accepted as a fallback.
  writeFileSync(
    join(app, 'packages/scope/src/client-bundle.ts'),
    'export const clientBundle = {};',
  );
  writeFileSync(
    join(app, 'package.json'),
    JSON.stringify({
      type: 'module',
      scripts: { 'build:clients': 'node scripts/build-client-bundle.mjs' },
    }),
  );
  cpSync(join(source, '../clients'), join(repo, 'clients'), { recursive: true });
  const secret = 'SYNTHETIC_ARCHIVE_EXCLUSION_SENTINEL';
  for (const name of [
    'clients/codex/.env',
    'clients/claude-code/credentials-test.json',
    'clients/not-a-plugin/private.txt',
  ]) {
    mkdirSync(dirname(join(repo, name)), { recursive: true });
    writeFileSync(join(repo, name), secret);
  }
  const vendor = join(app, 'vendor/merv-sandboxes');
  for (const dir of ['typescript/packages', 'typescript/hosts/merv', 'typescript/patches']) {
    mkdirSync(join(vendor, dir), { recursive: true });
    writeFileSync(join(vendor, dir, 'pin.txt'), 'committed vendor');
  }
  git(vendor, 'init', '-q');
  git(vendor, 'add', '.');
  git(vendor, 'commit', '-qm', 'Vendor fixture');
  git(repo, 'init', '-q');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'Release fixture');
  const revision = git(repo, 'rev-parse', 'HEAD');
  const skill = 'codex/skills/research/SKILL.md';
  const committedSkill = readFileSync(join(repo, 'clients', skill), 'utf8');
  writeFileSync(join(repo, 'clients', skill), 'UNCOMMITTED_CLIENT_INPUT');
  writeFileSync(join(repo, 'clients/codex/untracked.md'), 'UNTRACKED_CLIENT_INPUT');
  const { packageSource } = await import(pathToFileURL(join(app, 'deploy/source-archive.mjs')));
  const release = packageSource();
  t.after(() => rmSync(release.dir, { recursive: true, force: true }));
  assert.equal(release.gitRevision, revision);
  const manifest = JSON.parse(readFileSync(join(release.dir, 'source-manifest.json')));
  assert.equal(manifest.archiveSha256, sha(readFileSync(join(release.dir, 'source.tar.gz'))));
  assert.equal(
    manifest.contentSha256,
    sha(manifest.files.map((e) => `${e.sha256}  ${e.path}\n`).join('')),
  );
  assert.ok(
    manifest.files.some((e) => e.path === `clients/${skill}` && e.sha256 === sha(committedSkill)),
  );
  assert.ok(
    !manifest.files.some((e) => /\.env|credentials-test|untracked|private\.txt/.test(e.path)),
  );
  const context = join(temp, 'app');
  mkdirSync(context);
  // Match GNU tar --ignore-zeros for concatenated Git archives; BSD tar lacks -i.
  execFileSync('python3', [
    '-c',
    'import sys,tarfile; tarfile.open(sys.argv[1], ignore_zeros=True).extractall(sys.argv[2])',
    join(release.dir, 'source.tar.gz'),
    context,
  ]);
  assert.ok(!existsSync(join(temp, 'clients')), 'no repository-relative client fallback exists');
  for (const entry of manifest.files) {
    const bytes = readFileSync(join(context, entry.path));
    assert.equal(bytes.length, entry.bytes, entry.path);
    assert.equal(sha(bytes), entry.sha256, entry.path);
    assert.ok(!bytes.includes(secret), entry.path);
  }
  assert.equal(readFileSync(join(context, 'clients', skill), 'utf8'), committedSkill);
  symlinkSync(join(source, 'node_modules'), join(context, 'node_modules'), 'dir');
  execFileSync('npm', ['run', 'build:clients'], { cwd: context, stdio: 'pipe' });
  writeFileSync(join(repo, 'clients', skill), committedSkill + '\nCommitted release marker.\n');
  git(repo, 'add', join('clients', skill));
  git(repo, 'commit', '-qm', 'Change shipped skill');
  const next = packageSource();
  t.after(() => rmSync(next.dir, { recursive: true, force: true }));
  assert.notEqual(
    next.contentSha256,
    release.contentSha256,
    'client changes change immutable release content hash',
  );
});

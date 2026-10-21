import assert from 'node:assert/strict';
import test from 'node:test';
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
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = (data) => createHash('sha256').update(data).digest('hex');
const git = (cwd, ...args) =>
  execFileSync(
    'git',
    ['-c', 'user.name=Archive Test', '-c', 'user.email=archive@example.invalid', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();

test('committed release archive rebuilds and serves client plugins in the flattened Docker layout', async (t) => {
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
  // Real setup handlers, built client source and archive extraction, with no database/account needed.
  const probe = `
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { setupRoutes } from './packages/scope/src/setup.ts';
import { packageName } from './packages/scope/src/client-package.ts';
for (const origin of ['https://experiments.rapidreview.io', 'https://release-fixture.invalid']) {
  const route = setupRoutes(origin);
  const server = createServer((req, res) => { Promise.resolve(route(req, res, { url: new URL(req.url, origin) })).then(value => { if (!res.writableEnded) { res.setHeader('content-type','application/json'); res.end(JSON.stringify(value)); } }).catch(error => { res.statusCode=500; res.end(String(error)); }); });
  await new Promise(done => server.listen(0,'127.0.0.1',done));
  const base='http://127.0.0.1:'+server.address().port;
  try {
    const guide = await (await fetch(base+'/connect/agent.md')).text();
    const page = await (await fetch(base+'/connect')).text();
    const name = packageName(origin);
    assert.ok(guide.includes('codex mcp login '+name));
    assert.ok(page.includes('codex mcp login '+name));
    assert.ok(guide.includes('From the extraction directory (MARKETPLACE)'));
    const bundle = await (await fetch(base+'/connect/bundle.json')).json();
    assert.equal(JSON.parse(bundle.files['codex/.mcp.json']).mcpServers[name].url,origin+'/mcp');
    assert.equal(JSON.parse(bundle.files['claude-code/.mcp.json']).mcpServers[name].url,origin+'/mcp');
    assert.ok(bundle.files['codex/skills/research/SKILL.md'].includes('# Research in Merv'));
    assert.ok(!bundle.files['codex/plugin.json']);
    writeFileSync('served-'+name+'.tar.gz',Buffer.from(await (await fetch(base+'/connect/bundle.tar.gz')).arrayBuffer()));
    writeFileSync('served-'+name+'.json',JSON.stringify(bundle.files));
    for (const file of Object.keys(bundle.files)) assert.ok(!/\\.(sh|mjs)$|credentials|\\.env/.test(file));
  } finally { await new Promise(done => server.close(done)); }
}
`;
  writeFileSync(join(context, 'probe.mjs'), probe);
  execFileSync(process.execPath, ['--import', 'tsx', 'probe.mjs'], { cwd: context, stdio: 'pipe' });
  for (const name of ['merv', `merv-${sha('https://release-fixture.invalid').slice(0, 8)}`]) {
    const served = join(temp, name);
    mkdirSync(served);
    execFileSync('tar', ['-xzf', join(context, `served-${name}.tar.gz`), '-C', served]);
    for (const [path, content] of Object.entries(
      JSON.parse(readFileSync(join(context, `served-${name}.json`))),
    )) {
      assert.equal(readFileSync(join(served, path), 'utf8'), content, path);
    }
  }
  // Both callers share packageSource; Docker must admit the mapped sources into COPY . .
  const ignore = readFileSync(join(context, 'deploy/Dockerfile.dockerignore'), 'utf8');
  assert.match(ignore, /^!clients\/\*\*$/m);
  for (const caller of ['release.mjs', 'hosted-release.mjs'])
    assert.match(readFileSync(join(source, 'deploy', caller), 'utf8'), /packageSource\(\)/);
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

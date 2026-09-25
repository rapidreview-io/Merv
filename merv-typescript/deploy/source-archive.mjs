// The allowlisted archive of committed HEAD that release.mjs and hosted-release.mjs build from,
// and the commit of the production ledgers they write.
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const NODE_IMAGE =
  'node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5';
export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(root, '..'); // git commands run at the repository root; the tree is HEAD:merv-typescript
const ROOTS = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'packages',
  'src',
  'scripts',
  'tests',
  'config/default.json',
  'config/no-code.example.json',
  'config/runner-no-code.example.json',
  'config/production.example.json',
  'deploy',
  'docs/architecture',
];
const EXCLUDE =
  /(^|\/)(node_modules|dist)\/|(^|\/)\.env|\.env$|credentials[^/]*\.json$|\.sqlite|^deploy\/[^/]*-private\.json$/;

export const sh = (cmd, a, cwd = root) =>
  execFileSync(cmd, a, { cwd, encoding: 'utf8', maxBuffer: 64 << 20 });
export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export function packageSource() {
  // Releases are commits: the archive comes from HEAD, never from the working tree, so a peer's
  // uncommitted work cannot ride along. Uncommitted differences under the allowlist are listed.
  // A concurrent coding session may advance HEAD while this archive is being assembled.
  const gitRevision = sh('git', ['rev-parse', 'HEAD']).trim();
  const tree = `${gitRevision}:merv-typescript`;
  const files = sh('git', ['ls-tree', '-r', '-z', '--name-only', tree, '--', ...ROOTS], repo)
    .split('\0')
    .filter((p) => p && !EXCLUDE.test(p))
    .sort();
  const entries = files.map((path) => {
    const buf = execFileSync('git', ['show', `${tree}/${path}`], {
      cwd: root,
      maxBuffer: 64 << 20,
    });
    return { path, sha256: sha256(buf), bytes: buf.length };
  });
  const contentSha256 = sha256(entries.map((e) => `${e.sha256}  ${e.path}\n`).join(''));
  const stamp = new Date().toISOString().replace(/[-:]|\.\d+/g, '');
  const release = `${stamp}-${gitRevision.slice(0, 8)}-${contentSha256.slice(0, 12)}`;
  const dir = mkdtempSync(join(tmpdir(), 'merv-release-'));
  execFileSync(
    'git',
    ['archive', '--format=tar.gz', '-o', join(dir, 'source.tar.gz'), tree, '--', ...files],
    { cwd: repo },
  );
  const archiveSha256 = sha256(readFileSync(join(dir, 'source.tar.gz')));
  const manifest = { release, gitRevision, contentSha256, archiveSha256, files: entries };
  writeFileSync(join(dir, 'source-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const uncommitted = sh(
    'git',
    ['status', '--porcelain', '--', ...ROOTS.map((r) => `merv-typescript/${r}`)],
    repo,
  ).trim();
  if (uncommitted) console.error(`not in this release (uncommitted):\n${uncommitted}`);
  return { dir, release, gitRevision, contentSha256, archiveSha256, count: files.length };
}

/** Commits exactly these ledger files, if a production release changed them, with a [skip ci]
 * message and pushes them to origin main, but only from origin/main's tip; otherwise it leaves
 * them in the working tree and says so. */
export function publishLedgers(files, subject) {
  const git = (...a) => spawnSync('git', ['-C', dirname(files[0]), ...a], { encoding: 'utf8' });
  const names = files.map((file) => basename(file)).join(' and ');
  if (!git('status', '--porcelain', '--', ...files).stdout?.trim()) return; // or no checkout
  const head = git('rev-parse', 'HEAD').stdout.trim();
  const tip = git('ls-remote', 'origin', 'refs/heads/main').stdout?.split('\t')[0];
  if (head !== tip) {
    console.error(`${names} left uncommitted: HEAD is not origin/main's tip; commit them by path.`);
    return;
  }
  const failed = (r, step) =>
    r.status !== 0 && !console.error(`${names}: git ${step} failed: ${r.stderr.trim()}`);
  if (failed(git('commit', '-q', '-m', `${subject} [skip ci]`, '--', ...files), 'commit')) return;
  // A peer session may commit here meanwhile: push only this commit, and only if it sits on the tip.
  const [commit, parent] = git('rev-parse', 'HEAD', 'HEAD^').stdout.split('\n');
  if (parent !== tip)
    return console.error(
      `${names} committed but not pushed: a peer's commit landed under them; push once it is reviewed.`,
    );
  if (!failed(git('push', '-q', 'origin', `${commit}:refs/heads/main`), 'push'))
    console.log(`${names} committed and pushed to origin main`);
}

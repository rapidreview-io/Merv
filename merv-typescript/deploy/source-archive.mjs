// The allowlisted archive of committed HEAD that release.mjs and hosted-release.mjs build from.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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

#!/usr/bin/env node
// Deploy the browser UI alone, in seconds, without rebuilding or restarting the server.
//   node deploy/ui-release.mjs [--public https://origin] [--host HOST] [--dry-run]
// Only for commits that change nothing but the UI since the server that is running: every file
// that differs from the running release's commit must be under packages/ui/web (or a test or a
// document). Anything else refuses and names the files; deploy/release.mjs ships those, and its
// own UI with them. So the UI a server serves is always built from that server's tree plus UI
// changes, and every tool the UI calls is one the running server has.
// Builds packages/ui from committed origin/main in this checkout, copies the new hashed assets
// beside the ones open tabs still load, swaps index.html last, checks the public origin, and
// appends a `ui` row to the same release log as deploy/release.mjs.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { releaseTarget, UI_DIR } from './release-target.mjs';
import { publishLedgers, root, sh } from './source-archive.mjs';

const { values: args } = parseArgs({
  options: {
    help: { type: 'boolean' },
    host: { type: 'string' },
    public: { type: 'string' },
    'dry-run': { type: 'boolean' },
  },
});
if (args.help) {
  console.log('Usage: node deploy/ui-release.mjs [--public ORIGIN] [--host HOST] [--dry-run]');
  process.exit(0);
}
const { PUBLIC, host, production, RELEASES, ssh } = releaseTarget(args);
const repo = resolve(root, '..');
/**
 * What a UI release may carry: the bundle's own sources, and files no server reads — tests,
 * documents, the deploy ledgers a release writes back to main, and this script.
 */
const UI_ONLY = [
  /^merv-typescript\/packages\/ui\/web\//,
  /^merv-typescript\/packages\/ui\/vite\.config\.ts$/,
  /^merv-typescript\/tests\//,
  /^merv-typescript\/deploy\/(hosted-release\.json|ui-release\.mjs)$/,
  /\.md$/,
];
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

// Releases are commits on main: a UI deploy is never built from local or unpushed work.
sh('git', ['fetch', '-q', 'origin', 'main'], repo);
const head = sh('git', ['rev-parse', 'HEAD'], repo).trim();
if (production && head !== sh('git', ['rev-parse', 'origin/main'], repo).trim())
  fail('HEAD is not origin/main: push the UI change to main first.');
if (sh('git', ['status', '--porcelain', '--', 'merv-typescript/packages/ui'], repo).trim())
  fail('packages/ui has uncommitted changes; the bundle is built from the commit.');

// The server that is running, and the UI it serves.
const state = ssh(`set -euo pipefail
docker inspect --format '{{.Config.Image}}' merv-typescript-control-1
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' merv-typescript-control-1 | grep -c '^MERV_UI_ASSETS=' || true
cat ${UI_DIR}/release.json 2>/dev/null || echo '{}'`);
if (state.status !== 0) fail('Could not read the running release from the VM.');
const [image, mounted, served] = state.stdout.trim().split('\n');
const server = /^merv-typescript:(\d{8}T\d{6}Z-([0-9a-f]{8})-[0-9a-f]{12})$/.exec(image);
if (!server) fail(`The running image is not a release: ${image}`);
if (mounted !== '1')
  fail('The running server serves the UI from its image; run deploy/release.mjs once first.');
const previous = JSON.parse(served || '{}').release ?? '—';

const changed = sh('git', ['diff', '--name-only', server[2], head], repo).trim().split('\n');
const serverSide = changed.filter((file) => file && !UI_ONLY.some((ui) => ui.test(file)));
if (serverSide.length)
  fail(
    `Changed since the running server (${server[2]}) outside the UI; use deploy/release.mjs:\n  ${serverSide.join('\n  ')}`,
  );
if (!changed.some((file) => file.startsWith('merv-typescript/packages/ui/')))
  fail(`The UI is unchanged since the running server (${server[2]}); nothing to deploy.`);

const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, '')
  .replace(/\.\d+Z$/, 'Z');
const release = `${stamp}-${head.slice(0, 8)}-ui`;
console.log(JSON.stringify({ release, server: server[1], files: changed.length }));
if (args['dry-run']) process.exit(0);

execFileSync('npm', ['run', 'build:ui'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
const dist = join(root, 'packages/ui/dist');
const assets = [
  ...readFileSync(join(dist, 'index.html'), 'utf8').matchAll(/\/ui\/(assets\/[^"]+)"/g),
].map((match) => match[1]);
const tarball = join(mkdtempSync(join(tmpdir(), 'merv-ui-')), 'ui.tar.gz');
execFileSync('tar', ['-czf', tarball, '-C', dist, '.']);

// Under Main's maintenance lock, so it never interleaves with deploy/release.mjs. Hashed assets are
// added beside the old ones, never replaced; index.html goes last, in one rename.
execFileSync('scp', ['-q', tarball, `${host}:merv-${release}.tar.gz`]);
const deploy = ssh(`set -euo pipefail
UPLOAD=~azureuser/merv-${release}.tar.gz
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE" "$UPLOAD"' EXIT
exec 9>/run/lock/merv-maintenance.lock
flock -n 9 || { echo 'another deployment holds the maintenance lock' >&2; exit 1; }
umask 022
tar -xzf "$UPLOAD" -C "$STAGE"
[ -s "$STAGE/index.html" ]
cp -rn "$STAGE/assets/." ${UI_DIR}/assets/
find "$STAGE" -mindepth 1 -maxdepth 1 ! -name assets ! -name index.html -exec cp -r {} ${UI_DIR}/ \\;
cp "$STAGE/index.html" ${UI_DIR}/.index.html && mv -f ${UI_DIR}/.index.html ${UI_DIR}/index.html
printf '{"release":"%s","kind":"ui","server":"%s"}\\n' '${release}' '${server[1]}' > ${UI_DIR}/.release.json
mv -f ${UI_DIR}/.release.json ${UI_DIR}/release.json
echo deployed`);
if (deploy.status !== 0 || !deploy.stdout.includes('deployed')) fail('The UI was not deployed.');

// What the public origin serves now: this build's index.html, and every asset it loads.
const html = await (await fetch(`${PUBLIC}/ui/`, { cache: 'no-store' })).text();
const codes = await Promise.all(
  assets.map(async (asset) => `/ui/${asset} ${(await fetch(`${PUBLIC}/ui/${asset}`)).status}`),
);
const ok =
  assets.length > 0 &&
  assets.every((asset) => html.includes(`/ui/${asset}`)) &&
  codes.every((line) => line.endsWith(' 200'));
console.log(JSON.stringify({ release, ok, assets: codes }));
appendFileSync(
  join(root, RELEASES),
  `| ${new Date().toISOString().slice(0, 16)}Z | \`${release}\` | ui only | server \`${server[1]}\` | ${ok ? 'pass' : 'CHECK'} | public ui, assets ${codes.join('; ')} | previous ui \`${previous}\` |\n`,
);
execFileSync('npx', ['prettier', '--write', RELEASES], { cwd: root, stdio: 'ignore' });
if (production)
  publishLedgers([join(root, RELEASES)], `Record UI release ${release} in production`);
if (!ok) process.exit(1);

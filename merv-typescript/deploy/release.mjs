#!/usr/bin/env node
// Build and deploy one immutable merv-typescript release on the production VM.
//   node deploy/release.mjs [--host ResearchSuite_Control] [--dry-run] [--resume <release-id>]
// Local: allowlisted source archive + manifest (git sha + content hash) → scp to the VM.
// VM (root, detached): extract under /opt/merv-typescript/releases/<id>, docker build with the
// pinned Node digest, compiled-CLI check, rollback record, `docker compose up -d`, health wait,
// local acceptance (status codes, active plugins, served assets). Then this script runs the
// public HTTPS checks and appends one row to deploy/RELEASES.md. Never prints private env files.
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(root, '..'); // git commands run at the repository root; the release tree is HEAD:merv-typescript
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const host = opt('--host', 'ResearchSuite_Control');
const dryRun = args.includes('--dry-run');
const resume = opt('--resume');
const NODE_IMAGE =
  'node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5';
const PUBLIC = 'https://experiments.rapidreview.io';
const ROOTS = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'packages',
  'src',
  'scripts',
  'tests',
  'config/default.json',
  'deploy',
  'docs/architecture',
];
const EXCLUDE =
  /(^|\/)(node_modules|dist)\/|(^|\/)\.env|\.env$|credentials[^/]*\.json$|\.sqlite|^deploy\/[^/]*-private\.json$/;

const sh = (cmd, a, cwd = root) =>
  execFileSync(cmd, a, { cwd, encoding: 'utf8', maxBuffer: 64 << 20 });
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const ssh = (script, opts = {}) =>
  spawnSync('ssh', ['-o', 'BatchMode=yes', host, 'sudo', 'bash', '-s'], {
    input: script,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'],
    ...opts,
  });

function packageSource() {
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

// Runs as root on the VM, detached, writing <release>/deploy-status.json when finished.
const remoteJob = ({ release, archiveSha256 }) => `
set -euo pipefail
REL=/opt/merv-typescript/releases/${release}
IMG=merv-typescript:${release}
BK=/var/backups/merv/typescript-staging-refresh/${release}
cd "$REL"
echo "${archiveSha256}  source.tar.gz" | sha256sum -c - >/dev/null
echo "${archiveSha256}  source.tar.gz" > archive.sha256
mkdir -p source && tar -xzf source.tar.gz -C source
docker image inspect ${NODE_IMAGE} > build.log 2>&1 || docker pull ${NODE_IMAGE} >> build.log 2>&1
docker build --platform linux/amd64 --build-arg NODE_IMAGE=${NODE_IMAGE} -f source/deploy/Dockerfile -t "$IMG" source >> build.log 2>&1
docker run --rm --entrypoint node "$IMG" dist/src/cli.js help >> build.log 2>&1
IMAGE_ID=$(docker image inspect --format '{{.Id}}' "$IMG")
PREV=$(docker inspect --format '{{.Config.Image}}' merv-typescript-control-1)
PREV_ID=$(docker image inspect --format '{{.Id}}' "$PREV")
PREV_DIR=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' merv-typescript-control-1)
mkdir -p "$BK" && chmod 700 "$BK" && cp -p /etc/merv/typescript.env "$BK/" && chmod 600 "$BK/typescript.env"
printf '{"previousImage":"%s","previousImageId":"%s","previousComposeFiles":"%s/compose.yml","newImage":"%s","publicRoutesChanged":false}\\n' "$PREV" "$PREV_ID" "$PREV_DIR" "$IMG" > "$BK/rollback.json"
printf '{"release":"%s","image":"%s","imageId":"%s","nodeImage":"%s","archiveSha256":"%s","buildAndCompiledCli":"passed"}\\n' "${release}" "$IMG" "$IMAGE_ID" "${NODE_IMAGE}" "${archiveSha256}" > build-manifest.json
(cd source/deploy && MERV_TS_IMAGE="$IMG" docker compose -f compose.yml up -d) > deploy.log 2>&1
H=starting; R=0
for i in $(seq 1 60); do
  H=$(docker inspect --format '{{.State.Health.Status}}' merv-typescript-control-1 2>/dev/null || echo starting)
  R=$(docker inspect --format '{{.RestartCount}}' merv-typescript-control-1 2>/dev/null || echo 0)
  [ "$H" = healthy ] && break
  [ "$R" -ge 3 ] && break
  sleep 5
done
if [ "$H" != healthy ]; then
  # The new image never became healthy (or is restart-looping): put the previous image back before reporting.
  LOG=$(docker logs --tail 200 merv-typescript-control-1 2>&1 | grep -vE 'ExperimentalWarning|trace-warnings' | tail -n 2 | tr -d '\\\\"' | tr '\\n' ' ')
  (cd "$PREV_DIR" && MERV_TS_IMAGE="$PREV" docker compose -f compose.yml up -d) > rollback.log 2>&1
  P=starting
  for i in $(seq 1 24); do
    P=$(docker inspect --format '{{.State.Health.Status}}' merv-typescript-control-1 2>/dev/null || echo starting)
    [ "$P" = healthy ] && break; sleep 5
  done
  printf '{"release":"%s","image":"%s","imageId":"%s","rolledBack":true,"containerHealth":"%s","restarts":"%s","previousImage":"%s","previousHealth":"%s","log":"%s"}\\n' \\
    "${release}" "$IMG" "$IMAGE_ID" "$H" "$R" "$PREV" "$P" "$LOG" > deploy-status.json
  exit 1
fi
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
HEALTH=$(code http://127.0.0.1:3081/health)
UI=$(code http://127.0.0.1:3081/ui/)
ANON=$(code -X POST -H 'content-type: application/json' -d '{}' http://127.0.0.1:3081/tools/ui.shell)
OKORIGIN=$(code -H 'Origin: ${PUBLIC}' http://127.0.0.1:3081/auth/config)
BADORIGIN=$(code -X POST -H 'Origin: http://evil.example' -H 'content-type: application/json' -d '{}' http://127.0.0.1:3081/tools/ui.shell)
PLUGINS=$(docker logs merv-typescript-control-1 2>&1 | grep -m1 '"status":"ready"' | python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); print(sum(p["state"]=="active" for p in d["plugins"]), len(d["plugins"]))')
ASSETS=$(curl -s http://127.0.0.1:3081/ui/ | grep -oE '/ui/assets/[^"]+\\.(js|css)' | sort -u | while read -r a; do printf '%s %s %s\\n' "$a" "$(code http://127.0.0.1:3081$a)" "$(curl -s http://127.0.0.1:3081$a | sha256sum | cut -c1-64)"; done | tr '\\n' ';')
printf '{"release":"%s","image":"%s","imageId":"%s","health":"%s","ui":"%s","anonymous":"%s","approvedOrigin":"%s","unapprovedOrigin":"%s","containerHealth":"%s","plugins":"%s","assets":"%s","previousImage":"%s"}\\n' \\
  "${release}" "$IMG" "$IMAGE_ID" "$HEALTH" "$UI" "$ANON" "$OKORIGIN" "$BADORIGIN" "$H" "$PLUGINS" "$ASSETS" "$PREV" > staging-refresh-acceptance.json
cp staging-refresh-acceptance.json deploy-status.json
`;

function upload({ dir, release, archiveSha256 }) {
  const rel = `/opt/merv-typescript/releases/${release}`;
  execFileSync('ssh', ['-o', 'BatchMode=yes', host, `mkdir -p ~/merv-release-${release}`]);
  execFileSync('scp', [
    '-q',
    join(dir, 'source.tar.gz'),
    join(dir, 'source-manifest.json'),
    `${host}:merv-release-${release}/`,
  ]);
  const job = remoteJob({ release, archiveSha256 });
  const start = ssh(`
set -euo pipefail
mkdir -p ${rel} && chmod 700 ${rel}
mv ~azureuser/merv-release-${release}/source.tar.gz ~azureuser/merv-release-${release}/source-manifest.json ${rel}/
rmdir ~azureuser/merv-release-${release}
cat > ${rel}/release-job.sh <<'JOB'
${job}
JOB
chmod 700 ${rel}/release-job.sh
nohup bash ${rel}/release-job.sh > ${rel}/release-job.log 2>&1 < /dev/null &
echo started
`);
  if (start.status !== 0 || !start.stdout.includes('started'))
    throw new Error('remote job did not start');
}

function waitForVm(release) {
  const rel = `/opt/merv-typescript/releases/${release}`;
  const deadline = Date.now() + 9 * 60_000;
  // A job that is between two commands, or not yet spawned, can be missed by one process
  // check; only two consecutive misses without a status file mean the job died.
  let misses = 0;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3_000);
  while (Date.now() < deadline) {
    const r = ssh(
      `if [ -f ${rel}/deploy-status.json ]; then cat ${rel}/deploy-status.json; elif pgrep -f ${rel}/release-job.sh >/dev/null; then echo RUNNING; else echo FAILED; tail -n 20 ${rel}/release-job.log ${rel}/build.log 2>/dev/null; fi`,
    );
    const out = r.stdout.trim();
    if (out.startsWith('{')) return JSON.parse(out);
    if (out.startsWith('FAILED') && ++misses >= 2) throw new Error(`remote job failed:\n${out}`);
    if (!out.startsWith('FAILED')) misses = 0;
    process.stdout.write('.');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
  }
  throw new Error(`still building; rerun with --resume ${release}`);
}

async function publicChecks() {
  const code = async (path, init) =>
    (await fetch(`${PUBLIC}${path}`, { redirect: 'manual', ...init })).status;
  const html = await (await fetch(`${PUBLIC}/ui/`)).text();
  const assets = [...new Set(html.match(/\/ui\/assets\/[^"]+\.(?:js|css)/g) ?? [])];
  const assetCodes = await Promise.all(assets.map(async (a) => `${a} ${await code(a)}`));
  return { health: await code('/health'), ui: await code('/ui/'), assets: assetCodes.join('; ') };
}

const local = resume ? null : packageSource();
if (local)
  console.log(
    JSON.stringify({
      release: local.release,
      files: local.count,
      git: local.gitRevision.slice(0, 8),
      dir: local.dir,
    }),
  );
if (dryRun) process.exit(0);
const release = resume ?? local.release;
if (local) upload(local);
const vm = waitForVm(release);
console.log('\n' + JSON.stringify(vm));
if (vm.rolledBack) {
  // The VM already restored the previous image; record the failure and stop.
  appendFileSync(
    join(root, 'deploy/RELEASES.md'),
    `| ${new Date().toISOString().slice(0, 16)}Z | \`${release}\` | \`${vm.imageId.slice(7, 19)}\` | — | FAILED | container ${vm.containerHealth} after ${vm.restarts} restarts, rolled back automatically (previous image ${vm.previousHealth}); log: ${vm.log.slice(0, 300)} | rollback \`${vm.previousImage}\` applied |\n`,
  );
  execFileSync('npx', ['prettier', '--write', 'deploy/RELEASES.md'], {
    cwd: root,
    stdio: 'ignore',
  });
  console.error(`release ${release} failed and was rolled back to ${vm.previousImage}`);
  process.exit(1);
}
const pub = await publicChecks();
console.log(JSON.stringify(pub));
const ok =
  vm.health === '200' &&
  vm.ui === '200' &&
  vm.anonymous === '401' &&
  vm.unapprovedOrigin === '403' &&
  vm.containerHealth === 'healthy' &&
  pub.health === 200 &&
  pub.ui === 200;
appendFileSync(
  join(root, 'deploy/RELEASES.md'),
  `| ${new Date().toISOString().slice(0, 16)}Z | \`${release}\` | \`${vm.imageId.slice(7, 19)}\` | ${vm.plugins.replace(' ', '/')} | ${ok ? 'pass' : 'CHECK'} | vm ${vm.health}/${vm.ui}/${vm.anonymous}/${vm.approvedOrigin}/${vm.unapprovedOrigin}, public ${pub.health}/${pub.ui}, assets ${pub.assets} | rollback \`${vm.previousImage}\` |\n`,
);
execFileSync('npx', ['prettier', '--write', 'deploy/RELEASES.md'], { cwd: root, stdio: 'ignore' });
if (!ok) process.exit(1);

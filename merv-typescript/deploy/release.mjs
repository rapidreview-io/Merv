#!/usr/bin/env node
// Build and deploy one immutable merv-typescript release on the production VM.
//   node deploy/release.mjs [--host ResearchSuite_Control] [--public https://origin]
//                           [--dry-run] [--resume <release-id>] [--skip-hosted]
// Local: allowlisted source archive + manifest (git sha + content hash) → scp to the VM.
// VM (root, detached): extract under /opt/merv-typescript/releases/<id>, docker build with the
// pinned Node digest, compiled-CLI check, rollback record, `docker compose up -d`, health wait,
// local acceptance (status codes, active plugins, served assets). Then this script runs the
// public HTTPS checks against --public and appends one row to the release log. Never prints
// private env files. --public also selects that log: the production origin writes
// deploy/RELEASES.md, and any other origin (a staging VM) writes deploy/STAGING_RELEASES.md,
// so a staging deploy can never be mistaken for a production one. A passing production release
// then runs deploy/hosted-release.mjs, which does nothing unless the hosted Pi/Codex image's
// sources changed; --skip-hosted leaves the hosted image for an emergency Main-only release.
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { NODE_IMAGE, packageSource, root } from './source-archive.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const host = opt('--host', 'ResearchSuite_Control');
const dryRun = args.includes('--dry-run');
const resume = opt('--resume');
const PRODUCTION = 'https://experiments.rapidreview.io';
const PUBLIC = opt('--public', PRODUCTION);
// The origin is interpolated into the remote job's approved-origin check, so it is an origin
// and nothing else: no path, no credentials, no shell metacharacters.
if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?$/.test(PUBLIC))
  throw new Error(`--public must be an https origin without a path, got ${PUBLIC}`);
// A staging deploy never appends to the production release log.
const RELEASES = PUBLIC === PRODUCTION ? 'deploy/RELEASES.md' : 'deploy/STAGING_RELEASES.md';
const ssh = (script, opts = {}) =>
  spawnSync('ssh', ['-o', 'BatchMode=yes', host, 'sudo', 'bash', '-s'], {
    input: script,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'],
    ...opts,
  });

// Runs as root on the VM, detached, writing <release>/deploy-status.json when finished.
const remoteJob = ({ release, archiveSha256 }) => `
set -euo pipefail
# A hosted-image rollout between its catalog and canary steps owns Main's recreates.
HOSTED=$(cat /var/lib/merv-fleet-pilot/hosted-release/active 2>/dev/null || true)
if [ -n "$HOSTED" ]; then echo "hosted rollout $HOSTED is open: node deploy/hosted-release.mjs --resume $HOSTED" >&2; exit 1; fi
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
# A first deploy on a VM has no previous container, and so nothing to roll back to.
PREV=$(docker inspect --format '{{.Config.Image}}' merv-typescript-control-1 2>/dev/null || true)
PREV_ID=; PREV_DIR=
if [ -n "$PREV" ]; then
  PREV_ID=$(docker image inspect --format '{{.Id}}' "$PREV")
  PREV_DIR=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' merv-typescript-control-1)
fi
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
  if [ -z "$PREV" ]; then (cd source/deploy && MERV_TS_IMAGE="$IMG" docker compose -f compose.yml down) > rollback.log 2>&1; fi
  [ -n "$PREV" ] && (cd "$PREV_DIR" && MERV_TS_IMAGE="$PREV" docker compose -f compose.yml up -d) > rollback.log 2>&1
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
# What the running process reported, with its optional plugins: later env-only changes get no row.
PLUGINS=$(docker logs merv-typescript-control-1 2>&1 | grep '"status":"ready"' | tail -n1 | python3 -c 'import json,sys; p=json.loads(sys.stdin.read())["plugins"]; i={x["id"] for x in p}; print("%d/%d %s" % (sum(x["state"]=="active" for x in p), len(p), "+".join(k for k in ("fleet","fleet-workflow","pi") if k in i) or "no fleet/pi"))' 2>/dev/null || echo '?')
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
    join(root, RELEASES),
    `| ${new Date().toISOString().slice(0, 16)}Z | \`${release}\` | \`${vm.imageId.slice(7, 19)}\` | — | FAILED | container ${vm.containerHealth} after ${vm.restarts} restarts, rolled back automatically (previous image ${vm.previousHealth}); log: ${vm.log.slice(0, 300)} | rollback \`${vm.previousImage}\` applied |\n`,
  );
  execFileSync('npx', ['prettier', '--write', RELEASES], {
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
  join(root, RELEASES),
  `| ${new Date().toISOString().slice(0, 16)}Z | \`${release}\` | \`${vm.imageId.slice(7, 19)}\` | ${vm.plugins} | ${ok ? 'pass' : 'CHECK'} | vm ${vm.health}/${vm.ui}/${vm.anonymous}/${vm.approvedOrigin}/${vm.unapprovedOrigin}, public ${pub.health}/${pub.ui}, assets ${pub.assets} | rollback \`${vm.previousImage}\` |\n`,
);
execFileSync('npx', ['prettier', '--write', RELEASES], { cwd: root, stdio: 'ignore' });
if (!ok) process.exit(1);
if (PUBLIC === PRODUCTION && !args.includes('--skip-hosted')) {
  const hosted = [join(root, 'deploy/hosted-release.mjs'), '--host', host];
  if (spawnSync(process.execPath, hosted, { stdio: 'inherit' }).status !== 0) {
    console.error('Main is released; the hosted image release did not complete (see above).');
    process.exit(1);
  }
}

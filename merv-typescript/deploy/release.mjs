#!/usr/bin/env node
// Build and deploy one immutable merv-typescript release on the production VM.
//   node deploy/release.mjs [--public https://origin] [--host HOST]
//                           [--sandboxes <committed Sandboxes checkout>] [--dry-run] [--resume <release-id>] [--skip-hosted] [--no-rollback]
// Local: allowlisted source archive + manifest (git sha + content hash) → scp to the VM.
// VM (root, detached): extract under /opt/merv-typescript/releases/<id>, docker build with the
// pinned Node digest, compiled-CLI check, rollback record, `docker compose up -d`, health wait,
// local acceptance (status codes, active plugins, served assets). Then this script runs the
// public HTTPS checks against --public and appends one row to the release log. Never prints
// private env files. --public also selects that log: the production origin writes
// deploy/RELEASES.md, and any other origin (a staging VM) writes deploy/STAGING_RELEASES.md,
// so a staging deploy can never be mistaken for a production one. A production release first lets
// deploy/hosted-release.mjs finish any open hosted-image run and check the live pins, and after
// passing runs it again, which does nothing unless the hosted Pi/Codex image's sources changed;
// --skip-hosted leaves the hosted image for an emergency Main-only release. A production row is
// committed by path and pushed when this checkout is at origin/main's tip.
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { PRODUCTION, releaseTarget, UI_DIR } from './release-target.mjs';
import { NODE_IMAGE, packageSource, publishLedgers, root } from './source-archive.mjs';

const { values: args, tokens } = parseArgs({
  tokens: true,
  options: {
    help: { type: 'boolean' },
    host: { type: 'string' },
    public: { type: 'string', default: 'https://experiments.rapidreview.io' },
    sandboxes: { type: 'string' },
    resume: { type: 'string' },
    'dry-run': { type: 'boolean' },
    'skip-hosted': { type: 'boolean' },
    'no-rollback': { type: 'boolean' },
  },
});
if (args.help) {
  console.log(
    'Usage: node deploy/release.mjs [--public ORIGIN] [--host HOST] [--sandboxes PATH] [--dry-run] [--resume RELEASE] [--skip-hosted] [--no-rollback]',
  );
  process.exit(0);
}
const sandboxes = (() => {
  const value = args.sandboxes;
  if (value === undefined) return undefined;
  if (
    !value ||
    value.startsWith('--') ||
    /[\x00-\x1f\x7f]/.test(value) ||
    tokens.filter((token) => token.kind === 'option' && token.name === 'sandboxes').length > 1
  )
    throw new Error('--sandboxes requires one checkout path');
  const path = resolve(value);
  if (!existsSync(path) || !statSync(path).isDirectory() || !existsSync(join(path, '.git')))
    throw new Error('--sandboxes must name a Git checkout directory');
  return path;
})();
const dryRun = args['dry-run'];
const noRollback = args['no-rollback'];
const resume = args.resume;
const { PUBLIC, host, RELEASES, ssh } = releaseTarget(args);

// Runs as root on the VM, detached, writing <release>/deploy-status.json when finished.
const remoteJob = ({ release, archiveSha256 }) => `
set -euo pipefail
# Serialize Main's entire release with recovery capture and hosted-image changes.
mkdir -p /run/lock
exec 9>/run/lock/merv-maintenance.lock
flock -n 9 || { echo "another deployment or recovery snapshot holds the maintenance lock" >&2; exit 1; }
if [ -e /var/lib/merv-recovery/resume.json ]; then echo "recovery snapshot restart is pending; recover it before releasing" >&2; exit 1; fi
# An open hosted-image run owns Main's recreates; it checks for this job after claiming the marker.
HOSTED=$(cat /var/lib/merv-fleet-pilot/hosted-release/active 2>/dev/null || true)
if [ -n "$HOSTED" ]; then echo "hosted run $HOSTED is open; node deploy/hosted-release.mjs finishes it, or --abandon closes it" >&2; exit 1; fi
REL=/opt/merv-typescript/releases/${release}
IMG=merv-typescript:${release}
BK=/var/backups/merv/typescript-staging-refresh/${release}
cd "$REL"
echo "${archiveSha256}  source.tar.gz" | sha256sum -c - >/dev/null
echo "${archiveSha256}  source.tar.gz" > archive.sha256
mkdir -p source && tar -xizf source.tar.gz -C source
docker image inspect ${NODE_IMAGE} > build.log 2>&1 || docker pull ${NODE_IMAGE} >> build.log 2>&1
SANDBOXES_TS_IMAGE=$(sed -n 's/^SANDBOXES_TS_IMAGE=//p' /etc/sandboxes/release.env)
[[ $SANDBOXES_TS_IMAGE =~ ^([a-zA-Z0-9][a-zA-Z0-9._:/-]*@)?sha256:[a-f0-9]{64}$ ]] || { echo 'release.env requires one SANDBOXES_TS_IMAGE registry digest reference or local image ID' >&2; exit 1; }
# Bound unused build cache before each build, including retries after a failed release.
# This never prunes images or volumes; rollback images remain available.
docker builder prune -af --keep-storage 10GB >> build.log 2>&1 || echo 'build-cache cleanup failed; continuing release' >> build.log
docker build --platform linux/amd64 --build-arg SANDBOXES_TS_IMAGE="$SANDBOXES_TS_IMAGE" --build-arg NODE_IMAGE=${NODE_IMAGE} -f source/deploy/Dockerfile -t "$IMG" source >> build.log 2>&1
docker run --rm --entrypoint node "$IMG" --import tsx dist/src/cli.js help >> build.log 2>&1
IMAGE_ID=$(docker image inspect --format '{{.Id}}' "$IMG")
# The served UI is ${UI_DIR}, which deploy/ui-release.mjs also writes: this image's bundle goes
# there beside the hashed assets already served, and its index.html only once it is healthy.
umask 022
rm -rf ui && mkdir ui
docker run --rm --entrypoint tar "$IMG" -C /app/dist/packages/ui/dist -cf - . | tar -C ui -xf -
[ -s ui/index.html ] || { echo 'the image has no UI bundle' >&2; exit 1; }
mkdir -p ${UI_DIR}/assets
cp -rn ui/assets/. ${UI_DIR}/assets/
find ui -mindepth 1 -maxdepth 1 ! -name assets ! -name index.html -exec cp -r {} ${UI_DIR}/ \\;
[ -e ${UI_DIR}/index.html ] || cp ui/index.html ${UI_DIR}/index.html
# A first deploy on a VM has no previous container, and so nothing to roll back to.
PREV=$(docker inspect --format '{{.Config.Image}}' merv-typescript-control-1 2>/dev/null || true)
PREV_ID=; PREV_DIR=; PREV_NATIVE=false
if [ -n "$PREV" ]; then
  # Inspect and restore the exact container image, never a mutable tag's new target.
  PREV_ID=$(docker inspect --format '{{.Image}}' merv-typescript-control-1)
  PREV_DIR=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' merv-typescript-control-1)
  PREV_PROTOCOL=$(docker image inspect --format '{{index .Config.Labels "org.merv.native-git-protocol"}}' "$PREV_ID")
  [ "$PREV_PROTOCOL" != 1 ] || PREV_NATIVE=true
fi
ALLOW_ROLLBACK=false
# This candidate can migrate Code after either preflight. Only a previous image
# declaring the same native protocol can be restored after candidate startup.
if [ "${noRollback ? '1' : '0'}" = 0 ] && [ -n "$PREV" ] && [ "$PREV_NATIVE" = true ]; then
  PREV_SBX=$(docker image inspect --format '{{index .Config.Labels "org.merv.sandboxes-image"}}' "$PREV_ID")
  [ "$PREV_SBX" != "$SANDBOXES_TS_IMAGE" ] || ALLOW_ROLLBACK=true
fi
mkdir -p "$BK" && chmod 700 "$BK" && cp -p /etc/merv/typescript.env "$BK/" && chmod 600 "$BK/typescript.env"
printf '{"previousImage":"%s","previousImageId":"%s","previousComposeFiles":"%s/compose.yml","newImage":"%s","publicRoutesChanged":false,"automaticRollbackAllowed":%s}\\n' "$PREV" "$PREV_ID" "$PREV_DIR" "$IMG" "$ALLOW_ROLLBACK" > "$BK/rollback.json"
printf '{"release":"%s","image":"%s","imageId":"%s","nodeImage":"%s","archiveSha256":"%s","sandboxesImage":"%s","buildAndCompiledCli":"passed"}\\n' "${release}" "$IMG" "$IMAGE_ID" "${NODE_IMAGE}" "${archiveSha256}" "$SANDBOXES_TS_IMAGE" > build-manifest.json
# Until the new container is healthy, any failure (a failed compose up included) ends here.
# A schema cutover may make the previous image unsafe: --no-rollback leaves it stopped.
rollback() {
  trap - EXIT
  set +e
  LOG=$(docker logs --tail 200 merv-typescript-control-1 2>&1 | grep -vE 'ExperimentalWarning|trace-warnings' | tail -n 2 | tr -d '\\\\"' | tr '\\n' ' ')
  if [ "$ALLOW_ROLLBACK" != true ]; then
    (cd source/deploy && MERV_TS_IMAGE="$IMG" docker compose -f compose.yml down) > rollback.log 2>&1
    printf '{"release":"%s","image":"%s","imageId":"%s","noRollback":true,"rolledBack":false,"containerHealth":"%s","restarts":"%s","previousImage":"%s","log":"%s"}\\n' \\
      "${release}" "$IMG" "$IMAGE_ID" "$H" "$R" "$PREV" "$LOG" > deploy-status.json
    exit 1
  fi
  (cd "$PREV_DIR" && MERV_TS_IMAGE="$PREV_ID" docker compose -f compose.yml up -d) > rollback.log 2>&1
  P=starting
  for i in $(seq 1 24); do
    P=$(docker inspect --format '{{.State.Health.Status}}' merv-typescript-control-1 2>/dev/null) || P=starting
    [ "$P" = healthy ] && break; sleep 5
  done
  printf '{"release":"%s","image":"%s","imageId":"%s","rolledBack":true,"containerHealth":"%s","restarts":"%s","previousImage":"%s","previousHealth":"%s","log":"%s"}\\n' \\
    "${release}" "$IMG" "$IMAGE_ID" "$H" "$R" "$PREV" "$P" "$LOG" > deploy-status.json
  exit 1
}
H=not-started; R=0
# The first native-Git release must drain old protocols on the old runtime. Check
# before stopping it, then again after stop so an admission cannot race cutover.
# A failed recheck can restart a native-capable exact previous image. Otherwise,
# both reports must prove that neither protocol nor Code migration has happened.
cutover() {
  docker run --rm --network deploy_default --env-file /etc/merv/typescript.env \\
    --entrypoint node "$IMG" --import tsx deploy/git-cutover-preflight.mjs
}
cutover > git-cutover-before.json
cp git-cutover-before.json git-cutover.json
if [ -n "$PREV" ]; then
  docker stop -t 60 merv-typescript-control-1 > /dev/null
  if ! cutover > git-cutover.json; then
    if [ "${noRollback}" != true ] && { [ "$PREV_NATIVE" = true ] || python3 - <<'PY'
import json
try:
    records=[json.load(open(path)) for path in ['git-cutover-before.json','git-cutover.json']]
    assert all(record.get('protocolMigrated') is False and (record.get('alreadyNative') is None or record.get('alreadyNative') is False) for record in records)
except Exception:
    raise SystemExit(1)
PY
    }; then
      docker start merv-typescript-control-1 > /dev/null
      echo 'Git cutover refused; compatible previous runtime restarted for draining' >&2
    else
      echo 'Git cutover refused; preserve maintenance. Previous runtime compatibility is unproven or automatic rollback is disabled.' >&2
    fi
    exit 1
  fi
fi
trap rollback EXIT
(cd source/deploy && MERV_TS_IMAGE="$IMG" docker compose -f compose.yml up -d) > deploy.log 2>&1
for i in $(seq 1 60); do
  H=$(docker inspect --format '{{.State.Health.Status}}' merv-typescript-control-1 2>/dev/null) || H=starting
  R=$(docker inspect --format '{{.RestartCount}}' merv-typescript-control-1 2>/dev/null) || R=0
  [ "$H" = healthy ] && break
  [ "$R" -ge 3 ] && break
  sleep 5
done
[ "$H" = healthy ] || rollback
trap - EXIT
cp ui/index.html ${UI_DIR}/.index.html && mv -f ${UI_DIR}/.index.html ${UI_DIR}/index.html
printf '{"release":"%s","kind":"full","server":"%s"}\\n' "${release}" "${release}" > ${UI_DIR}/.release.json && mv -f ${UI_DIR}/.release.json ${UI_DIR}/release.json
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
const hosted = (...extra) =>
  spawnSync(
    process.execPath,
    [
      join(root, 'deploy/hosted-release.mjs'),
      '--host',
      host,
      ...(sandboxes ? ['--sandboxes', sandboxes] : []),
      ...extra,
    ],
    {
      stdio: 'inherit',
    },
  ).status;
// A hosted run left open would make the VM job refuse; finish it (forward or back) first.
if (
  local &&
  PUBLIC === PRODUCTION &&
  !args['skip-hosted'] &&
  ![0, 1, 4].includes(hosted('--resume'))
) {
  console.error(
    'A hosted image run is still open; Main was not released. Once production agrees on one of its releases, `node deploy/hosted-release.mjs --abandon` closes it.',
  );
  process.exit(1);
}
// The hosted run after Main's release refuses pins that differ from the host's record: refuse them
// here instead, before Main names them.
if (local && PUBLIC === PRODUCTION && !args['skip-hosted'] && hosted('--check') !== 0) {
  console.error("The hosted pins differ from the host's record (above); Main was not released.");
  process.exit(1);
}
const release = resume ?? local.release;
const log = (row) => {
  appendFileSync(join(root, RELEASES), `| ${new Date().toISOString().slice(0, 16)}Z | ${row} |\n`);
  execFileSync('npx', ['prettier', '--write', RELEASES], { cwd: root, stdio: 'ignore' });
  if (PUBLIC === PRODUCTION)
    publishLedgers([join(root, RELEASES)], `Record release ${release} in production`);
};
if (local) upload(local);
const vm = waitForVm(release);
console.log('\n' + JSON.stringify(vm));
if (vm.rolledBack) {
  // The VM already restored the previous image; record the failure and stop.
  log(
    `\`${release}\` | \`${vm.imageId.slice(7, 19)}\` | — | FAILED | container ${vm.containerHealth} after ${vm.restarts} restarts, rolled back automatically (previous image ${vm.previousHealth}); log: ${vm.log.slice(0, 300)} | rollback \`${vm.previousImage}\` applied`,
  );
  console.error(`release ${release} failed and was rolled back to ${vm.previousImage}`);
  process.exit(1);
}
if (vm.noRollback) {
  log(
    `\`${release}\` | \`${vm.imageId.slice(7, 19)}\` | — | FAILED | container ${vm.containerHealth} after ${vm.restarts} restarts; previous image was not started; log: ${vm.log.slice(0, 300)} | forward recovery required`,
  );
  console.error(
    `release ${release} failed; previous image was not started. Forward recovery is required.`,
  );
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
log(
  `\`${release}\` | \`${vm.imageId.slice(7, 19)}\` | ${vm.plugins} | ${ok ? 'pass' : 'CHECK'} | vm ${vm.health}/${vm.ui}/${vm.anonymous}/${vm.approvedOrigin}/${vm.unapprovedOrigin}, public ${pub.health}/${pub.ui}, assets ${pub.assets} | previous image \`${vm.previousImage}\``,
);
if (!ok) process.exit(1);
if (PUBLIC === PRODUCTION && !args['skip-hosted'] && hosted() !== 0) {
  console.error('Main is released; the hosted image release did not complete (see above).');
  process.exit(1);
}

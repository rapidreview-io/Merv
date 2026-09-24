#!/usr/bin/env node
// Release the hosted Pi/Codex worker image with one guarded command, from the founder's Mac:
//   node deploy/hosted-release.mjs [--dry-run] [--resume <run>] [--host ResearchSuite_Control]
//        [--drain-minutes 15] [--canary-credential <root-only path on the host>]
//        [--sandboxes ../output/fleet-sandboxes] [--wrangler <path to wrangler.js>]
//   node deploy/hosted-release.mjs --mint-canary   (once: the canary's root-only reader key)
// release.mjs runs it after every passing production release. The image is pinned in three
// places, which move together: the Cloudflare container app, the Sandboxes release catalog
// (control and pipelines-worker) and Main's MERV_FLEET_RUNTIME_RELEASE_ID.
//  1 plan: hosted inputs changed since the commit in deploy/hosted-release.json pick the lane:
//    worker-only, or the supervisor/bootstrap boundary. A base-image change is refused; no change
//    ends the run. --dry-run stops here.
//  2 build on the host from an allowlisted archive of committed HEAD: one layer of the compiled
//    hosted files on the pinned base. Its installed-file diff against the deployed image can
//    raise the lane; an empty diff ends the run.
//  3 gates on the host against that exact image: linux-pi-gate for every change, plus the
//    workflow gate and the isolation probe for the boundary. A failure stops with nothing changed.
//  4 push with a 30-minute registry credential minted by the local wrangler and piped over ssh
//    stdin into docker login (tmpfs config, logged out after); pin the amd64 manifest digest.
//  5 catalog: add the release to both Sandboxes services, keeping earlier releases.
//  6 drain: wait, bounded, until no Pi turn or launch is in flight. Idle runtimes may be replaced.
//  7 deploy the Cloudflare app from deploy/hosted-wrangler.json pinned to the new digest, then
//    verify it natively through the Sandboxes container: image, version, settled health, SSH off.
//  8 switch Main's release id and recreate Main from its live release dir on the same image.
//  9 canary: one real Pi turn as a root-only reader key, served by the new release and released.
// A failure after 5 rolls back automatically (previous digest, previous release id, Main
// recreate) and verifies that. Rows go to deploy/HOSTED_RELEASES.md; the live pins are recorded
// in deploy/hosted-release.json. Prints only non-secret receipts.
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NODE_IMAGE, packageSource, root, sh, sha256 } from './source-archive.mjs';

// Paths are relative to merv-typescript. The base image holds these; this pipeline never rebuilds it.
export const BASE_PATHS = ['scripts/hosted-runner/Dockerfile', 'packages/pi/worker-runtime/'];
export const BOUNDARY_PATHS = [
  'scripts/hosted-runner/start-runtime.py',
  'scripts/hosted-runner/assignment-probed.py',
  'scripts/hosted-runner/isolation_probe.py',
  'scripts/hosted-runner/build.mjs',
  'scripts/hosted-runner/smoke-supervisor.ts',
  'packages/runner/src/supervisor.mjs',
];
// Watched besides the last build's bundle inputs, which deploy/hosted-release.json records.
const ALWAYS = [
  'scripts/hosted-runner/',
  'packages/runner/src/supervisor.mjs',
  'package-lock.json',
];
export const GATES = {
  worker: ['linux-pi-gate.py'],
  boundary: ['linux-pi-gate.py', 'linux-workflow-gate.py', 'linux-isolation-probe-gate.mjs'],
};
const LANES = ['none', 'worker', 'boundary'];
const LANE_TEXT = {
  none: 'none: no hosted input changed',
  worker: 'worker-only',
  boundary: 'supervisor/bootstrap boundary',
  base: 'base image: refused',
};
const STEPS =
  'upload, preflight, build, gates, push, catalog, drain, deploy, verify, switch, canary';
const RUNS = '/opt/merv-typescript/hosted';
const SSH = ['-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=30'];
const within = (path, list) =>
  list.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p));
const digestOf = (image) => image.split('@')[1];

export function classify(changed, baseChanged = []) {
  if (baseChanged.length) return 'base';
  if (!changed.length) return 'none';
  return changed.some((p) => within(p, BOUNDARY_PATHS)) ? 'boundary' : 'worker';
}

/** The source lane, raised to the boundary when the image changed anything but the Pi worker. */
export function finalLane(sourceLane, build) {
  if (!build.changed.length && !build.configChanged) return 'none';
  const worker =
    !build.configChanged && build.changed.every((p) => p === '/opt/merv/pi/worker-main.mjs');
  return LANES[Math.max(LANES.indexOf(sourceLane), worker ? 1 : 2)];
}

export function releaseEntry(image, executableSha256) {
  const digest = /@(sha256:[0-9a-f]{64})$/.exec(image)?.[1];
  if (!digest || !/^[0-9a-f]{64}$/.test(executableSha256))
    throw new Error('A release needs a digest-pinned image and its executable hash');
  return {
    provider: 'cloudflare-fleet',
    image_digest: digest,
    executable: '/opt/merv/runtime/start-runner',
    executable_sha256: executableSha256,
    arguments: [],
    enrollment_timeout_seconds: 60,
  };
}

/** Exactly RuntimeRelease.release_id in merv-sandboxes; the catalog step also asks Sandboxes. */
export const releaseId = (e) =>
  `rt1_${sha256(
    JSON.stringify([
      'merv-runtime-release-v1',
      e.provider,
      e.image_digest,
      e.executable,
      e.executable_sha256,
      e.arguments,
      e.enrollment_timeout_seconds,
    ]),
  )}`;

export function wranglerConfig(template, image, workerMain) {
  if (!/^registry\.cloudflare\.com\/[a-z0-9/_-]+@sha256:[0-9a-f]{64}$/.test(image))
    throw new Error(`Not a digest-pinned registry image: ${image}`);
  const [container, ...rest] = template.containers;
  if (
    rest.length ||
    container.ssh?.enabled !== false ||
    container.authorized_keys?.length !== 0 ||
    container.trusted_user_ca_keys?.length !== 0
  )
    throw new Error('The template must hold one container with SSH off and no keys');
  return { ...template, main: workerMain, containers: [{ ...container, image }] };
}

/** How the live application differs from what this pipeline pins, and whether it has settled. */
export function drift(native, expect) {
  return [
    native.image !== expect.image && `image ${native.image}`,
    !(native.version >= expect.minVersion) && `version ${native.version} < ${expect.minVersion}`,
    native.name !== expect.name && `application ${native.name}`,
    native.maxInstances !== expect.maxInstances && `max_instances ${native.maxInstances}`,
    (native.ssh || native.keys) && 'SSH or keys configured',
  ].filter(Boolean);
}
export function unsettled(native, expect) {
  const counts = native.health?.instances ?? {};
  return [
    ...drift(native, expect),
    native.rollout && 'rollout in progress',
    JSON.stringify(native.health?.errors) !== '[]' && 'health errors',
    ...['failed', 'scheduling', 'starting']
      .filter((key) => counts[key] !== 0)
      .map((key) => `${key} ${counts[key]}`),
  ].filter(Boolean);
}

export function pinProblems(current, template, pre) {
  const [app] = template.containers;
  return [
    ...drift(pre.native, {
      image: current.image,
      minVersion: 1,
      name: app.name,
      maxInstances: app.max_instances,
    }),
    pre.mainReleaseId !== current.releaseId && `Main runs ${pre.mainReleaseId}`,
    pre.fileReleaseId !== current.releaseId && `the env file names ${pre.fileReleaseId}`,
    !pre.catalog.includes(digestOf(current.image)) && 'the Sandboxes catalog lacks the live digest',
  ].filter(Boolean);
}

/** What to undo, in order, after a failure; each step is idempotent. */
export function rollbackSteps(progress, previous) {
  const steps = [];
  if (progress.deployAttempted) steps.push(['deploy', previous.image]);
  if (progress.switched) steps.push(['switch', previous.releaseId]);
  if (steps.length) steps.push(['canary', previous.releaseId]);
  return steps;
}

export function ledgerRow(r) {
  const code = (v) => (v ? `\`${v}\`` : '—');
  const source = `${code(r.sourceCommit.slice(0, 8))} ${code(r.contentSha256?.slice(0, 12))}`;
  return `| ${r.at.slice(0, 16)}Z | ${code(r.run)} | ${source} | ${r.lane} | ${code(r.image && digestOf(r.image).slice(7, 19))} | ${code(r.releaseId?.slice(4, 16))} | ${r.version ? `v${r.version}` : '—'} | ${r.gates ?? '—'} | ${r.canary ?? '—'} | ${r.result} | ${(r.note ?? '').replace(/[|\n]/g, ' ')} |\n`;
}

export function describePlan(p) {
  const gated = GATES[p.lane];
  return [
    `hosted release ${p.run}`,
    `  deployed  ${p.current.sourceCommit.slice(0, 8)} as ${p.current.releaseId.slice(0, 16)}…`,
    `  HEAD      ${p.sourceCommit.slice(0, 8)}`,
    `  changed   ${p.changed.join(', ') || 'no hosted inputs'}`,
    `  lane      ${LANE_TEXT[p.lane]}`,
    ...(gated
      ? [
          `  gates     ${gated.join(', ')}, then a live canary Pi turn (the installed-file diff may raise the lane)`,
          `  steps     ${STEPS}; rollback after catalog`,
        ]
      : []),
  ].join('\n');
}

const BASE_REFUSAL =
  'The hosted base image changed (scripts/hosted-runner/Dockerfile or packages/pi/worker-runtime). ' +
  'This pipeline layers compiled files on a pinned base and does not rebuild it: build and push a ' +
  'new base with scripts/hosted-runner/package.mjs build, then pin it as "base" in deploy/hosted-release.json.';
const WRANGLER_ENV = {
  ...process.env,
  WRANGLER_WRITE_LOGS: 'false',
  WRANGLER_LOG_SANITIZE: 'true',
  WRANGLER_SEND_METRICS: 'false',
  CI: 'true',
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function main(args) {
  const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
  const host = opt('--host', 'ResearchSuite_Control');
  const statePath = join(root, 'deploy/hosted-release.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const template = JSON.parse(readFileSync(join(root, 'deploy/hosted-wrangler.json'), 'utf8'));
  const [app] = template.containers;
  const sandboxes = resolve(opt('--sandboxes', join(root, '../output/fleet-sandboxes')));
  const wrangler = resolve(
    opt(
      '--wrangler',
      join(root, '../output/fleet-cloudflare-tools/node_modules/wrangler/bin/wrangler.js'),
    ),
  );
  const canary = {
    ...state.canary,
    credential: opt('--canary-credential', state.canary.credential),
  };
  const stamp = new Date().toISOString().replace(/[-:]|\.\d+/g, '');
  const git = (a) => sh('git', a).trim();
  const prettier = (file) =>
    execFileSync('npx', ['prettier', '--write', file], { cwd: root, stdio: 'ignore' });

  const onHost = (run, step, input = {}) => {
    const dir = `${RUNS}/${run}`;
    const script = `${dir}/source/deploy/hosted-release-vm.py`;
    const r = spawnSync('ssh', [...SSH, host, 'sudo', '-n', 'python3', script, step, dir], {
      input: JSON.stringify(input),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'inherit'],
      maxBuffer: 64 << 20,
    });
    let out;
    try {
      out = JSON.parse(r.stdout.trim().split('\n').pop());
    } catch {
      out = { error: `no result (ssh exit ${r.status})` };
    }
    if (r.status !== 0 || out.error) throw new Error(`${step}: ${out.error ?? 'failed'}`);
    return out;
  };
  const upload = (run) => {
    const src = packageSource();
    const dir = `${RUNS}/${run}`;
    const inbox = `merv-hosted-${run}`;
    execFileSync('ssh', [...SSH, host, `mkdir -p ~/${inbox}`]);
    execFileSync('scp', ['-q', join(src.dir, 'source.tar.gz'), `${host}:${inbox}/`]);
    execFileSync('ssh', [...SSH, host, 'sudo', 'bash', '-s'], {
      input: `set -euo pipefail
mkdir -p -m 700 ${RUNS} && mkdir -m 700 ${dir}
mv ~azureuser/${inbox}/source.tar.gz ${dir}/ && rmdir ~azureuser/${inbox}
echo "${src.archiveSha256}  ${dir}/source.tar.gz" | sha256sum -c - >/dev/null
mkdir ${dir}/source && tar -xzf ${dir}/source.tar.gz -C ${dir}/source --no-same-owner
`,
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    return src;
  };

  if (args.includes('--mint-canary')) {
    const run = `${stamp}-canary`;
    upload(run);
    console.log(JSON.stringify(onHost(run, 'mint_canary', { canary })));
    return 0;
  }

  // wrangler deploy also uploads the bridge Worker, so it must be committed code.
  const workerSource = () => {
    const workerDir = dirname(dirname(template.main));
    if (git(['-C', sandboxes, 'status', '--porcelain', '--', workerDir]))
      throw new Error(`The Cloudflare Worker in ${sandboxes}/${workerDir} has uncommitted changes`);
    return git(['-C', sandboxes, 'rev-parse', '--short', 'HEAD']);
  };
  let run = opt('--resume');
  let plan, pre, build, gates, pushed, progress, finished, worker;
  if (run) {
    worker = workerSource();
    ({
      plan,
      preflight: pre,
      build,
      gates,
      push: pushed,
      progress = {},
      finish: finished,
    } = onHost(run, 'status'));
    if (finished || !pre)
      throw new Error(`hosted run ${run} is finished or never passed preflight`);
  } else {
    const head = git(['rev-parse', 'HEAD']);
    const diff = (from, paths) =>
      git(['diff', '--name-only', '--relative', from, head, '--', ...paths]);
    const changed = diff(state.current.sourceCommit, [...state.inputs, ...ALWAYS])
      .split('\n')
      .filter(Boolean);
    const baseChanged = diff(state.base.sourceCommit, BASE_PATHS).split('\n').filter(Boolean);
    run = `${stamp}-${head.slice(0, 8)}`;
    plan = {
      run,
      sourceCommit: head,
      changed,
      lane: classify(changed, baseChanged),
      current: state.current,
      base: state.base,
      canary,
      nodeImage: NODE_IMAGE,
      drainSeconds: Number(opt('--drain-minutes', '15')) * 60,
    };
    console.log(describePlan(plan));
    if (args.includes('--dry-run') || plan.lane === 'none') return 0;
    if (plan.lane === 'base') throw new Error(BASE_REFUSAL);
    worker = workerSource();
    const src = upload(run);
    if (src.gitRevision !== head) throw new Error('HEAD moved while planning; rerun');
    plan.contentSha256 = src.contentSha256;
    pre = onHost(run, 'preflight', plan);
    const problems = pinProblems(state.current, template, pre);
    if (problems.length) {
      onHost(run, 'finish');
      throw new Error(`Live pins differ from deploy/hosted-release.json: ${problems.join('; ')}`);
    }
    progress = {};
  }
  const previous = plan.current;
  const { sourceCommit, contentSha256, lane } = plan;
  const row = { at: new Date().toISOString(), run, sourceCommit, contentSha256, lane };
  // The ledger is committed: a note keeps each step's reason, never a command's output.
  const brief = (message) => message.split(' :: ')[0].slice(0, 300);
  const record = (result, ...notes) => {
    const note = notes.map(brief).join('; ');
    appendFileSync(join(root, 'deploy/HOSTED_RELEASES.md'), ledgerRow({ ...row, result, note }));
    prettier('deploy/HOSTED_RELEASES.md');
  };
  const save = (current, inputs) => {
    writeFileSync(statePath, JSON.stringify({ ...state, current, inputs }, null, 2));
    prettier('deploy/hosted-release.json');
  };
  const config = (image) => {
    const path = join(mkdtempSync(join(tmpdir(), 'merv-hosted-')), 'wrangler.json');
    writeFileSync(
      path,
      JSON.stringify(wranglerConfig(template, image, join(sandboxes, template.main))),
    );
    return path;
  };
  const wranglerRun = (a) =>
    spawnSync(process.execPath, [wrangler, ...a], {
      env: WRANGLER_ENV,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  // Until the catalog step nothing in production has changed, so a failure only ends the run.
  try {
    build ??= onHost(run, 'build');
    row.lane = finalLane(plan.lane, build);
    if (row.lane === 'none') {
      onHost(run, 'finish');
      save({ ...previous, sourceCommit: plan.sourceCommit }, build.inputs);
      console.log('The hosted image is current: its installed files match the deployed image.');
      return 0;
    }
    gates ??= onHost(run, 'gates', { gates: GATES[row.lane] });
    row.gates = `${Object.keys(gates).length} pass`;
    if (!pushed) {
      const mint = 'containers registries credentials registry.cloudflare.com --push --pull';
      const r = wranglerRun([
        ...`${mint} --expiration-minutes 30 --json -c`.split(' '),
        config(previous.image),
      ]);
      if (r.status !== 0)
        throw new Error(`wrangler minted no registry credential: ${r.stderr.slice(-400)}`);
      const { username, password } = JSON.parse(r.stdout);
      pushed = onHost(run, 'push', { credential: { username, password } });
    }
  } catch (error) {
    onHost(run, 'finish');
    record('FAILED', error.message, 'nothing changed');
    console.error(`hosted release stopped before any change: ${error.message}`);
    return 1;
  }
  const entry = releaseEntry(pushed.image, build.executableSha256);
  const next = { image: pushed.image, releaseId: releaseId(entry), localId: build.candidate };
  Object.assign(row, { image: next.image, releaseId: next.releaseId });

  const settle = async (image, minVersion) => {
    const expect = { image, minVersion, name: app.name, maxInstances: app.max_instances };
    let last, stable;
    for (const deadline = Date.now() + 10 * 60_000; Date.now() < deadline; await sleep(10_000)) {
      last = onHost(run, 'native');
      if (!unsettled(last, expect).length && stable?.version === last.version) return last;
      stable = unsettled(last, expect).length ? undefined : last;
    }
    throw new Error(`Cloudflare did not settle on ${image}: ${unsettled(last, expect).join('; ')}`);
  };
  const deploy = async (image, minVersion) => {
    if (onHost(run, 'native').image !== image) {
      const path = config(image);
      const r = wranglerRun([
        'deploy',
        '--keep-vars',
        '--containers-rollout=immediate',
        '-c',
        path,
      ]);
      writeFileSync(`${path}.log`, `${r.stdout}${r.stderr}`);
      if (r.status !== 0) throw new Error(`wrangler deploy exited ${r.status}; log ${path}.log`);
    }
    return await settle(image, minVersion);
  };

  const canaryOn = (releaseId) => {
    try {
      return onHost(run, 'canary', { releaseId }).status;
    } catch (error) {
      return `failed too (${brief(error.message)})`;
    }
  };
  let failure = progress.rollback;
  if (!failure) {
    try {
      onHost(run, 'catalog', {
        entry,
        releaseId: next.releaseId,
        protect: [digestOf(previous.image)],
      });
      onHost(run, 'drain');
      progress = onHost(run, 'note', { deployAttempted: true });
      row.version = (await deploy(next.image, pre.native.version + 1)).version;
      progress = onHost(run, 'note', { switched: true });
      onHost(run, 'switch', { releaseId: next.releaseId });
      const turn = onHost(run, 'canary', { releaseId: next.releaseId });
      row.canary = `${turn.status} in ${turn.seconds}s`;
    } catch (error) {
      failure = error.message;
    }
  }
  if (failure) {
    console.error(`hosted release failed: ${failure}`);
    let outcome = 'nothing to roll back';
    const steps = rollbackSteps(progress, previous);
    try {
      if (steps.length) onHost(run, 'note', { rollback: failure.slice(0, 1000) });
      for (const [step, value] of steps) {
        if (step === 'deploy') await deploy(value, pre.native.version);
        else if (step === 'switch') onHost(run, 'switch', { releaseId: value, wait: false });
        else outcome = `rolled back and verified; canary ${canaryOn(value)}`;
      }
    } catch (error) {
      // The run stays open, so Main releases stay blocked until the pins agree again.
      record('ROLLBACK FAILED', failure, error.message);
      console.error(
        `ROLLBACK INCOMPLETE: ${error.message}. Retry: node deploy/hosted-release.mjs --resume ${run}`,
      );
      return 3;
    }
    onHost(run, 'finish');
    record('FAILED', failure, outcome);
    console.error(`hosted release ${run}: ${outcome}`);
    return 1;
  }
  onHost(run, 'finish');
  record('pass', `Worker ${worker}`);
  save({ ...next, sourceCommit: plan.sourceCommit }, build.inputs);
  console.log(JSON.stringify({ run, ...next, version: row.version, canary: row.canary }));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

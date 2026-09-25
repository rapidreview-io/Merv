#!/usr/bin/env node
// Release the hosted Pi/Codex worker image with one guarded command, from the founder's Mac:
//   node deploy/hosted-release.mjs [--dry-run] [--resume] [--host ResearchSuite_Control]
//        [--drain-minutes 15] [--canary-credential <root-only path on the host>]
//        [--sandboxes <main checkout>/output/fleet-sandboxes] [--wrangler <path to wrangler.js>]
//   node deploy/hosted-release.mjs --mint-canary   (once: the canary's root-only reader key)
//   node deploy/hosted-release.mjs --abandon   (closes a stuck run once production agrees on one
//        of its releases: Cloudflare runs its image, Main names it, the Sandboxes catalog holds it;
//        its own release is canaried first, and one that fails stays the live pins as unverified)
// release.mjs finishes any open run before a production release and starts one after it. The
// image is pinned in three places that move together: every Cloudflare container app serving one
// of Main's machines (APPS: Standard, and Large once MERV_FLEET_RUNTIMES names it), the Sandboxes
// release catalog (control and pipelines-worker; Standard's entry and its copy for each other app,
// only the provider changed) and Main's release ids (each machine's in MERV_FLEET_RUNTIMES, and
// Standard's in the legacy MERV_FLEET_RUNTIME_RELEASE_ID). The host keeps the live pins and the
// open run; deploy/hosted-release.json seeds and records the pins and deploy/HOSTED_RELEASES.md
// logs each run, both committed by path and pushed when this checkout is at origin/main's tip.
//  1 plan: hosted inputs changed since the deployed commits, in Merv and in the Sandboxes checkout
//    (the sandbox base, its agent, the bridge Worker), pick a lane: worker-only or the
//    supervisor/bootstrap boundary. No change ends the run, unless the live release is unverified,
//    and --dry-run always stops here.
//  2 build on the host from archives of both committed HEADs: the sandbox base, the compiled
//    bundle (worker tests included), then scripts/hosted-runner/Dockerfile. The host diffs the whole
//    image against the deployed one: anything beyond the Pi worker bundle is the boundary, and an
//    identical image ends the run, after a canary if the live release is unverified.
//  3 gates, chosen on the host from its lane: linux-pi-gate; the boundary adds the workflow gate
//    and the isolation probe. A failure stops with nothing changed.
//  4 push with a 30-minute registry credential minted by the local wrangler and piped over ssh
//    stdin into docker login (tmpfs config, logged out after); pin the amd64 manifest digest.
//  5 catalog: add the release to both Sandboxes services, keeping earlier releases.
//  6 drain until no Pi turn or launch is in flight, deploy each live app from its template at HEAD
//    with the new digest and the Sandboxes commit's bridge Worker, and switch Main's release ids as
//    soon as Cloudflare runs the new image everywhere: until then Sandboxes refuses Pi launches.
//  7 verify each app natively (settled health, SSH off), then a canary: one real Pi turn on
//    Standard as a root-only reader key, whose machine it then releases.
// No run starts, and no open run is driven forward, unless a rollback could run from here: the
// deployed Sandboxes commit's bridge Worker is in the checkout and wrangler is signed in. A failure
// after 5 rolls back automatically, in the same order (previous digest and Worker on every app,
// previous release ids), and checks that with a canary. A real run detaches from the terminal and
// keeps the Mac awake; a later run, or release.mjs, finishes an open run first, rolling it back if
// the pipeline changed meanwhile. A host out of reach is waited out for 10 minutes, and while this
// Mac is silent mid-deploy a host timer, which a reboot keeps, points Main at whatever Cloudflare
// runs. Exit: 0 released, abandoned or nothing to do; 1 failed with production unchanged or rolled
// back; 2 refused; 3 a run is left open; 4 closed, but the release left live failed its canary.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NODE_IMAGE, packageSource, publishLedgers, root, sh, sha256 } from './source-archive.mjs';

// Merv paths, relative to merv-typescript, watched besides the last build's bundle inputs: the
// payload and the build recipe (the host's Dockerfiles, Go image and worker tests; NODE_IMAGE and
// the archive; the TypeScript settings). The host's image diff then decides the lane.
export const WATCH = [
  'scripts/hosted-runner/',
  'packages/runner/src/supervisor.mjs',
  'packages/pi/worker-runtime/',
  'package-lock.json',
  'deploy/hosted-release-vm.py',
  'deploy/source-archive.mjs',
  'tsconfig.json',
];
export const BOUNDARY = [
  'scripts/hosted-runner/Dockerfile',
  'scripts/hosted-runner/start-runtime.py',
  'scripts/hosted-runner/assignment-probed.py',
  'scripts/hosted-runner/isolation_probe.py',
  'scripts/hosted-runner/build.mjs',
  'scripts/hosted-runner/smoke-supervisor.ts',
  'packages/runner/src/supervisor.mjs',
  'packages/pi/worker-runtime/',
];
// In the Sandboxes checkout: the sandbox base, its agent and the bridge Worker, all boundary.
export const SANDBOXES = [
  'agent',
  'deploy/cloudflare-sandbox',
  'control/src/merv_sandboxes/__init__.py',
  'control/src/merv_sandboxes/errors.py',
  'control/src/merv_sandboxes/runtimes',
];
// Each Cloudflare app that may serve one of Main's machines, by its Sandboxes provider, and the
// template it is deployed from; the host reads which are live from Main. A template names its app
// as wrangler did when it was created (Large: `wrangler deploy --env large` appends `-large`).
export const APPS = {
  'cloudflare-fleet': 'deploy/hosted-wrangler.json',
  'cloudflare-fleet-large': 'deploy/hosted-wrangler-large.json',
};
const STANDARD = 'cloudflare-fleet';
// What this Mac runs or reads besides the archive; it must equal HEAD.
const PIPELINE = [
  'deploy/hosted-release.mjs',
  'deploy/hosted-release-vm.py',
  'deploy/source-archive.mjs',
  ...Object.values(APPS),
];
// For the plan text; the host runs its own LANE_GATES, which a test keeps equal to these.
export const GATES = {
  worker: ['linux-pi-gate.py'],
  boundary: ['linux-pi-gate.py', 'linux-workflow-gate.py', 'linux-isolation-probe-gate.mjs'],
};
export const LEASE = 300; // seconds; as in hosted-release-vm.py
const LANE_TEXT = {
  none: 'none: no hosted input changed',
  worker: 'worker-only',
  boundary: 'supervisor/bootstrap boundary',
};
const STEPS = 'build, gates, push, catalog, drain, deploy each live app, switch, verify, canary';
const RUNS = '/opt/merv-typescript/hosted';
const HOME = '/var/lib/merv-fleet-pilot/hosted-release';
const SSH = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=30'];
// Tests record elsewhere and poll faster.
const RECORDS = process.env.MERV_HOSTED_RECORDS ?? join(root, 'deploy');
const POLL = Number(process.env.MERV_HOSTED_POLL_MS ?? 10_000);
const within = (path, list) =>
  list.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p));
const digestOf = (image) => image.split('@')[1];
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
// What the host's switch takes: Standard's release id, and each live app's.
const pins = ({ releaseId, releases }) => ({ releaseId, releases });

/** null means the deployed commit is unknown here, which counts as a boundary change. */
export function classify(changed, sandboxChanged) {
  if (changed === null || sandboxChanged === null || sandboxChanged.length) return 'boundary';
  if (!changed.length) return 'none';
  return changed.some((p) => within(p, BOUNDARY)) ? 'boundary' : 'worker';
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

/** Each live app runs the live image, Main and the env file name its releases, the catalog has them. */
export function pinProblems(current, templates, pre) {
  const held = ([provider, id]) =>
    pre.catalog.some(
      (r) => r.provider === provider && r.id === id && r.digest === digestOf(current.image),
    );
  return [
    ...Object.entries(pre.apps).flatMap(([provider, native]) => {
      const [app] = templates[provider]?.containers ?? [];
      if (!app) return [`no template deploys ${provider}`];
      const expect = { image: current.image, minVersion: 1, name: app.name };
      const problems = drift(native, { ...expect, maxInstances: app.max_instances });
      return problems.map((problem) => `${provider} ${problem}`);
    }),
    ...new Set(
      [pre.mainReleaseId, pre.releases[STANDARD]]
        .filter((id) => id !== current.releaseId)
        .map((id) => `Main runs ${id}`),
    ),
    pre.fileReleaseId !== current.releaseId && `the env file names ${pre.fileReleaseId}`,
    JSON.stringify(pre.fileReleases) !== JSON.stringify(pre.releases) &&
      'the env file names other machine releases than Main runs',
    ...Object.entries(pre.releases)
      .filter((release) => !held(release))
      .map(([provider]) => `the Sandboxes catalog lacks ${provider}'s live release`),
  ].filter(Boolean);
}

/** What to undo, in order, after a failure; each step is idempotent, so a resume repeats them. */
export function rollbackSteps(progress, previous) {
  return [
    ...(progress.catalogBroken ? [['catalog']] : []),
    ...(progress.deployAttempted
      ? [
          ['deploy', previous],
          ['switch', pins(previous)],
          ['settle', previous.image],
          ['canary', previous.releaseId],
        ]
      : []),
  ];
}

export function ledgerRow(r) {
  const code = (v) => (v ? `\`${v}\`` : '—');
  const source = `${code(r.sourceCommit.slice(0, 8))} ${code(r.contentSha256?.slice(0, 12))}`;
  const versions = [r.version ?? []].flat().map((v) => `v${v}`); // each live app's, Standard's first
  return `| ${r.at.slice(0, 16)}Z | ${code(r.run)} | ${source} | ${r.lane} | ${code(r.image && digestOf(r.image).slice(7, 19))} | ${code(r.releaseId?.slice(4, 16))} | ${versions.join(' ') || '—'} | ${r.gates ?? '—'} | ${r.canary ?? '—'} | ${r.result} | ${(r.note ?? '').replace(/[|\n]/g, ' ')} |\n`;
}

export function describePlan(p) {
  const list = (paths) => (paths ? paths.join(', ') || 'nothing' : 'unknown to this checkout');
  const at = (merv, sandboxes) =>
    `${merv.slice(0, 8)} + Sandboxes ${sandboxes?.slice(0, 8) ?? '?'}`;
  return [
    `hosted release ${p.run}`,
    `  deployed  ${at(p.current.sourceCommit, p.current.sandboxesCommit)} as ${p.current.releaseId.slice(0, 16)}…${p.current.verified === false ? ' UNVERIFIED: it failed its canary' : ''}`,
    `  HEAD      ${at(p.sourceCommit, p.sandboxesCommit)}`,
    `  changed   ${list(p.changed)}`,
    `  sandboxes ${list(p.sandboxChanged)}`,
    `  lane      ${LANE_TEXT[p.lane]}`,
    ...(p.lane === 'none'
      ? p.current.verified === false
        ? ['  steps     build; an identical image gets a live canary Pi turn as deployed']
        : []
      : [
          `  gates     ${GATES[p.lane].join(', ')}, then a live canary Pi turn (the host's image diff may raise the lane)`,
          `  steps     ${STEPS}; rollback after catalog`,
        ]),
  ].join('\n');
}

/** A real run outlives its terminal (and, on macOS, idle sleep); this process only follows it. */
async function detached(args) {
  const log = join(mkdtempSync(join(tmpdir(), 'merv-hosted-')), 'run.log');
  const out = openSync(log, 'a');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], {
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, MERV_HOSTED_DRIVER: '1' },
  });
  if (process.platform === 'darwin')
    spawn('caffeinate', ['-i', '-w', String(child.pid)], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  console.log(
    `(pid ${child.pid}, log ${log}; closing this terminal or Ctrl-C only stops following)`,
  );
  let shown = 0;
  const follow = () => {
    const text = readFileSync(log);
    process.stdout.write(text.subarray(shown));
    shown = text.length;
  };
  const timer = setInterval(follow, 500);
  const code = await new Promise((done) => child.on('exit', (status) => done(status ?? 3)));
  clearInterval(timer);
  follow();
  return code;
}

async function main(args) {
  const opt = (k, d) => {
    const value = args[args.indexOf(k) + 1];
    return args.includes(k) && value && !value.startsWith('--') ? value : d;
  };
  const dryRun = args.includes('--dry-run');
  if (!dryRun && !process.env.MERV_HOSTED_DRIVER) return detached(args);
  const host = opt('--host', 'ResearchSuite_Control');
  const git = (a, cwd = root) => sh('git', a, cwd).trim();
  // The defaults sit in the main checkout, which a worktree shares its Git directory with.
  const checkout = dirname(resolve(root, git(['rev-parse', '--git-common-dir'])));
  const sandboxes = resolve(opt('--sandboxes', join(checkout, 'output/fleet-sandboxes')));
  const wrangler = resolve(
    opt(
      '--wrangler',
      join(checkout, 'output/fleet-cloudflare-tools/node_modules/wrangler/bin/wrangler.js'),
    ),
  );
  const head = git(['rev-parse', 'HEAD']);
  const atHead = (path) => JSON.parse(git(['show', `${head}:./${path}`]));
  const seed = atHead('deploy/hosted-release.json');
  const templates = Object.fromEntries(Object.entries(APPS).map(([p, file]) => [p, atHead(file)]));
  const template = templates[STANDARD]; // every app runs the same bridge Worker
  const bridge = dirname(dirname(template.main)); // the bridge Worker's directory in Sandboxes
  const canary = { ...seed.canary, credential: opt('--canary-credential', seed.canary.credential) };
  const driver = randomUUID();
  const stamp = () => new Date().toISOString().replace(/[-:]|\.\d+/g, '');
  const ssh = (argv, input) =>
    spawnSync('ssh', [...SSH, host, ...argv], {
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'inherit'],
      maxBuffer: 64 << 20,
    });
  // A host out of reach (a reboot, a network blip) is waited out for about 10 minutes, never taken
  // for a failed step: a repeated step is harmless, and the next one re-arms the host's guard.
  const onHost = (run, step, arg = {}) => {
    const dir = `${RUNS}/${run}`;
    const script = `${dir}/source/deploy/hosted-release-vm.py`;
    let r;
    for (let wait = POLL, until = Date.now() + 60 * POLL; ; wait = Math.min(2 * wait, 6 * POLL)) {
      r = ssh(['sudo', '-n', 'python3', script, step, dir], JSON.stringify({ driver, arg }));
      if (r.status !== 255 || Date.now() > until) break;
      console.error(`${step}: ${host} is out of reach (ssh exit 255); retrying`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
    }
    let out;
    try {
      out = JSON.parse(r.stdout.trim().split('\n').pop());
    } catch {
      out = { error: `no result (ssh exit ${r.status})` };
    }
    if (r.status !== 0 || out.error) throw new Error(`${step}: ${out.error ?? 'failed'}`);
    return out;
  };
  const hostNow = () => {
    const r = ssh(
      ['sudo', '-n', 'python3', '-'],
      `import json,pathlib
h=pathlib.Path('${HOME}')
read=lambda n:(h/n).read_text().strip() if (h/n).exists() else None
print(json.dumps({'state':json.loads(read('state.json') or 'null'),'active':read('active')}))`,
    );
    if (r.status !== 0)
      throw new Error(`cannot read the hosted state on ${host} (ssh exit ${r.status})`);
    return JSON.parse(r.stdout);
  };
  const upload = (run, sandboxesCommit) => {
    const src = packageSource();
    const sbx = join(src.dir, 'sandboxes.tar.gz');
    execFileSync('git', [
      '-C',
      sandboxes,
      'archive',
      '--format=tar.gz',
      '-o',
      sbx,
      sandboxesCommit,
      '--',
      ...SANDBOXES,
    ]);
    const dir = `${RUNS}/${run}`;
    const inbox = `merv-hosted-${run}`;
    execFileSync('ssh', [...SSH, host, `mkdir -p ~/${inbox}`]);
    execFileSync('scp', ['-q', join(src.dir, 'source.tar.gz'), sbx, `${host}:${inbox}/`]);
    execFileSync('ssh', [...SSH, host, 'sudo', 'bash', '-s'], {
      input: `set -euo pipefail
mkdir -p -m 700 ${RUNS} && mkdir -m 700 ${dir}
mv ~azureuser/${inbox}/source.tar.gz ~azureuser/${inbox}/sandboxes.tar.gz ${dir}/ && rmdir ~azureuser/${inbox}
cd ${dir} && printf '%s  source.tar.gz\\n%s  sandboxes.tar.gz\\n' ${src.archiveSha256} ${sha256(readFileSync(sbx))} | sha256sum -c - >/dev/null
umask 022 # git archive's files are group-writable; the gates mount them into the image
mkdir source sandboxes
tar -xzf source.tar.gz -C source --no-same-owner --no-same-permissions
tar -xzf sandboxes.tar.gz -C sandboxes --no-same-owner --no-same-permissions
`,
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    return src;
  };
  const sandboxesHead = () => {
    if (!existsSync(join(sandboxes, '.git')))
      throw new Error(`No Sandboxes checkout at ${sandboxes}; pass --sandboxes <path>`);
    return git(['rev-parse', 'HEAD'], sandboxes);
  };
  const clean = () => {
    const dirty = git(['status', '--porcelain', '--', ...PIPELINE]);
    if (dirty)
      console.error(`The hosted release pipeline differs from HEAD; commit it first:\n${dirty}`);
    return !dirty;
  };
  // A deploy ends, or is killed, before its driver's lease could be taken over.
  const wranglerRun = (a, cwd) =>
    spawnSync(process.execPath, [wrangler, ...a], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: (LEASE - 60) * 1000,
      env: {
        ...process.env,
        WRANGLER_WRITE_LOGS: 'false',
        WRANGLER_LOG_SANITIZE: 'true',
        WRANGLER_SEND_METRICS: 'false',
        CI: 'true',
      },
    });
  // Why a rollback to `previous` could not run from here, if it could not: it redeploys the bridge
  // Worker of the deployed Sandboxes commit, entered at this template's main, with this wrangler.
  const unready = ({ sandboxesCommit }) => {
    const at = `${sandboxesCommit}^{commit}:${template.main}`;
    const entry = spawnSync('git', ['-C', sandboxes, 'cat-file', '-t', at], { encoding: 'utf8' });
    if (entry.stdout?.trim() !== 'blob')
      return `a rollback needs ${template.main} at the deployed Sandboxes commit, and ${sandboxesCommit?.slice(0, 8)} has none in ${sandboxes}`;
    const who = wranglerRun(['whoami', '--json']);
    return who.status === 0
      ? null
      : `a rollback needs ${wrangler}, signed in (whoami exit ${who.status})`;
  };

  if (args.includes('--mint-canary')) {
    if (!clean()) return 2;
    const run = `${stamp()}-canary`;
    upload(run, sandboxesHead());
    console.log(JSON.stringify(onHost(run, 'mint_canary', { canary })));
    return 0;
  }
  let live;
  try {
    live = hostNow();
  } catch (error) {
    if (!dryRun) throw error;
    console.log(`(${error.message}; planning from deploy/hosted-release.json at HEAD)`);
    live = { state: null, active: null };
  }
  const mode = args.includes('--abandon') ? 'abandon' : 'resume';
  if (live.active) {
    const doing = { abandon: 'abandoning it', resume: 'finishing it' }[mode];
    console.log(
      `hosted run ${live.active} is open; ${dryRun ? 'a real run finishes it first' : doing}`,
    );
    return dryRun ? 0 : clean() ? await drive(live.active, mode) : 2;
  }
  if (args.includes('--resume') || mode === 'abandon') {
    console.log('No hosted run is open.');
    return 0;
  }
  const { current, inputs } = live.state ?? seed;
  const since = (from, to, paths, cwd) =>
    from && spawnSync('git', ['-C', cwd, 'cat-file', '-e', `${from}^{commit}`]).status === 0
      ? git(['diff', '--name-only', '--relative', from, to, '--', ...paths], cwd)
          .split('\n')
          .filter(Boolean)
      : null;
  const sandboxesCommit = sandboxesHead();
  const changed = since(current.sourceCommit, head, [...inputs, ...WATCH], root);
  const sandboxChanged = since(current.sandboxesCommit, sandboxesCommit, SANDBOXES, sandboxes);
  const run = `${stamp()}-${head.slice(0, 8)}`;
  const plan = {
    run,
    sourceCommit: head,
    sandboxesCommit,
    changed,
    sandboxChanged,
    lane: classify(changed, sandboxChanged),
    current,
    canary,
    nodeImage: NODE_IMAGE,
    drainSeconds: Number(opt('--drain-minutes', '15')) * 60,
  };
  console.log(describePlan(plan));
  if (dryRun && plan.lane !== 'none') {
    const why = unready(current);
    if (why) console.log(`A real run would refuse: ${why}.`);
  }
  if (dryRun || (plan.lane === 'none' && current.verified !== false)) return 0;
  if (!clean()) return 2;
  const why = unready(current);
  if (why) {
    console.error(`hosted release refused, nothing changed: ${why}`);
    return 2;
  }
  const src = upload(run, sandboxesCommit);
  if (src.gitRevision !== head) {
    console.error('HEAD moved while planning; rerun');
    return 2;
  }
  plan.contentSha256 = src.contentSha256;
  try {
    const problems = pinProblems(current, templates, onHost(run, 'preflight', plan));
    if (problems.length)
      throw new Error(`Live pins differ from the host's record: ${problems.join('; ')}`);
  } catch (error) {
    onHost(run, 'finish', { result: 'refused' });
    console.error(`hosted release refused, nothing changed: ${error.message}`);
    return 2;
  }
  return drive(run);

  async function drive(run, mode) {
    try {
      return await driveRun(run, mode);
    } catch (error) {
      console.error(`hosted run ${run} stopped: ${error.message}. The next run finishes it.`);
      return 3;
    } finally {
      const ledgers = ['HOSTED_RELEASES.md', 'hosted-release.json'].map((f) => join(RECORDS, f));
      publishLedgers(ledgers, `Record hosted image run ${run} in production`);
    }
  }

  // mode: undefined for a run this process opened, 'resume' or 'abandon' for an open one.
  async function driveRun(run, mode) {
    let s = onHost(run, 'status');
    // Another process drives it while its lease is fresh: wait for it to finish or fall silent.
    for (const until = Date.now() + 45 * 60_000; !s.finish && s.lease?.driver !== driver;) {
      if (s.leaseAge === null || s.leaseAge >= LEASE) break;
      if (Date.now() > until) throw new Error('another process still drives it after 45 minutes');
      console.log(`hosted run ${run} is driven by another process; waiting`);
      await sleep(3 * POLL);
      s = onHost(run, 'status');
    }
    if (s.finish) {
      console.log(`hosted run ${run} finished: ${s.finish.result}`);
      return ['pass', 'current'].includes(s.finish.result) ? 0 : 1;
    }
    const { plan, preflight: pre } = s;
    let { build, gates, push: pushed, progress = {} } = s;
    if (!pre) {
      onHost(run, 'finish', { result: 'refused' });
      console.error(`hosted run ${run} never passed preflight; closed, nothing changed`);
      return 1;
    }
    // The live apps and Main's machine releases as preflight read them; a run from before Large
    // knew only Standard.
    const apps = pre.apps ?? { [STANDARD]: pre.native };
    const providers = Object.keys(apps);
    const previous = { ...plan.current, releases: pre.releases };
    const commits = { sourceCommit: plan.sourceCommit, sandboxesCommit: plan.sandboxesCommit };
    const row = {
      at: new Date().toISOString(),
      run,
      sourceCommit: plan.sourceCommit,
      contentSha256: plan.contentSha256,
      lane: build?.lane ?? plan.lane,
    };
    const brief = (message) => message.split(' :: ')[0].slice(0, 300);
    const prettier = (file) =>
      spawnSync('npx', ['prettier', '--write', file], { cwd: root, stdio: 'ignore' });
    // The ledger is committed: a note keeps each step's reason, never a command's output.
    const record = (result, ...notes) => {
      const file = join(RECORDS, 'HOSTED_RELEASES.md');
      const note = notes.filter(Boolean).map(brief).join('; ');
      appendFileSync(file, ledgerRow({ ...row, result, note }));
      prettier(file);
    };
    const close = (result, state) => {
      onHost(run, 'finish', { result, state });
      if (!state) return;
      const file = join(RECORDS, 'hosted-release.json');
      writeFileSync(file, JSON.stringify({ canary: seed.canary, ...state }, null, 2));
      prettier(file);
    };
    const config = (provider, image, workerMain = template.main) => {
      const path = join(mkdtempSync(join(tmpdir(), 'merv-hosted-')), 'wrangler.json');
      writeFileSync(path, JSON.stringify(wranglerConfig(templates[provider], image, workerMain)));
      return path;
    };
    // The bridge Worker is the one in the target's Sandboxes commit, never a working tree. Each note
    // first proves this driver still holds the run, so a takeover never meets a stale deploy.
    const deploy = (target, which, note = {}) => {
      const worker = mkdtempSync(join(tmpdir(), 'merv-hosted-worker-'));
      const tar = join(worker, 'worker.tar');
      execFileSync('git', ['-C', sandboxes, 'archive', '-o', tar, target.sandboxesCommit, bridge]);
      execFileSync('tar', ['-xf', tar, '-C', worker]);
      for (const provider of which) {
        const path = config(provider, target.image, join(worker, template.main));
        onHost(run, 'note', note);
        const r = wranglerRun(
          ['deploy', '--keep-vars', '--containers-rollout=immediate', '-c', path],
          dirname(path),
        );
        writeFileSync(`${path}.log`, `${r.stdout}${r.stderr}`);
        if (r.status !== 0)
          throw new Error(`wrangler deploy of ${provider} exited ${r.status}; log ${path}.log`);
      }
    };
    // Cloudflare's own view of each live app in turn, polled at most 60 times: `landed` once it
    // runs the image (Main may name its release at once), otherwise settled, twice in a row at one
    // version; `raise` over the app's version at preflight. Resolves to the apps' versions.
    const poll = async (landed, image, raise) => {
      const versions = [];
      for (const provider of providers) {
        const [app] = templates[provider].containers;
        const minVersion = apps[provider].version + raise;
        const expect = { image, minVersion, name: app.name, maxInstances: app.max_instances };
        const pending = landed ? drift : unsettled;
        let last, stable;
        for (const until = Date.now() + 60 * POLL; ; await sleep(POLL)) {
          last = onHost(run, 'native', { provider });
          if (!pending(last, expect).length && (landed || stable?.version === last.version)) break;
          stable = pending(last, expect).length ? undefined : last;
          if (Date.now() > until)
            throw new Error(
              `${provider} did not ${landed ? 'take' : 'settle on'} ${image}: ${pending(last, expect).join('; ')}`,
            );
        }
        versions.push(last.version);
      }
      return versions;
    };
    const landed = (image, raise = 0) => poll(true, image, raise);
    const settle = (image, raise = 0) => poll(false, image, raise);
    // Closes the run on a live release no canary has passed: it becomes the live pins either way,
    // but one whose canary fails is marked unverified, and the next run canaries it again.
    const closeCanaried = ({ verified, ...current }, result, note) => {
      Object.assign(row, { image: current.image, releaseId: current.releaseId });
      let failed;
      try {
        const turn = onHost(run, 'canary', { releaseId: current.releaseId });
        row.canary = `${turn.status} in ${turn.seconds}s`;
      } catch (error) {
        failed = error.message;
        current.verified = false;
      }
      close(failed ? `${result}, canary failed` : result, { current, inputs: build.inputs });
      record(failed ? `${result.toUpperCase()}, CANARY FAILED` : result, note, failed);
      const said = `hosted run ${run} ${result}: ${note}`;
      if (!failed) console.log(`${said}, and it passed a canary`);
      else console.error(`${said}, but it failed its canary, so it stays live as UNVERIFIED`);
      return failed ? 4 : 0;
    };

    if (mode === 'abandon') {
      let agreed;
      try {
        agreed = onHost(run, 'abandon');
      } catch (error) {
        console.error(`hosted run ${run} stays open: ${error.message}`);
        return 2;
      }
      const ours = agreed.releaseId !== previous.releaseId;
      const note = `production agrees on the ${ours ? 'new' : 'previous'} release`;
      if (ours) {
        const current = { ...agreed, localId: build.candidate, ...commits };
        return closeCanaried(current, 'abandoned', note);
      }
      close('abandoned');
      Object.assign(row, agreed);
      record('abandoned', note);
      console.log(`hosted run ${run} abandoned: ${note}`);
      return 0;
    }
    let failure = progress.rollback;
    if (mode === 'resume' && !failure) {
      // Forward only with the pipeline this run began with, and only while a rollback could run.
      const why = unready(previous);
      const moved =
        spawnSync('git', ['diff', '--quiet', plan.sourceCommit, head, '--', ...PIPELINE], {
          cwd: root,
        }).status !== 0 && 'the release pipeline differs from the one this run began with';
      if ((why || moved) && !rollbackSteps(progress, previous).length) {
        close('refused');
        console.error(`hosted run ${run} closed, production unchanged: ${why || moved}`);
        return 1;
      }
      if (why) {
        console.error(
          `hosted run ${run} left open, not driven: ${why}. Fix that and rerun, or once production agrees on one release, close it with node deploy/hosted-release.mjs --abandon`,
        );
        return 3;
      }
      if (moved) failure = moved;
    }

    // Until the catalog step nothing in production has changed, so a failure only ends the run.
    // A run with something to roll back has every one of these steps recorded.
    try {
      build ??= onHost(run, 'build');
      row.lane = build.lane;
      if (build.lane === 'none') {
        const current = { ...previous, ...commits };
        if (previous.verified === false)
          return closeCanaried(current, 'rechecked', 'unverified, rebuilt identical');
        close('current', { current, inputs: build.inputs });
        console.log('The hosted image is current: the rebuilt image matches the deployed one.');
        return 0;
      }
      gates ??= onHost(run, 'gates');
      row.gates = `${Object.keys(gates).length} pass`;
      if (!pushed) {
        const mint = 'containers registries credentials registry.cloudflare.com --push --pull';
        const r = wranglerRun([
          ...`${mint} --expiration-minutes 30 --json -c`.split(' '),
          config(STANDARD, previous.image),
        ]);
        if (r.status !== 0)
          throw new Error(`wrangler minted no registry credential (exit ${r.status})`);
        const { username, password } = JSON.parse(r.stdout);
        pushed = onHost(run, 'push', { credential: { username, password } });
      }
    } catch (error) {
      close('failed');
      record('FAILED', error.message, 'nothing changed');
      console.error(`hosted release stopped before any change: ${error.message}`);
      return 1;
    }
    const entry = releaseEntry(pushed.image, build.executableSha256);
    const entries = providers.map((provider) => ({ ...entry, provider })); // only the provider differs
    const next = {
      image: pushed.image,
      releaseId: releaseId(entry),
      releases: Object.fromEntries(entries.map((e) => [e.provider, releaseId(e)])),
      localId: build.candidate,
      ...commits,
    };
    Object.assign(row, { image: next.image, releaseId: next.releaseId });
    if (!failure) {
      try {
        onHost(run, 'catalog', { ...pins(next), entries, protect: [digestOf(previous.image)] });
        const stale = providers.filter(
          (p) => onHost(run, 'native', { provider: p }).image !== next.image,
        );
        if (stale.length) {
          onHost(run, 'drain');
          deploy(next, stale, { deployAttempted: true }); // the note also arms the host's guard timer
        }
        await landed(next.image, 1);
        onHost(run, 'switch', pins(next));
        row.version = await settle(next.image, 1);
        const turn = onHost(run, 'canary', { releaseId: next.releaseId });
        row.canary = `${turn.status} in ${turn.seconds}s`;
      } catch (error) {
        failure = error.message;
      }
    }
    if (failure) {
      console.error(`hosted release failed: ${failure}`);
      let outcome = 'nothing to roll back';
      let code = 1;
      try {
        const steps = rollbackSteps(onHost(run, 'status').progress ?? {}, previous);
        if (steps.length) onHost(run, 'note', { rollback: failure.slice(0, 1000) });
        for (const [step, value] of steps) {
          if (step === 'catalog') onHost(run, 'catalog', { restore: true });
          else if (step === 'deploy') {
            deploy(value, providers);
            await landed(value.image);
          } else if (step === 'switch') onHost(run, 'switch', value);
          else if (step === 'settle') await settle(value);
          else {
            try {
              onHost(run, 'canary', { releaseId: value });
              outcome = 'rolled back and verified by a canary';
            } catch (error) {
              outcome = `rolled back, but the canary on the previous release failed too (${brief(error.message)})`;
              code = 4;
            }
          }
        }
        if (steps.length && !steps.some(([step]) => step === 'canary'))
          outcome = 'catalog restored';
      } catch (error) {
        record('ROLLBACK FAILED', failure, error.message);
        console.error(
          `ROLLBACK INCOMPLETE: ${error.message}. The run stays open: rerun once that is fixed, or once production agrees on one release, close it with node deploy/hosted-release.mjs --abandon.`,
        );
        return 3;
      }
      close(code === 4 ? 'rolled back, canary failed' : 'failed');
      record(code === 4 ? 'ROLLED BACK, CANARY FAILED' : 'FAILED', failure, outcome);
      console.error(`hosted release ${run}: ${outcome}`);
      return code;
    }
    close('pass', { current: next, inputs: build.inputs });
    record('pass', `Sandboxes ${plan.sandboxesCommit.slice(0, 8)}`);
    console.log(JSON.stringify({ run, ...next, version: row.version, canary: row.canary }));
    return 0;
  }
}

if (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

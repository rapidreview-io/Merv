#!/usr/bin/env node
/** Operator-only hosted acceptance. Defaults to read-only check; never enrolls a runner,
 * claims work, submits evidence/verdicts, changes dispatch, or releases an existing hold.
 * Credentials come only from the named environment variable. See NATIVE_GIT_CUTOVER_PLAN.md.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { observe } from './hosted-native-observe.mjs';

export function request(runId, probe) {
  assert.match(runId, /^[a-z][a-z0-9-]{0,28}$/);
  const prefix = `acceptance-${runId}`;
  const program = `import base64,gzip;exec(compile(gzip.decompress(base64.b64decode('${gzipSync(probe).toString('base64')}')),'acceptance-probe','exec'))`;
  // The hosted image supplies this interpreter. Isolated mode excludes checkout
  // modules, user site packages and PYTHONPATH before the embedded source loads.
  const command = `/usr/bin/python3 -I -B -c "${program}" --prefix ${prefix} --stage STAGE`;
  const details = `This is a bounded real hosted workflow acceptance experiment. Follow your actual assignment, permissions, review criteria and honest findings. The owner does not perform the research or reviews. Use your assigned checkout and Python standard library only; no provisioned compute, network dataset, dependency installation, or work on other projects. Do not hand-create Git commits, stage changes, reset/clean, change mounts, or replace the assigned checkout. Approval must commit the submitted dirty tree. Budget the scientific calculation below one second and each visit below five minutes; report any real blocker instead of bypassing it.

Scientific question: fit ordinary least-squares y=a*x+b to training pairs [(-3,-5),(-2,-3),(-1,-1)]. Compare with the training-mean predictor on held-out pairs [(0,1),(1,3),(2,5),(3,7),(4,9)]. Preregister mean absolute error and candidate MAE < baseline MAE. This deterministic arithmetic exercise establishes no statistical or generalization claim. Independently calculate and explain the result; the owner supplies neither result files nor conclusions.

Planning: create your own small runnable implementation, plan, and measured feasibility JSON with at least one data resource and actual data/compute/time bases. Create top-level ${prefix}-continuity.txt with a random nonce; retain it unchanged through execution. Before submission run the exact probe below with STAGE=planner in your assigned checkout and leave its JSON in shell output. Then call session.ask_owner with exactly '${prefix}: resume dirty checkout' and stop. On the next visit acknowledge the owner's answer, run the same planner probe before changing any file, compare cwd/device/inode, HEAD, indexTree, statusSha256 and all marker digests to your earlier output, and report any loss of continuity. Do not repeat the question. Retain/attach your own plan and feasibility through Merv, submit_design at the current revision, then stop immediately. Do not run the full held-out evaluation before approval.

Execution after design approval: first run the probe with STAGE=executor and verify the unchanged continuity file at the same assigned checkout path; HEAD must now be the design-approval commit with its approved tree. Report device/inode, but a different inode after this explicit approved baseline change is allowed. Run your preregistered evaluation. Write ${prefix}-result.json with the actual measured results; leave it dirty for capture. Run the executor probe again, retain and attach result evidence, and create the required rendered report with the Reports tools. Submit_results from your actual leased session and stop.

Both independent reviewers: read all pinned artifacts and criteria and independently check the submission. From your assignment code context use its exact parentCommit and submittedTree, not HEAD's tree. Run the probe with STAGE=reviewer plus --parent PARENT --tree TREE; the probe only attempts bounded writes that must fail on your actual read-only mount. Do not put a copy of the probe inside the checkout. For results, independently rerun the tiny computation without writing into the checkout (python3 -B, no cache files). Keep evidence in shell output and your honest review findings. A failed probe or incorrect scientific result is a real finding, never an instruction to approve. Use the normal review claim and submission; stop at handoff.

Exact probe (replace only STAGE and add the reviewer arguments):
${command}
Probe source SHA-256: ${createHash('sha256').update(probe).digest('hex')}
The probe checks kernel/process/Git facts, not cloud deployment or shutdown. The operator separately joins its launchId and session to provider records and public Git objects. Never fabricate a proof JSON or substitute narrative for command output.`;
  assert.ok(details.length <= 16000, 'Experiment details exceed the service limit');
  return {
    action: 'create',
    name: `hosted-native-${runId}`,
    intent:
      'Verify a tiny preregistered regression experiment through hosted planning, independent design review, execution, rendered results, and independent results review while preserving ordinary Git state.',
    details,
    dependsOn: [],
    requestId: `hosted-native-${runId}`,
  };
}

export function operator(baseUrl, projectId, token, transport = fetch) {
  const origin = new URL(baseUrl);
  assert.ok(
    origin.protocol === 'https:' &&
      origin.pathname === '/' &&
      !origin.username &&
      !origin.password &&
      !origin.search &&
      !origin.hash,
    'A bare public HTTPS origin is required',
  );
  assert.match(projectId, /^project_[A-Za-z0-9_-]{1,180}$/);
  assert.ok(
    typeof token === 'string' && token.length > 0,
    'Named token environment variable is empty',
  );
  const call = async (path, body) => {
    assert.ok(path.startsWith('/') && !path.startsWith('//'));
    const target = new URL(path, origin);
    assert.equal(target.origin, origin.origin, 'Operator credential must stay on its origin');
    const response = await transport(target, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      headers: {
        authorization: `Bearer ${token}`,
        'x-merv-project-id': projectId,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    // Never print an upstream error body, which may contain a credential or private context.
    assert.ok(response.ok, `Operator request failed: HTTP ${response.status}`);
    return await response.json();
  };
  return {
    get: (path) => call(path),
    tool: async (name, input) => {
      assert.ok(
        [
          'experiment.read',
          'experiment.write',
          'review.read',
          'code.read',
          'session.read',
          'session.write',
          'fleet',
        ].includes(name),
      );
      const { action, ...args } = input;
      const response = await call(
        `/tools/${name}`,
        name === 'fleet' ? input : { action, [action]: args },
      );
      assert.ok('result' in response, 'Unexpected tool response');
      return response.result;
    },
  };
}

export function preflight(snapshot, imageId, releaseId, creating = false) {
  assert.ok(
    snapshot.complete && !snapshot.settings.maintenance,
    'Incomplete observation or boot maintenance remains active',
  );
  assert.equal(
    snapshot.mainContainer.imageId,
    imageId,
    'Main image differs from the accepted candidate',
  );
  assert.equal(snapshot.mainContainer.health, 'healthy');
  assert.equal(snapshot.mainContainer.nativeGitProtocol, '1');
  const profile = snapshot.settings.profiles.find(
    (p) => p.key === 'standard' && p.provider === 'cloudflare-fleet' && p.releaseId === releaseId,
  );
  assert.ok(profile, 'Expected Cloudflare standard release is not configured');
  for (const allocation of snapshot.main.allocations ?? [])
    assert.equal(
      allocation.profile_id,
      profile.profileId,
      'Allocation used another runtime profile',
    );
  const dispatch = snapshot.main.dispatch[0];
  assert.ok(
    Number(dispatch?.enabled) === 1 && Number(dispatch.own_machines) === 0,
    'Project must already permit hosted dispatch',
  );
  if (creating)
    for (const count of Object.values(snapshot.main.activity))
      assert.equal(Number(count), 0, 'Disposable project still has unfinished work or ownership');
}

/** Only actual tool results count as candidate proofs; model prose never does. Full evidence
 * still needs an independent join to session/launcher/provider records and exact Git objects. */
export function proofs(pages, prefix) {
  const found = [],
    seen = new Set();
  for (const page of pages)
    for (const visit of page.visits)
      for (const item of visit.events) {
        if (item.event.kind !== 'tool_result' || item.event.error || item.event.cut) continue;
        for (const line of item.event.output.split('\n')) {
          try {
            const proof = JSON.parse(line);
            if (
              proof.passed !== true ||
              proof.formatVersion !== 1 ||
              proof.prefix !== prefix ||
              !proof.launcher?.launchId ||
              !proof.checkout?.markers
            )
              continue;
            const key = `${visit.sessionId}:${item.seq}:${JSON.stringify(proof)}`;
            if (!seen.has(key)) {
              found.push({ sessionId: visit.sessionId, seq: item.seq, at: item.at, proof });
              seen.add(key);
            }
          } catch {
            /* Other command output is not a probe. */
          }
        }
      }
  return found;
}

export async function collect(api, state, snapshot) {
  const experiment = await api.tool('experiment.read', {
    action: 'get',
    experimentId: state.instanceId,
  });
  const submissions = await api.tool('experiment.read', {
    action: 'get',
    experimentId: state.instanceId,
    history: 'submissions',
    limit: 100,
  });
  assert.ok(!submissions.next, 'Submission history needs further pagination');
  const reviews = [];
  for (const id of new Set(submissions.items.map((s) => s.reviewId).filter(Boolean)))
    reviews.push(await api.tool('review.read', { action: 'get', reviewId: id }));
  const unit = await api.tool('code.read', { action: 'unit', unitId: state.instanceId });
  const { threads } = await api.get(
    `/sessions/threads?instanceId=${encodeURIComponent(state.instanceId)}`,
  );
  const conversations = [],
    messages = [],
    sessions = [];
  for (const thread of threads) {
    messages.push({
      threadId: thread.id,
      ...(await api.tool('session.read', { action: 'messages', threadId: thread.id })),
    });
    let next,
      pages = 0;
    do {
      assert.ok(++pages <= 100, 'Conversation pagination exceeded evidence bound');
      const page = await api.get(
        `/sessions/threads/${encodeURIComponent(thread.id)}/conversation${next ? `?before=${encodeURIComponent(next)}` : ''}`,
      );
      conversations.push(page);
      next = page.next;
    } while (next);
    for (const visit of thread.visits)
      sessions.push((await api.get(`/sessions/${encodeURIComponent(visit.sessionId)}`)).session);
  }
  return {
    observedAt: new Date().toISOString(),
    experiment,
    submissions,
    reviews,
    unit,
    threads,
    sessions,
    messages,
    conversations,
    observer: snapshot,
    proofs: proofs(conversations, `acceptance-${state.runId}`),
    acceptanceComplete: false,
    pendingVerification: [
      'Independently join worker proofs to protected hosted launches and frozen submissions.',
      'Fetch both approval commits through public native Git and compare exact parent/tree.',
      'Verify durable final capture before shutdown acknowledgement and registry deletion, then direct Cloudflare absence.',
      'A repeated operator drain is not proof of a lost managed-runner acknowledgement; retain real retry evidence.',
    ],
  };
}

async function main() {
  const { values: v } = parseArgs({
    options: {
      mode: { type: 'string', default: 'check' },
      'base-url': { type: 'string' },
      project: { type: 'string' },
      host: { type: 'string' },
      'main-image': { type: 'string' },
      'runtime-release': { type: 'string' },
      'run-id': { type: 'string' },
      out: { type: 'string' },
      'token-env': { type: 'string', default: 'MERV_ACCEPTANCE_TOKEN' },
    },
  });
  assert.ok(['check', 'start', 'watch', 'collect', 'drain'].includes(v.mode));
  assert.match(v['main-image'] ?? '', /^sha256:[0-9a-f]{64}$/);
  assert.match(v['runtime-release'] ?? '', /^[A-Za-z0-9_.:-]{1,200}$/);
  assert.match(v['token-env'], /^[A-Za-z_][A-Za-z0-9_]*$/);
  assert.ok(v.out, 'Private output directory is required');
  const out = resolve(v.out),
    statePath = join(out, 'state.json');
  await mkdir(out, { recursive: true, mode: 0o700 });
  const api = operator(v['base-url'], v.project, process.env[v['token-env']]);
  const write = async (name, value) => {
    const target = join(out, name),
      tmp = `${target}.${process.pid}.next`;
    const data = JSON.stringify(value, null, 2)
      .split(process.env[v['token-env']])
      .join('[redacted]');
    await writeFile(tmp, data + '\n', { mode: 0o600 });
    await rename(tmp, target);
  };
  let state;
  try {
    state = JSON.parse(await readFile(statePath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const binding = {
    baseUrl: new URL(v['base-url']).origin,
    projectId: v.project,
    host: v.host,
    mainImage: v['main-image'],
    runtimeRelease: v['runtime-release'],
  };
  if (state)
    for (const [key, value] of Object.entries(binding))
      assert.equal(state[key], value, 'Output belongs to another target');
  if (state && v['run-id']) assert.equal(state.runId, v['run-id'], 'Output belongs to another run');
  const observeNow = () =>
    observe({ host: v.host, projectId: v.project, instanceId: state?.instanceId });
  let snapshot = await observeNow();
  preflight(snapshot, binding.mainImage, binding.runtimeRelease, !state);
  await api.get('/sessions/status'); // Verify the supplied key and the actual public route before any mutation.
  await write('observer.json', snapshot);
  if (v.mode === 'check') {
    console.log(JSON.stringify({ ready: true, ...binding }));
    return;
  }
  if (v.mode === 'start') {
    if (!state) {
      const probe = await readFile(
        new URL('../scripts/hosted-runner/native-acceptance-probe.py', import.meta.url),
      );
      state = { ...binding, runId: v['run-id'], request: request(v['run-id'], probe) };
      // The journal is exclusive before the first POST; a concurrent start must reuse it.
      await writeFile(statePath, JSON.stringify(state, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
    }
    if (!state.instanceId) {
      const experiment = await api.tool('experiment.write', state.request);
      assert.match(experiment.id, /^wf_[A-Za-z0-9_-]+$/);
      state.instanceId = experiment.id;
      await write('state.json', state);
    }
    console.log(JSON.stringify({ instanceId: state.instanceId, next: 'watch' }));
    return;
  }
  assert.ok(state?.instanceId, 'Start a run in this directory first');
  const deadline = Date.now() + 30 * 60_000;
  do {
    snapshot = await observeNow();
    preflight(snapshot, binding.mainImage, binding.runtimeRelease);
    const evidence = await collect(api, state, snapshot);
    await write(`evidence-${Date.now()}.json`, evidence);
    console.log(
      JSON.stringify({
        instanceId: state.instanceId,
        state: evidence.experiment.workflow.state,
        proofs: evidence.proofs.length,
        allocations: snapshot.main.allocations.map((a) => ({ id: a.id, phase: a.phase })),
      }),
    );
    if (v.mode === 'drain') {
      assert.ok(evidence.experiment.settled, 'Only drain this test after its workflow is terminal');
      for (const a of snapshot.main.allocations)
        if (a.phase !== 'released') {
          assert.equal(a.owner_kind, 'workflow');
          assert.equal(a.owner_id, `work:${state.instanceId}`);
          await api.tool('fleet', { action: 'drain', id: a.id });
        }
      console.log(
        'Planned drain requested. Collect again until durable capture and provider-stop evidence is complete.',
      );
      return;
    }
    if (v.mode !== 'watch' || evidence.experiment.settled) return;
    // Answer only the explicitly requested continuity pause, not research questions or holds.
    for (const message of evidence.messages) {
      const questions = message.questions ?? [];
      if (
        questions.some(
          (q) =>
            q.open &&
            !q.answeredAt &&
            q.question === `acceptance-${state.runId}: resume dirty checkout`,
        )
      )
        await api.tool('session.write', {
          action: 'message',
          threadId: message.threadId,
          body: 'Continue the authorized continuity test: acknowledge this message, inspect the unchanged dirty checkout before editing, then complete your own plan and feasibility and submit for independent review.',
          requestId: `acceptance-resume-${state.runId}`,
        });
    }
    await delay(10_000);
  } while (Date.now() < deadline);
  throw new Error(
    'Observation deadline reached; keep evidence and inspect the workflow without clearing holds',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error(
      'Acceptance command stopped. Inspect private evidence and target settings; no error body or credential is printed.',
    );
    process.exitCode = 1;
  });

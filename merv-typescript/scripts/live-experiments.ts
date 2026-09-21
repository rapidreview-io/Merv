import { mapAsync } from '@merv/contracts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import type { Caller, ReviewRequest } from '@merv/contracts';
import type { CodeCapture } from '@merv/code/types';
import { MachineRunner } from '@merv/runner';
import { programVersion } from '@merv/experiments/program';
import { createApp } from '../src/app.js';

// Explicit native acceptance of the production Experiments program, with controlled data.
// No synthetic workflow, review owner, tool, or artifact/evidence writer is registered here.
const args = process.argv.slice(2);
const gitMode = args.includes('--git');
const destinations = args.filter((arg) => arg !== '--git');
assert.ok(
  destinations.length <= 1 && destinations.every((arg) => !arg.startsWith('--')),
  'Usage: live-experiments.ts [directory] [--git]',
);
const directory = resolve(
  destinations[0] ?? `live-runs/experiments-${gitMode ? 'git-' : ''}${Date.now()}`,
);
mkdirSync(directory, { recursive: false, mode: 0o700 });
const credentialEnv = 'MERV_NATIVE_EXPERIMENTS_SOURCE';
const previous = process.env[credentialEnv];
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const secrets: string[] = [];
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let source: Caller | undefined;
let runner: MachineRunner | undefined;
let report: Record<string, unknown> | undefined;
const launchedSource = readFileSync(new URL('./live-experiments.ts', import.meta.url));
writeFileSync(join(directory, 'launched-script.ts'), launchedSource, { mode: 0o600 });
const introduction =
  'INTRO_NATIVE_CAPTURE_2026: This project checks exact evidence, conservative claims, and independently reviewed code on a fixed synthetic study.';
const repository = join(directory, 'source');
const gitEnv = {
  PATH: process.env.PATH,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const localGit = (path: string, ...args: string[]) =>
  execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', env: gitEnv });
const initialCode =
  '# Replace this scaffolding with the actual approved experiment.\nraise SystemExit("No experiment implementation has been authored yet")\n';
let initialOid: string | null = null;
if (gitMode) {
  mkdirSync(repository);
  localGit(repository, 'init', '-b', 'main');
  writeFileSync(join(repository, 'calculate.py'), initialCode);
  localGit(repository, 'add', 'calculate.py');
  localGit(
    repository,
    '-c',
    'user.name=Acceptance Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-m',
    'Empty experiment scaffolding',
  );
  initialOid = localGit(repository, 'rev-parse', 'HEAD').trim();
}

const protocol =
  `This is a bounded local validation of a real research lifecycle using deliberately synthetic data. Do not use network, external research, GPU resources, additional tasks or additional agents. A passing run establishes only the calculation and workflow behavior on this specified data, not general scientific superiority.

Research question: does a linear least-squares model fitted ONLY on training data have lower mean absolute error (MAE) on the fixed held-out examples than a constant training-mean baseline?
Training pairs: x=[-3,-2,-1], y=[-5,-3,-1]. Held-out pairs: x=[0,1,2,3,4], y=[1,3,5,7,9]. The data are explicit synthetic observations. Freeze these splits and all five held-out examples. The baseline predicts mean(training y); candidate fits slope and intercept by ordinary least squares on the three training pairs only. No fitting, tuning or selection may use held-out labels. Compute per-example predictions and absolute errors for both methods, with MAE=sum(abs errors)/5 on the exact same held-out examples. Predeclare criterion candidate_MAE < baseline_MAE. State limitations: tiny deterministic noiseless synthetic data, no uncertainty estimate or generalization claim. No need for packages beyond Python3's standard library.

Planner: write your own plan with nonempty Summary, Objective & hypothesis, Evaluation sections, matched comparison, split isolation, predetermined metric/criterion, executable procedure, failure checks and limitations. Preserve it through artifact.create and experiment.attach as role plan, path experiments/native-linear-check/plan.md. Use the current numeric attemptIndex and workflow revision. Submit design through the actual experiment.transition; stop after handoff. Do not execute the study during planning.

Design reviewer: call review.get for the exact claimed review and artifact.read for EVERY artifactId in its pinned manifest before deciding. Independently assess the real plan against every review criterion. Return an honest review.submit verdict with synopsis, verification notes and findings, not an automatic approval. Stop after handoff.

Executor: first read the exact approved plan via artifact.read. Execute the specified comparison using a real local python3 command in your assigned workspace. Capture the actual source code and stdout, not a simulated run. Retain a single valid JSON result artifact containing train/test arrays, baseline prediction, fitted slope/intercept, both prediction vectors, absolute-error vectors, both MAEs, denominator, criterion outcome, code and actual stdout. For reproducible checking use these exact JSON fields: train:{x:[],y:[]}, test:{x:[],y:[]}, baseline:{prediction:number,predictions:[],absoluteErrors:[],mae:number}, candidate:{slope:number,intercept:number,predictions:[],absoluteErrors:[],mae:number}, denominator:number, criterion:{operator:"<",met:boolean}, code:string, stdout:string. Additional explanatory fields are allowed. The retained code and stdout are a transcript, not a summary: code must be the exact bytes of the file you executed, and stdout must be that command's standard output byte for byte, with no reformatting, re-indentation or re-serialization. If you want pretty-printed output, print it that way in the script itself and retain what it actually printed. Keep every retained plan/result/report document below 16000 UTF-8 bytes. Attach resultFormat json at experiments/native-linear-check/results.json. Inspect experiment.exhibit after the result is attached. Author your own report with Summary, Results, Deviations from plan, Conclusion; reference and interpret the exact metrics_exhibit.json filename and distinguish the calculated result from the limits of this synthetic study. Attach it at experiments/native-linear-check/report.md. Submit results through actual experiment.transition, passing only experimentId, transition, expectedRevision and requestId: submission evidence comes from the attached artifacts, so an evidence field is refused. Stop after handoff.

Attempt reviewer: call review.get and artifact.read for EVERY artifactId in the exact pinned manifest (approved plan, result, report and system metrics exhibit) before verdict. Independently recompute slope/intercept, all predictions/errors, and both MAEs with a real read-only python3 shell command from the retained input arrays. Compare actual stdout and the pinned exhibit's source hash/data with the result, and the report with the approved plan. Print one JSON object with checks:"all passed", training_count, held_out_count, slope, intercept, baseline, candidate, criterion, retained_stdout_matches_reexecution:true and exhibit_data_and_source_hash_match:true only after those independent checks actually pass. Do not write files or artifacts. Submit an honest verdict with substantive independent verification notes and one finding per criterion. Stop after handoff. A correct synthetic calculation does not justify a broader scientific claim.

All workers: use only your current fixed Merv tool grants. Read current assignment metadata if necessary. Use stable requestIds on mutations and stop immediately when the node handoff succeeds. Review findings must reference the actual pinned artifact IDs. All scientific material is your responsibility; no evidence is preseeded.` +
  (gitMode
    ? `

Git mode: this is production experiment@2. Planning and design review use scratch; only execution receives the persistent private Git checkout and attempt review receives its exact captured commit. There are no direct Git-writing tools or publication instructions. Executor: replace the tracked calculate.py scaffold with your actual calculation. Run python3 calculate.py, retain its exact file bytes as result.code and its actual stdout as result.stdout, and write the same stdout to a new local observations.json file. Do not run git add or git commit; leave the tracked calculation modification and untracked observations file for the Runner to capture after submit_results. Before handoff, run a successful local command that checks git status --porcelain and prints one JSON record with workspace_evidence:true, tracked_code_modified:true, local_result_untracked:true, head:the actual full Git HEAD, and codeSha256:SHA256 of calculate.py, setting booleans only after checking the actual status entries. This must precede submit_results.
Attempt reviewer: in addition to all existing review requirements, read calculate.py and observations.json from your actual read-only checkout. Verify git rev-parse HEAD and HEAD^{tree} against the producing-session codeCapture in your context. Compare calculate.py bytes to retained result.code, observations.json to retained result.stdout, then actually reexecute python3 calculate.py without writing files. Independently recompute the study separately as already required. In the successful checks JSON also include checkout_head, checkout_tree, checkout_code_sha256, checkout_code_matches_retained:true, and checkout_reexecution_matches_retained_stdout:true, only after these exact file/object checks pass. Never replace a missing file with code copied from artifacts. Stop after review.submit.
`
    : '');

try {
  app = await createApp({ directory: join(directory, 'server'), api: true, port: 0 });
  const boot = await app.ctx.scope.bootstrap({
    projectName: 'Native production experiment',
    actorName: 'Fixture owner',
  });
  source = { projectId: boot.project.id, actorId: boot.actor.id, credentialId: boot.credential.id };
  await app.ctx.scope.updateProjectContext(source, {
    summary: introduction,
    expectedSummary: '',
    requestId: 'project-introduction',
  });
  secrets.push(boot.token);
  process.env[credentialEnv] = boot.token;
  const other = await app.ctx.scope.bootstrap({
    projectName: 'Separate untouched project',
    actorName: 'Other owner',
  });
  secrets.push(other.token);
  const otherCaller: Caller = {
    projectId: other.project.id,
    actorId: other.actor.id,
    credentialId: other.credential.id,
  };
  const created = await app.ctx.experiments.create(source, {
    name: 'native-linear-check',
    intent:
      'Test the predefined training-only OLS versus training-mean baseline hypothesis on matched, fixed held-out synthetic data.',
    details: protocol,
    ...(gitMode ? { workspace: 'git' as const } : {}),
    requestId: 'experiment',
  });
  assert.equal(created.workflow.state, 'planned');
  assert.equal(created.attempt.startedAt, null);
  assert.equal(created.evidence.length, 0);
  assert.equal((await app.ctx.artifacts.list(source)).length, 0);
  runner = new MachineRunner({
    directory: join(directory, 'machine'),
    baseUrl: app.ctx.api.url!,
    projectId: source.projectId,
    credentialEnv,
    capacity: 1,
    ...(gitMode ? { workspace: { repository, baseRef: 'refs/heads/main' } } : {}),
    pollIntervalMs: 500,
    profiles: [
      {
        name: 'native-codex',
        harness: 'codex',
        executable: process.env.MERV_CODEX_BIN ?? 'codex',
        enabled: true,
        parallelism: 1,
      },
    ],
  });
  await runner.start();
  await app.ctx.sessions.setDispatch(source, { enabled: true });
  const deadline = Date.now() + 20 * 60_000;
  let last = '';
  const observations: { state: string; revision: number; startedAt: string | null }[] = [];
  for (;;) {
    const current = await app.ctx.experiments.get(source, created.id);
    const snapshot = runner.snapshot();
    const line = JSON.stringify({
      state: current.workflow.state,
      revision: current.workflow.revision,
      startedAt: current.attempt.startedAt,
      runnerState: snapshot.state,
      error: snapshot.lastError,
      launches: snapshot.launches.map(({ id, status }) => ({ id, status })),
    });
    if (line !== last) {
      console.log(line);
      last = line;
    }
    if (observations.at(-1)?.state !== current.workflow.state)
      observations.push({
        state: current.workflow.state,
        revision: current.workflow.revision,
        startedAt: current.attempt.startedAt,
      });
    if (
      current.workflow.state === 'complete' &&
      snapshot.launches.length === 4 &&
      snapshot.launches.every((launch) => ['stopped', 'exited'].includes(launch.status))
    )
      break;
    assert.ok(Date.now() < deadline, 'Native production Experiment acceptance timed out');
    assert.ok(
      snapshot.launches.length <= 4,
      'Unexpected replacement/return; preserve logs for diagnosis',
    );
    assert.ok(
      current.workflow.revision <= 4,
      'Unexpected rework; preserve honest verdict and logs',
    );
    assert.ok(
      !['abandoned', 'failed'].includes(current.workflow.state),
      'Native experiment ended without completing both independent reviews',
    );
    await delay(1000);
  }
  await app.ctx.sessions.setDispatch(source, { enabled: false });
  await runner.stop();
  const final = await app.ctx.experiments.get(source, created.id);
  const guidance = await app.ctx.workflows.evaluate(source, created.id);
  const sessions = (await app.ctx.sessions.list(source)).sort(
    (a, b) => a.expectedRevision - b.expectedRevision,
  );
  assert.equal(sessions.length, 4);
  assert.ok(
    sessions.every((session) => session.assignment.context?.prompt.includes(introduction)),
    'Every offered worker must receive the frozen Project Introduction',
  );
  // Ask the program for its current version rather than pinning the frozen history.
  assert.equal(final.workflow.version, programVersion(gitMode ? 'git' : undefined));
  assert.equal(new Set(sessions.map((session) => session.actorId)).size, 4);
  assert.deepEqual(
    sessions.map((session) => session.expectedRevision),
    [0, 1, 2, 3],
  );
  assert.deepEqual(
    sessions.map((session) => session.execution.policy.readOnly),
    [false, true, false, true],
  );
  assert.ok(
    sessions.every(
      (session) =>
        session.instanceId === created.id &&
        session.source.actorId === source!.actorId &&
        session.actorId !== source!.actorId,
    ),
  );
  assert.equal(final.workflow.state, 'complete');
  assert.equal(final.workflow.revision, 4);
  assert.equal(final.attempt.index, 1);
  assert.equal(final.attempts.length, 1);
  assert.ok(guidance.terminal);
  assert.equal(final.submissions.length, 2);
  const [design, results] = final.submissions;
  assert.equal(design.stage, 'design');
  assert.equal(results.stage, 'results');
  assert.equal(design.producerId, sessions[0].actorId);
  assert.equal(results.producerId, sessions[2].actorId);
  assert.equal(design.sessionId, sessions[0].id);
  assert.equal(results.sessionId, sessions[2].id);
  assert.equal(final.attempt.approvedSubmissionId, design.id);
  assert.equal(final.attempt.approvedReviewId, design.reviewId);
  const reviews = await mapAsync(
    [design, results],
    async (submission) => await app!.ctx.reviews.get(source!, submission.reviewId),
  );
  for (const [index, review] of reviews.entries()) {
    assert.equal(review.verdict, 'pass');
    assert.equal(review.reviewerId, sessions[index * 2 + 1].actorId);
    assert.equal(review.producerId, sessions[index * 2].actorId);
    assert.notEqual(review.reviewerId, review.producerId);
    assert.equal(review.subjectRevision, index * 2 + 1);
  }
  const planId = design.evidence.find((entry) => entry.role === 'plan')!.artifactId;
  assert.ok(reviews[1].artifactIds.includes(planId));
  const workStarts = await app.ctx.workflows.workStarts(source, created.id);
  assert.deepEqual(
    workStarts.map((start) => start.state),
    ['planned', 'design_review', 'running', 'experiment_review'],
  );
  assert.equal(final.attempt.startedAt, workStarts[2].startedAt);
  assert.equal(workStarts[2].actorId, sessions[2].actorId);
  assert.ok(
    observations
      .filter((entry) => ['planned', 'design_review'].includes(entry.state))
      .every((entry) => entry.startedAt === null),
  );
  assert.deepEqual(await app.ctx.experiments.list(otherCaller), []);
  assert.deepEqual(await app.ctx.artifacts.list(otherCaller), []);
  const artifacts = await mapAsync(await app.ctx.artifacts.list(source), async (artifact) => {
    const read = await app!.ctx.artifacts.read(source!, artifact.id);
    const bytes = Buffer.from(read.content, read.encoding === 'base64' ? 'base64' : 'utf8');
    assert.equal(sha(bytes), artifact.hash);
    return {
      ...artifact,
      retainedByteCount: bytes.length,
      verifiedSha256: sha(bytes),
      content: read.content,
      encoding: read.encoding,
    };
  });
  const resultEvidence = results.evidence.find((entry) => entry.role === 'result')!;
  const resultArtifact = artifacts.find((artifact) => artifact.id === resultEvidence.artifactId)!;
  const resultData = JSON.parse(resultArtifact.content);
  assert.deepEqual(resultData.train, { x: [-3, -2, -1], y: [-5, -3, -1] });
  assert.deepEqual(resultData.test, { x: [0, 1, 2, 3, 4], y: [1, 3, 5, 7, 9] });
  assert.equal(resultData.baseline.prediction, -3);
  assert.deepEqual(resultData.baseline.predictions, [-3, -3, -3, -3, -3]);
  assert.deepEqual(resultData.baseline.absoluteErrors, [4, 6, 8, 10, 12]);
  assert.equal(resultData.baseline.mae, 8);
  assert.equal(resultData.candidate.slope, 2);
  assert.equal(resultData.candidate.intercept, 1);
  assert.deepEqual(resultData.candidate.predictions, [1, 3, 5, 7, 9]);
  assert.deepEqual(resultData.candidate.absoluteErrors, [0, 0, 0, 0, 0]);
  assert.equal(resultData.candidate.mae, 0);
  assert.equal(resultData.denominator, 5);
  assert.equal(resultData.criterion.operator, '<');
  assert.equal(resultData.criterion.met, true);
  assert.equal(typeof resultData.code, 'string');
  assert.equal(typeof resultData.stdout, 'string');
  assert.ok(resultData.code.length > 100 && resultData.stdout.length > 20);
  const exhibitEvidence = results.evidence.find((entry) => entry.role === 'exhibit')!;
  assert.ok(exhibitEvidence?.systemGenerated);
  const exhibit = JSON.parse(
    artifacts.find((artifact) => artifact.id === exhibitEvidence.artifactId)!.content,
  );
  assert.equal(exhibit.resultFiles.length, 1);
  assert.equal(exhibit.resultFiles[0].source.artifactId, resultArtifact.id);
  assert.equal(exhibit.resultFiles[0].source.sha256, resultArtifact.hash);
  assert.deepEqual(exhibit.resultFiles[0].data, resultData);
  assert.equal(exhibit.window.startedAt, final.attempt.startedAt);
  assert.equal(
    final.evidence.find((entry) => entry.role === 'report')!.createdBy,
    sessions[2].actorId,
  );
  assert.equal(
    design.evidence.find((entry) => entry.role === 'plan')!.createdBy,
    sessions[0].actorId,
  );
  let gitProof: {
    capture: CodeCapture;
    initialOid: string;
    codeSha256: string;
    sourceUnchanged: true;
    centralUnchanged: true;
    capturedObservationsMatch: true;
  } | null = null;
  if (gitMode) {
    assert.ok(results.codeCaptureRef?.kind === 'session-final');
    assert.equal(results.codeCaptureRef.sessionId, sessions[2].id);
    const capture = await app.ctx.code.capture(source, results.codeCaptureRef);
    assert.equal(capture.status, 'ready');
    const captured = capture.workspace!;
    assert.ok(captured.treeOid);
    assert.equal(capture.provenance.actorId, sessions[2].actorId);
    assert.equal(capture.provenance.revision, 2);
    assert.notEqual(captured.headOid, initialOid);
    assert.notEqual(captured.treeOid, sessions[2].workspace!.attachment.treeOid);
    assert.equal(sessions[3].execution.references.code, captured.headOid);
    assert.equal(sessions[3].workspace!.attachment.baseOid, captured.headOid);
    assert.equal(sessions[3].workspace!.attachment.headOid, captured.headOid);
    assert.equal(sessions[3].workspace!.attachment.treeOid, captured.treeOid);
    assert.equal(sessions[3].workspace!.result!.headOid, captured.headOid);
    assert.equal(sessions[3].workspace!.result!.treeOid, captured.treeOid);
    assert.equal(localGit(repository, 'rev-parse', 'HEAD').trim(), initialOid);
    assert.equal(readFileSync(join(repository, 'calculate.py'), 'utf8'), initialCode);
    const bare = join(directory, 'machine/workspaces/repository.git');
    assert.equal(localGit(bare, 'rev-parse', 'refs/merv/central').trim(), initialOid);
    assert.equal(
      localGit(bare, 'rev-parse', `${captured.headOid}^{tree}`).trim(),
      captured.treeOid,
    );
    assert.equal(localGit(bare, 'show', `${captured.headOid}:calculate.py`), resultData.code);
    assert.equal(
      localGit(bare, 'show', `${captured.headOid}:observations.json`),
      resultData.stdout,
    );
    const captureEvent = (await app.ctx.state.events(source.projectId)).find(
      (event) => event.id === capture.eventId,
    )!;
    const reviewStart = workStarts[3];
    assert.ok(
      captureEvent &&
        captureEvent.id <
          (await app.ctx.state.events(source.projectId)).find(
            (event) =>
              event.type === 'workflow.work_started' &&
              event.data.revision === reviewStart.revision &&
              event.subjectId === final.id,
          )!.id,
    );
    gitProof = {
      capture,
      initialOid: initialOid!,
      codeSha256: sha(resultData.code),
      sourceUnchanged: true,
      centralUnchanged: true,
      capturedObservationsMatch: true,
    };
  }
  // An owner-side check that the live record reads back what the program wrote. No model
  // claims to have performed Reflection, publication, or claim assessment.
  const records = await app.ctx.knowledge.records(source);
  assert.equal(records.publication.status, 'none');
  assert.equal(records.project.summary, introduction);
  assert.equal(records.experiments.length, 1);
  assert.deepEqual(records.experiments[0], final);
  if (gitProof) {
    const observed = await app.ctx.knowledge.resolve(source, [`session-final:${sessions[2].id}`]);
    assert.equal(observed[0]?.status, 'resolved');
  }
  const walk = (path: string): string[] =>
    readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(path, entry.name)) : [join(path, entry.name)],
    );
  const returned = (call: any): any =>
    JSON.parse(call.result.content.find((content: any) => content.type === 'text').text);
  const phases = walk(join(directory, 'machine/launches'))
    .filter((path) => path.endsWith('/stdout.log'))
    .map((path) => {
      const launchDirectoryHash = basename(dirname(path));
      const launch = runner!
        .snapshot()
        .launches.find((entry) => sha(entry.id) === launchDirectoryHash)!;
      assert.ok(launch);
      const launchId = launch.id;
      const session = sessions.find((entry) => entry.id === launch.sessionId)!;
      assert.ok(session);
      const events = readFileSync(path, 'utf8')
        .split('\n')
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        });
      const items = events
        .filter((event) => event.type === 'item.completed')
        .map((event) => event.item);
      const calls = items.filter((item) => item.type === 'mcp_tool_call');
      const commands = items.filter((item) => item.type === 'command_execution');
      const revision = session.expectedRevision;
      const review = revision % 2 ? reviews[(revision - 1) / 2] : undefined;
      const readProofs = review
        ? review.artifactIds.map((artifactId) => {
            const verdict = calls.find((call) => call.tool === 'review.submit');
            const read = calls.find(
              (call) => call.tool === 'artifact.read' && call.arguments.artifactId === artifactId,
            );
            const get = calls.find(
              (call) => call.tool === 'review.get' && call.arguments.reviewId === review.id,
            );
            assert.ok(
              get && verdict && calls.indexOf(get) < calls.indexOf(verdict),
              'Full review record must be read before verdict',
            );
            assert.equal((returned(get) as ReviewRequest).snapshotHash, review.snapshotHash);
            assert.ok(
              read && calls.indexOf(read) < calls.indexOf(verdict),
              'Every pinned artifact must be read before verdict',
            );
            const value = returned(read);
            const bytes = Buffer.from(
              value.content,
              value.encoding === 'base64' ? 'base64' : 'utf8',
            );
            const metadata = artifacts.find((artifact) => artifact.id === artifactId)!;
            assert.equal(sha(bytes), metadata.hash);
            assert.equal(verdict.arguments.notes, review.notes);
            return {
              artifactId,
              sha256: metadata.hash,
              byteCount: bytes.length,
              fullReadBeforeVerdict: true,
            };
          })
        : [];
      let workspaceEvidence: any = null;
      if (revision === 2) {
        assert.ok(
          calls.some(
            (call) => call.tool === 'artifact.read' && call.arguments.artifactId === planId,
          ),
        );
        assert.ok(calls.some((call) => call.tool === 'experiment.exhibit'));
        assert.ok(
          commands.some((command) => /python3/.test(command.command) && command.exit_code === 0),
          'Executor must run actual Python',
        );
        assert.ok(
          commands.some(
            (command) =>
              command.exit_code === 0 &&
              String(command.aggregated_output).includes(resultData.stdout.trim()),
          ),
          'Retained executor stdout must match an actual observed successful command output',
        );
      }
      if (gitProof && revision === 2) {
        const proof = commands
          .flatMap((command) =>
            command.exit_code === 0
              ? String(command.aggregated_output)
                  .split('\n')
                  .flatMap((line) => {
                    try {
                      const value = JSON.parse(line);
                      return value.workspace_evidence === true ? [{ command, value }] : [];
                    } catch {
                      return [];
                    }
                  })
              : [],
          )
          .find(
            ({ value }) =>
              value.tracked_code_modified === true && value.local_result_untracked === true,
          );
        assert.ok(
          proof,
          'Native executor must prove its tracked modification and untracked output before handoff',
        );
        assert.equal(proof.value.head, initialOid);
        assert.equal(proof.value.codeSha256, gitProof.codeSha256);
        const handoff = calls.find((call) => call.tool === 'experiment.transition');
        assert.ok(handoff && items.indexOf(proof.command) < items.indexOf(handoff));
        workspaceEvidence = proof.value;
      }
      let recomputation: any = null;
      if (revision === 3) {
        assert.ok(
          commands.some((command) => /python3/.test(command.command) && command.exit_code === 0),
          'Attempt reviewer must independently recompute with actual Python',
        );
        const checked = commands
          .flatMap((command) => {
            if (!/python3/.test(command.command) || command.exit_code !== 0) return [];
            return String(command.aggregated_output)
              .split('\n')
              .flatMap((line) => {
                try {
                  const value = JSON.parse(line);
                  return value.checks === 'all passed' ? [{ command, value }] : [];
                } catch {
                  return [];
                }
              });
          })
          .find(({ value }) => value.training_count === 3 && value.held_out_count === 5);
        assert.ok(
          checked,
          'Successful reviewer stdout must contain independently checked arithmetic',
        );
        recomputation = checked.value;
        assert.equal(recomputation.slope, 2);
        assert.equal(recomputation.intercept, 1);
        assert.deepEqual(recomputation.baseline, resultData.baseline);
        assert.deepEqual(recomputation.candidate, resultData.candidate);
        assert.deepEqual(recomputation.criterion, resultData.criterion);
        assert.equal(recomputation.retained_stdout_matches_reexecution, true);
        assert.equal(recomputation.exhibit_data_and_source_hash_match, true);
        if (gitProof) {
          assert.equal(recomputation.checkout_head, gitProof.capture.workspace!.headOid);
          assert.equal(recomputation.checkout_tree, gitProof.capture.workspace!.treeOid);
          assert.equal(recomputation.checkout_code_sha256, gitProof.codeSha256);
          assert.equal(recomputation.checkout_code_matches_retained, true);
          assert.equal(recomputation.checkout_reexecution_matches_retained_stdout, true);
        }
        const verdict = calls.find((call) => call.tool === 'review.submit');
        assert.ok(
          verdict && items.indexOf(checked.command) < items.indexOf(verdict),
          'Independent arithmetic must precede the verdict',
        );
      }

      const handoff = calls.find(
        (call) => call.tool === (review ? 'review.submit' : 'experiment.transition'),
      );
      assert.ok(handoff);
      return {
        log: path,
        launchId,
        revision,
        state: session.execution.state,
        threadId: events.find((event) => event.type === 'thread.started')?.thread_id,
        session: {
          id: session.id,
          actorId: session.actorId,
          sourceActorId: session.source.actorId,
          expectedRevision: revision,
          readOnly: session.execution.policy.readOnly,
          status: session.status,
          closeReason: session.closeReason,
        },
        calls: calls.map((call) => ({
          tool: call.tool,
          failed: call.status !== 'completed' || !!call.error || call.result?.isError === true,
        })),
        commands: commands.map((command) => ({
          commandSha256: sha(command.command),
          commandPrefix: String(command.command).slice(0, 500),
          exitCode: command.exit_code,
          output: command.aggregated_output,
        })),
        artifactReads: readProofs,
        recomputation,
        workspaceEvidence,
      };
    })
    .sort((a, b) => a.revision - b.revision);
  assert.equal(phases.length, 4);
  assert.equal(new Set(phases.map((phase) => phase.threadId).filter(Boolean)).size, 4);
  const calls = phases.flatMap((phase) => phase.calls);
  assert.equal(
    calls.filter((call) => call.failed).length,
    0,
    'Inspect any failed tool call before claiming native acceptance',
  );
  const domainEvents = (await app.ctx.state.events(source.projectId)).filter((event) =>
    /^(experiment\.|review\.|workflow\.work_started|artifact\.created)/.test(event.type),
  );
  for (const submission of [design, results]) {
    const reviewEvent = domainEvents.find(
      (event) => event.type === 'review.submitted' && event.subjectId === submission.reviewId,
    )!;
    const reviewer = sessions.find((session) => session.actorId === reviewEvent.actorId)!;
    assert.ok(reviewer);
    assert.deepEqual(reviewEvent.data.source, { kind: 'session', sessionId: reviewer.id });
  }
  report = {
    passed: true,
    mode: gitMode ? 'git' : 'scratch',
    introduction,
    frozenIntroductionsVerified: 4,
    git: gitProof,
    records: {
      readBy: 'fixture-owner-after-native-terminal',
      experiments: records.experiments.length,
      publication: records.publication.status,
    },
    freshAgents: 4,
    successfulCalls: calls.length,
    failedCalls: 0,
    shellCalls: phases.reduce((sum, phase) => sum + phase.commands.length, 0),
    projectId: source.projectId,
    sourceActorId: source.actorId,
    otherProjectUnchanged: true,
    observations,
    workStarts,
    experiment: final,
    guidance,
    reviews,
    artifacts,
    resultData,
    exhibit,
    phases,
    domainEvents,
    runner: runner.snapshot(),
    sourceSha256: sha(launchedSource),
    limits: [
      'Production Experiments/Workflows/Reviews/ContextBuilder/Sessions and MachineRunner; fixture setup creates only the owner and empty experiment.',
      'Four fresh native agents complete one planned/design_review/running/experiment_review attempt; negative return/recovery paths are separately tested, not exercised by this positive run.',
      'The fixed tiny noiseless synthetic data validate this calculation and lifecycle, not a general scientific performance claim.',
      gitMode
        ? 'Actual private persistent producer checkout, stopped-worker Git capture, and exact read-only reviewer checkout; no Git publication, remote object transport, cloud runner, reflection or automatic claim assessment.'
        : 'Scratch workspaces only; no Git publication, cloud runner, reflection or automatic claim assessment is exercised.',
      'Knowledge.capture is a backend owner-side terminal corpus check, not a native-agent action or a published reflection.',
      'Component rendering from retained records is separate from this process/MCP acceptance; this report is not browser proof.',
    ],
  };
} finally {
  const failures: unknown[] = [];
  try {
    if (app && source) await app.ctx.sessions.setDispatch(source, { enabled: false });
  } catch (error) {
    failures.push(error);
  }
  try {
    await runner?.stop();
  } catch (error) {
    failures.push(error);
  }
  try {
    await app?.stop();
  } catch (error) {
    failures.push(error);
  }
  if (previous === undefined) delete process.env[credentialEnv];
  else process.env[credentialEnv] = previous;
  if (existsSync(join(directory, 'machine/ledger.sqlite'))) {
    const ledger = new DatabaseSync(join(directory, 'machine/ledger.sqlite'), { readOnly: true });
    try {
      const workspaceRows = ledger
        .prepare(
          'SELECT w.launch_id,w.path,w.policy_json,w.status,w.result_json,l.session_id FROM runner_workspaces w JOIN launches l ON l.id=w.launch_id',
        )
        .all();
      const workspaces = workspaceRows.map((row) => {
        const policy = JSON.parse(String(row.policy_json));
        const result = row.result_json ? JSON.parse(String(row.result_json)) : null;
        return {
          launchId: row.launch_id,
          sessionId: row.session_id,
          mode: policy.mode,
          retain: policy.mode === 'none' || policy.retain,
          status: row.status,
          path: row.path,
          pathExists: existsSync(String(row.path)),
          headOid: result?.headOid ?? null,
          treeOid: result?.treeOid ?? null,
        };
      });
      const cleanup = {
        workspaces,
        launches: ledger
          .prepare('SELECT id,session_id,status,reason,metadata_json FROM launches')
          .all()
          .map((launch) => ({
            id: launch.id,
            sessionId: launch.session_id,
            status: launch.status,
            reason: launch.reason,
            releasePending: JSON.parse(String(launch.metadata_json)).releasePending,
          })),
        pendingRequests: ledger.prepare('SELECT COUNT(*) AS n FROM launch_requests').get()!.n,
        ownedSlots: ledger
          .prepare(
            'SELECT COUNT(*) AS n FROM runner_checkout_slots WHERE owner_launch_id IS NOT NULL',
          )
          .get()!.n,
        appStopped: failures.length === 0,
        cleanupErrors: failures.length,
      };
      writeFileSync(join(directory, 'cleanup.json'), JSON.stringify(cleanup, null, 2) + '\n', {
        mode: 0o600,
      });
      if (report) {
        assert.equal(cleanup.pendingRequests, 0);
        assert.equal(cleanup.ownedSlots, 0);
        assert.ok(workspaces.every((workspace) => workspace.status === 'closed'));
        if (gitMode) {
          const producer = workspaces.find((workspace) => workspace.mode === 'persistent');
          const reviewer = workspaces.find((workspace) => workspace.mode === 'ephemeral');
          assert.ok(
            producer?.retain && producer.pathExists && producer.headOid && producer.treeOid,
          );
          assert.ok(
            reviewer &&
              !reviewer.retain &&
              !reviewer.pathExists &&
              reviewer.headOid === producer.headOid &&
              reviewer.treeOid === producer.treeOid,
          );
        }
        assert.ok(
          cleanup.launches.every(
            (launch) =>
              ['stopped', 'exited'].includes(String(launch.status)) && !launch.releasePending,
          ),
        );
        assert.equal(failures.length, 0);
        report.cleanup = cleanup;
      }
    } finally {
      ledger.close();
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Native Experiment cleanup failed');
}
assert.ok(report, 'The production Experiment did not reach its passing assertions');
const encoded = JSON.stringify(report, null, 2);
assert.ok(secrets.every((secret) => !encoded.includes(secret)));
assert.ok(
  !/m[sk]_[A-Za-z0-9_-]{32,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(encoded),
);
writeFileSync(join(directory, 'report.json'), encoded + '\n', { mode: 0o600 });
console.log(
  JSON.stringify({
    passed: true,
    freshAgents: 4,
    successfulCalls: report.successfulCalls,
    failedCalls: 0,
    shellCalls: report.shellCalls,
    report: join(directory, 'report.json'),
  }),
);

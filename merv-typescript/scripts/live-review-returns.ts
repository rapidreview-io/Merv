import { mapAsync } from '@merv/contracts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import {
  check,
  digest,
  eventSource,
  type Caller,
  type ReviewApplication,
  type ReviewRequest,
  type Transaction,
  type WorkflowAssignmentRule,
} from '@merv/contracts';
import { MachineRunner } from '@merv/runner';
import { createApp } from '../src/app.js';

// Two real native reviewers exercise generic returnTo transport and Reviews routing.
// This synthetic program deliberately has no Experiment records or execution loop.
const directory = resolve(process.argv[2] ?? `live-runs/review-returns-${Date.now()}`);
mkdirSync(directory, { recursive: false, mode: 0o700 });
const app = await createApp({ directory: join(directory, 'server'), api: true, port: 0 });
const credentialEnv = 'MERV_NATIVE_REVIEW_RETURNS_SOURCE';
const previous = process.env[credentialEnv];
const disposers: (() => void)[] = [];
let runner: MachineRunner | undefined;
let source: Caller | undefined;
let report: Record<string, unknown> | undefined;
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const secretValues: string[] = [];
try {
  const boot = await app.ctx.scope.bootstrap({
    projectName: 'Synthetic native review return routes',
    actorName: 'Fixture controller',
  });
  source = { projectId: boot.project.id, actorId: boot.actor.id, credentialId: boot.credential.id };
  process.env[credentialEnv] = boot.token;
  secretValues.push(boot.token);
  const producer = await app.ctx.scope.issueActor(source, {
    name: 'Fixture evidence author',
    role: 'producer',
  });
  secretValues.push(producer.token);
  const author: Caller = {
    projectId: source.projectId,
    actorId: producer.actor.id,
    credentialId: producer.credential.id,
  };
  const fixtures = [
    {
      name: 'flawed-design',
      returnTo: 'planned',
      verdict: 'fail',
      criteria: [
        'The proposed comparison isolates the intervention using the same held-out examples, metric, and baseline conditions.',
        'The evaluation uses held-out data that was not used to train or select the method.',
      ],
      documents: [
        {
          title: 'Flawed plan: unmatched data and train-set evaluation',
          content:
            '# Plan\n\n## Summary\nCompare synthetic methods A and B.\n\n## Objective & hypothesis\nClaim that A improves accuracy over B because of the new intervention.\n\n## Evaluation\nTrain A on 100 examples and report its accuracy on those same 100 training examples. Run B on a different set of 20 harder examples. Do not use a held-out test set or matched evaluation conditions. Treat any observed difference as proof of the intervention.\n\nEvidence marker: DESIGN-UNMATCHED-TRAIN100-TEST20.\n',
        },
      ],
    },
    {
      name: 'execution-repair',
      returnTo: 'running',
      verdict: 'needs_changes',
      criteria: [
        'The pinned plan defines a matched held-out evaluation of A and B on the same 100 examples.',
        'The actual execution follows that plan and computes accuracy as correct predictions divided by the full 100-example denominator.',
      ],
      documents: [
        {
          title: 'Approved fixture plan: matched held-out comparison',
          content:
            '# Approved plan\n\n## Summary\nCompare A and B on one fixed held-out set.\n\n## Objective & hypothesis\nMeasure whether A improves held-out accuracy over B.\n\n## Evaluation\nUse the same 100 held-out examples for A and B, none used for training or model selection. Record every prediction and compute correct/100 for each method. Preserve all examples, including errors. Compare the two accuracies.\n\nEvidence marker: PLAN-MATCHED-HELDOUT100.\n',
        },
        {
          title: 'Execution report with omitted errors and incorrect accuracy',
          content:
            '# Execution report\n\n## Summary\nWe claim A achieved 100% accuracy.\n\n## Results\nA made 80 correct predictions and 20 incorrect predictions on the planned 100 held-out examples. We removed the 20 incorrect cases from the denominator and reported 80/80 = 100%. B made 75 correct predictions on all 100 examples, reported as 75%. The retained counts imply A is actually 80/100 = 80%.\n\n## Deviations from plan\nThe 20 A errors were discarded instead of retaining all examples.\n\n## Conclusion\nThe original plan is usable, but this execution/report must be repaired before its result can be accepted.\n\nEvidence marker: RUN-CORRECT80-WRONG20-DENOM100.\n',
        },
      ],
    },
  ] as const;
  await app.ctx.state.migrate('native_review_returns', [
    {
      version: 1,
      sql: `
    CREATE TABLE native_return_cases(instance_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, review_id TEXT NOT NULL UNIQUE, case_name TEXT NOT NULL, return_to TEXT NOT NULL, verdict TEXT NOT NULL);
    CREATE TABLE native_return_commands(project_id TEXT NOT NULL, actor_id TEXT NOT NULL, request_id TEXT NOT NULL, input_hash TEXT NOT NULL, result_json TEXT NOT NULL, PRIMARY KEY(project_id,actor_id,request_id));
    CREATE TRIGGER native_return_receipts_immutable BEFORE UPDATE ON native_return_commands BEGIN SELECT RAISE(ABORT,'Fixture receipts are immutable'); END;
  `,
    },
  ]);
  interface CaseRow {
    instance_id: string;
    project_id: string;
    review_id: string;
    case_name: string;
    return_to: string;
    verdict: string;
  }
  const caseRow = async (caller: Caller, instanceId: string, tx: Transaction) => {
    const row = await tx.get<CaseRow>(
      'SELECT * FROM native_return_cases WHERE instance_id=? AND project_id=?',
      instanceId,
      caller.projectId,
    );
    check(row, 'fixture_not_found', 'This review fixture is not in the selected project', 404);
    return row;
  };
  const currentReview = async (
    caller: Caller,
    instanceId: string,
    revision: number,
    tx: Transaction,
  ) => {
    const row = await caseRow(caller, instanceId, tx);
    const review = await app.ctx.reviews.get(caller, row.review_id, tx);
    check(review.subjectRevision === revision, 'stale_review', 'Review revision changed', 409);
    return review;
  };
  const validateRoute = async (caller: Caller, input: ReviewApplication, tx: Transaction) => {
    await app.ctx.scope.require(caller, 'review', tx);
    const review = await app.ctx.reviews.get(caller, input.reviewId, tx);
    const row = await caseRow(caller, review.subjectId, tx);
    const snapshot = await app.ctx.workflows.get(caller, row.instance_id, tx);
    check(
      snapshot.state === 'review' &&
        snapshot.revision === input.expectedRevision &&
        review.subjectRevision === snapshot.revision,
      'stale_review',
      'Submit against the exact current review revision',
      409,
    );
    check(
      row.review_id === review.id &&
        input.returnTo === row.return_to &&
        input.verdict === row.verdict,
      'invalid_return_route',
      'Fundamental design failure returns to planned; repairable execution returns to running',
      409,
    );
    await app.ctx.reviews.checkSubmit(caller, review.id, input, tx);
    return { row, review, snapshot };
  };
  const rule: WorkflowAssignmentRule = {
    state: 'review',
    check: async ({ caller, snapshot, tx }) => {
      const review = await currentReview(caller, snapshot.id, snapshot.revision, tx);
      await app.ctx.reviews.checkSubmit(caller, review.id, undefined, tx);
    },
    references: async ({ caller, snapshot, tx }) => {
      const review = await currentReview(caller, snapshot.id, snapshot.revision, tx);
      return { reviewId: review.id, claimId: review.claimId!, artifacts: review.artifactIds };
    },
    build: async ({ caller, snapshot, tx }) => {
      const review = await currentReview(caller, snapshot.id, snapshot.revision, tx);
      const row = await caseRow(caller, snapshot.id, tx);
      return {
        role: 'reviewer',
        label: `Review return-route fixture: ${row.case_name}`,
        brief: `Independently review the complete pinned evidence. Your lease already owns review ${review.id}, claim ${review.claimId}. First call review.get. Then call artifact.read for EVERY artifactId in its manifest and read the full returned content before deciding. No shell or external research is needed. Assess every criterion against the actual evidence. This fixture distinguishes a fundamentally invalid design (verdict fail, returnTo planned) from a valid plan with repairable execution/report errors (verdict needs_changes, returnTo running). Do not infer a destination from the word fail alone: choose based on what needs repair. Submit through review.submit with reviewId, claimId, expectedRevision:0, requestId:"native-verdict", verdict and explicit returnTo. Include notes explaining your concrete checks, a plain 40–420 character synopsis without entity IDs, and one finding per criterionNumber with status, evidenceIds from the pinned manifest, and verification/correction notes. Cite the observed evaluation conditions or numerical counts. Stop immediately after the verdict succeeds. This proves generic review routing; it is not a production Experiment workflow.`,
        references: review.artifactIds.map((id) => ({
          kind: 'artifact',
          id,
          label: 'Pinned evidence',
        })),
        handoff: {
          instruction: 'Submit the explicit review return route, then stop.',
          tools: ['review.submit'],
        },
        execution: { readOnly: true, tools: [] },
        context: null,
      };
    },
    execution: {
      readOnly: true,
      workspace: { mode: 'none' },
      tools: [
        {
          name: 'review.get',
          alternatives: [{ reviewId: { kind: 'reference', name: 'reviewId' } }],
        },
        {
          name: 'artifact.read',
          alternatives: [{ artifactId: { kind: 'oneOf', name: 'artifacts' } }],
        },
        {
          name: 'review.submit',
          alternatives: [
            {
              reviewId: { kind: 'reference', name: 'reviewId' },
              claimId: { kind: 'reference', name: 'claimId' },
              expectedRevision: { kind: 'target', field: 'revision' },
            },
          ],
        },
      ],
    },
    lease: {
      label: async ({ caller, snapshot, tx }) => (await caseRow(caller, snapshot.id, tx)).case_name,
      role: async ({
        caller,
        snapshot,
        tx,
      }): Promise<'operator' | 'producer' | 'reviewer' | 'reader'> => {
        await app.ctx.scope.require(caller, 'review', tx);
        const review = await currentReview(caller, snapshot.id, snapshot.revision, tx);
        check(
          review.status === 'requested',
          'review_unavailable',
          'Review is already claimed',
          409,
        );
        return 'reviewer';
      },
      acquire: async ({ caller, snapshot, tx }) => {
        const review = await app.ctx.reviews.start(
          caller,
          (await currentReview(caller, snapshot.id, snapshot.revision, tx)).id,
          tx,
        );
        return { reviewId: review.id, claimId: review.claimId!, actorId: caller.actorId };
      },
      check: async ({ caller, snapshot, tx }, receipt) => {
        const review = await app.ctx.reviews.checkSubmit(
          caller,
          String(receipt.reviewId),
          undefined,
          tx,
        );
        check(
          review.subjectId === snapshot.id &&
            review.subjectRevision === snapshot.revision &&
            review.claimId === receipt.claimId &&
            receipt.actorId === caller.actorId,
          'stale_claim',
          'The lease must own this exact claim',
          409,
        );
      },
      release: async ({ lease, reason, tx }) =>
        await app.ctx.reviews.releaseClaim(
          {
            projectId: lease.projectId,
            reviewId: String(lease.receipt.reviewId),
            claimId: String(lease.receipt.claimId),
            actorId: lease.actorId,
            reason,
          },
          tx,
        ),
    },
  };
  const program = await app.ctx.workflows.register(
    {
      name: 'native-review-returns',
      version: 1,
      managed: true,
      initial: 'review',
      states: ['review', 'planned', 'running'],
      terminal: ['planned', 'running'],
      edges: [
        { from: 'review', action: 'return_planned', to: 'planned' },
        { from: 'review', action: 'return_running', to: 'running' },
      ],
    },
    {
      successStates: ['planned', 'running'],
      assignments: [rule],
      actions: [
        {
          name: 'submit_review',
          states: ['review'],
          transitions: ['return_planned', 'return_running'],
          tool: 'review.submit',
          instruction: 'Independently assess and select the explicit return destination.',
          check: async ({ caller, input, transition, tx }) => {
            check(input, 'invalid_input', 'The complete verdict is required');
            const { row } = await validateRoute(caller, input as unknown as ReviewApplication, tx);
            check(
              transition === `return_${row.return_to}`,
              'invalid_return_route',
              'Transition must match the recorded verdict destination',
              409,
            );
          },
        },
      ],
    },
  );
  disposers.push(() => program.dispose());
  const records = await mapAsync(
    fixtures,
    async (fixture) =>
      await app.ctx.state.transaction(async (tx) => {
        const target = await program.start(
          source!,
          { workflow: 'native-review-returns', requestId: fixture.name },
          tx,
        );
        const artifacts = await mapAsync(
          fixture.documents,
          async (document) =>
            await app.ctx.artifacts.create(author, { ...document, mediaType: 'text/markdown' }, tx),
        );
        const review = await app.ctx.reviews.request(
          source!,
          {
            subjectId: target.id,
            subjectRevision: target.revision,
            producerId: producer.actor.id,
            administrativeActorId: source!.actorId,
            artifactIds: artifacts.map((artifact) => artifact.id),
            criteria: [...fixture.criteria],
            formatVersion: 2,
            requestId: fixture.name,
          },
          tx,
        );
        await tx.run(
          'INSERT INTO native_return_cases VALUES(?,?,?,?,?,?)',
          target.id,
          source!.projectId,
          review.id,
          fixture.name,
          fixture.returnTo,
          fixture.verdict,
        );
        return { fixture, target, artifacts, review };
      }),
  );
  disposers.push(
    app.ctx.reviews.registerSubmitOwner({
      id: 'native-review-returns',
      owns: async (review, tx) =>
        !!(await tx.get(
          'SELECT instance_id FROM native_return_cases WHERE project_id=? AND review_id=? AND instance_id=?',
          review.projectId,
          review.id,
          review.subjectId,
        )),
      submit: async (caller, input, tx) => {
        await app.ctx.scope.require(caller, 'review', tx);
        const hash = digest(input);
        const prior = await tx.get<{ input_hash: string; result_json: string }>(
          'SELECT input_hash,result_json FROM native_return_commands WHERE project_id=? AND actor_id=? AND request_id=?',
          caller.projectId,
          caller.actorId,
          input.requestId,
        );
        if (prior) {
          check(
            prior.input_hash === hash,
            'request_conflict',
            'The request ID belongs to another verdict',
            409,
          );
          return JSON.parse(prior.result_json);
        }
        const { row, snapshot } = await validateRoute(caller, input, tx);
        const moved = await program.transition(
          caller,
          {
            instanceId: row.instance_id,
            expectedRevision: snapshot.revision,
            action: `return_${input.returnTo}`,
            requestId: `${caller.actorId}:${input.requestId}`,
            input: { ...input },
            data: {
              reviewId: input.reviewId,
              verdict: input.verdict,
              returnTo: input.returnTo!,
              notes: input.notes,
            },
          },
          tx,
        );
        const submitted = await app.ctx.reviews.submit(caller, input, tx);
        const result = { review: submitted, workflow: moved };
        await tx.run(
          'INSERT INTO native_return_commands VALUES(?,?,?,?,?)',
          caller.projectId,
          caller.actorId,
          input.requestId,
          hash,
          JSON.stringify(result),
        );
        await app.ctx.state.appendEvent(tx, {
          projectId: caller.projectId,
          actorId: caller.actorId,
          type: 'fixture.review_return_applied',
          subjectId: moved.id,
          data: {
            reviewId: submitted.id,
            returnTo: submitted.returnTo!,
            verdict: submitted.verdict!,
            ...eventSource(caller),
          },
        });
        return result;
      },
    }),
  );
  runner = new MachineRunner({
    directory: join(directory, 'machine'),
    baseUrl: app.ctx.api.url!,
    projectId: source.projectId,
    credentialEnv,
    capacity: 1,
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
  const deadline = Date.now() + 12 * 60_000;
  let previousLine = '';
  for (;;) {
    const states = await mapAsync(
      records,
      async (record) => (await app.ctx.workflows.get(source!, record.target.id)).state,
    );
    const snapshot = runner.snapshot();
    const line = JSON.stringify({
      states,
      runnerState: snapshot.state,
      launches: snapshot.launches.map(({ id, status }) => ({ id, status })),
      error: snapshot.lastError,
    });
    if (line !== previousLine) {
      console.log(line);
      previousLine = line;
    }
    if (
      states.every((state, i) => state === fixtures[i].returnTo) &&
      snapshot.launches.length === 2 &&
      snapshot.launches.every((launch) => ['stopped', 'exited'].includes(launch.status))
    )
      break;
    assert.ok(Date.now() < deadline, 'Native return-route acceptance timed out');
    assert.ok(
      snapshot.launches.length <= 2,
      'Unexpected replacement; inspect retained native logs',
    );
    await delay(1000);
  }
  await app.ctx.sessions.setDispatch(source, { enabled: false });
  await runner.stop();
  const sessions = await app.ctx.sessions.list(source);
  assert.equal(sessions.length, 2);
  assert.equal(new Set(sessions.map((session) => session.actorId)).size, 2);
  const walk = (path: string): string[] =>
    readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(path, entry.name)) : [join(path, entry.name)],
    );
  const phases = await mapAsync(
    walk(join(directory, 'machine')).filter((path) => path.endsWith('/stdout.log')),
    async (path) => {
      const events = readFileSync(path, 'utf8')
        .split('\n')
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        });
      const calls = events
        .filter((event) => event.type === 'item.completed' && event.item?.type === 'mcp_tool_call')
        .map((event) => event.item);
      const verdict = calls.find((call) => call.tool === 'review.submit');
      assert.ok(verdict, 'Each reviewer must submit a real MCP verdict');
      const record = records.find((record) => record.review.id === verdict.arguments.reviewId)!;
      assert.ok(record, 'Review belongs to a seeded fixture');
      const returned = (call: any) =>
        JSON.parse(call.result.content.find((content: any) => content.type === 'text').text);
      const reviewCall = calls.find((call) => call.tool === 'review.get');
      assert.ok(reviewCall && calls.indexOf(reviewCall) < calls.indexOf(verdict));
      const seenReview = returned(reviewCall) as ReviewRequest;
      assert.equal(seenReview.snapshotHash, record.review.snapshotHash);
      const reads = record.artifacts.map((artifact, index) => {
        const call = calls.find(
          (call) => call.tool === 'artifact.read' && call.arguments.artifactId === artifact.id,
        );
        assert.ok(
          call && calls.indexOf(call) < calls.indexOf(verdict),
          'Read every full artifact before the verdict',
        );
        const content = returned(call);
        assert.equal(content.content, record.fixture.documents[index].content);
        assert.equal(sha(content.content), artifact.hash);
        return { artifactId: artifact.id, hash: artifact.hash, fullBytesReadBeforeVerdict: true };
      });
      const saved = await app.ctx.reviews.get(source!, record.review.id);
      const session = sessions.find((session) => session.instanceId === record.target.id)!;
      assert.equal(saved.returnTo, record.fixture.returnTo);
      assert.equal(saved.verdict, record.fixture.verdict);
      assert.equal(saved.notes, verdict.arguments.notes);
      assert.ok(saved.notes!.trim().length > 30);
      assert.equal(saved.reviewerId, session.actorId);
      assert.equal(saved.producerId, producer.actor.id);
      assert.notEqual(saved.reviewerId, saved.producerId);
      assert.notEqual(session.actorId, source!.actorId);
      assert.equal(session.execution.policy.readOnly, true);
      const state = await app.ctx.workflows.get(source!, record.target.id);
      assert.equal(state.state, saved.returnTo);
      assert.equal(state.revision, 1);
      return {
        log: path,
        threadId: events.find((event) => event.type === 'thread.started')?.thread_id,
        shellCalls: events.filter(
          (event) => event.type === 'item.completed' && event.item?.type === 'command_execution',
        ).length,
        calls: calls.map((call) => ({
          tool: call.tool,
          failed: call.status !== 'completed' || !!call.error || call.result?.isError === true,
        })),
        artifactReads: reads,
        review: saved,
        workflow: state,
        session: {
          id: session.id,
          actorId: session.actorId,
          sourceActorId: session.source.actorId,
          instanceId: session.instanceId,
          readOnly: true,
        },
      };
    },
  );
  assert.equal(phases.length, 2);
  assert.equal(new Set(phases.map((phase) => phase.threadId).filter(Boolean)).size, 2);
  const calls = phases.flatMap((phase) => phase.calls);
  assert.equal(calls.filter((call) => call.failed).length, 0);
  assert.equal(
    phases.reduce((sum, phase) => sum + phase.shellCalls, 0),
    0,
  );
  const events = (await app.ctx.state.events(source.projectId)).filter(
    (event) => event.type === 'review.submitted' || event.type === 'fixture.review_return_applied',
  );
  assert.equal(events.length, 4);
  for (const phase of phases) {
    const submitted = events.find((event) => event.subjectId === phase.review.id)!;
    assert.equal(submitted.data.returnTo, phase.review.returnTo);
    assert.deepEqual(submitted.data.source, { kind: 'session', sessionId: phase.session.id });
  }
  report = {
    passed: true,
    freshAgents: 2,
    successfulCalls: calls.length,
    failedCalls: 0,
    shellCalls: 0,
    producerActorId: producer.actor.id,
    sourceActorId: source.actorId,
    phases,
    reviews: phases.map((phase) => phase.review),
    events,
    runner: runner.snapshot(),
    sourceSha256: sha(readFileSync(new URL('./live-review-returns.ts', import.meta.url))),
    limits: [
      'Synthetic registered owner and immutable fixture reviews; no production Experiment lifecycle, attempt records or scientific acceptance is implemented.',
      'The plan approval in the execution fixture is a seeded document, not a prior native design-review run.',
      'The evidence producer is a synthetic credentialed actor; the two reviewers are fresh native leased workers.',
      'planned and running are terminal only in this bounded fixture, so no producer execution follows the routed verdict.',
    ],
  };
} finally {
  const failures: unknown[] = [];
  try {
    if (source) await app.ctx.sessions.setDispatch(source, { enabled: false });
  } catch (error) {
    failures.push(error);
  }
  try {
    await runner?.stop();
  } catch (error) {
    failures.push(error);
  }
  for (const dispose of disposers.reverse()) {
    try {
      dispose();
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await app.stop();
  } catch (error) {
    failures.push(error);
  }
  if (previous === undefined) delete process.env[credentialEnv];
  else process.env[credentialEnv] = previous;
  if (existsSync(join(directory, 'machine/ledger.sqlite'))) {
    const ledger = new DatabaseSync(join(directory, 'machine/ledger.sqlite'), { readOnly: true });
    try {
      const launches = ledger
        .prepare('SELECT id,session_id,status,reason,metadata_json FROM launches')
        .all();
      const cleanup = {
        launches: launches.map((launch) => ({
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
  if (failures.length) throw new AggregateError(failures, 'Native fixture cleanup failed');
}
assert.ok(report, 'The native fixture did not reach its passing assertions');
const encoded = JSON.stringify(report, null, 2);
assert.ok(secretValues.every((secret) => !encoded.includes(secret)));
assert.ok(
  !/m[sk]_[A-Za-z0-9_-]{32,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(encoded),
);
writeFileSync(join(directory, 'report.json'), encoded + '\n', { mode: 0o600 });
console.log(
  JSON.stringify({
    passed: true,
    freshAgents: report.freshAgents,
    successfulCalls: report.successfulCalls,
    failedCalls: 0,
    report: join(directory, 'report.json'),
  }),
);

import { createService } from '@merv/contracts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  check,
  type Caller,
  type Data,
  type ReviewApplication,
  type SessionWorkspace,
} from '@merv/contracts';
import { SqliteState } from '@merv/state';
import { ProjectScope } from '@merv/scope';
import { DiskBlobs } from '@merv/blobs';
import { ArtifactStore } from '@merv/artifacts';
import { WorkflowsService } from '@merv/workflows';
import { ReviewService } from '@merv/reviews';
import { RecipeContextBuilder } from '@merv/context-builder';
import { DurableEvents } from '@merv/domain-events';
import { LeasedSessions } from '@merv/sessions';
import { CodeService } from '../packages/code/src/service.js';
import { githubFixture, config as githubConfig } from './github-fixture.js';
import { ConsolidationService } from '../packages/consolidation/src/index.js';
import type { ApprovedReflection } from '@merv/reflections/types';
import type {
  ConsolidationRecord,
  ConsolidationSubmit,
} from '../packages/consolidation/src/types.js';

const oid = (digit: string) => digit.repeat(40);
async function fixture(t: TestContext, github = false) {
  const dir = mkdtempSync(join(tmpdir(), 'merv-consolidation-'));
  const state = new SqliteState(join(dir, 'state.sqlite'));
  const scope = await createService(new ProjectScope(state));
  const gh = github ? await githubFixture(t, state) : undefined;
  if (gh) await gh.enable();
  const boot = await scope.bootstrap({ projectName: 'Consolidation', actorName: 'Owner' });
  const owner: Caller = gh?.caller ?? {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const issue = async (role: 'producer' | 'reviewer' | 'reader') => {
    const record = await scope.issueActor(owner, { name: role, role });
    return {
      actorId: record.actor.id,
      projectId: owner.projectId,
      credentialId: record.credential.id,
    };
  };
  const producer = await issue('producer'),
    reviewer = await issue('reviewer'),
    reader = await issue('reader');
  const artifacts = await createService(
    new ArtifactStore(state, scope, new DiskBlobs(join(dir, 'blobs'))),
  );
  const workflows = await createService(new WorkflowsService(state, scope)),
    reviews = await createService(new ReviewService(state, scope, artifacts));
  const contexts = await createService(new RecipeContextBuilder(state, scope, artifacts)),
    events = await createService(new DurableEvents(state));
  const sessions = await createService(
    new LeasedSessions(state, scope, workflows, events, { sweepIntervalMs: 60000 }),
  );
  const code = await createService(
    new CodeService(state, scope, sessions, artifacts, gh ? githubConfig : undefined, gh?.fetcher),
  );
  const fixtureDefinition = {
    name: 'approved-reflection-fixture',
    version: 1,
    initial: 'working',
    states: ['working', 'complete', 'abandoned'],
    terminal: ['complete', 'abandoned'],
    edges: [
      { from: 'working', action: 'finish', to: 'complete' },
      // A prerequisite that ends without succeeding, so a dependant meets dependency_failed.
      { from: 'working', action: 'give_up', to: 'abandoned' },
    ],
  };
  const fixturePolicy = {
    successStates: ['complete'],
    actions: [
      {
        name: 'finish',
        states: ['working'],
        transitions: ['finish'],
        tool: 'fixture.finish',
        instruction: 'Complete fixture.',
        check: async () => {},
      },
      {
        name: 'give_up',
        states: ['working'],
        transitions: ['give_up'],
        tool: 'fixture.give_up',
        instruction: 'Abandon fixture.',
        check: async () => {},
      },
    ],
  };
  const prior = await workflows.register(fixtureDefinition, fixturePolicy);
  const predecessor = await prior.start(owner, {
    workflow: 'approved-reflection-fixture',
    requestId: 'predecessor',
  });
  // A consolidation names experiments of the project: one stands in under the real name.
  const experiments = await workflows.register(
    { ...fixtureDefinition, name: 'experiment' },
    fixturePolicy,
  );
  const experimentId = (await experiments.start(owner, { workflow: 'experiment', requestId: 'e1' }))
    .id;
  const report = await artifacts.create(owner, {
    title: 'Reflection',
    content: 'Approved reflection: remove the unsupported experiment.',
  });
  let approved = false;
  const reflection: ApprovedReflection = {
    experimentIds: [experimentId],
    id: predecessor.id,
    projectId: owner.projectId,
    revision: 1,
    report,
    changeSpec: report,
    producerId: owner.actorId,
    reviewerId: reviewer.actorId,
    reviewId: 'prior-review',
    approvedAt: new Date().toISOString(),
    lenses: [],
    paper: {
      documents: Object.fromEntries(
        (['problem', 'literature', 'methods', 'results'] as const).map((kind) => [
          kind,
          {
            current: {
              projectId: owner.projectId,
              kind,
              revision: 0,
              sections: [],
              updatedBy: null,
              updatedAt: null,
              updateId: null,
            },
            published: null,
          },
        ]),
      ) as unknown as NonNullable<ApprovedReflection['paper']>['documents'],
      citations: [],
    },
    corpus: {
      id: 'corpus',
      projectId: owner.projectId,
      formatVersion: 1,
      createdBy: owner.actorId,
      createdAt: new Date().toISOString(),
      sourceEventHead: 0,
      manifestHash: 'a'.repeat(64),
      selection: {
        projectFacts: 'pinned-at-capture',
        project: boot.project,
        claims: [],
        tasks: [],
        experiments: [{ id: experimentId }] as NonNullable<
          ApprovedReflection['corpus']
        >['selection']['experiments'],
        artifacts: [{ id: report.id, status: 'retained', artifact: report }],
        assessments: [],
        captures: [],
        publication: { status: 'none', reflection: null, lenses: [] },
        taskReviewCoverage: 'current-record-references',
      },
    },
  };
  const consolidation = await createService(
    new ConsolidationService(state, scope, artifacts, workflows, reviews, contexts, code),
  );
  let counter = 0;
  const id = () => `request-${++counter}`;
  const approve = async () => {
    if (!approved)
      await prior.transition(owner, {
        instanceId: predecessor.id,
        expectedRevision: 0,
        action: 'finish',
        requestId: 'approve',
      });
    approved = true;
  };
  const create = async (workspace: 'none' | 'git' = 'none', dependsOn: string[] = []) => {
    await approve();
    return await consolidation.create(producer, {
      name: 'Combine findings',
      sourceArtifactIds: [report.id],
      experimentIds: [experimentId],
      workspace,
      dependsOn: [predecessor.id, ...dependsOn],
      requestId: id(),
    });
  };
  const input = async (
    record: ConsolidationRecord,
    caller: Caller = producer,
  ): Promise<ConsolidationSubmit> => ({
    consolidationId: record.id,
    expectedRevision: record.workflow.revision,
    reportArtifactId: (
      await artifacts.create(caller, {
        title: 'Consolidation report',
        content: 'Verified the approved reflection and retained regression test evidence.',
      })
    ).id,
    evidenceArtifactIds: [],
    decisions: [
      {
        experimentId: experimentId,
        decision: 'drop',
        rationale: 'The approved reflection rejected this unsupported approach.',
      },
    ],
    requestId: id(),
  });
  const verdict = async (
    record: ConsolidationRecord,
    verdict: ReviewApplication['verdict'] = 'pass',
  ) => {
    const review = await reviews.start(reviewer, record.reviewId!);
    return {
      reviewId: review.id,
      claimId: review.claimId!,
      expectedRevision: record.workflow.revision,
      verdict,
      notes: 'Checked the frozen reflection, experiment decisions and exact retained evidence.',
      synopsis:
        'Independent verification confirms the submitted experiment decisions and retained evidence.',
      findings: review.criteria.map((_, index) => ({
        criterionNumber: index + 1,
        status: verdict === 'pass' ? ('met' as const) : ('not_met' as const),
        evidenceIds: [review.artifactIds[0]],
        notes: 'Verified the retained evidence.',
      })),
      requestId: id(),
    };
  };
  const offer = async (record: ConsolidationRecord, source = producer) => {
    const secret = `ms_${randomBytes(32).toString('base64url')}`;
    const session = await sessions.offer(source, {
      instanceId: record.id,
      expectedRevision: record.workflow.revision,
      runnerId: 'test',
      requestId: id(),
      secret,
    });
    return { secret, session, caller: await sessions.authenticate(secret) };
  };
  const run = async <T>(
    caller: Caller,
    tool: string,
    input: Data,
    handler: (caller: Caller, input: Data) => T | Promise<T>,
  ) => sessions.run(await sessions.prepare(caller, tool, input), handler);
  t.after(async () => {
    consolidation.close();
    code.close();
    await sessions.close();
    await events.close();
    contexts.close();
    reviews.close();
    workflows.close();
    await state.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    experimentId,
    gh,
    state,
    scope,
    owner,
    producer,
    reviewer,
    reader,
    artifacts,
    workflows,
    reviews,
    sessions,
    events,
    code,
    consolidation,
    prior,
    predecessor,
    reflection,
    id,
    approve,
    create,
    input,
    verdict,
    offer,
    run,
  };
}

test('consolidation pins source artifacts without a Reflections service, exact experiment decisions and transactional replay', async (t) => {
  const f = await fixture(t);
  const pending = await f.consolidation.create(f.producer, {
    name: 'Waiting on source approval',
    sourceArtifactIds: [f.reflection.report.id],
    dependsOn: [f.predecessor.id],
    requestId: f.id(),
  });
  await assert.rejects(async () => await f.workflows.assignment(f.producer, pending.id), {
    code: 'dependencies_pending',
  });
  const record = await f.create();
  assert.equal(record.workflow.workflow, 'consolidation');
  assert.equal(record.workflow.state, 'consolidating');
  assert.equal(
    (await f.workflows.dependencies(f.producer, record.id)).dependencies[0].id,
    f.predecessor.id,
  );
  f.reflection.report.title = 'Changed external object';
  assert.notEqual(
    (await f.consolidation.get(f.producer, record.id)).sources[0].title,
    f.reflection.report.title,
  );
  const submission = await f.input(record);
  await assert.rejects(
    async () => await f.consolidation.submit(f.producer, { ...submission, decisions: [] }),
    {
      code: 'consolidation_decisions',
    },
  );
  await assert.rejects(
    async () =>
      await f.consolidation.submit(f.producer, {
        ...submission,
        decisions: [...submission.decisions, ...submission.decisions],
      }),
    { code: 'consolidation_decisions' },
  );
  await assert.rejects(
    async () =>
      await f.consolidation.submit(f.producer, {
        ...submission,
        decisions: [{ ...submission.decisions[0], decision: 'retain' }],
      }),
    { code: 'consolidation_code_required' },
  );
  await assert.rejects(async () => await f.consolidation.submit(f.reader, submission), {
    code: 'forbidden',
  });
  await assert.rejects(async () => await f.consolidation.submit(f.reviewer, submission), {
    code: 'forbidden',
  });
  await assert.rejects(
    async () =>
      await f.consolidation.submit(f.producer, {
        ...submission,
        reportArtifactId: f.reflection.report.id,
        requestId: 'source-as-report',
      }),
    { code: 'consolidation_report' },
  );
  const submitted = await f.consolidation.submit(f.producer, submission);
  assert.equal(submitted.workflow.state, 'consolidation_review');
  assert.deepEqual(await f.consolidation.submit(f.producer, submission), submitted);
  await assert.rejects(
    async () =>
      await f.consolidation.submit(f.producer, { ...submission, reportArtifactId: 'different' }),
    { code: 'request_conflict' },
  );
  await assert.rejects(
    async () =>
      await f.state.transaction(
        async (tx) =>
          await tx.run(
            'UPDATE consolidation_submissions SET record=? WHERE id=?',
            '{}',
            submitted.submissions[0].id,
          ),
      ),
    /immutable/,
  );
  await assert.rejects(async () => await f.reviews.start(f.producer, submitted.reviewId!), {
    code: 'forbidden',
  });
  await assert.rejects(async () => await f.consolidation.approved(f.owner, record.id), {
    code: 'consolidation_not_approved',
  });
});

test('a consolidation row written before the sources field keeps its legacy project graph as a source', async (t) => {
  const f = await fixture(t);
  const instance = await f.prior.start(f.owner, {
    workflow: 'approved-reflection-fixture',
    requestId: 'legacy-consolidation',
  });
  const graph = await f.artifacts.create(f.owner, {
    title: 'Project graph',
    content: 'An authored project graph pinned before the 2026-09-16 ruling.',
  });
  await f.state.transaction(
    async (tx) =>
      await tx.run(
        'INSERT INTO consolidations(id,project_id,record) VALUES(?,?,?)',
        instance.id,
        f.owner.projectId,
        JSON.stringify({
          id: instance.id,
          projectId: f.owner.projectId,
          name: 'Legacy consolidation',
          ownerId: f.owner.actorId,
          createdAt: new Date().toISOString(),
          workspace: 'none',
          reflection: { ...f.reflection, graph },
        }),
      ),
  );
  const record = await f.consolidation.get(f.reader, instance.id);
  assert.deepEqual(
    record.sources.map((a) => a.id).sort(),
    [f.reflection.report.id, graph.id].sort(),
    'the reconstructed source set of an already-completed consolidation does not shrink',
  );
  assert.deepEqual(record.experimentIds, [f.experimentId]);
});

test('independent review returns only consolidation and seals the reviewed result', async (t) => {
  const f = await fixture(t),
    record = await f.create();
  let submitted = await f.consolidation.submit(f.producer, await f.input(record));
  const rejected = await f.verdict(submitted, 'needs_changes');
  await assert.rejects(
    async () => await f.reviews.apply(f.reviewer, { ...rejected, returnTo: 'reflection' }),
    {
      code: 'invalid_review_return',
    },
  );
  const returned = (await f.reviews.apply(f.reviewer, {
    ...rejected,
    returnTo: 'consolidating',
  })) as ConsolidationRecord;
  assert.equal(returned.workflow.state, 'consolidating');
  assert.equal(returned.workflow.revision, 2);
  assert.equal((await f.workflows.get(f.owner, f.predecessor.id)).state, 'complete');
  assert.equal(returned.submissions.length, 1);
  assert.match(
    (await f.workflows.assignment(f.producer, record.id)).context!.prompt,
    /Independent verification confirms/,
  );
  submitted = await f.consolidation.submit(f.producer, await f.input(returned));
  const passed = await f.verdict(submitted);
  const completed = (await f.reviews.apply(f.reviewer, passed)) as ConsolidationRecord;
  assert.equal(completed.workflow.state, 'complete');
  assert.equal(completed.completion?.centralGit, 'not-applicable');
  assert.equal(completed.submissions.length, 2);
  assert.equal(
    (await f.consolidation.approved(f.owner, record.id)).completion?.submissionId,
    completed.submissions[1].id,
  );
  assert.deepEqual(await f.reviews.apply(f.reviewer, passed), completed);
  await assert.rejects(
    async () =>
      await f.state.transaction(
        async (tx) =>
          await tx.run('UPDATE consolidations SET completion=? WHERE id=?', '{}', record.id),
      ),
    /immutable/,
  );
});

test('additional workflow dependencies block assignment and submission until satisfied', async (t) => {
  const f = await fixture(t);
  const dependency = await f.prior.start(f.owner, {
    workflow: 'approved-reflection-fixture',
    requestId: 'extra',
  });
  const record = await f.create('none', [dependency.id]);
  await assert.rejects(async () => await f.offer(record), { code: 'dependencies_pending' });
  await assert.rejects(
    async () => await f.consolidation.submit(f.producer, await f.input(record)),
    {
      code: 'dependencies_pending',
    },
  );
  await f.prior.transition(f.owner, {
    instanceId: dependency.id,
    expectedRevision: 0,
    action: 'finish',
    requestId: 'finish-extra',
  });
  assert.equal((await f.offer(record)).session.assignment.workflow, 'consolidation');
});

test('a consolidation whose prerequisite ends without succeeding can still be ended', async (t) => {
  const f = await fixture(t);
  const dependency = await f.prior.start(f.owner, {
    workflow: 'approved-reflection-fixture',
    requestId: 'doomed',
  });
  const record = await f.create('none', [dependency.id]);
  await f.prior.transition(f.owner, {
    instanceId: dependency.id,
    expectedRevision: 0,
    action: 'give_up',
    requestId: 'give-up',
  });
  // Submitting and being assigned are both refused, and rightly so.
  await assert.rejects(
    async () => await f.consolidation.submit(f.producer, await f.input(record)),
    {
      code: 'dependency_failed',
    },
  );
  await assert.rejects(async () => await f.offer(record), { code: 'dependency_failed' });
  const stuck = await f.workflows.evaluate(f.owner, record.id);
  assert.ok(
    stuck.actions.some(
      (action) =>
        action.action === 'submit' &&
        action.blockers.some((blocker) => blocker.code === 'dependency_failed'),
    ),
  );
  assert.ok(
    stuck.actions.some((action) => action.action === 'end'),
    'the guidance that says to end this work offers a way to end it',
  );
  // Ending is all it can do, so the project reports it as stalled rather than as ready.
  assert.ok((await f.workflows.overview(f.owner)).stalled.includes(record.id));
  const ended = await f.consolidation.end(f.owner, {
    consolidationId: record.id,
    expectedRevision: stuck.revision,
    outcome: 'abandoned',
    reason: 'Its prerequisite was abandoned, so there is nothing left to consolidate.',
    requestId: f.id(),
  });
  assert.equal(ended.workflow.state, 'abandoned');
  assert.equal((await f.workflows.evaluate(f.owner, record.id)).terminal, true);
  assert.ok((await f.workflows.overview(f.owner)).terminal.includes(record.id));
  // A reader cannot end one, and a second end replays rather than moving it again.
  await assert.rejects(
    async () =>
      await f.consolidation.end(f.owner, {
        consolidationId: record.id,
        expectedRevision: ended.workflow.revision,
        outcome: 'failed',
        reason: 'Already ended.',
        requestId: f.id(),
      }),
    { code: 'invalid_transition' },
  );
});

test('leased workers receive frozen context, bounded artifact tools, and recovered independent review ownership', async (t) => {
  const f = await fixture(t),
    record = await f.create();
  const worker = await f.offer(record);
  assert.match(worker.session.assignment.context!.prompt, /Approved reflection/);
  await assert.rejects(
    async () => await f.consolidation.submit(f.producer, await f.input(record)),
    {
      code: 'consolidation_leased',
    },
  );
  const outside = await f.artifacts.create(f.owner, {
    title: 'Outside',
    content: 'Not selected for this worker.',
  });
  await assert.rejects(
    async () =>
      await f.sessions.prepare(worker.caller, 'artifact.read', { artifactId: outside.id }),
    { code: 'execution_arguments_forbidden' },
  );
  const report = await f.run(
    worker.caller,
    'artifact.create',
    { title: 'Worker report', content: 'All decisions checked.' },
    async (caller, input) =>
      await f.artifacts.create(caller, input as unknown as { title: string; content: string }),
  );
  const submitted = await f.run(
    worker.caller,
    'consolidation.submit',
    {
      consolidationId: record.id,
      expectedRevision: 0,
      reportArtifactId: report.id,
      evidenceArtifactIds: [],
      decisions: [{ experimentId: f.experimentId, decision: 'drop', rationale: 'Confirmed.' }],
      requestId: f.id(),
    },
    async (caller, input) =>
      await f.consolidation.submit(caller, input as unknown as ConsolidationSubmit),
  );
  await f.sessions.release(f.producer, { sessionId: worker.session.id, runnerId: 'test' });
  await f.events.drain();
  const first = await f.offer(submitted, f.reviewer);
  const firstReview = await f.reviews.get(f.owner, submitted.reviewId!);
  assert.equal(firstReview.reviewerId, first.caller.actorId);
  await f.sessions.release(f.reviewer, { sessionId: first.session.id, runnerId: 'test' });
  await f.events.drain();
  assert.equal((await f.reviews.get(f.owner, submitted.reviewId!)).status, 'requested');
  const next = await f.offer(submitted, f.reviewer);
  assert.notEqual(next.caller.actorId, first.caller.actorId);
  assert.notEqual((await f.reviews.get(f.owner, submitted.reviewId!)).claimId, firstReview.claimId);
  assert.equal(next.session.execution.policy.readOnly, true);
});

for (const github of [false, true])
  test(`Git consolidation seals this worker commit and gives review the exact proposal head (${github ? 'GitHub' : 'local'})`, async (t) => {
    const f = await fixture(t, github),
      record = await f.create('git');
    const worker = await f.offer(record);
    const control = { sessionId: worker.session.id, runnerId: 'test', hostRef: 'launch' };
    if (f.gh) await f.code.transportGrant(f.producer, { ...control, operation: 'fetch' });
    const workspace: SessionWorkspace = {
      repositoryId: github ? 'github:101' : 'repo',
      workspaceId: 'workspace',
      mode: 'persistent',
      branch: 'codex/consolidation',
      baseOid: oid('a'),
      headOid: oid('a'),
      stats: { commitCount: 0, filesChanged: 0, insertions: 0, deletions: 0 },
    };
    await f.sessions.attach(f.producer, { ...control, workspace });
    const operation = await f.run(
      worker.caller,
      'code.commit',
      { expectedHead: oid('a'), message: 'Combine verified work', requestId: f.id() },
      async (caller, input) =>
        await f.code.commit(
          caller,
          input as unknown as { expectedHead: string; message: string; requestId: string },
        ),
    );
    const command = (await f.code.nextCommand(f.producer, control))!;
    assert.equal(command.id, operation.command.id);
    const completion = {
      ...control,
      commandId: command.id,
      receipt: {
        commandId: command.id,
        repositoryId: workspace.repositoryId,
        workspaceId: 'workspace',
        baseOid: oid('a'),
        parentOid: oid('a'),
        headOid: oid('b'),
        treeOid: oid('c'),
        stats: { commitCount: 1, filesChanged: 1, insertions: 2, deletions: 0 },
      },
    };
    if (f.gh) {
      const input = { ...control, operation: 'checkpoint' as const, receipt: completion.receipt };
      const grant = await f.code.transportGrant(f.producer, input);
      f.gh.branches.set(grant.target!.branch, completion.receipt.headOid);
      await f.code.verifyTransport(f.producer, input);
    }
    await f.code.completeCommand(f.producer, completion);
    const report = await f.run(
      worker.caller,
      'artifact.create',
      { title: 'Tests', content: 'Combined tests passed; verified each decision.' },
      async (caller, input) =>
        await f.artifacts.create(caller, input as unknown as { title: string; content: string }),
    );
    const submitted = await f.run(
      worker.caller,
      'consolidation.submit',
      {
        consolidationId: record.id,
        expectedRevision: 0,
        reportArtifactId: report.id,
        evidenceArtifactIds: [],
        commandId: command.id,
        decisions: [
          {
            experimentId: f.experimentId,
            decision: 'adapt',
            rationale: 'Keep only the supported behavior.',
          },
        ],
        requestId: f.id(),
      },
      async (caller, input) =>
        await f.consolidation.submit(caller, input as unknown as ConsolidationSubmit),
    );
    const proposal = submitted.submissions[0].proposal!;
    assert.equal(proposal.receipt.headOid, oid('b'));
    assert.deepEqual(
      proposal.provenance.sources,
      record.sources.map((a) => ({ id: a.id, hash: a.hash })),
    );
    assert.deepEqual(proposal.provenance.decisions, submitted.submissions[0].decisions);
    await f.sessions.release(f.producer, { sessionId: worker.session.id, runnerId: 'test' });
    await f.events.drain();
    const review = await f.offer(submitted, f.reviewer);
    assert.equal(review.session.execution.references.code, oid('b'));
    assert.equal(review.session.execution.policy.readOnly, true);
    const reviewWorkspace = review.session.execution.policy.workspace;
    assert.ok(reviewWorkspace && reviewWorkspace.mode !== 'none');
    assert.equal(reviewWorkspace.base, 'reference:code');
    const claim = await f.reviews.get(f.owner, submitted.reviewId!);
    const completed = await f.run(
      review.caller,
      'review.submit',
      {
        reviewId: claim.id,
        claimId: claim.claimId!,
        expectedRevision: submitted.workflow.revision,
        verdict: 'pass',
        notes:
          'Verified the exact proposed commit and retained tests against the frozen reflection.',
        synopsis:
          'The proposed code and experiment decisions match the approved reflection and passed independent verification.',
        findings: claim.criteria.map((_, index) => ({
          criterionNumber: index + 1,
          status: 'met',
          evidenceIds: [report.id],
          notes: 'Verified against the exact retained evidence and code proposal.',
        })),
        requestId: f.id(),
      },
      async (caller, input) =>
        (await f.reviews.apply(
          caller,
          input as unknown as ReviewApplication,
        )) as ConsolidationRecord,
    );
    assert.equal(completed.completion?.centralGit, 'not-published');
    assert.equal(completed.completion?.submissionId, submitted.submissions[0].id);
    if (f.gh) {
      const publication = (await f.code.syncPublications(f.owner))[0];
      assert.equal(publication.review?.id, claim.id);
      assert.equal(publication.review?.actorId, review.caller.actorId);
      assert.equal(publication.review?.verdict, 'pass');
      assert.equal(publication.pull?.head.sha, proposal.receipt.headOid);
      assert.equal(publication.pull?.draft, false);
      assert.equal(publication.lastError, null);
    }
  });

test('creation composes in the caller transaction and project scopes and producer independence hold', async (t) => {
  const f = await fixture(t);
  await f.approve();
  const input = {
    name: 'Rollback',
    sourceArtifactIds: [f.reflection.report.id],
    experimentIds: [f.experimentId],
    requestId: f.id(),
  };
  await assert.rejects(
    async () =>
      await f.state.transaction(async (tx) => {
        await f.consolidation.create(f.owner, input, tx);
        throw new Error('roll back');
      }),
    /roll back/,
  );
  assert.equal((await f.consolidation.list(f.owner)).length, 0);
  const record = await f.consolidation.create(f.owner, input);
  const submitted = await f.consolidation.submit(f.owner, await f.input(record, f.owner));
  await assert.rejects(async () => await f.reviews.start(f.owner, submitted.reviewId!), {
    code: 'review_independence',
  });
  const review = await f.reviews.get(f.owner, submitted.reviewId!);
  assert.ok(review.pinnedInputIds?.includes(record.sources[0].id));
  const stranger = await f.scope.bootstrap({
    projectName: 'Other project',
    actorName: 'Other owner',
  });
  const other = { actorId: stranger.actor.id, projectId: stranger.project.id };
  await assert.rejects(async () => await f.consolidation.get(other, record.id), {
    code: 'consolidation_not_found',
  });
  assert.deepEqual(await f.consolidation.list(other), []);
});

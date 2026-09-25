import { mapAsync } from '@merv/contracts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createApp } from './fixtures/app.js';
import type { Artifact, Caller, ReviewApplication, ReviewHistory } from '@merv/contracts';
import type { ChangeSpec, Reflection } from '../packages/reflections/src/types.js';
import type { ResearchLineage } from '../packages/research/src/types.js';
import { buildLaunch } from '../packages/runner/src/profiles.js';
import {
  CHANGE_SPEC_CRITERION,
  REFLECTION_CRITERIA,
} from '../packages/reflections/src/definitions.js';
const token = () => `ms_${randomBytes(32).toString('base64url')}`;
async function fixture(t: TestContext, reflections?: object) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-reflection-'));
  const config = JSON.parse(
    readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
  );
  // These domain tests need Code's contracts, not its socket-backed repository store.
  config.plugins.find((entry: { id: string }) => entry.id === 'code').config = {};
  config.plugins = config.plugins.filter(
    (entry: { id: string }) =>
      entry.id !== 'api' &&
      entry.id !== 'identity' &&
      entry.id !== 'ui' &&
      !entry.id.endsWith('-api') &&
      !entry.id.endsWith('-ui'),
  );
  if (reflections)
    config.plugins.find((entry: { id: string }) => entry.id === 'reflections').config = reflections;
  const app = await createApp({ directory, config });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const boot = await app.ctx.scope.bootstrap({
    projectName: 'Reflection integration',
    actorName: 'Owner',
  });
  const owner: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  const actor = async (name: string, role: 'producer' | 'reviewer' | 'operator' = 'producer') => {
    const issued = await app.ctx.scope.issueActor(owner, { name, role });
    return {
      projectId: owner.projectId,
      actorId: issued.actor.id,
      credentialId: issued.credential.id,
    } as Caller;
  };
  const create = async (caller: Caller, label: string) =>
    await app.ctx.artifacts.create(caller, {
      title: label,
      content: `# Summary\n${label}: source-linked observation.\n# Evidence\nNo completed experiments in the pinned corpus; no empirical conclusion is claimed.`,
    });
  const lenses = async (wave: Reflection) => {
    for (const [i, lens] of wave.lenses.entries()) {
      const caller = await actor(`Lens ${wave.attempt}-${i}`);
      const artifact = await create(caller, lens.perspective);
      await app.ctx.reflections.submitLens(caller, {
        lensId: lens.id,
        artifactId: artifact.id,
        expectedRevision: 0,
        requestId: `lens-${lens.id}`,
      });
    }
    return await app.ctx.reflections.get(owner, wave.id);
  };
  const synthesize = async (wave: Reflection) => {
    const report = await create(owner, 'Synthesis'),
      spec = await create(owner, 'Changes');
    return await app.ctx.reflections.submit(owner, {
      reflectionId: wave.id,
      reportArtifactId: report.id,
      changeSpecArtifactId: spec.id,
      expectedRevision: wave.workflow.revision,
      requestId: `synthesis-${wave.workflow.revision}`,
    });
  };
  const verdict = async (wave: Reflection, reviewer: Caller, pass: boolean, returnTo?: string) => {
    const review = await app.ctx.reviews.start(reviewer, wave.review!.id);
    const input: ReviewApplication = {
      reviewId: review.id,
      claimId: review.claimId!,
      expectedRevision: wave.workflow.revision,
      verdict: pass ? 'pass' : 'needs_changes',
      ...(returnTo ? { returnTo } : {}),
      notes: 'Verified exact frozen sources and lens outputs.',
      synopsis: pass
        ? 'The exact frozen evidence supports this synthesis after independent verification.'
        : 'The exact submission requires repair of the documented coverage and evidence problems.',
      findings: review.criteria.map((_, i) => ({
        criterionNumber: i + 1,
        status: pass ? 'met' : 'not_met',
        evidenceIds: [review.artifactIds[0]!],
        notes: 'Checked against the corpus.',
      })),
      requestId: `verdict-${review.id}`,
    };
    await assert.rejects(
      async () =>
        await app.ctx.reviews.apply(reviewer, {
          ...input,
          expectedRevision: input.expectedRevision + 1,
          requestId: `stale-${review.id}`,
        }),
      { code: 'revision_conflict' },
    );
    return (await app.ctx.reviews.apply(reviewer, input)) as Reflection;
  };
  return { app, owner, actor, create, lenses, synthesize, verdict };
}
test('Reflection entrypoints keep their caller and enforce project access', async (t) => {
  const f = await fixture(t);
  const other = await f.app.ctx.scope.bootstrap({ projectName: 'Other', actorName: 'Other' });
  const foreign = {
    projectId: other.project.id,
    actorId: other.actor.id,
    credentialId: other.credential.id,
  };
  let wave = await f.app.ctx.reflections.create(f.owner, { requestId: 'wave' });
  await t.test('open authorizes its caller', async () => {
    await assert.rejects(
      f.app.ctx.state.transaction((tx) =>
        f.app.ctx.reflections.open({ ...foreign, projectId: f.owner.projectId }, tx),
      ),
      { code: 'forbidden' },
    );
  });
  wave = await f.verdict(
    await f.synthesize(await f.lenses(wave)),
    await f.actor('Reviewer', 'reviewer'),
    true,
  );
  for (const method of ['get', 'list', 'lens', 'approved'] as const) {
    await t.test(method, async (t) => {
      const caller = { ...foreign };
      const authorize = f.app.ctx.scope.require.bind(f.app.ctx.scope);
      t.mock.method(f.app.ctx.scope, 'require', async (...args: Parameters<typeof authorize>) => {
        const result = await authorize(...args);
        Object.assign(caller, f.owner);
        return result;
      });
      if (method === 'list') assert.deepEqual(await f.app.ctx.reflections.list(caller), []);
      else
        await assert.rejects(
          f.app.ctx.reflections[method](caller, method === 'lens' ? wave.lenses[0]!.id : wave.id),
          { code: method === 'lens' ? 'reflection_lens_not_found' : 'reflection_not_found' },
        );
    });
  }
  await t.test('creation captures ownership and input', async () => {
    const caller = { ...f.owner };
    const input = { title: 'Original', requestId: 'original' };
    const original = { ...input };
    const creating = f.app.ctx.reflections.create(caller, input);
    Object.assign(caller, foreign);
    Object.assign(input, { title: 'Replacement', requestId: 'replacement' });
    const created = await creating;
    assert.equal(created.ownerId, f.owner.actorId);
    assert.equal(created.title, original.title);
    assert.deepEqual(await f.app.ctx.reflections.create(f.owner, original), created);
  });
});

test('reflection uses live research, joins five independent ordinary workflows, reviews and retains exact approval', async (t) => {
  const f = await fixture(t);
  let wave = await f.app.ctx.research.startReflection(f.owner, { requestId: 'wave' });
  assert.equal(wave.workflow.workflow, 'reflection');
  await assert.rejects(
    async () =>
      await f.app.ctx.workflows.start(f.owner, {
        workflow: 'reflection.lens',
        requestId: 'unowned-start',
      }),
    { code: 'workflow_managed' },
  );
  assert.equal(wave.lenses.length, 5);
  assert.ok(wave.lenses.every((l) => l.workflow.workflow === 'reflection.lens'));
  assert.equal(
    (await f.app.ctx.research.startReflection(f.owner, { requestId: 'wave' })).id,
    wave.id,
  );
  await assert.rejects(
    async () => await f.app.ctx.research.startReflection(f.owner, { requestId: 'other' }),
    {
      code: 'reflection_open',
    },
  );
  await assert.rejects(
    async () =>
      await f.app.ctx.research.startReflection(f.owner, { requestId: 'wave', title: 'Different' }),
    { code: 'request_conflict' },
  );
  await assert.rejects(async () => await f.app.ctx.reflections.approved(f.owner, wave.id), {
    code: 'reflection_not_approved',
  });
  // The frozen corpus, paper snapshot and experiment list of retired waves are no longer shown.
  for (const retired of ['corpus', 'paper', 'experimentIds', 'paperProposal'])
    assert.ok(!(retired in wave), retired);
  await assert.rejects(
    async () =>
      await f.app.ctx.tasks.create(f.owner, {
        title: 'Later task',
        goal: 'Paused during reflection',
        checks: ['Recorded'],
        requestId: 'later',
      }),
    { code: 'workflow_creation_paused' },
  );
  const lensWorker = await f.actor('Independent lens', 'operator');
  // A blank Summary is refused whether or not a blank line separates it from the next heading.
  for (const [index, content] of [
    '# Summary\n\n# Evidence\nThis is evidence, not a summary.',
    '# Summary\n# Evidence\nThis is evidence, not a summary.',
    '```\n# Summary\nA fenced example is not the summary.\n```\n# Evidence\nEvidence.',
  ].entries()) {
    const emptySummary = await f.app.ctx.artifacts.create(lensWorker, {
      title: 'Empty summary',
      content,
    });
    await assert.rejects(
      async () =>
        await f.app.ctx.reflections.submitLens(lensWorker, {
          lensId: wave.lenses[0]!.id,
          artifactId: emptySummary.id,
          expectedRevision: 0,
          requestId: `invalid-summary-${index}`,
        }),
      { code: 'reflection_summary_required' },
    );
    // And asking whether that submission is ready gives the same answer the call would.
    assert.ok(
      (
        await f.app.ctx.workflows.evaluate(lensWorker, wave.lenses[0]!.id, {
          action: 'submit',
          input: { artifactId: emptySummary.id, expectedRevision: 0 },
        })
      ).blockers.some((blocker) => blocker.code === 'reflection_summary_required'),
    );
  }
  const artifact = await f.create(lensWorker, 'First');
  const replacementWorker = await f.actor('Replacement lens worker');
  const replacement = await f.create(replacementWorker, 'Replacement');
  const caller = { ...lensWorker };
  const input = {
    lensId: wave.lenses[0]!.id,
    artifactId: artifact.id,
    expectedRevision: 0,
    requestId: 'first',
  };
  const original = { ...input };
  const submitting = f.app.ctx.reflections.submitLens(caller, input);
  Object.assign(caller, replacementWorker);
  Object.assign(input, { artifactId: replacement.id, requestId: 'replacement' });
  const submitted = await submitting;
  assert.equal(submitted.producerId, lensWorker.actorId);
  assert.equal(submitted.artifact!.id, artifact.id);
  assert.deepEqual(await f.app.ctx.reflections.submitLens(lensWorker, original), submitted);
  await assert.rejects(
    async () =>
      await f.app.ctx.reflections.submitLens(lensWorker, {
        lensId: wave.lenses[1]!.id,
        artifactId: artifact.id,
        expectedRevision: 0,
        requestId: 'repeat-worker',
      }),
    { code: 'lens_independence' },
  );
  for (const lens of wave.lenses.slice(1)) {
    const actor = await f.actor(lens.perspective);
    await f.app.ctx.reflections.submitLens(actor, {
      lensId: lens.id,
      artifactId: (await f.create(actor, lens.perspective)).id,
      expectedRevision: 0,
      requestId: lens.id,
    });
  }
  wave = await f.app.ctx.reflections.get(f.owner, wave.id);
  assert.equal(wave.workflow.state, 'synthesizing');
  assert.match(
    (await f.app.ctx.workflows.assignment(f.owner, wave.id)).context!.prompt,
    /Independent lens reports/,
  );
  wave = await f.synthesize(wave);
  assert.equal(wave.workflow.state, 'in_review');
  await assert.rejects(async () => await f.synthesize(wave), { code: 'reflection_in_review' });
  await assert.rejects(async () => await f.app.ctx.workflows.assignment(lensWorker, wave.id), {
    code: 'review_independence',
  });
  await assert.rejects(async () => await f.app.ctx.reviews.start(lensWorker, wave.review!.id), {
    code: 'review_independence',
  });
  const reviewer = await f.actor('Independent reviewer', 'reviewer');
  wave = await f.verdict(wave, reviewer, true);
  assert.equal(wave.workflow.state, 'approved');
  await assert.rejects(async () => await f.synthesize(wave), { code: 'reflection_complete' });
  const approved = await f.app.ctx.reflections.approved(f.owner, wave.id);
  assert.equal(approved.report.id, wave.report!.id);
  // A text change specification is never parsed: no plan, and no criterion to judge one.
  assert.equal(wave.plan, null);
  assert.equal(approved.plan, undefined);
  assert.equal(wave.review!.criteria.length, 4);
  assert.equal(approved.reviewerId, reviewer.actorId);
  for (const retired of ['corpus', 'paper', 'experimentIds', 'paperProposal', 'graph'])
    assert.ok(!(retired in approved), retired);
  assert.ok(
    (
      await f.app.ctx.tasks.create(f.owner, {
        title: 'Later task',
        goal: 'Paused during reflection',
        checks: ['Recorded'],
        requestId: 'later',
      })
    ).id,
  );
  await assert.rejects(
    async () =>
      await f.app.ctx.state.transaction(
        async (tx) =>
          await tx.run('UPDATE reflections SET title=? WHERE id=?', 'Tampered', wave.id),
      ),
    { code: 'state_constraint' },
  );
  assert.ok((await f.app.ctx.research.startReflection(f.owner, { requestId: 'next-wave' })).id);
});

test('a JSON change specification is parsed, reviewed as a plan and retained with the approval', async (t) => {
  const f = await fixture(t);
  const carried = await f.app.ctx.tasks.create(f.owner, {
    title: 'Unfinished measurement',
    goal: 'Started before the wave',
    checks: ['Recorded'],
    requestId: 'carried',
  });
  let wave = await f.lenses(await f.app.ctx.reflections.create(f.owner, { requestId: 'wave' }));
  const plan: ChangeSpec = {
    version: 2,
    changes: 'Narrow the scope to the controlled setting.',
    next: { decision: 'continue', name: 'Second wave', rationale: 'The control is cheap.' },
    items: [
      {
        key: 'measure',
        kind: 'task',
        title: 'Build the measurement',
        goal: 'Establish the measurement the experiment needs.',
        checks: ['The measurement is recorded'],
        dependsOn: [],
        rationale: 'The methods lens found it missing.',
        workspace: { provider: 'code', version: 1 },
      },
      {
        key: 'control',
        kind: 'experiment',
        name: 'controlled-rerun',
        question: 'Does the effect survive the control?',
        details: '',

        dependsOn: ['measure'],
        rationale: 'The evidence lens found the control missing.',
        workspace: { provider: 'code', version: 1 },
      },
    ],
    carriedOver: [{ workflowId: carried.id, reason: 'Still needed by the next cycle.' }],
    rejected: [{ title: 'Scale up first', reason: 'No evidence yet that the effect is real.' }],
  };
  assert.equal(wave.workflow.version, 4);
  assert.ok(wave.lenses.every((lens) => lens.workflow.version === 3));
  const assignment = await f.app.ctx.workflows.assignment(f.owner, wave.id);
  assert.match(JSON.stringify(assignment), /version: 2/);
  assert.match(JSON.stringify(assignment), /deliverable is code in the project's repository/);
  const report = await f.create(f.owner, 'Synthesis');
  const submit = async (spec: Artifact, requestId: string) =>
    await f.app.ctx.reflections.submit(f.owner, {
      reflectionId: wave.id,
      reportArtifactId: report.id,
      changeSpecArtifactId: spec.id,
      expectedRevision: wave.workflow.revision,
      requestId,
    });
  const json = async (value: unknown) =>
    await f.app.ctx.artifacts.create(f.owner, {
      title: 'Changes',
      mediaType: 'application/json',
      content: typeof value === 'string' ? value : JSON.stringify(value),
    });
  for (const [label, value] of [
    ['malformed', '{not json'],
    ['unknown field', { ...plan, budget: 3 }],
    ['wrong version', { ...plan, version: 3 }],
    // The first format, which declared no workspaces, was only ever written by reflection@2.
    [
      'first version',
      {
        ...plan,
        version: 1,
        items: plan.items.map(({ workspace: _workspace, ...item }) => item),
      },
    ],
    ['cycle', { ...plan, items: [{ ...plan.items[0]!, dependsOn: ['measure'] }] }],
    ['missing carried work', { ...plan, carriedOver: [{ workflowId: 'task_none', reason: 'x' }] }],
    [
      'carried work of another kind',
      { ...plan, carriedOver: [{ workflowId: wave.id, reason: 'x' }] },
    ],
  ] as const) {
    await assert.rejects(
      async () => await submit(await json(value), `refused-${label}`),
      { code: 'invalid_change_spec' },
      label,
    );
    const after = await f.app.ctx.reflections.get(f.owner, wave.id);
    assert.equal(after.workflow.state, 'synthesizing');
    assert.equal(after.workflow.revision, wave.workflow.revision);
    assert.equal(after.plan, null);
  }
  // Asking whether a refused plan is ready gives the answer the submission would.
  const refused = await json({ ...plan, version: 3 });
  const refusal = await submit(refused, 'refused-preflight').then(
    () => assert.fail('A version-3 plan is refused'),
    (error: { code: string; message: string }) => error,
  );
  assert.equal(refusal.code, 'invalid_change_spec');
  const preflight = await f.app.ctx.workflows.evaluate(f.owner, wave.id, {
    action: 'submit',
    input: { reportArtifactId: report.id, changeSpecArtifactId: refused.id },
  });
  assert.ok(
    preflight.blockers.some(
      (blocker) => blocker.code === refusal.code && blocker.message === refusal.message,
    ),
    JSON.stringify({ refusal: refusal.message, blockers: preflight.blockers }),
  );
  const original = await json(plan);
  const originalHash = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
  assert.equal(original.hash, originalHash);
  const submitted = await submit(original, 'structured');
  assert.deepEqual(await submit(original, 'structured'), submitted);
  wave = submitted;
  const reviewContext = await f.app.ctx.workflows.assignment(
    await f.actor('Preview reviewer', 'reviewer'),
    wave.id,
  );
  assert.match(
    JSON.stringify(reviewContext),
    /Verify that each declaration matches its deliverable/,
  );
  assert.ok(JSON.stringify(reviewContext).includes(original.id));
  assert.deepEqual(
    JSON.parse((await f.app.ctx.artifacts.read(f.owner, original.id)).content),
    plan,
  );
  assert.deepEqual(wave.plan, plan);
  assert.equal(wave.review!.criteria.length, 5);
  assert.equal(wave.review!.criteria[4], CHANGE_SPEC_CRITERION);
  // A repair that falls back to prose drops the plan and the criterion that judged it.
  wave = await f.verdict(wave, await f.actor('First reviewer', 'reviewer'), false, 'synthesizing');
  assert.equal(wave.workflow.state, 'synthesizing');
  const structuredReviewId = wave.review!.id;
  wave = await submit(await f.create(f.owner, 'Changes as prose'), 'prose');
  assert.equal(wave.plan, null);
  assert.notEqual(wave.review!.id, structuredReviewId);
  assert.equal(wave.review!.criteria.length, 4);
  assert.ok(!wave.review!.criteria.includes(CHANGE_SPEC_CRITERION));
  wave = await f.verdict(wave, await f.actor('Second reviewer', 'reviewer'), false, 'synthesizing');
  wave = await submit(original, 'structured-again');
  wave = await f.verdict(wave, await f.actor('Third reviewer', 'reviewer'), true);
  assert.equal(wave.workflow.state, 'approved');
  assert.deepEqual(wave.plan, plan);
  const approved = await f.app.ctx.reflections.approved(f.owner, wave.id);
  assert.deepEqual(approved.plan, plan);
  assert.equal(approved.changeSpec.hash, originalHash);
  await assert.rejects(
    async () =>
      await f.app.ctx.state.transaction(
        async (tx) =>
          await tx.run(
            'UPDATE reflections SET approved=? WHERE id=?',
            JSON.stringify({ plan: { ...plan, items: [] } }),
            wave.id,
          ),
      ),
    { code: 'state_constraint' },
  );
});

test('review return preserves lenses for synthesis repair and creates fresh versioned children for lens repair', async (t) => {
  const f = await fixture(t);
  let wave = await f.app.ctx.research.startReflection(f.owner, { requestId: 'wave' });
  // With no rejected round there is nothing to carry, and the context says so.
  const untouched = (await f.app.ctx.workflows.assignment(f.owner, wave.lenses[0]!.id)).context!;
  assert.ok(untouched.omitted.includes('history'));
  assert.doesNotMatch(untouched.prompt, /Earlier review rounds/);
  wave = await f.synthesize(await f.lenses(wave));
  const firstIds = wave.lenses.map((l) => l.id);
  const reviewer = await f.actor('Reviewer', 'reviewer');
  const firstReview = wave.review!.id;
  wave = await f.verdict(wave, reviewer, false, 'synthesizing');
  assert.equal(wave.workflow.state, 'synthesizing');
  // The first repair already reads the one rejected round, and the feedback section is unchanged.
  const repair = (await f.app.ctx.workflows.assignment(f.owner, wave.id)).context!;
  assert.ok(!repair.omitted.includes('history') && !repair.omitted.includes('feedback'));
  assert.match(repair.prompt, /Earlier review rounds, oldest first/);
  assert.ok(
    repair.prompt.includes(
      JSON.stringify({
        previousReviews: [
          {
            id: firstReview,
            synopsis:
              'The exact submission requires repair of the documented coverage and evidence problems.',
          },
        ],
        recovery: null,
      }),
    ),
  );
  assert.deepEqual(
    wave.lenses.map((l) => l.id),
    firstIds,
  );
  wave = await f.synthesize(wave);
  const secondReview = wave.review!.id;
  // A reviewer judges the submission in front of them and is shown no earlier verdicts.
  assert.doesNotMatch(
    (await f.app.ctx.workflows.assignment(reviewer, wave.id)).context!.prompt,
    /Earlier review rounds/,
  );
  wave = await f.verdict(wave, reviewer, false, 'reflecting');
  assert.equal(wave.workflow.state, 'reflecting');
  assert.equal(wave.attempt, 2);
  const lens = wave.lenses[0]!;
  const lensContext = (await f.app.ctx.workflows.assignment(f.owner, lens.id)).context!;
  assert.equal(lensContext.typeVersion, 7);
  const history = JSON.parse(
    lensContext.prompt.slice(lensContext.prompt.indexOf('{"rounds":')).split('\n')[0]!,
  ) as ReviewHistory;
  assert.equal(history.omittedRounds, 0);
  assert.deepEqual(
    history.rounds.map(({ round, reviewId, verdict, returnTo, notes }) => ({
      round,
      reviewId,
      verdict,
      returnTo,
      notes,
    })),
    [firstReview, secondReview].map((reviewId, index) => ({
      round: index + 1,
      reviewId,
      verdict: 'needs_changes',
      returnTo: index ? 'reflecting' : 'synthesizing',
      notes: 'Verified exact frozen sources and lens outputs.',
    })),
  );
  assert.ok(
    history.rounds.every(
      (round) =>
        round.unmet.length === REFLECTION_CRITERIA.length &&
        round.unmet.every(
          (finding, index) =>
            finding.status === 'not_met' &&
            finding.criterion === REFLECTION_CRITERIA[index]!.slice(0, 200),
        ),
    ),
  );
  assert.ok(!lensContext.prompt.includes(reviewer.actorId));
  assert.ok(Buffer.byteLength(lensContext.prompt) < 16 * 1024);
  assert.deepEqual(
    (await f.app.ctx.workflows.execution(f.owner, { instanceId: lens.id, expectedRevision: 0 }))
      .references.researchReviews,
    [firstReview, secondReview],
  );
  assert.ok(wave.lenses.every((l) => !firstIds.includes(l.id) && l.artifact === null));
  assert.equal((await f.app.ctx.workflows.get(f.owner, firstIds[0]!)).state, 'complete');
  // No dependency edge names a lens, so the wave's policy does: a usage rollup over the
  // wave has to reach the lenses of every attempt, which are most of what it cost.
  assert.deepEqual(
    (await f.app.ctx.workflows.dependencyClosure(f.owner, wave.id)).sort(),
    [wave.id, ...firstIds, ...wave.lenses.map((l) => l.id)].sort(),
  );
  wave = await f.synthesize(await f.lenses(wave));
  wave = await f.verdict(wave, reviewer, true);
  assert.equal(wave.workflow.state, 'approved');
});

test('a cycle that follows another hands its wave the predecessor digest, and a leased lens can read the lineage', async (t) => {
  const f = await fixture(t);
  const research = f.app.ctx.research;
  const first = await research.create(f.owner, { name: 'First cycle', requestId: 'first' });
  const ended = await research.end(f.owner, {
    researchId: first.id,
    expectedRevision: first.workflow.revision,
    outcome: 'abandoned',
    reason: 'The first question was answered elsewhere.',
    requestId: 'end-first',
  });
  let cycle = await research.create(f.owner, {
    name: 'Second cycle',
    previousCycleId: first.id,
    requestId: 'second',
  });
  await f.app.ctx.paper.patch(f.owner, {
    kind: 'problem',
    expectedRevision: (await f.app.ctx.paper.read(f.owner)).documents.problem.current.revision,
    requestId: 'define',
    changes: [
      { id: 'problem', content: 'Can this comparison be evaluated reliably?' },
      { id: 'scope', content: 'A bounded local comparison.' },
      { id: 'goals', content: 'Retain independently verified evidence.' },
      { id: 'constraints', content: 'Use only the frozen available corpus.' },
    ],
  });
  for (const requestId of ['to-researching', 'to-reflecting'])
    cycle = await research.advance(f.owner, {
      researchId: cycle.id,
      expectedRevision: cycle.workflow.revision,
      requestId,
    });
  const wave = await f.app.ctx.reflections.get(f.owner, cycle.reflectionId!);
  const lens = wave.lenses[0]!;
  const context = (await f.app.ctx.workflows.assignment(f.owner, lens.id)).context!;
  assert.ok(!context.omitted.includes('previousCycle'));
  assert.match(context.prompt, /Predecessor cycle digest \(decisions already made/);
  assert.ok(context.prompt.includes('The first question was answered elsewhere.'));
  assert.match(context.prompt, /research\.lineage/);
  assert.ok(context.sources.some((source) => source.id === ended.digest!.id));
  assert.ok(Buffer.byteLength(context.prompt) < 16 * 1024);

  // Read before the lease: a leased lens's assignment is its worker's alone.
  const briefs = await mapAsync(
    wave.lenses,
    async (entry) => (await f.app.ctx.workflows.assignment(f.owner, entry.id)).context!.prompt,
  );
  const secret = token();
  await f.app.ctx.sessions.registerAgent(f.owner, {
    name: 'Lens agent',
    runnerId: 'external',
    requestId: 'agent',
    secret,
  });
  const execution = await f.app.ctx.sessions.assignAgent(secret, {
    instanceId: lens.id,
    expectedRevision: 0,
    requestId: 'assign-lens',
  });
  assert.match(execution.assignment.context!.prompt, /Predecessor cycle digest/);
  const caller = await f.app.ctx.sessions.authenticate(secret);
  const lineage = (await f.app.ctx.tools.call('research.lineage', caller, {
    researchId: cycle.id,
  })) as ResearchLineage;
  assert.deepEqual(
    lineage.cycles.map((entry) => [entry.id, entry.digest?.id ?? null]),
    [
      [first.id, ended.digest!.id],
      [cycle.id, null],
    ],
  );
  assert.ok(await f.app.ctx.tools.call('artifact.read', caller, { artifactId: ended.digest!.id }));

  // The server admits any read, but Codex is launched with an explicit allowlist: every read a
  // lens brief names must be on it, or a Codex lens cannot see the tool it was told to use.
  const launch = buildLaunch(
    {
      name: 'local-codex',
      harness: 'codex',
      executable: '/opt/bin/codex',
      enabled: true,
      parallelism: 1,
    },
    { session: execution, secret, mcpUrl: 'http://127.0.0.1:8080/mcp', cwd: '/tmp/merv-lens' },
    {},
  );
  const enabled = JSON.parse(
    /enabled_tools=(\[[^\]]*\])/.exec(
      launch.args.find((arg) => arg.startsWith('mcp_servers'))!,
    )![1]!,
  ) as string[];
  const reads = new Set(
    (await f.app.ctx.tools.describe(caller))
      .filter((tool) => tool.annotations?.readOnlyHint === true)
      .map((tool) => tool.name),
  );
  const named = [
    ...new Set(briefs.flatMap((brief) => brief.match(/\b[a-z_]+\.[a-z_]+\b/g) ?? [])),
  ].filter((name) => reads.has(name));
  for (const read of ['research.lineage', 'usage.read', 'project.records'])
    assert.ok(named.includes(read), read);
  assert.deepEqual(
    named.filter((name) => !enabled.includes(name)),
    [],
  );
});

test('a standalone wave names no lineage, and a digest that does not fit is omitted yet stays readable', async (t) => {
  const f = await fixture(t);
  const oversized = await f.app.ctx.artifacts.create(f.owner, {
    title: 'Cycle digest: oversized',
    content: JSON.stringify({ formatVersion: 1, filler: 'x'.repeat(30000) }),
    mediaType: 'application/json',
  });
  const other = await f.app.ctx.scope.bootstrap({ projectName: 'Other', actorName: 'Other' });
  const foreign = await f.app.ctx.artifacts.create(
    { projectId: other.project.id, actorId: other.actor.id, credentialId: other.credential.id },
    { title: 'Foreign digest', content: '{}', mediaType: 'application/json' },
  );
  await assert.rejects(
    async () =>
      await f.app.ctx.reflections.create(f.owner, {
        previousCycleDigestId: foreign.id,
        requestId: 'foreign',
      }),
    { status: 404 },
  );
  // No tool accepts the field: only Research may say what the predecessor decided.
  await assert.rejects(
    async () =>
      await f.app.ctx.tools.call('reflection.create', f.owner, {
        previousCycleDigestId: oversized.id,
        requestId: 'by-tool',
      }),
    { status: 400 },
  );
  let wave = await f.app.ctx.reflections.create(f.owner, {
    previousCycleDigestId: oversized.id,
    requestId: 'carrying',
  });
  const lens = wave.lenses[0]!;
  const context = (await f.app.ctx.workflows.assignment(f.owner, lens.id)).context!;
  assert.ok(context.omitted.includes('previousCycle'));
  assert.ok(!context.prompt.includes('Predecessor cycle digest'));
  assert.ok(
    (
      await f.app.ctx.workflows.execution(f.owner, { instanceId: lens.id, expectedRevision: 0 })
    ).references.artifacts.includes(oversized.id),
  );
  // The digest stays with the wave through rework: no later transition rewrites it.
  const reviewer = await f.actor('Reviewer', 'reviewer');
  wave = await f.synthesize(await f.lenses(wave));
  wave = await f.verdict(wave, reviewer, false, 'synthesizing');
  assert.ok(
    (
      await f.app.ctx.workflows.execution(f.owner, {
        instanceId: wave.id,
        expectedRevision: wave.workflow.revision,
      })
    ).references.artifacts.includes(oversized.id),
  );
});

test('a reflection returned as often as its limit allows opens no more lenses and can still be approved', async (t) => {
  const f = await fixture(t, { limits: { reviewReturns: 1 } });
  const reviewer = await f.actor('Reviewer', 'reviewer');
  let wave = await f.synthesize(
    await f.lenses(await f.app.ctx.research.startReflection(f.owner, { requestId: 'wave' })),
  );
  // A lens has nothing to return to, and carries no limit of its own.
  assert.deepEqual((await f.app.ctx.workflows.evaluate(f.owner, wave.lenses[0]!.id)).limits, []);
  wave = await f.verdict(wave, reviewer, false, 'reflecting');
  assert.equal(wave.attempt, 2);
  wave = await f.synthesize(await f.lenses(wave));
  const guidance = await f.app.ctx.workflows.evaluate(f.owner, wave.id);
  assert.equal(guidance.currentGate, 'loop_limit_reached');
  assert.deepEqual(
    guidance.limits.map((limit) => [limit.name, limit.actions, limit.used, limit.max]),
    [['review_returns', ['revise_synthesis', 'restart_lenses'], 1, 1]],
  );
  const instances = (await f.app.ctx.workflows.list(f.owner)).length;
  for (const returnTo of ['reflecting', 'synthesizing'])
    await assert.rejects(async () => await f.verdict(wave, reviewer, false, returnTo), {
      code: 'loop_limit_reached',
      status: 409,
    });
  assert.equal((await f.app.ctx.workflows.list(f.owner)).length, instances);
  const after = await f.app.ctx.reflections.get(f.owner, wave.id);
  assert.deepEqual(
    [after.attempt, after.workflow, after.lenses, after.review?.verdict],
    [wave.attempt, wave.workflow, wave.lenses, null],
  );
  assert.equal((await f.verdict(wave, reviewer, true)).workflow.state, 'approved');
});

test('the reflection limit is validated as plugin configuration before anything is published', async (t) => {
  for (const config of [{ limits: { reviewReturns: 0 } }, { limits: { rounds: 2 } }, { cap: 2 }])
    await assert.rejects(async () => await fixture(t, config));
});

test('leased lens calls use exact execution evidence, retain context through release and recover independent review claims', async (t) => {
  const f = await fixture(t);
  let wave = await f.app.ctx.research.startReflection(f.owner, { requestId: 'wave' });
  const secret = token();
  const agent = await f.app.ctx.sessions.registerAgent(f.owner, {
    name: 'Lens agent',
    runnerId: 'external',
    requestId: 'agent',
    secret,
  });
  const first = wave.lenses[0]!;
  const execution = await f.app.ctx.sessions.assignAgent(secret, {
    instanceId: first.id,
    expectedRevision: 0,
    requestId: 'assign-first',
  });
  const caller = await f.app.ctx.sessions.authenticate(secret);
  assert.equal(execution.role, 'producer');
  assert.match(execution.assignment.context!.prompt, /live research access/i);
  // The lens may read the wave it belongs to, as it may read anything in the project.
  assert.ok(await f.app.ctx.tools.call('reflection.get', caller, { reflectionId: wave.id }));
  const artifact = (await f.app.ctx.tools.call('artifact.create', caller, {
    title: 'Lens evidence',
    content:
      '# Summary\nThe corpus contains no completed research.\n# Evidence\nNo empirical conclusion is claimed.',
  })) as Artifact;
  await f.app.ctx.tools.call('reflection.submit_lens', caller, {
    lensId: first.id,
    artifactId: artifact.id,
    expectedRevision: 0,
    requestId: 'submit-first',
  });
  await f.app.ctx.sessions.releaseAgentAssignment(secret, execution.id);
  await assert.rejects(
    async () =>
      await f.app.ctx.sessions.assignAgent(secret, {
        instanceId: wave.lenses[1]!.id,
        expectedRevision: 0,
        requestId: 'same-agent-second',
      }),
    { code: 'lens_independence' },
  );
  for (const lens of wave.lenses.slice(1)) {
    const actor = await f.actor(lens.perspective);
    await f.app.ctx.reflections.submitLens(actor, {
      lensId: lens.id,
      artifactId: (await f.create(actor, lens.perspective)).id,
      expectedRevision: 0,
      requestId: lens.id,
    });
  }
  wave = await f.synthesize(await f.app.ctx.reflections.get(f.owner, wave.id));
  const reviewToken = token();
  // The owner wrote the synthesis, so the review worker is directed by someone else.
  await f.app.ctx.sessions.registerAgent(await f.actor('Lead', 'operator'), {
    name: 'Review agent',
    runnerId: 'external',
    requestId: 'review-agent',
    secret: reviewToken,
  });
  const reviewExecution = await f.app.ctx.sessions.assignAgent(reviewToken, {
    instanceId: wave.id,
    expectedRevision: wave.workflow.revision,
    requestId: 'review',
  });
  assert.equal(reviewExecution.role, 'reviewer');
  const oldClaim = (await f.app.ctx.reviews.get(f.owner, wave.review!.id)).claimId;
  await f.app.ctx.sessions.releaseAgentAssignment(reviewToken, reviewExecution.id);
  await f.app.ctx.domainEvents.drain();
  assert.equal((await f.app.ctx.reviews.get(f.owner, wave.review!.id)).status, 'requested');
  const next = await f.app.ctx.sessions.assignAgent(reviewToken, {
    instanceId: wave.id,
    expectedRevision: wave.workflow.revision,
    requestId: 'review-again',
  });
  assert.notEqual((await f.app.ctx.reviews.get(f.owner, wave.review!.id)).claimId, oldClaim);
  assert.match(next.assignment.context!.prompt, /recovery/);
  assert.equal(agent.id, execution.agentId);
});

test('ordinary session workers execute a lens, synthesis and repair; unload preserves frozen assignments', async (t) => {
  const f = await fixture(t);
  let wave = await f.app.ctx.research.startReflection(f.owner, { requestId: 'leased-wave' });
  const actors: string[] = [];
  const [lens, ...others] = wave.lenses;
  const secret = token();
  const agent = await f.app.ctx.sessions.registerAgent(f.owner, {
    name: lens!.perspective,
    runnerId: 'external',
    requestId: lens!.id,
    secret,
  });
  actors.push(agent.actorId);
  const lensExecution = await f.app.ctx.sessions.assignAgent(secret, {
    instanceId: lens!.id,
    expectedRevision: 0,
    requestId: `assign-${lens!.id}`,
  });
  const lensCaller = await f.app.ctx.sessions.authenticate(secret);
  // A step is named as the record it works on is named: the wave by its title, a lens by its
  // wave and its perspective. The step's own state is the gate's, and never part of the name.
  const offered = async (id: string) =>
    (await f.app.ctx.workflows.dispatchCandidates(f.owner)).find((item) => item.instanceId === id)
      ?.label;
  assert.equal(lensExecution.assignment.label, `${wave.title}: ${lens!.perspective}`);
  assert.equal(await offered(others[0]!.id), `${wave.title}: ${others[0]!.perspective}`);
  const previous = f.app.ctx.reflections;
  await f.app.setEnabled('reflections', false);
  await assert.rejects(async () => await previous.get(f.owner, wave.id), {
    code: 'reflection_unavailable',
  });
  await f.app.setEnabled('reflections', true);
  assert.equal((await f.app.ctx.reflections.get(f.owner, wave.id)).id, wave.id);
  assert.equal(
    (await f.app.ctx.sessions.agentSelf(secret)).current!.assignment.context!.hash,
    lensExecution.assignment.context!.hash,
  );
  const artifact = (await f.app.ctx.tools.call('artifact.create', lensCaller, {
    title: lens!.perspective,
    content:
      '# Summary\nIndependent observations from the frozen corpus.\n# Evidence\nNo empirical claims without completed experiments.',
  })) as Artifact;
  await f.app.ctx.tools.call('reflection.submit_lens', lensCaller, {
    lensId: lens!.id,
    artifactId: artifact.id,
    expectedRevision: 0,
    requestId: `submit-${lens!.id}`,
  });
  await f.app.ctx.sessions.releaseAgentAssignment(secret, lensExecution.id);
  await f.app.ctx.domainEvents.drain();
  // The other four lenses are submitted by distinct producers directly; the session path is
  // the one above, and every lens author is excluded from the review all the same.
  for (const other of others) {
    const producer = await f.actor(other.perspective);
    actors.push(producer.actorId);
    await f.app.ctx.reflections.submitLens(producer, {
      lensId: other.id,
      artifactId: (await f.create(producer, other.perspective)).id,
      expectedRevision: 0,
      requestId: `submit-${other.id}`,
    });
  }
  wave = await f.app.ctx.reflections.get(f.owner, wave.id);
  assert.equal(wave.workflow.state, 'synthesizing');
  assert.equal(await offered(wave.id), wave.title);
  const synthesisToken = token();
  await f.app.ctx.sessions.registerAgent(f.owner, {
    name: 'Synthesis',
    runnerId: 'external',
    requestId: 'synthesis-agent',
    secret: synthesisToken,
  });
  const execution = await f.app.ctx.sessions.assignAgent(synthesisToken, {
    instanceId: wave.id,
    expectedRevision: wave.workflow.revision,
    requestId: 'synthesis-work',
  });
  const caller = await f.app.ctx.sessions.authenticate(synthesisToken);
  assert.equal(execution.assignment.label, wave.title);
  // Writing the next wave's plan grants no power to create it.
  await assert.rejects(
    async () =>
      await f.app.ctx.tools.call('task.create', caller, {
        title: 'Planned by synthesis',
        goal: 'Work the plan proposes',
        checks: ['Recorded'],
        requestId: 'synthesis-task',
      }),
    { code: 'execution_tool_forbidden' },
  );
  await assert.rejects(
    async () =>
      await f.app.ctx.tools.call('experiment.create', caller, {
        name: 'planned-by-synthesis',
        intent: 'Work the plan proposes',
        requestId: 'synthesis-experiment',
      }),
    { code: 'execution_tool_forbidden' },
  );
  const outputs: Artifact[] = [];
  for (const title of ['Report', 'Change specification'])
    outputs.push(
      (await f.app.ctx.tools.call('artifact.create', caller, {
        title,
        content: `# Summary\n${title}: grounded in the exact corpus and all five lens reports.`,
      })) as Artifact,
    );
  const submission = {
    reflectionId: wave.id,
    expectedRevision: wave.workflow.revision,
    reportArtifactId: outputs[0]!.id,
    changeSpecArtifactId: outputs[1]!.id,
    requestId: 'submit-synthesis',
  };
  await assert.rejects(
    f.app.ctx.tools.call('reflection.submit', caller, {
      ...submission,
      paperChangesArtifactId: outputs[0]!.id,
    }),
    { code: 'invalid_input' },
  );
  await assert.rejects(
    f.app.ctx.tools.call('paper.patch', caller, {
      kind: 'results',
      expectedRevision: 0,
      requestId: 'producer-edit',
      changes: [{ id: 'synthesis', title: 'Synthesis', content: 'Unreviewed producer text' }],
    }),
    { code: 'execution_tool_forbidden' },
  );
  wave = (await f.app.ctx.tools.call('reflection.submit', caller, submission)) as Reflection;
  await f.app.ctx.sessions.releaseAgentAssignment(synthesisToken, execution.id);
  await f.app.ctx.domainEvents.drain();
  // Lens authors, and the owner who directed the synthesis worker, are excluded from its review.
  assert.deepEqual(new Set(wave.review!.excludedActorIds), new Set([...actors, f.owner.actorId]));
  assert.equal(await offered(wave.id), wave.title);
  const reviewToken = token();
  await f.app.ctx.sessions.registerAgent(f.owner, {
    name: 'Independent review',
    runnerId: 'external',
    requestId: 'independent-review',
    secret: reviewToken,
  });
  const reviewing = await f.app.ctx.sessions.assignAgent(reviewToken, {
    instanceId: wave.id,
    expectedRevision: wave.workflow.revision,
    requestId: 'review-work',
  });
  const reviewer = await f.app.ctx.sessions.authenticate(reviewToken);
  assert.equal(reviewing.assignment.label, wave.title);
  const review = await f.app.ctx.reviews.get(f.owner, wave.review!.id);
  const repaired = (await f.app.ctx.tools.call('review.submit', reviewer, {
    reviewId: review.id,
    claimId: review.claimId!,
    expectedRevision: wave.workflow.revision,
    verdict: 'needs_changes',
    returnTo: 'reflecting',
    notes: 'Fresh lenses must examine the identified missing evidence.',
    synopsis: 'A new independent lens attempt is required to repair the identified coverage gap.',
    findings: review.criteria.map((_, i) => ({
      criterionNumber: i + 1,
      status: 'not_met',
      evidenceIds: [outputs[0]!.id],
      notes: 'The documented coverage gap must be repaired.',
    })),
    paperChanges: {
      documents: [
        {
          kind: 'results',
          expectedRevision: 0,
          changes: [
            {
              id: 'synthesis',
              title: 'Synthesis',
              content: 'The coverage gap prevents an empirical conclusion.',
            },
          ],
        },
      ],
    },
    requestId: 'return-lenses',
  })) as Reflection;
  assert.equal((await f.app.ctx.paper.read(f.owner)).documents.results.current.revision, 1);
  assert.equal(repaired.attempt, 2);
  assert.equal(repaired.lenses.length, 5);
  assert.ok(repaired.lenses.every((lens) => lens.workflow.revision === 0));
  await f.app.ctx.sessions.releaseAgentAssignment(reviewToken, reviewing.id);
  await f.app.ctx.domainEvents.drain();
});

test('synthesis admission matches review ownership for direct producers and source-bound workers', async (t) => {
  const f = await fixture(t);
  const owner = await f.actor('Wave owner');
  const outsider = await f.actor('Other producer');
  const wave = await f.lenses(
    await f.app.ctx.research.startReflection(owner, { requestId: 'owned-wave' }),
  );
  assert.equal(wave.ownerId, owner.actorId);
  assert.equal(wave.workflow.state, 'synthesizing');
  assert.equal(
    (await f.app.ctx.workflows.dispatchCandidates(outsider)).some(
      (candidate) => candidate.instanceId === wave.id,
    ),
    false,
  );
  assert.ok(
    (await f.app.ctx.workflows.dispatchCandidates(owner)).some(
      (candidate) => candidate.instanceId === wave.id,
    ),
  );
  assert.ok(
    (await f.app.ctx.workflows.dispatchCandidates(f.owner)).some(
      (candidate) => candidate.instanceId === wave.id,
    ),
    'An operator can administer another producer’s wave',
  );
  await assert.rejects(async () => await f.app.ctx.workflows.assignment(outsider, wave.id), {
    code: 'forbidden',
  });
  assert.equal((await f.app.ctx.workflows.assignment(owner, wave.id)).role, 'producer');
  const outputs = await mapAsync(
    ['Report', 'Changes'],
    async (title) => await f.create(outsider, title),
  );
  await assert.rejects(
    async () =>
      await f.app.ctx.reflections.submit(outsider, {
        reflectionId: wave.id,
        expectedRevision: wave.workflow.revision,
        reportArtifactId: outputs[0]!.id,
        changeSpecArtifactId: outputs[1]!.id,
        requestId: 'outsider-submit',
      }),
    { code: 'forbidden' },
  );
  assert.equal((await f.app.ctx.reflections.get(owner, wave.id)).review, null);
  const blockedToken = token();
  await f.app.ctx.sessions.registerAgent(outsider, {
    name: 'Other producer’s agent',
    runnerId: 'external',
    requestId: 'blocked-agent',
    secret: blockedToken,
  });
  await assert.rejects(
    async () =>
      await f.app.ctx.sessions.assignAgent(blockedToken, {
        instanceId: wave.id,
        expectedRevision: wave.workflow.revision,
        requestId: 'blocked-synthesis',
      }),
    { code: 'forbidden' },
  );
  assert.equal((await f.app.ctx.sessions.agentSelf(blockedToken)).current, null);
  const secret = token();
  await f.app.ctx.sessions.registerAgent(owner, {
    name: 'Owner’s synthesis agent',
    runnerId: 'external',
    requestId: 'owner-agent',
    secret,
  });
  const execution = await f.app.ctx.sessions.assignAgent(secret, {
    instanceId: wave.id,
    expectedRevision: wave.workflow.revision,
    requestId: 'owned-synthesis',
  });
  const worker = await f.app.ctx.sessions.authenticate(secret);
  assert.equal((await f.app.ctx.scope.authorityActor(worker)).id, owner.actorId);
  const evidence: Artifact[] = [];
  for (const title of ['Report', 'Change specification'])
    evidence.push(
      (await f.app.ctx.tools.call('artifact.create', worker, {
        title,
        content:
          '# Summary\nThe frozen evidence and five independent perspectives support these observations.',
      })) as Artifact,
    );
  const submitted = (await f.app.ctx.tools.call('reflection.submit', worker, {
    reflectionId: wave.id,
    expectedRevision: wave.workflow.revision,
    reportArtifactId: evidence[0]!.id,
    changeSpecArtifactId: evidence[1]!.id,
    requestId: 'worker-submit',
  })) as Reflection;
  assert.equal(submitted.workflow.state, 'in_review');
  assert.equal(submitted.review!.producerId, worker.actorId);
  assert.equal(submitted.review!.administrativeActorId, owner.actorId);
  await f.app.ctx.sessions.releaseAgentAssignment(secret, execution.id);
  await f.app.ctx.domainEvents.drain();
});

test('reflection reviewer authors paper edits with the verdict and main-agent edits can cause a safe retry', async (t) => {
  const f = await fixture(t);
  let wave = await f.lenses(
    await f.app.ctx.research.startReflection(f.owner, { requestId: 'paper-reflection' }),
  );
  wave = await f.synthesize(wave);
  const reviewer = await f.actor('Scientific reviewer', 'reviewer');
  const assignment = await f.app.ctx.workflows.assignment(reviewer, wave.id);
  assert.ok(JSON.stringify(assignment).includes('paperChanges'));
  const review = await f.app.ctx.reviews.start(reviewer, wave.review!.id);
  const input: ReviewApplication = {
    reviewId: review.id,
    claimId: review.claimId!,
    expectedRevision: wave.workflow.revision,
    verdict: 'pass',
    notes: 'Checked the lenses and updated the project narrative.',
    synopsis:
      'The synthesis accurately preserves the lack of empirical evidence and its limitations.',
    findings: review.criteria.map((_, i) => ({
      criterionNumber: i + 1,
      status: 'met',
      evidenceIds: [review.artifactIds[0]],
      notes: 'Verified the evidence.',
    })),
    paperChanges: {
      documents: [
        {
          kind: 'results',
          expectedRevision: 0,
          changes: [
            {
              id: 'synthesis',
              title: 'Synthesis',
              content: 'No completed experiments; no empirical conclusion is supported.',
            },
          ],
        },
      ],
    },
    requestId: 'paper-review',
  };
  await f.app.ctx.paper.patch(f.owner, {
    kind: 'results',
    expectedRevision: 0,
    requestId: 'main-edit',
    changes: [{ id: 'limits', title: 'Limits', content: 'Evidence is still being collected.' }],
  });
  await assert.rejects(f.app.ctx.tools.call('review.submit', reviewer, input), {
    code: 'paper_revision_conflict',
  });
  const guidance = await f.app.ctx.workflows.evaluate(reviewer, wave.id, {
    action: 'review',
    input: input as never,
  });
  assert.ok(
    guidance.actions
      .find((a) => a.action === 'review')
      ?.blockers.some((b) => b.code === 'paper_revision_conflict'),
  );
  assert.equal((await f.app.ctx.reviews.get(reviewer, review.id)).status, 'started');
  input.paperChanges!.documents[0].expectedRevision = 1;
  await assert.rejects(
    f.app.ctx.state.transaction(async (tx) => {
      await f.app.ctx.reviews.apply(reviewer, input, tx);
      throw Error('abort verdict');
    }),
    /abort verdict/,
  );
  assert.equal((await f.app.ctx.paper.read(f.owner)).documents.results.current.revision, 1);
  wave = (await f.app.ctx.tools.call('review.submit', reviewer, input)) as Reflection;
  assert.equal(wave.workflow.state, 'approved');
  assert.deepEqual(await f.app.ctx.tools.call('review.submit', reviewer, input), wave);
  const document = (await f.app.ctx.paper.read(f.owner)).documents.results;
  assert.equal(document.current.updatedBy, reviewer.actorId);
  assert.equal(document.current.revision, 2);
  assert.equal(document.published!.publication.reviewId, review.id);
  assert.equal(document.published!.publication.source.id, wave.id);
  assert.equal(document.current.sections.length, 2);
});

test('a leased lens reads research added after assignment through existing tools without seeing peer reports', async (t) => {
  const f = await fixture(t);
  const taskInput = {
    title: 'Existing work',
    goal: 'Check feasibility',
    checks: ['Report outcome'],
    requestId: 'existing-task',
  };
  const task = await f.app.ctx.tasks.create(f.owner, taskInput);
  const experimentInput = {
    name: 'existing-experiment',
    intent: 'Test feasibility',
    requestId: 'existing-experiment',
  };
  const experiment = await f.app.ctx.experiments.create(f.owner, experimentInput);
  const tools = (await f.app.ctx.tools.list()).map((tool) => tool.name);
  assert.equal(tools.filter((name) => name === 'reflection.create').length, 1);
  const wave = (await f.app.ctx.tools.call('reflection.create', f.owner, {
    requestId: 'live-wave',
  })) as Reflection;
  const secret = token();
  await f.app.ctx.sessions.registerAgent(f.owner, {
    name: 'Live lens',
    runnerId: 'external',
    requestId: 'live-agent',
    secret,
  });
  const execution = await f.app.ctx.sessions.assignAgent(secret, {
    instanceId: wave.lenses[0]!.id,
    expectedRevision: 0,
    requestId: 'live-assignment',
  });
  const caller = await f.app.ctx.sessions.authenticate(secret);
  const call = async (name: string, input: Record<string, unknown>) =>
    f.app.ctx.tools.call(name, caller, input);
  // A session reads whatever its project holds, including what was added after its assignment.
  const evidence = await f.create(f.owner, 'New evidence after the lens started');
  await f.app.ctx.experiments.attach(f.owner, {
    experimentId: experiment.id,
    artifactId: evidence.id,
    role: 'plan',
    path: 'plan.md',
    attemptIndex: 1,
    expectedRevision: 0,
    requestId: 'attach-later',
  });
  assert.match(
    JSON.stringify(await call('artifact.read', { artifactId: evidence.id })),
    /New evidence after the lens started/,
  );
  assert.ok(
    JSON.stringify(await call('experiment.get_state', { experimentId: experiment.id })).includes(
      evidence.id,
    ),
  );
  const delivery = await f.create(f.owner, 'Check feasibility: report outcome');
  const submitted = await f.app.ctx.tasks.submitDelivery(f.owner, {
    taskId: task.id,
    expectedRevision: task.workflow.revision,
    artifactIds: [delivery.id],
    confirmations: [
      {
        checkNumber: 1,
        status: 'met',
        evidenceIds: [delivery.id],
        notes: 'Reported the feasibility outcome.',
      },
    ],
    requestId: 'submit-existing',
  });
  assert.ok(
    JSON.stringify(await call('review.get', { reviewId: submitted.reviewId! })).includes(
      delivery.id,
    ),
  );
  assert.match(
    JSON.stringify(await call('artifact.read', { artifactId: delivery.id })),
    /report outcome/,
  );
  const taskNow = await f.app.ctx.tasks.markFailed(f.owner, {
    taskId: task.id,
    expectedRevision: submitted.workflow.revision,
    reason: 'The initial feasibility check ruled out this approach.',
    requestId: 'finish-existing',
  });
  assert.equal(taskNow.workflow.state, 'failed');
  assert.match(JSON.stringify(await call('task.get', { taskId: task.id })), /failed/);
  assert.ok(await call('paper.read', {}));
  const peer = await f.actor('Other lens');
  const peerReport = await f.create(peer, 'Private independent lens report');
  await f.app.ctx.reflections.submitLens(peer, {
    lensId: wave.lenses[1]!.id,
    artifactId: peerReport.id,
    expectedRevision: 0,
    requestId: 'peer-report',
  });
  // A peer's report is readable too (no read constraints); lens independence is asked of
  // the agent, not enforced here.
  assert.ok(await call('artifact.read', { artifactId: peerReport.id }));
  const boot = await f.app.ctx.scope.bootstrap({
    projectName: 'Other project',
    actorName: 'Other owner',
  });
  const other = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  const foreignTask = await f.app.ctx.tasks.create(other, {
    ...taskInput,
    requestId: 'other-task',
  });
  await assert.rejects(call('task.get', { taskId: foreignTask.id }), { code: 'not_found' });
  const foreignArtifact = await f.create(other, 'Other project evidence');
  await assert.rejects(call('artifact.read', { artifactId: foreignArtifact.id }), {
    code: 'not_found',
  });
  assert.equal(
    (await f.app.ctx.tasks.create(f.owner, taskInput)).id,
    task.id,
    'a committed create can still replay',
  );
  assert.equal((await f.app.ctx.experiments.create(f.owner, experimentInput)).id, experiment.id);

  const provider = f.app.ctx.reflections;
  await f.app.setEnabled('knowledge', false);
  assert.equal(f.app.status().find((plugin) => plugin.id === 'reflections')!.state, 'active');
  assert.equal(f.app.status().find((plugin) => plugin.id === 'research')!.state, 'active');
  assert.equal(f.app.ctx.reflections, provider);
  assert.ok((await f.app.ctx.tools.list()).some((tool) => tool.name === 'reflection.create'));
  assert.ok(await call('artifact.read', { artifactId: evidence.id }));
  const ownReport = (await call('artifact.create', {
    title: 'Independent report while research access is unavailable',
    content:
      '# Summary\nThe observed feasibility outcome is retained.\n# Evidence\nResearch inputs read before the outage support this observation.',
  })) as Artifact;
  assert.equal((await f.app.ctx.sessions.agentSelf(secret)).current!.id, execution.id);
  assert.ok((await f.app.ctx.workflows.assignment(f.owner, wave.lenses[2]!.id)).context);
  assert.equal(
    (await f.app.ctx.sessions.heartbeat(f.owner, { sessionId: execution.id, runnerId: 'external' }))
      .id,
    execution.id,
  );
  assert.ok(await call('reflection.lens', { lensId: wave.lenses[0]!.id }));

  await f.app.setEnabled('knowledge', true);
  assert.equal(f.app.ctx.reflections, provider);
  assert.equal((await f.app.ctx.sessions.agentSelf(secret)).current!.id, execution.id);
  assert.equal(
    (await f.app.ctx.tools.list()).filter((tool) => tool.name === 'reflection.create').length,
    1,
  );
  assert.match(
    JSON.stringify(await call('artifact.read', { artifactId: evidence.id })),
    /New evidence/,
  );

  const blocked = async () =>
    await f.app.ctx.experiments.create(f.owner, {
      ...experimentInput,
      name: 'new-experiment',
      requestId: 'blocked',
    });
  await assert.rejects(blocked, { code: 'workflow_creation_paused' });
  await f.app.setEnabled('reflections', false);
  await assert.rejects(
    blocked,
    { code: 'workflow_creation_paused' },
    'unloading the owner cannot bypass the durable pause',
  );
  await f.app.setEnabled('reflections', true);
  assert.match(
    JSON.stringify(await call('artifact.read', { artifactId: evidence.id })),
    /New evidence/,
  );
  await f.app.setEnabled('knowledge', false);
  const completed = (await call('reflection.submit_lens', {
    lensId: wave.lenses[0]!.id,
    artifactId: ownReport.id,
    expectedRevision: 0,
    requestId: 'submit-without-knowledge',
  })) as { workflow: { state: string } };
  assert.equal(completed.workflow.state, 'complete');
  await f.app.ctx.sessions.releaseAgentAssignment(secret, execution.id);
  await f.app.setEnabled('knowledge', true);
  assert.deepEqual(
    (await f.app.ctx.tools.list()).map((tool) => tool.name),
    tools,
    'no new tools',
  );
});

test('large research stays outside the assignment and live source permissions do not inflate its packet', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 12; i++)
    await f.app.ctx.tasks.create(f.owner, {
      title: `Research question ${i}`,
      goal: 'long research context '.repeat(500),
      checks: ['Verify the hypothesis.'],
      requestId: `large-${i}`,
    });
  assert.ok(JSON.stringify(await f.app.ctx.knowledge.records(f.owner)).length > 100_000);
  const wave = await f.app.ctx.research.startReflection(f.owner, { requestId: 'large-wave' });
  const secret = token();
  await f.app.ctx.sessions.registerAgent(f.owner, {
    name: 'Compact lens',
    runnerId: 'external',
    requestId: 'compact-agent',
    secret,
  });
  const execution = await f.app.ctx.sessions.assignAgent(secret, {
    instanceId: wave.lenses[0]!.id,
    expectedRevision: 0,
    requestId: 'compact-assignment',
  });
  assert.ok(Buffer.byteLength(JSON.stringify(execution.assignment)) < 16_000);
  assert.ok(!execution.assignment.context!.prompt.includes('long research context'));
});

test('standalone Reflections can create and complete its own work without Research or Knowledge', async (t) => {
  const f = await fixture(t);
  await f.app.setEnabled('knowledge', false);
  assert.equal(f.app.status().find((plugin) => plugin.id === 'reflections')!.state, 'active');
  const wave = await f.app.ctx.reflections.create(f.owner, { requestId: 'standalone-wave' });
  assert.ok((await f.app.ctx.workflows.assignment(f.owner, wave.lenses[0]!.id)).context);
  const submitted = await f.synthesize(await f.lenses(wave));
  const approved = await f.verdict(
    submitted,
    await f.actor('Standalone reviewer', 'reviewer'),
    true,
  );
  assert.equal(approved.workflow.state, 'approved');
  assert.equal((await f.app.ctx.reflections.approved(f.owner, wave.id)).id, wave.id);
});

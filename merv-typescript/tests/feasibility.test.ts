import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller, ReviewApplication, ReviewRequest } from '@merv/contracts';
import {
  feasibilityShortfalls,
  parseFeasibility,
  type FeasibilityStatement,
} from '@merv/experiments/evidence';
import type { Experiment, ExperimentAttach } from '@merv/experiments/types';
import { createApp } from './fixtures/app.js';
import type { ApplicationConfig } from '../src/config.js';
import { feasibilityStatement } from './feasibility-fixture.js';

const statement = (): FeasibilityStatement => ({
  formatVersion: 1,
  resources: [
    {
      kind: 'data',
      name: 'receipt corpus',
      unit: 'receipts',
      required: 900,
      available: 973,
      basis: 'Row count of the retained corpus inventory.',
    },
    {
      kind: 'compute',
      name: 'GPU hours',
      unit: 'hours',
      required: 6.5,
      available: 24,
      basis: 'Measured 40 steps per minute on the assigned runner.',
    },
  ],
  dependencies: [
    { name: 'base checkpoint', present: true, basis: 'Listed in the model inventory.' },
  ],
  blockers: [],
});

test('a well-formed feasibility statement parses to itself and admits the design', () => {
  const parsed = parseFeasibility(JSON.stringify(statement()));
  assert.deepEqual(parsed, statement());
  assert.deepEqual(feasibilityShortfalls(parsed), []);
  assert.deepEqual(
    feasibilityShortfalls(
      parseFeasibility(JSON.stringify({ ...statement(), dependencies: [], blockers: [] })),
    ),
    [],
  );
});

test('a malformed feasibility statement is refused with the place it went wrong', () => {
  const broken: [string, unknown, RegExp][] = [
    ['text that is not JSON', 'not json', /valid JSON/],
    ['an unknown key', { ...statement(), verdict: 'feasible' }, /top level/],
    [
      'an unknown resource key',
      { ...statement(), resources: [{ ...statement().resources[0], spare: 1 }] },
      /resources\.0/,
    ],
    [
      'a negative quantity',
      { ...statement(), resources: [{ ...statement().resources[0], available: -1 }] },
      /resources\.0\.available/,
    ],
    [
      'an unknown kind',
      { ...statement(), resources: [{ ...statement().resources[0], kind: 'budget' }] },
      /resources\.0\.kind/,
    ],
    [
      'a blank basis',
      { ...statement(), resources: [{ ...statement().resources[0], basis: ' ' }] },
      /resources\.0\.basis/,
    ],
    ['no resources', { ...statement(), resources: [] }, /resources/],
    ['no data resource', { ...statement(), resources: [statement().resources[1]] }, /data/],
    ['another format version', { ...statement(), formatVersion: 2 }, /formatVersion/],
    ['a missing blockers list', { ...statement(), blockers: undefined }, /blockers/],
    ['too many blockers', { ...statement(), blockers: Array(21).fill('Blocked.') }, /blockers/],
  ];
  for (const [name, value, message] of broken)
    assert.throws(
      () => parseFeasibility(typeof value === 'string' ? value : JSON.stringify(value)),
      { code: 'invalid_experiment_evidence', message },
      name,
    );
});

test('each shortfall, absent dependency and known blocker is named', () => {
  const short = statement();
  short.resources[0].required = 4000;
  short.dependencies.push({
    name: 'tokenizer',
    present: false,
    basis: 'Not in the model inventory.',
  });
  short.blockers.push('The runner has no GPU driver.');
  assert.deepEqual(feasibilityShortfalls(short), [
    'data receipt corpus: 973 receipts available, 4000 required',
    'dependency tokenizer is not present',
    'blocker: The runner has no GPU driver.',
  ]);
  const exact = statement();
  exact.resources[0].required = 973;
  assert.deepEqual(feasibilityShortfalls(exact), [], 'Exactly enough is enough');
});

const plan =
  '# Summary\nCompare two methods.\n# Objective & hypothesis\nA improves held-out accuracy.\n# Evaluation\nUse the same held-out examples, baseline, metric and denominator.\n';

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-feasibility-'));
  const config = JSON.parse(
    readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
  ) as ApplicationConfig;
  // The real server composition, without opening HTTP listeners.
  config.plugins = config.plugins.filter(
    ({ id }) =>
      !['api', 'identity', 'ui'].includes(id) && !id.endsWith('-api') && !id.endsWith('-ui'),
  );
  const app = await createApp({ directory, config });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const boot = await app.ctx.scope.bootstrap({ projectName: 'Feasibility', actorName: 'Owner' });
  const owner: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  const issued = await app.ctx.scope.issueActor(owner, { name: 'Reviewer', role: 'reviewer' });
  const reviewer: Caller = {
    projectId: owner.projectId,
    actorId: issued.actor.id,
    credentialId: issued.credential.id,
  };
  let sequence = 0;
  const id = () => `feasibility-${++sequence}`;
  const attach = async (
    experiment: Experiment,
    role: ExperimentAttach['role'],
    content: string,
    path = role === 'plan' ? 'plan.md' : `${role}.json`,
  ) => {
    const artifact = await app.ctx.artifacts.create(owner, {
      title: role,
      content,
      mediaType: role === 'plan' ? 'text/markdown' : 'application/json',
    });
    return await app.ctx.experiments.attach(owner, {
      experimentId: experiment.id,
      artifactId: artifact.id,
      role,
      path,
      attemptIndex: experiment.attempt.index,
      expectedRevision: experiment.workflow.revision,
      requestId: id(),
    });
  };
  const submit = async (experiment: Experiment) =>
    await app.ctx.experiments.transition(owner, {
      experimentId: experiment.id,
      expectedRevision: experiment.workflow.revision,
      transition: 'submit_design',
      requestId: id(),
    });
  const verdict = (
    experiment: Experiment,
    review: ReviewRequest,
    feasibility: { status: 'met' | 'waived'; evidenceIds: string[] },
  ): ReviewApplication => ({
    reviewId: review.id,
    claimId: review.claimId!,
    expectedRevision: experiment.workflow.revision,
    verdict: 'pass',
    notes: 'Independently checked the retained design.',
    synopsis: 'The design and its stated requirements were independently assessed.',
    findings: review.criteria.map((_, index) => ({
      criterionNumber: index + 1,
      status: 'met',
      evidenceIds: [review.artifactIds[0]!],
      notes: 'I inspected the retained evidence for this criterion.',
      ...(review.requiredCriteria?.includes(index + 1) ? feasibility : {}),
    })),
    requestId: id(),
  });
  return { app, owner, reviewer, id, attach, submit, verdict };
}
const code = (value: string) => ({ code: value });

test('a design cannot be submitted without a feasibility statement that admits it', async (t) => {
  const f = await fixture(t);
  const experiments = f.app.ctx.experiments;
  const e = await experiments.create(f.owner, {
    name: 'Gated',
    intent: 'Compare two methods.',
    requestId: f.id(),
  });
  assert.equal(e.workflow.version, 5);
  await f.attach(e, 'plan', plan);
  const blockers = async () =>
    (await f.app.ctx.workflows.evaluate(f.owner, e.id)).actions
      .find((item) => item.action === 'submit_design')!
      .blockers.map((blocker) => blocker.code);
  assert.deepEqual(await blockers(), ['experiment_evidence_required']);
  await assert.rejects(f.submit(e), {
    code: 'experiment_evidence_required',
    message: /feasibility/,
  });

  for (const malformed of [
    'not json',
    feasibilityStatement({ verdict: 'feasible' } as Partial<FeasibilityStatement>),
    feasibilityStatement({ resources: [] }),
    feasibilityStatement({
      resources: [{ ...statement().resources[0], available: -1 }],
    }),
    feasibilityStatement({ resources: [statement().resources[1]] }),
  ])
    await assert.rejects(
      f.attach(e, 'feasibility', malformed),
      code('invalid_experiment_evidence'),
    );

  const short = statement();
  short.resources[0].required = 4000;
  const refused: [Partial<FeasibilityStatement>, RegExp][] = [
    [{ resources: short.resources }, /receipt corpus: 973 receipts available, 4000 required/],
    [
      { dependencies: [{ name: 'tokenizer', present: false, basis: 'Not in the inventory.' }] },
      /dependency tokenizer is not present/,
    ],
    [{ blockers: ['The runner has no GPU driver.'] }, /blocker: The runner has no GPU driver\./],
  ];
  for (const [change, message] of refused) {
    await f.attach(e, 'feasibility', feasibilityStatement(change));
    assert.deepEqual(await blockers(), ['experiment_infeasible']);
    await assert.rejects(f.submit(e), { code: 'experiment_infeasible', message });
    assert.equal((await experiments.get(f.owner, e.id)).workflow.state, 'planned');
  }

  // A statement at another path replaces the refused one, so exactly one is current.
  const admitted = await f.attach(
    e,
    'feasibility',
    feasibilityStatement(),
    'feasibility-measured.json',
  );
  assert.deepEqual(await blockers(), []);
  const pending = await f.submit(e);
  assert.equal(pending.workflow.state, 'design_review');
  assert.deepEqual(
    pending.submissions[0].evidence.map((evidence) => [evidence.role, evidence.path]),
    [
      ['plan', 'plan.md'],
      ['feasibility', 'feasibility-measured.json'],
    ],
  );
  const review = await f.app.ctx.reviews.get(f.reviewer, pending.reviewId!);
  assert.equal(review.criteria.length, 4);
  assert.match(review.criteria[3], /feasibility statement/);
  assert.deepEqual(review.requiredCriteria, [4]);
  assert.ok(review.artifactIds.includes(admitted.artifactId));
});

test('a design review cannot waive feasibility, and its finding cites the statement', async (t) => {
  const f = await fixture(t);
  const experiments = f.app.ctx.experiments;
  const e = await experiments.create(f.owner, {
    name: 'Reviewed',
    intent: 'Compare two methods.',
    requestId: f.id(),
  });
  // The planner is told of the statement where it is told of the plan, and shown its shape.
  const planning = await f.app.ctx.workflows.assignment(f.owner, e.id);
  assert.match(planning.brief, /Attach it as role feasibility/);
  assert.match(planning.handoff.instruction, /Attach it as role feasibility/);
  assert.equal(planning.context!.typeVersion, 9);
  assert.match(planning.context!.prompt, /"feasibilityFormat":\{"formatVersion":1/);
  await f.attach(e, 'plan', plan);
  const marked = statement();
  marked.resources[0].basis = 'Row count of inventory FEASIBILITY_BASIS_7731.';
  const attached = await f.attach(e, 'feasibility', feasibilityStatement(marked));
  const pending = await f.submit(e);
  const review = await f.app.ctx.reviews.start(f.reviewer, pending.reviewId!);
  const reviewing = await f.app.ctx.workflows.assignment(f.reviewer, e.id);
  assert.match(reviewing.brief, /Criterion 4 is required/);
  assert.match(reviewing.context!.prompt, /"requiredCriteria":\[4\]/);
  const plans = [review.artifactIds[0]!];
  assert.notEqual(plans[0], attached.artifactId);

  await assert.rejects(
    experiments.submitReview(
      f.reviewer,
      f.verdict(pending, review, { status: 'waived', evidenceIds: [] }),
    ),
    code('criterion_not_waivable'),
  );
  await assert.rejects(
    f.app.ctx.reviews.apply(
      f.reviewer,
      f.verdict(pending, review, { status: 'met', evidenceIds: plans }),
    ),
    code('feasibility_not_cited'),
  );
  const held = await experiments.get(f.owner, e.id);
  assert.equal(held.workflow.state, 'design_review');
  assert.equal(held.workflow.revision, pending.workflow.revision);
  assert.equal((await f.app.ctx.reviews.get(f.reviewer, review.id)).verdict, null);

  const running = await experiments.submitReview(
    f.reviewer,
    f.verdict(pending, review, { status: 'met', evidenceIds: [attached.artifactId] }),
  );
  assert.equal(running.workflow.state, 'running');
  // The admitted statement travels with the approved plan into execution.
  assert.match(
    (await f.app.ctx.workflows.assignment(f.owner, e.id)).context!.prompt,
    /FEASIBILITY_BASIS_7731/,
  );
});

test('an experiment already on version 3 finishes its design under the rules it started with', async (t) => {
  const f = await fixture(t);
  const experiments = f.app.ctx.experiments;
  // Version 3 no longer starts experiments, so start one the way a live row was started.
  const program = (experiments as unknown as { program: { handleFor(version: number): unknown } })
    .program;
  const handleFor = program.handleFor.bind(program);
  program.handleFor = (version) => handleFor(version === 5 ? 3 : version);
  const e = await experiments.create(f.owner, {
    name: 'Legacy',
    intent: 'Compare two methods.',
    requestId: f.id(),
  });
  program.handleFor = handleFor;
  assert.equal(e.workflow.version, 3);
  const planning = await f.app.ctx.workflows.assignment(f.owner, e.id);
  assert.doesNotMatch(planning.brief, /role feasibility/);
  assert.doesNotMatch(planning.context!.prompt, /"feasibilityFormat":/);
  await assert.rejects(
    f.attach(e, 'feasibility', feasibilityStatement()),
    code('invalid_experiment_role'),
  );
  await f.attach(e, 'plan', plan);
  const pending = await f.submit(e);
  const review = await f.app.ctx.reviews.start(f.reviewer, pending.reviewId!);
  assert.equal(review.criteria.length, 3);
  assert.equal('requiredCriteria' in review, false);
  assert.doesNotMatch(
    (await f.app.ctx.workflows.assignment(f.reviewer, e.id)).brief,
    /Criterion 4 is required/,
  );
  const input = f.verdict(pending, review, { status: 'met', evidenceIds: [] });
  input.findings![2] = { ...input.findings![2], status: 'waived', evidenceIds: [] };
  assert.equal((await experiments.submitReview(f.reviewer, input)).workflow.state, 'running');
});

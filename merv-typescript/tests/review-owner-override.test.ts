/**
 * The founder's ruling of 2026-09-25: a review is decided by an independent agent by default,
 * and the person who owns the project may still decide any review, as owner. The override is a
 * deliberate claim (review.start with override), taken only by that person acting as themself,
 * and it is on the record wherever the review is.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService, digest } from '@merv/contracts';
import type { Artifact, Caller, Data, ReviewRequest, Role, Task } from '@merv/contracts';
import type { Experiment } from '@merv/experiments/types';
import type { Reflection } from '@merv/reflections/types';
import { ArtifactStore } from '@merv/artifacts';
import { DiskBlobs } from '@merv/blobs';
import { ReviewService } from '@merv/reviews';
import { reviewToolsPlugin } from '@merv/reviews/tools';
import { createApp } from './fixtures/app.js';
import { fixture as piFixture } from './fixtures/pi.js';
import { confirmedDelivery } from './fixtures/task-evidence.js';
import { assessment } from './fixtures/review-verdict.js';
import { citedEvidence, feasibilityStatement } from './feasibility-fixture.js';

const issuer = 'https://identity.example/auth/v1';
const expiresAt = () => new Date(Date.now() + 3_600_000).toISOString();

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-owner-override-'));
  const app = await createApp({ directory, api: true, port: 0 });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const { scope, sessions, tools, reviews, workflows } = app.ctx;
  const login = async (subject: string) =>
    await scope.acceptVerifiedIdentity({ issuer, subject, expiresAt: expiresAt() });
  const person = await login('founder');
  const project = await scope.createProject(person, { name: 'Owner', requestId: 'project' });
  // The founder signed in, and the same person on their own key.
  const founder = await scope.caller(person, project.id);
  const key = await scope.caller({
    kind: 'key',
    key: await scope.authenticateKey(
      (await scope.createKey(person, { projectId: project.id })).token,
    ),
  });
  let seq = 0;
  const member = async (role: Role) => {
    const subject = `member-${++seq}`;
    await scope.addMember(person, project.id, { subject, role });
    return await scope.caller(await login(subject), project.id);
  };
  /** A machine actor with an actor credential: never a person, whatever its role. */
  const machine = async (role: Role): Promise<Caller> => {
    const issued = await scope.issueActor(founder, { name: `Machine ${++seq}`, role });
    return {
      actorId: issued.actor.id,
      projectId: project.id,
      credentialId: issued.credential.id,
    };
  };
  /** A worker whose every lease `source` directs. */
  const worker = async (source: Caller) => {
    const token = `ms_${randomBytes(32).toString('base64url')}`;
    await sessions.registerAgent(source, {
      name: `Worker ${++seq}`,
      runnerId: 'external',
      requestId: `register-${seq}`,
      secret: token,
    });
    return {
      token,
      assign: async (subject: { id: string; workflow: { revision: number } }) =>
        await sessions.assignAgent(token, {
          instanceId: subject.id,
          expectedRevision: subject.workflow.revision,
          requestId: `assign-${++seq}`,
        }),
      caller: async () => await sessions.authenticate(token),
    };
  };
  const call = async <T>(name: string, caller: Caller, input: Data) =>
    (await tools.call(name, caller, input)) as T;
  const task = async (by: Caller) =>
    await app.ctx.tasks.create(by, {
      title: `Task ${++seq}`,
      goal: 'Verify addition.',
      checks: ['Two plus three equals five.'],
      requestId: `task-${seq}`,
    });
  const deliver = async (by: Caller, subject: Task) => {
    const proof = await call<Artifact>('artifact.create', by, {
      title: 'Proof',
      content: 'Observed 2 + 3 = 5.',
    });
    return await call<Task>(
      'task.submit_delivery',
      by,
      confirmedDelivery({
        taskId: subject.id,
        expectedRevision: subject.workflow.revision,
        artifactIds: [proof.id],
        requestId: `deliver-${++seq}`,
      }),
    );
  };
  /** A complete verdict on the claimed review, cited as `cite` says. */
  const verdict = (
    review: ReviewRequest,
    expectedRevision: number,
    value: 'pass' | 'needs_changes' | 'fail' = 'pass',
    cite: (number: number) => string[] = () => [...review.artifactIds],
  ): Data => ({
    reviewId: review.id,
    claimId: review.claimId!,
    verdict: value,
    notes: 'The owner checked the retained evidence against every criterion.',
    synopsis: assessment(review).synopsis,
    findings: review.criteria.map((_, index) => ({
      criterionNumber: index + 1,
      status: value === 'pass' ? 'met' : 'not_met',
      evidenceIds: value === 'pass' ? cite(index + 1) : [],
      notes: `The owner assessed criterion ${index + 1} against the pinned evidence.`,
    })),
    expectedRevision,
    requestId: `verdict-${++seq}`,
  });
  const action = async (caller: Caller, instanceId: string, tool: string) =>
    (await workflows.evaluate(caller, instanceId)).actions.find((item) => item.tool === tool)!;
  const events = async (reviewId: string, type: string) =>
    (await app.ctx.state.events(project.id)).filter(
      (event) => event.subjectId === reviewId && event.type === type,
    );
  return {
    app,
    reviews,
    founder,
    key,
    member,
    machine,
    worker,
    call,
    task,
    deliver,
    verdict,
    action,
    events,
  };
}

test('the founder decides, only as owner, the delivery of a worker the founder directed, and it is recorded as an override', async (t) => {
  const f = await fixture(t);
  const task = await f.task(f.founder);
  // In production every worker is directed by the founder's key.
  const hand = await f.worker(f.key);
  const work = await hand.assign(task);
  const delivered = await f.deliver(await hand.caller(), task);
  await f.app.ctx.sessions.releaseAgentAssignment(hand.token, work.id);
  const reviewId = delivered.reviewId!;
  const requested = await f.reviews.get(f.founder, reviewId);
  assert.deepEqual(requested.excludedActorIds, [f.founder.actorId]);
  assert.equal(requested.overridable, true, 'the owner may decide it as owner');

  // The default stands: the owner's ordinary claim is refused, signed in or on the key.
  for (const caller of [f.founder, f.key])
    await assert.rejects(f.call('review.start', caller, { reviewId }), {
      code: 'review_independence',
    });
  assert.equal((await f.action(f.founder, task.id, 'review.start')).status, 'blocked');
  assert.equal((await f.reviews.get(f.founder, reviewId)).status, 'requested');

  // Deciding as owner is one deliberate claim; its verdict is the ordinary one.
  const claimed = await f.call<ReviewRequest>('review.start', f.founder, {
    reviewId,
    override: true,
  });
  assert.deepEqual(
    [claimed.status, claimed.reviewerId, claimed.override],
    ['started', f.founder.actorId, true],
  );
  assert.equal((await f.reviews.get(f.founder, reviewId)).overridable, undefined);
  assert.notEqual((await f.action(f.founder, task.id, 'review.submit')).status, 'blocked');
  const done = await f.call<Task>(
    'review.submit',
    f.founder,
    f.verdict(claimed, delivered.workflow.revision),
  );
  assert.equal(done.workflow.state, 'done');
  const decided = await f.reviews.get(f.founder, reviewId);
  assert.deepEqual(
    [decided.verdict, decided.reviewerId, decided.override],
    ['pass', f.founder.actorId, true],
  );
  assert.deepEqual(
    (await f.events(reviewId, 'review.started')).map((event) => event.data.override),
    [true],
  );
  assert.deepEqual(
    (await f.events(reviewId, 'review.submitted')).map((event) => event.data.override),
    [true],
  );
});

test('the owner’s key, which agents hold, is never the owner, and the signed-in owner returns the work like any reviewer', async (t) => {
  const f = await fixture(t);
  const task = await f.task(f.founder);
  const delivered = await f.deliver(f.founder, task);
  const reviewId = delivered.reviewId!;
  // Nothing points an agent on the key at the override, and the key cannot take it.
  const [start] = (await f.app.ctx.tools.describe(f.key)).filter(
    (tool) => tool.name === 'review.start',
  );
  assert.doesNotMatch(start!.description ?? '', /override/i);
  assert.equal((await f.reviews.get(f.key, reviewId)).overridable, undefined);
  await assert.rejects(f.call('review.start', f.key, { reviewId, override: true }), {
    code: 'review_independence',
  });
  assert.equal((await f.reviews.get(f.founder, reviewId)).status, 'requested');
  const claimed = await f.call<ReviewRequest>('review.start', f.founder, {
    reviewId,
    override: true,
  });
  assert.deepEqual(
    [claimed.reviewerId, claimed.producerId],
    [f.founder.actorId, f.founder.actorId],
  );
  // A retry of the claim, with or without the flag, is the same claim; the key's is not.
  for (const input of [{ reviewId }, { reviewId, override: true }] as Data[]) {
    assert.equal(
      (await f.call<ReviewRequest>('review.start', f.founder, input)).claimId,
      claimed.claimId,
    );
    await assert.rejects(f.call('review.start', f.key, input), { code: 'review_independence' });
  }
  const returning = f.verdict(claimed, delivered.workflow.revision, 'needs_changes');
  // The key shares the person's actor, and still cannot give the person's verdict.
  await assert.rejects(f.call('review.submit', f.key, returning), {
    code: 'review_independence',
  });
  const returned = await f.call<Task>('review.submit', f.founder, returning);
  assert.equal(returned.workflow.state, 'in_progress');
  const decided = await f.reviews.get(f.founder, reviewId);
  assert.deepEqual([decided.verdict, decided.override], ['needs_changes', true]);
});

test('no worker, machine actor, non-operator member or other person decides as owner, and an independent claim carries no override', async (t) => {
  const f = await fixture(t);
  const task = await f.task(f.founder);
  const delivered = await f.deliver(f.founder, task);
  const reviewId = delivered.reviewId!;
  const reviewer = await f.member('reviewer');
  const operatorMachine = await f.machine('operator');
  // A worker the founder directs, holding a lease elsewhere, speaks for the founder.
  const elsewhere = await f.deliver(operatorMachine, await f.task(operatorMachine));
  const hand = await f.worker(f.key);
  await hand.assign(elsewhere);
  const leased = await hand.caller();
  for (const caller of [reviewer, operatorMachine, leased]) {
    assert.equal((await f.reviews.get(caller, reviewId)).overridable, undefined);
    await assert.rejects(f.reviews.start(caller, reviewId, undefined, true), {
      code: 'review_independence',
    });
  }
  assert.equal((await f.reviews.get(f.founder, reviewId)).status, 'requested');
  // An independent reviewer claims it the ordinary way, and nothing records an override.
  const claimed = await f.call<ReviewRequest>('review.start', reviewer, { reviewId });
  assert.equal(claimed.override, undefined);
  const done = await f.call<Task>(
    'review.submit',
    reviewer,
    f.verdict(claimed, delivered.workflow.revision),
  );
  assert.equal(done.workflow.state, 'done');
  assert.equal((await f.reviews.get(f.founder, reviewId)).override, undefined);
  assert.deepEqual(
    (await f.events(reviewId, 'review.submitted')).map((event) => event.data.override),
    [undefined],
  );
  // Another operator member is a person too, but the founder's claim is not theirs to submit.
  const second = await f.task(f.founder);
  const again = await f.deliver(f.founder, second);
  const owner = await f.call<ReviewRequest>('review.start', f.founder, {
    reviewId: again.reviewId!,
    override: true,
  });
  const colleague = await f.member('operator');
  await assert.rejects(
    f.call('review.submit', colleague, {
      ...f.verdict(owner, again.workflow.revision),
      claimId: owner.claimId,
    }),
    { code: 'review_independence' },
  );
});

test('the owner decides an experiment’s design and its results as owner', async (t) => {
  const f = await fixture(t);
  const { experiments, artifacts } = f.app.ctx;
  let experiment = await experiments.create(f.founder, {
    name: 'Owner-decided',
    intent: 'Test the hypothesis.',
    requestId: 'experiment',
  });
  const attach = async (role: string, content: string, markdown: boolean) => {
    const artifact = await artifacts.create(f.founder, {
      title: role,
      content,
      mediaType: markdown ? 'text/markdown' : 'application/json',
    });
    await experiments.attach(f.founder, {
      experimentId: experiment.id,
      attemptIndex: experiment.attempt.index,
      expectedRevision: experiment.workflow.revision,
      artifactId: artifact.id,
      role: role as never,
      path: `${role}.${markdown ? 'md' : 'json'}`,
      requestId: `attach-${role}`,
    });
  };
  const decide = async (stage: string) => {
    const reviewId = experiment.reviewId!;
    await assert.rejects(f.reviews.start(f.founder, reviewId), { code: 'review_independence' });
    assert.equal((await f.reviews.get(f.founder, reviewId)).overridable, true, stage);
    const claimed = await f.call<ReviewRequest>('review.start', f.founder, {
      reviewId,
      override: true,
    });
    const current = await experiments.get(f.founder, experiment.id);
    experiment = await f.call<Experiment>(
      'review.submit',
      f.founder,
      f.verdict(claimed, current.workflow.revision, 'pass', (number) =>
        citedEvidence(current, claimed, number),
      ),
    );
    assert.equal((await f.reviews.get(f.founder, reviewId)).override, true, stage);
  };
  await attach(
    'plan',
    '# Summary\nA paired comparison.\n# Objective & hypothesis\nThe change should improve accuracy.\n# Evaluation\nCompare two fixed seeds.',
    true,
  );
  await attach('feasibility', feasibilityStatement(), false);
  experiment = await experiments.transition(f.founder, {
    experimentId: experiment.id,
    expectedRevision: experiment.workflow.revision,
    transition: 'submit_design',
    requestId: 'design',
  });
  await decide('design');
  assert.equal(experiment.workflow.state, 'running');
  await attach('result', '{"accuracy":0.5}', false);
  await attach(
    'report',
    '# Summary\nThe result refuted the hypothesis.\n# Results\nmetrics_exhibit.json reports the observations.\n# Deviations from plan\nNone.\n# Conclusion\nNo improvement was observed.',
    true,
  );
  experiment = await experiments.transition(f.founder, {
    experimentId: experiment.id,
    expectedRevision: experiment.workflow.revision,
    transition: 'submit_results',
    requestId: 'results',
  });
  await decide('results');
  assert.equal(experiment.workflow.state, 'complete');
});

test('the owner who wrote a lens decides the reflection wave as owner', async (t) => {
  const f = await fixture(t);
  const { reflections, research, artifacts } = f.app.ctx;
  const write = async (by: Caller, title: string) =>
    await artifacts.create(by, {
      title,
      content: `# Summary\n${title}: source-linked observation.\n# Evidence\nNo completed experiments in the pinned corpus; no empirical conclusion is claimed.`,
    });
  const wave = await research.startReflection(f.founder, { requestId: 'wave' });
  for (const [index, lens] of wave.lenses.entries()) {
    const by = index === 0 ? f.founder : await f.machine('producer');
    await reflections.submitLens(by, {
      lensId: lens.id,
      artifactId: (await write(by, lens.perspective)).id,
      expectedRevision: 0,
      requestId: `lens-${index}`,
    });
  }
  const synthesizing = await reflections.get(f.founder, wave.id);
  const submitted = await reflections.submit(f.founder, {
    reflectionId: wave.id,
    reportArtifactId: (await write(f.founder, 'Synthesis')).id,
    changeSpecArtifactId: (await write(f.founder, 'Changes')).id,
    expectedRevision: synthesizing.workflow.revision,
    requestId: 'synthesis',
  });
  const reviewId = submitted.review!.id;
  await assert.rejects(f.call('review.start', f.founder, { reviewId }), {
    code: 'review_independence',
  });
  const claimed = await f.call<ReviewRequest>('review.start', f.founder, {
    reviewId,
    override: true,
  });
  assert.notEqual((await f.action(f.founder, wave.id, 'review.submit')).status, 'blocked');
  const approved = await f.call<Reflection>(
    'review.submit',
    f.founder,
    f.verdict(claimed, submitted.workflow.revision),
  );
  assert.equal(approved.workflow.state, 'approved');
  assert.equal((await f.reviews.get(f.founder, reviewId)).override, true);
});

test('where no independent reviewer is left the owner may still decide, and a changed provenance refuses the verdict all the same', async (t) => {
  const f = await fixture(t);
  const producer = await f.machine('producer');
  const proof = await f.app.ctx.artifacts.create(producer, {
    title: 'Proof',
    content: 'Observed.',
  });
  let excluded = [f.founder.actorId];
  const certificate = () => {
    const body = {
      revalidate: true as const,
      formatVersion: 1 as const,
      provider: 'fixture',
      reference: 'subject',
      sourceHash: digest(excluded),
      excludedActorIds: [...excluded].sort(),
    };
    return { ...body, hash: digest(body) };
  };
  t.after(f.reviews.provenance('fixture').register(async () => certificate()));
  const requested = await f.reviews.request(producer, {
    subjectId: 'subject',
    subjectRevision: 0,
    producerId: producer.actorId,
    artifactIds: [proof.id],
    criteria: ['Correct'],
    provenanceOwner: 'fixture',
    requestId: 'certified',
  });
  const read = await f.reviews.get(f.founder, requested.id);
  assert.ok(read.waiting, 'no independent reviewer is left');
  assert.equal(read.overridable, true);
  await f.reviews.start(f.founder, requested.id, undefined, true);
  await f.reviews.checkSubmit(f.founder, requested.id);
  excluded = [f.founder.actorId, (await f.machine('operator')).actorId];
  await assert.rejects(f.reviews.checkSubmit(f.founder, requested.id), {
    code: 'review_provenance_changed',
  });
});

test('the database admits an excluded reviewer only on an owner override, and recovery clears it', async (t) => {
  const f = await fixture(t);
  const delivered = await f.deliver(f.founder, await f.task(f.founder));
  const reviewId = delivered.reviewId!;
  const { state } = f.app.ctx;
  const write = (sql: string, ...values: unknown[]) =>
    state.transaction(async (tx) => {
      await tx.run(sql, ...(values as never[]));
    });
  // The producer, and an excluded contributor, are refused unless the claim is an override.
  await assert.rejects(
    write(
      "UPDATE reviews SET status='started',reviewer_id=?,claim_id='c' WHERE id=?",
      f.founder.actorId,
      reviewId,
    ),
    { code: 'state_constraint' },
  );
  await assert.rejects(write('UPDATE reviews SET owner_override=true WHERE id=?', reviewId), {
    code: 'state_constraint',
  });
  const claimed = await f.reviews.start(f.founder, reviewId, undefined, true);
  // Losing review permission releases an override claim like any other.
  const event = await state.transaction(
    async (tx) =>
      await state.appendEvent(tx, {
        projectId: claimed.projectId,
        actorId: f.founder.actorId,
        type: 'actor.permissions_changed',
        subjectId: f.founder.actorId,
        data: { beforeRole: 'operator', role: 'reader' },
      }),
  );
  await state.transaction(
    async (tx) => await (f.reviews as ReviewService).actorPermissionsChanged(event, tx),
  );
  const released = await f.reviews.get(f.founder, reviewId);
  assert.deepEqual(
    [released.status, released.reviewerId, released.override],
    ['requested', null, undefined],
  );
});

test('an agent may only propose deciding as owner, and the person’s Run takes it as them', async (t) => {
  const f = await piFixture(t);
  const artifacts = await createService(
    new ArtifactStore(f.state, f.scope, new DiskBlobs(mkdtempSync(join(tmpdir(), 'merv-owner-')))),
  );
  const reviews = await createService(new ReviewService(f.state, f.scope, artifacts));
  t.after(() => reviews.close());
  reviewToolsPlugin.apply({
    tools: f.tools,
    reviews,
    effect: (register: () => () => Promise<void>) => void t.after(register()),
  } as never);
  const person = await f.scope.acceptVerifiedIdentity({
    issuer,
    subject: 'olive',
    expiresAt: expiresAt(),
  });
  const project = await f.scope.createProject(person, { name: 'Agent', requestId: 'agent' });
  const owner = await f.scope.caller(person, project.id);
  const robot = await f.scope.issueActor(owner, { name: 'Robot', role: 'producer' });
  const producer = { actorId: robot.actor.id, projectId: project.id };
  const proof = await artifacts.create(producer, { title: 'Proof', content: 'Observed.' });
  const review = await reviews.request(owner, {
    subjectId: 'subject',
    subjectRevision: 0,
    producerId: producer.actorId,
    administrativeActorId: owner.actorId,
    excludedActorIds: [owner.actorId],
    artifactIds: [proof.id],
    criteria: ['Correct'],
    requestId: 'request',
  });
  const key = await f.scope.caller({
    kind: 'key',
    key: await f.scope.authenticateKey(
      (await f.scope.createKey(person, { projectId: project.id })).token,
    ),
  });
  const { token, work, input } = await f.begun(owner);
  const agent = (name: string, value: object) => f.pi.tool(token, { ...input, name, input: value });
  // The agent reads that its person may decide it as owner, and can only propose that.
  assert.equal(
    ((await agent('review.get', { reviewId: review.id })) as ReviewRequest).overridable,
    true,
  );
  const propose = async () =>
    (
      (await agent('review.start', { reviewId: review.id, override: true })) as {
        proposed: { id: string };
      }
    ).proposed.id;
  const [onKey, asPerson] = [await propose(), await propose()];
  const conversation: Caller = {
    actorId: owner.actorId,
    projectId: project.id,
    conversation: {
      id: input.conversationId,
      commandId: input.commandId,
      runtimeId: work.command.runtimeId,
      epoch: work.command.epoch,
    },
  };
  // Nor does Reviews take it from the agent's own authority, whatever called it.
  await assert.rejects(reviews.start(conversation, review.id, undefined, true), {
    code: 'review_independence',
  });
  assert.equal((await reviews.get(owner, review.id)).status, 'requested');
  await f.pi.complete(token, f.completion(input));
  // An agent on the person's key reads no invitation in its own conversation.
  const keyed = await f.begun(key);
  assert.equal(
    (
      (await f.pi.tool(keyed.token, {
        ...keyed.input,
        name: 'review.get',
        input: { reviewId: review.id },
      })) as ReviewRequest
    ).overridable,
    undefined,
  );
  await f.pi.complete(keyed.token, f.completion(keyed.input));
  const run = (caller: Caller, proposalId: string) =>
    f.pi.run(caller, { id: input.conversationId, commandId: input.commandId, proposalId });
  // Run pressed with the person's key is not the person.
  await assert.rejects(run(key, onKey), { code: 'review_independence' });
  assert.equal((await reviews.get(owner, review.id)).status, 'requested');
  const ran = (await run(owner, asPerson)) as { result: ReviewRequest };
  assert.deepEqual(
    [ran.result.status, ran.result.reviewerId, ran.result.override],
    ['started', owner.actorId, true],
  );
});

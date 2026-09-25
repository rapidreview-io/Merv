/**
 * Decision 5: a worker is its directing authority's hand. Work a person (or their Agent, which
 * acts as them) delivered at the desk carries no provenance, and a worker that person directs
 * must still not review it. Two workers one authority directs are different actors, though, so
 * either may review the other's delivery (plan §5.3 C1).
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Artifact, Caller, Task } from '@merv/contracts';
import { createApp } from './fixtures/app.js';
import { confirmedDelivery } from './fixtures/task-evidence.js';

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-directing-authority-'));
  const app = await createApp({ directory, api: true, port: 0 });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const boot = await app.ctx.scope.bootstrap({ projectName: 'Authority', actorName: 'Founder' });
  const founder: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const issued = await app.ctx.scope.issueActor(founder, { name: 'Tab B', role: 'operator' });
  const other: Caller = {
    actorId: issued.actor.id,
    projectId: founder.projectId,
    credentialId: issued.credential.id,
  };
  let seq = 0;
  const member = async (name: string): Promise<Caller> => {
    const issued = await app.ctx.scope.issueActor(founder, { name, role: 'operator' });
    return {
      actorId: issued.actor.id,
      projectId: founder.projectId,
      credentialId: issued.credential.id,
    };
  };
  /** A worker identity whose every lease is directed by `source`. */
  const worker = async (source: Caller) => {
    const token = `ms_${randomBytes(32).toString('base64url')}`;
    await app.ctx.sessions.registerAgent(source, {
      name: `Worker ${++seq}`,
      runnerId: 'external',
      requestId: `register-${seq}`,
      secret: token,
    });
    return {
      token,
      assign: async (task: Pick<Task, 'id' | 'workflow'>) =>
        await app.ctx.sessions.assignAgent(token, {
          instanceId: task.id,
          expectedRevision: task.workflow.revision,
          requestId: `assign-${++seq}`,
        }),
      caller: async () => await app.ctx.sessions.authenticate(token),
      offered: async () =>
        (await app.ctx.sessions.agentSelf(token)).available.map((item) => item.instanceId),
    };
  };
  const create = async (by: Caller) =>
    await app.ctx.tasks.create(by, {
      title: `Task ${++seq}`,
      goal: 'Verify addition.',
      checks: ['Two plus three equals five.'],
      requestId: `task-${seq}`,
    });
  const deliver = async (by: Caller, task: Task) => {
    const proof = (await app.ctx.tools.call('artifact.create', by, {
      title: 'Proof',
      content: 'Observed 2 + 3 = 5.',
    })) as Artifact;
    return (await app.ctx.tools.call(
      'task.submit_delivery',
      by,
      confirmedDelivery({
        taskId: task.id,
        expectedRevision: task.workflow.revision,
        artifactIds: [proof.id],
        requestId: `deliver-${++seq}`,
      }),
    )) as Task;
  };
  const candidates = async (source: Caller) =>
    (await app.ctx.workflows.dispatchCandidates(source)).map((item) => item.instanceId);
  return { app, founder, other, member, worker, create, deliver, candidates };
}

test('a worker whose directing authority produced the desk delivery is refused, never offered and never a dispatch candidate', async (t) => {
  const f = await fixture(t);
  const delivered = await f.deliver(f.founder, await f.create(f.founder));
  const review = await f.app.ctx.reviews.get(f.founder, delivered.reviewId!);
  assert.equal(review.producerId, f.founder.actorId);
  assert.equal(review.provenance, undefined, 'a desk delivery carries no provenance');

  const hand = await f.worker(f.founder);
  await assert.rejects(async () => await hand.assign(delivered), { code: 'review_independence' });
  assert.ok(!(await hand.offered()).includes(delivered.id), 'what is refused is not offered');
  assert.ok(
    !(await f.candidates(f.founder)).includes(delivered.id),
    'no runner on the producer’s own key is offered its review',
  );
  assert.equal(
    (await f.app.ctx.sessions.agentSelf(hand.token)).assignments.length,
    0,
    'the refusal created no execution',
  );

  // A worker another member directs is independent of it, and claims it through its lease.
  assert.ok((await f.candidates(f.other)).includes(delivered.id));
  const independent = await f.worker(f.other);
  assert.ok((await independent.offered()).includes(delivered.id));
  assert.equal((await independent.assign(delivered)).role, 'reviewer');
  const claimed = await f.app.ctx.reviews.get(f.founder, delivered.reviewId!);
  assert.equal(claimed.status, 'started');
  assert.equal(claimed.reviewerId, (await independent.caller()).actorId);
});

test('a leased worker directed by the producer cannot claim its review, and the list says so, even while it holds another record’s review lease', async (t) => {
  const f = await fixture(t);
  const delivered = await f.deliver(f.founder, await f.create(f.founder));
  // The same worker, leased on an unrelated review, still speaks for the founder.
  const elsewhere = await f.deliver(f.other, await f.create(f.other));
  const hand = await f.worker(f.founder);
  await hand.assign(elsewhere);
  const leased = await hand.caller();
  await assert.rejects(
    async () => await f.app.ctx.reviews.checkStart(leased, delivered.reviewId!),
    { code: 'review_independence' },
  );
  await assert.rejects(async () => await f.app.ctx.reviews.start(leased, delivered.reviewId!), {
    code: 'review_independence',
  });
  assert.equal(
    (await f.app.ctx.reviews.list(leased)).find((item) => item.id === delivered.reviewId)
      ?.claimable,
    false,
    'the list answers the same rule the claim applies',
  );
  assert.equal(
    (await f.app.ctx.reviews.list(leased)).find((item) => item.id === elsewhere.reviewId)
      ?.claimable,
    false,
    'its own claimed review is nobody’s to claim',
  );
});

test('two workers one authority directs are different actors: either may review the other’s delivery, but not the authority itself (C1)', async (t) => {
  const f = await fixture(t);
  const task = await f.create(f.founder);
  const first = await f.worker(f.founder);
  const work = await first.assign(task);
  const producer = await first.caller();
  const delivered = await f.deliver(producer, task);
  await f.app.ctx.sessions.releaseAgentAssignment(first.token, work.id);
  const review = await f.app.ctx.reviews.get(f.founder, delivered.reviewId!);
  assert.equal(review.producerId, producer.actorId);
  assert.deepEqual(review.excludedActorIds, [f.founder.actorId]);

  // The directing authority of the producing worker is excluded by the request itself.
  await assert.rejects(async () => await f.app.ctx.reviews.start(f.founder, review.id), {
    code: 'review_independence',
  });
  // The producing worker is its own producer.
  await assert.rejects(async () => await first.assign(delivered), {
    code: 'review_independence',
  });
  // A second worker of the same authority is neither, so it is offered and claims it.
  const second = await f.worker(f.founder);
  assert.ok((await second.offered()).includes(delivered.id));
  assert.ok((await f.candidates(f.founder)).includes(delivered.id));
  assert.equal((await second.assign(delivered)).role, 'reviewer');
  assert.equal(
    (await f.app.ctx.reviews.get(f.founder, review.id)).reviewerId,
    (await second.caller()).actorId,
  );
});

test('a worker whose directing authority wrote a lens is not offered, and cannot take, the reflection’s review', async (t) => {
  const f = await fixture(t);
  const { artifacts, reflections, research, reviews } = f.app.ctx;
  const write = async (by: Caller, title: string) =>
    await artifacts.create(by, {
      title,
      content: `# Summary\n${title}: source-linked observation.\n# Evidence\nNo completed experiments in the pinned corpus; no empirical conclusion is claimed.`,
    });
  const wave = await research.startReflection(f.founder, { requestId: 'wave' });
  // The founder writes one lens at the desk; four other members write the rest.
  for (const [index, lens] of wave.lenses.entries()) {
    const by = index === 0 ? f.founder : await f.member(`Lens ${index}`);
    await reflections.submitLens(by, {
      lensId: lens.id,
      artifactId: (await write(by, lens.perspective)).id,
      expectedRevision: 0,
      requestId: `lens-${index}`,
    });
  }
  // Tab B writes the synthesis, so the review names Tab B as its producer.
  const synthesizing = await reflections.get(f.other, wave.id);
  const submitted = await reflections.submit(f.other, {
    reflectionId: wave.id,
    reportArtifactId: (await write(f.other, 'Synthesis')).id,
    changeSpecArtifactId: (await write(f.other, 'Changes')).id,
    expectedRevision: synthesizing.workflow.revision,
    requestId: 'synthesis',
  });
  const review = submitted.review!;
  assert.equal(review.producerId, f.other.actorId);
  await assert.rejects(async () => await reviews.start(f.founder, review.id), {
    code: 'review_independence',
  });

  // The founder's hand is no more independent of the founder's lens than the founder is.
  assert.ok(!(await f.candidates(f.founder)).includes(wave.id));
  const hand = await f.worker(f.founder);
  assert.ok(!(await hand.offered()).includes(wave.id));
  await assert.rejects(async () => await hand.assign(submitted), { code: 'review_independence' });
  assert.equal((await reviews.get(f.founder, review.id)).status, 'requested');

  // A member who wrote none of it directs an independent reviewer.
  const independent = await f.worker(await f.member('Rhea'));
  assert.equal((await independent.assign(submitted)).role, 'reviewer');
  assert.equal(
    (await reviews.get(f.founder, review.id)).reviewerId,
    (await independent.caller()).actorId,
  );
});

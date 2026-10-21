import { ArtifactStore } from '@merv/artifacts';
import { DiskBlobs } from '@merv/blobs';
import { RecipeContextBuilder } from '@merv/context-builder';
import { createService, type Caller, type RunningSection } from '@merv/contracts';
import { ExperimentService } from '@merv/experiments';
import { PaperService } from '@merv/paper';
import { ReviewService } from '@merv/reviews';
import { ProjectScope } from '@merv/scope';
import { WorkflowsService } from '@merv/workflows';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { CustomerExperiments } from '../packages/customer-experiments/src/domain.js';
import { managedServices } from './fixtures/managed-services.js';
import { openState } from './fixtures/state.js';

async function fixture(t: TestContext, customerFirst: boolean) {
  const directory = await mkdtemp(join(tmpdir(), 'merv-review-gates-'));
  const state = await openState(directory);
  const scope = await createService(new ProjectScope(state));
  const owner = async (projectName: string): Promise<Caller> => {
    const boot = await scope.credentials.bootstrap({ projectName, actorName: 'Owner' });
    return {
      projectId: boot.project.id,
      actorId: boot.actor.id,
      credentialId: boot.credential.id,
    };
  };
  const regularOwner = await owner('Research');
  const customerOwner = await owner('Customer');
  const artifacts = await createService(
    new ArtifactStore(state, scope, new DiskBlobs(join(directory, 'blobs'))),
  );
  const workflows = await createService(new WorkflowsService(state, scope));
  const reviews = await createService(new ReviewService(state, scope, artifacts));
  const context = await createService(new RecipeContextBuilder(state, scope, artifacts));
  const paper = await createService(new PaperService(state, scope, artifacts));
  const managed = await managedServices(
    { state, scope, artifacts, workflows, reviews },
    directory,
    regularOwner,
  );
  const customer = new CustomerExperiments(
    state,
    scope,
    artifacts,
    workflows,
    reviews,
    managed.code,
    managed.sessions,
  );
  const experiments = new ExperimentService(
    state,
    scope,
    artifacts,
    workflows,
    reviews,
    context,
    managed.code,
    paper,
  );
  // Both registrations are the domains' production owners, in either actual load order.
  for (const service of customerFirst ? [customer, experiments] : [experiments, customer])
    await service.initialize();
  t.after(async () => {
    customer.close();
    experiments.close();
    await managed.close();
    paper.close();
    context.close();
    reviews.close();
    workflows.close();
    await state.close();
    await rm(directory, { recursive: true, force: true });
  });
  const request = async (caller: Caller, subjectId: string, subjectRevision: number) => {
    const artifact = await artifacts.create(caller, {
      title: 'Retained review evidence',
      content: 'The immutable evidence this review reads.',
    });
    return reviews.request(caller, {
      subjectId,
      subjectRevision,
      producerId: caller.actorId,
      artifactIds: [artifact.id],
      criteria: ['Verify the retained evidence'],
      requestId: randomUUID(),
    });
  };
  return { state, reviews, customer, experiments, regularOwner, customerOwner, request };
}

function standing(sections: RunningSection[]) {
  const review = sections.find((section) => section.title === 'Review');
  assert.ok(review?.kind === 'facts');
  return review.rows.find((row) => row.label === 'Standing')!.value;
}

for (const customerFirst of [true, false])
  test(`review gates stay with their domain when the customer owner loads ${customerFirst ? 'first' : 'last'}`, async (t) => {
    const f = await fixture(t, customerFirst);
    const regular = await f.experiments.create(f.regularOwner, {
      name: 'research-comparison',
      intent: 'Compare the retained results.',
      requestId: 'regular',
    });
    const customer = await f.customer.create(f.customerOwner, {
      title: 'Customer comparison',
      requestId: 'customer',
    });
    const design = await f.request(f.regularOwner, regular.id, 1);
    // Seed only the retained stage lookup: this presentation regression does not execute work.
    const stage = async (id: string, name: 'design' | 'results') =>
      f.state.transaction((tx) =>
        tx.run(
          'INSERT INTO experiment_submissions(id,experiment_id,attempt_index,stage,round,review_id,record) VALUES(?,?,1,?,1,?,?)',
          randomUUID(),
          regular.id,
          name,
          id,
          '{}',
        ),
      );
    await stage(design.id, 'design');
    assert.equal((await f.reviews.guide(f.regularOwner, design.id)).gate, 'Design');
    assert.deepEqual(standing(await f.reviews.running(f.regularOwner, [regular.id])), [
      'Design · ',
      'unclaimed',
    ]);
    await f.reviews.supersede(f.regularOwner, design.id);
    const results = await f.request(f.regularOwner, regular.id, 2);
    await stage(results.id, 'results');
    assert.equal((await f.reviews.guide(f.regularOwner, results.id)).gate, 'Results');
    const researchSections = await f.reviews.running(f.regularOwner, [regular.id]);
    assert.deepEqual(standing(researchSections), ['Results · ', 'unclaimed']);
    const researchHistory = researchSections.find((section) => section.title === 'Earlier rounds');
    assert.ok(researchHistory?.kind === 'links');
    assert.equal(researchHistory.rows[0]!.name, 'Design · superseded');

    const first = await f.request(f.customerOwner, customer.id, 1);
    await f.reviews.supersede(f.customerOwner, first.id);
    const current = await f.request(f.customerOwner, customer.id, 2);
    await f.state.transaction((tx) =>
      tx.run('UPDATE customer_experiments SET review_id=? WHERE id=?', current.id, customer.id),
    );
    assert.equal((await f.reviews.guide(f.customerOwner, first.id)).gate, 'Results');
    assert.equal((await f.reviews.guide(f.customerOwner, current.id)).gate, 'Results');
    const customerSections = await f.reviews.running(f.customerOwner, [customer.id]);
    assert.deepEqual(standing(customerSections), ['Results · ', 'unclaimed']);
    const customerHistory = customerSections.find((section) => section.title === 'Earlier rounds');
    assert.ok(customerHistory?.kind === 'links');
    assert.equal(customerHistory.rows[0]!.name, 'Results · superseded');

    // Running asks every owner's gates callback even when no owner claims the subject.
    const generic = await f.request(f.regularOwner, 'unowned-subject', 1);
    const foreign = await f.request(f.regularOwner, customer.id, 1);
    for (const review of [generic, foreign]) {
      assert.equal((await f.reviews.guide(f.regularOwner, review.id)).gate, undefined);
      assert.deepEqual(standing(await f.reviews.running(f.regularOwner, [review.subjectId])), [
        'Unclaimed',
      ]);
    }
    assert.deepEqual(await f.reviews.running(f.regularOwner, ['missing-subject']), []);
    assert.deepEqual(await f.reviews.running(f.regularOwner, []), []);
  });

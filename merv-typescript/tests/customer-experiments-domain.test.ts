import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { legacyReports } from './fixtures/legacy-reports.js';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService, MervError, type Caller } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { DiskBlobs } from '@merv/blobs';
import { ArtifactStore } from '@merv/artifacts';
import { WorkflowsService } from '@merv/workflows';
import { ReviewService } from '@merv/reviews';
import { CustomerExperiments } from '../packages/customer-experiments/src/domain.js';
import {
  SERVICE_MODEL,
  type CustomerExperiment,
  type ExperimentPlan,
} from '../packages/customer-experiments/src/types.js';
import {
  executionPolicy,
  serviceExecution,
} from '../packages/customer-experiments/src/execution.js';
import { planSchema, validateAgreement } from '../packages/customer-experiments/src/schema.js';
import { registerWorkerTools } from '../packages/customer-experiments/src/worker-tools.js';
import { openState } from './fixtures/state.js';
import { managedServices } from './fixtures/managed-services.js';
import { currentWork } from './fixtures/current-work.js';
import { waitForManagedCode } from './fixtures/managed-code.js';

const errorCode = (code: string) => (error: unknown) =>
  !!error && typeof error === 'object' && 'code' in error && error.code === code;
const plan: ExperimentPlan = {
  title: 'Compare two deterministic classifiers',
  question: 'Does the proposed rule improve accuracy?',
  decision: 'Choose which rule to deploy.',
  rationale: 'A bounded comparison can resolve the disputed classification rule.',
  hypothesis: 'The proposed rule improves accuracy by 5 percentage points.',
  method: ['Generate the specified fixed evaluation cases.', 'Score both rules on the same cases.'],
  baseline: 'Always predict the majority class.',
  metric: 'Accuracy on held-out cases',
  successCriteria: ['Accuracy improves by at least 0.05'],
  research: [],
  code: null,
  models: [],
  dataRequirements: [],
  limits: { wallMinutes: 10, maxTokens: 10000, maxAttempts: 2 },
  turnaround: 'Within one hour once a worker is available',
  deliverables: ['Runnable comparison code', 'Metrics and concise report'],
  executionSpec:
    'Use TypeScript to generate 100 deterministic labeled integers and compare parity classification to the majority baseline. No network or external services.',
  feasibility: '100 cases, CPU only, no external dependencies or datasets.',
};

async function fixture(
  t: TestContext,
  compute?: ConstructorParameters<typeof CustomerExperiments>[8],
) {
  const dir = mkdtempSync(join(tmpdir(), 'merv-customer-experiments-'));
  const state = await openState(dir),
    scope = await createService(new ProjectScope(state));
  const boot = await scope.credentials.bootstrap({
    projectName: 'Private customer request',
    actorName: 'Sponsor',
  });
  const caller: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  const artifacts = await createService(
    new ArtifactStore(state, scope, new DiskBlobs(join(dir, 'blobs'))),
  );
  const workflows = await createService(new WorkflowsService(state, scope));
  const reviews = await createService(new ReviewService(state, scope, artifacts));
  const managed = await managedServices(
    { state, scope, artifacts, workflows, reviews },
    dir,
    caller,
  );
  const service = await createService(
    new CustomerExperiments(
      state,
      scope,
      artifacts,
      workflows,
      reviews,
      managed.code,
      managed.sessions,
      undefined,
      compute,
    ),
  );
  // These cover the structured offer: requests start on service_experiment@2.
  service.startVersion = 2;
  // The worker tools as a leased session calls them, answers included.
  type Handler = (caller: Caller, input: never) => Promise<Record<string, unknown>>;
  const tools = new Map<string, Handler>();
  await registerWorkerTools(
    {
      register: (tool: { name: string; handler: Handler }) => {
        tools.set(tool.name, tool.handler);
        return () => {};
      },
    } as never,
    service,
  );
  const submitted: Record<string, unknown>[] = [];
  const reports = legacyReports(state);
  service.bindReports(reports);
  const work = currentWork(managed, { directory: dir, source: caller });
  t.after(async () => {
    await work.close();
    service.close();
    await managed.close();
    reviews.close();
    workflows.close();
    await state.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await waitForManagedCode(managed.code, caller);
  let seq = 0;
  const id = () => `request-${++seq}`;
  const create = () => service.create(caller, { title: plan.title, requestId: id() });
  const prepare = async () => {
    const exp = await create();
    return service.propose(caller, {
      id: exp.id,
      expectedRevision: exp.workflow.revision,
      plan,
      datasets: [],
      requestId: id(),
    });
  };
  const pay = async () => {
    let exp = await prepare();
    exp = await service.approve(caller, {
      id: exp.id,
      expectedRevision: exp.workflow.revision,
      contractHash: exp.contract!.hash,
      email: 'customer@example.test',
      requestId: id(),
    });
    return service.confirmPayment(caller, {
      id: exp.id,
      contractHash: exp.contract!.hash,
      paymentId: `pi_${id()}`,
      amountCents: 1000,
      currency: 'usd',
      requestId: id(),
    });
  };
  const platform = { name: 'astra', ...SERVICE_MODEL, enabled: true, parallelism: 1 };
  await managed.sessions.dispatch.heartbeatRunner(caller, {
    runnerId: 'service-test',
    machine: { hostname: 'local-test', system: process.platform, architecture: process.arch },
    platforms: [platform],
    capacity: 1,
    capabilities: ['code.v2'],
  });
  await managed.sessions.dispatch.setDispatch(caller, { enabled: true });
  const offer = async () => {
    const secret = `ms_${randomBytes(32).toString('base64url')}`;
    const offered = await managed.sessions.dispatch.lease(caller, {
      runnerId: 'service-test',
      requestId: id(),
      secret,
      platform: { name: 'astra', ...SERVICE_MODEL },
    });
    assert.ok(offered.session, JSON.stringify(offered));
    const held = await work.attach(offered.session, caller);
    held.worker = await managed.sessions.authenticate(secret);
    held.token = secret;
    return held;
  };
  const finish = async (held: Awaited<ReturnType<typeof offer>>, tokens = 1000) => {
    held.stop();
    const workspace = await held.driver.capture(held.launch);
    await managed.sessions.release(caller, {
      sessionId: held.session.id,
      runnerId: held.control.runnerId,
      usage: { inputTokens: tokens, outputTokens: 0, model: SERVICE_MODEL.model },
    });
    if (workspace) await managed.sessions.workspaceResult(caller, { ...held.control, workspace });
    await managed.events.drain();
  };
  const deliver = async (exp: CustomerExperiment, held?: Awaited<ReturnType<typeof offer>>) => {
    const worker = held ?? (await offer());
    const artifact = await work.run(
      worker,
      'artifact.create',
      { title: 'Run results', content: 'Retained measurements and report.' },
      (c, input) => artifacts.create(c, input as { title: string; content: string }),
    );
    reports.claim(artifact.id, { kind: 'customer_experiment', id: exp.id });
    await work.commit(worker, { 'experiment.ts': `console.log('attempt ${exp.attempts}');\n` });
    submitted.push(
      await work.run(
        worker,
        'customer_experiment.submit_results',
        {
          id: exp.id,
          expectedRevision: exp.workflow.revision,
          artifactIds: [artifact.id],
          reportArtifactId: artifact.id,
          summary: 'Run finished.',
          requestId: id(),
        },
        (c, input) => tools.get('customer_experiment.submit_results')!(c, input as never),
      ),
    );
    await finish(worker);
    return service.reconcile(caller, exp.id);
  };
  const judge = async (
    held: Awaited<ReturnType<typeof offer>>,
    exp: CustomerExperiment,
    returnTo: 'running' | 'planning' | 'failed',
  ) => {
    const current = await service.get(held.worker, exp.id);
    return (await work.run(
      held,
      'review.submit',
      {
        reviewId: current.review!.id,
        claimId: current.review!.claimId!,
        expectedRevision: current.workflow.revision,
        verdict: 'needs_changes',
        returnTo,
        notes: 'The retained comparison needs correction.',
        synopsis:
          'The retained evidence does not establish the required comparison under the accepted contract.',
        findings: [1, 2, 3].map((criterionNumber) => ({
          criterionNumber,
          status: 'not_met',
          evidenceIds: current.submission!.artifactIds,
          notes: 'Verified mismatch in retained evidence.',
        })),
        requestId: id(),
      },
      (c, input) => reviews.apply(c, input as unknown as Parameters<typeof reviews.apply>[1]),
    )) as CustomerExperiment;
  };
  return {
    reports,
    state,
    scope,
    caller,
    tools,
    submitted,
    artifacts,
    workflows,
    reviews,
    managed,
    service,
    work,
    id,
    create,
    prepare,
    pay,
    offer,
    finish,
    deliver,
    judge,
  };
}

test('customer workflow cannot dispatch before exact acceptance and payment; receipts stay immutable', async (t) => {
  const f = await fixture(t);
  let exp = await f.prepare();
  assert.equal(exp.workflow.state, 'ready');
  assert.equal((await f.workflows.dispatchCandidates(f.caller)).length, 0);
  await assert.rejects(
    f.service.approve(f.caller, {
      id: exp.id,
      expectedRevision: exp.workflow.revision,
      contractHash: 'stale',
      email: 'customer@example.test',
      requestId: f.id(),
    }),
    errorCode('stale_contract'),
  );
  exp = await f.service.approve(f.caller, {
    id: exp.id,
    expectedRevision: exp.workflow.revision,
    contractHash: exp.contract!.hash,
    email: 'customer@example.test',
    requestId: f.id(),
  });
  assert.equal((await f.workflows.dispatchCandidates(f.caller)).length, 0);
  await assert.rejects(
    f.service.propose(f.caller, {
      id: exp.id,
      expectedRevision: exp.workflow.revision,
      plan: { ...plan, title: 'Changed' },
      datasets: [],
      requestId: f.id(),
    }),
    errorCode('fixed_contract'),
  );
  const payment = {
    id: exp.id,
    contractHash: exp.contract!.hash,
    paymentId: 'pi_verified',
    amountCents: 1000,
    currency: 'usd',
    requestId: f.id(),
  };
  await assert.rejects(
    f.service.confirmPayment(f.caller, { ...payment, amountCents: 1 }),
    errorCode('payment_mismatch'),
  );
  exp = await f.service.confirmPayment(f.caller, payment);
  assert.equal(exp.workflow.state, 'running');
  assert.equal((await f.workflows.dispatchCandidates(f.caller)).length, 1);
  assert.deepEqual(await f.service.confirmPayment(f.caller, payment), exp);
  assert.equal(
    (await f.service.confirmPayment(f.caller, { ...payment, requestId: f.id() })).workflow.revision,
    exp.workflow.revision,
  );
  assert.equal(
    (await f.state.read((sql) => sql.all('SELECT * FROM customer_experiment_payments'))).length,
    1,
  );
  await assert.rejects(
    f.state.transaction((tx) =>
      tx.run("UPDATE customer_experiment_contracts SET record='{}' WHERE id=?", exp.contract!.id),
    ),
    errorCode('state_constraint'),
  );
  const other = await f.scope.credentials.bootstrap({
    projectName: 'Another request',
    actorName: 'Another sponsor',
  });
  await assert.rejects(
    f.service.get({ projectId: other.project.id, actorId: other.actor.id }, exp.id),
    errorCode('not_found'),
  );
  await assert.rejects(f.create(), errorCode('project_not_isolated'));
});

test('results repair preserves the paid contract and consumes the same bounded allowance', async (t) => {
  const f = await fixture(t);
  let exp = await f.deliver(await f.pay());
  const contract = exp.contract!.hash;
  const firstReviewer = await f.offer();
  exp = await f.judge(firstReviewer, exp, 'running');
  assert.equal(exp.workflow.state, 'running');
  assert.equal(exp.attempts, 2);
  assert.equal(exp.workflow.data.computeEpoch, `${exp.contract!.id}:2`);
  assert.equal(exp.contract!.hash, contract);
  assert.equal(
    (await f.workflows.dispatchCandidates(f.caller)).length,
    0,
    'The returning reviewer retains its allowance until it closes',
  );
  assert.equal((await f.service.reconcile(f.caller, exp.id)).workflow.state, 'running');
  await f.finish(firstReviewer);
  exp = await f.deliver(exp);
  const secondReviewer = await f.offer();
  assert.ok(
    secondReviewer.session.tokenBudget! <= 7000,
    'Earlier execution and review spending is deducted',
  );
  await assert.rejects(f.judge(secondReviewer, exp, 'running'), errorCode('attempt_limit'));
  assert.equal((await f.service.get(f.caller, exp.id)).workflow.state, 'results_review');
  exp = await f.judge(secondReviewer, exp, 'failed');
  assert.equal(exp.workflow.state, 'failed');
});

test('an executor that stops at its allowance without handing off produces a terminal failure', async (t) => {
  const f = await fixture(t);
  const exp = await f.pay();
  const worker = await f.offer();
  assert.equal(
    (await f.service.reconcile(f.caller, exp.id)).workflow.state,
    'running',
    'A live worker must not be terminated by the reconciliation read',
  );
  await f.finish(worker, 8000);
  const failed = await f.service.reconcile(f.caller, exp.id);
  assert.equal(failed.workflow.state, 'failed');
  assert.match(String(failed.workflow.data.failureReason), /Execution stopped/);
  assert.equal((await f.workflows.dispatchCandidates(f.caller)).length, 0);
  assert.equal(
    (await f.service.reconcile(f.caller, exp.id)).workflow.revision,
    failed.workflow.revision,
    'Repeated reconciliation does not emit another failure',
  );
});

test('an exhausted independent review is closed without publishing unverified results', async (t) => {
  const f = await fixture(t);
  const exp = await f.deliver(await f.pay());
  const reviewer = await f.offer();
  await f.finish(reviewer, 9000);
  const failed = await f.service.reconcile(f.caller, exp.id);
  assert.equal(failed.workflow.state, 'failed');
  assert.equal(failed.review!.status, 'superseded');
  assert.match(String(failed.workflow.data.failureReason), /not been approved/);
});

test('missing token accounting waits without launching an unbounded replacement', async (t) => {
  const f = await fixture(t);
  const exp = await f.pay();
  const worker = await f.offer();
  await f.work.release(worker);
  assert.equal((await f.service.reconcile(f.caller, exp.id)).workflow.state, 'running');
  const budget = (await f.managed.sessions.usage(f.caller, { instanceId: exp.id })).budgets.find(
    (b) => b.scopeId === exp.id,
  )!;
  assert.equal(budget.unreportedSessions, 1);
  const demand = await f.managed.sessions.dispatch.dispatchDemand(f.caller, {
    platform: { name: 'astra', ...SERVICE_MODEL, enabled: true, parallelism: 1 },
    capabilities: ['code.v2'],
  });
  assert.equal(demand.candidates.length, 0);
});

test('a scope change clears acceptance and payment and requires a fresh fixed contract', async (t) => {
  const f = await fixture(t);
  let exp = await f.deliver(await f.pay());
  const oldContract = exp.contract!,
    oldPayment = exp.paymentId!;
  const reviewer = await f.offer();
  exp = await f.judge(reviewer, exp, 'planning');
  assert.equal(exp.workflow.state, 'planning');
  assert.equal(exp.acceptedContractId, null);
  assert.equal((await f.service.get(f.caller, exp.id)).paymentId, null);
  assert.equal(
    exp.workflow.data.computeEpoch,
    `${oldContract.id}:planning:${exp.workflow.revision}`,
  );
  assert.equal((await f.workflows.dispatchCandidates(f.caller)).length, 0);
  await f.finish(reviewer);
  exp = await f.service.propose(f.caller, {
    id: exp.id,
    expectedRevision: exp.workflow.revision,
    plan: { ...plan, question: 'Does a revised classification rule improve accuracy?' },
    datasets: [],
    requestId: f.id(),
  });
  assert.equal(exp.contract!.version, oldContract.version + 1);
  exp = await f.service.approve(f.caller, {
    id: exp.id,
    expectedRevision: exp.workflow.revision,
    contractHash: exp.contract!.hash,
    email: 'customer@example.test',
    requestId: f.id(),
  });
  await assert.rejects(
    f.service.confirmPayment(f.caller, {
      id: exp.id,
      contractHash: exp.contract!.hash,
      paymentId: oldPayment,
      amountCents: 1000,
      currency: 'usd',
      requestId: f.id(),
    }),
    errorCode('payment_reused'),
  );
  exp = await f.service.confirmPayment(f.caller, {
    id: exp.id,
    contractHash: exp.contract!.hash,
    paymentId: 'pi_new_scope',
    amountCents: 1000,
    currency: 'usd',
    requestId: f.id(),
  });
  assert.equal(exp.workflow.state, 'running');
  const fresh = await f.offer();
  assert.equal(
    fresh.session.tokenBudget,
    8000,
    'The newly purchased contract has its own allowance',
  );
});

test('results wait for the final code capture, then dispatch a separate Astra reviewer', async (t) => {
  const f = await fixture(t);
  let exp = await f.pay();
  const producer = await f.offer();
  const epoch = exp.workflow.data.computeEpoch;
  assert.equal(producer.session.kind, 'work');
  if (producer.session.kind === 'work') {
    assert.deepEqual(producer.session.execution.policy.platform, SERVICE_MODEL);
    assert.equal(producer.session.tokenBudget, 8000);
    assert.equal(producer.session.execution.references.computeKind, 'experiment');
    assert.equal(producer.session.execution.references.computeProfile, 'execute');
  }
  const artifact = await f.work.run(
    producer,
    'artifact.create',
    { title: 'Results', content: '100 cases: baseline 50%, candidate 100%.' },
    (caller, input) => f.artifacts.create(caller, input as { title: string; content: string }),
  );
  f.reports.claim(artifact.id, { kind: 'customer_experiment', id: exp.id });
  await f.work.commit(producer, { 'experiment.ts': 'console.log({baseline:0.5,candidate:1});\n' });
  exp = await f.work.run(
    producer,
    'customer_experiment.submit_results',
    {
      id: exp.id,
      expectedRevision: exp.workflow.revision,
      artifactIds: [artifact.id],
      reportArtifactId: artifact.id,
      summary: 'The rule improves accuracy on the agreed fixed cases.',
      requestId: f.id(),
    },
    (caller, input) => f.service.submitResults(caller, input),
  );
  assert.equal(exp.workflow.state, 'finalizing');
  assert.equal(exp.workflow.data.computeEpoch, epoch);
  assert.equal((await f.service.reconcile(f.caller, exp.id)).workflow.state, 'finalizing');
  assert.equal((await f.workflows.dispatchCandidates(f.caller)).length, 0);
  producer.stop();
  const workspace = await producer.driver.capture(producer.launch);
  await f.managed.sessions.release(f.caller, {
    sessionId: producer.session.id,
    runnerId: producer.control.runnerId,
    usage: { inputTokens: 1000, outputTokens: 500, model: SERVICE_MODEL.model },
  });
  if (workspace)
    await f.managed.sessions.workspaceResult(f.caller, { ...producer.control, workspace });
  await f.managed.events.drain();
  exp = await f.service.reconcile(f.caller, exp.id);
  assert.equal(exp.workflow.state, 'results_review');
  assert.equal(exp.workflow.data.computeEpoch, epoch);
  assert.ok(exp.submission!.codeHead);
  await assert.rejects(
    f.reviews.start(f.caller, exp.review!.id),
    errorCode('leased_review_required'),
  );
  const reviewer = await f.offer();
  assert.equal(reviewer.session.execution.references.computeKind, 'experiment');
  assert.equal(reviewer.session.execution.references.computeProfile, 'check');
  assert.notEqual(reviewer.worker.actorId, producer.worker.actorId);
  const current = await f.service.get(reviewer.worker, exp.id);
  assert.ok(current.review?.claimId);
  const submitted = await f.work.run(
    reviewer,
    'review.submit',
    {
      reviewId: current.review!.id,
      claimId: current.review!.claimId!,
      expectedRevision: current.workflow.revision,
      verdict: 'pass',
      notes: 'Checked code and results.',
      synopsis: 'The retained evidence supports the stated comparison.',
      findings: [1, 2, 3].map((criterionNumber) => ({
        criterionNumber,
        status: 'met',
        evidenceIds: [artifact.id],
        notes: 'Verified against retained code and measurements.',
      })),
      requestId: f.id(),
    },
    (caller, input) =>
      f.reviews.apply(caller, input as unknown as Parameters<typeof f.reviews.apply>[1]),
  );
  assert.equal((submitted as typeof exp).workflow.state, 'complete');
});

test("leased workers and reviewers read the request without the buyer's email or payment id", async (t) => {
  const f = await fixture(t);
  const paid = await f.pay();
  const buyer = (view: object) => ['email', 'paymentId'].filter((key) => key in view);
  // The owner's read keeps the buyer.
  const owned = await f.service.get(f.caller, paid.id);
  assert.equal(owned.email, 'customer@example.test');
  assert.match(owned.paymentId!, /^pi_/);
  const producer = await f.offer();
  const read = await f.tools.get('customer_experiment.get')!(producer.worker, {
    id: paid.id,
  } as never);
  assert.equal(read.id, paid.id);
  assert.equal(read.acceptedContractId, owned.acceptedContractId);
  assert.deepEqual(buyer(read), []);
  const exp = await f.deliver(owned, producer);
  assert.deepEqual(buyer(f.submitted.at(-1)!), []);
  const reviewer = await f.offer();
  assert.deepEqual(buyer(await f.judge(reviewer, exp, 'running')), []);
  assert.equal((await f.service.get(f.caller, exp.id)).email, 'customer@example.test');
});

test('customer agreements leave CPU and GPU selection to Merv', () => {
  assert.deepEqual(planSchema.parse(plan).limits, {
    wallMinutes: 10,
    maxTokens: 10000,
    maxAttempts: 2,
  });
  assert.throws(() => planSchema.parse({ ...plan, limits: { ...plan.limits, compute: 'cpu' } }));
  assert.throws(() => planSchema.parse({ ...plan, limits: { ...plan.limits, gpuType: 'H100' } }));
});

test('native compute captures are scoped to the accepted attempt and frozen into results review', async (t) => {
  const captures: string[] = [];
  let settled = false;
  const reads: { projectId: string; instanceId: string; attempts?: string[] }[] = [];
  const f = await fixture(t, {
    captures: async () => [...captures],
    evidence: async (projectId, works) => {
      for (const work of works) reads.push({ projectId, ...work });
      return new Map(
        works.map((work) => [work.instanceId, { artifactIds: [...captures], refused: [] }]),
      );
    },
    settled: async () => settled,
  });
  let exp = await f.pay();
  const epoch = `${exp.contract!.id}:1`;
  const producer = await f.offer();
  // Native collections are authored by the evidence bridge, not the execution agent.
  const remote = await f.artifacts.create(f.caller, {
    title: 'Retained GPU metrics',
    content: 'Native Capture collection fixture',
  });
  captures.push(remote.id);
  const report = await f.work.run(
    producer,
    'artifact.create',
    { title: 'Report', content: 'Metrics refer to the retained remote Capture.' },
    (caller, input) => f.artifacts.create(caller, input as { title: string; content: string }),
  );
  f.reports.claim(report.id, { kind: 'customer_experiment', id: exp.id });
  const unrelated = await f.artifacts.create(f.caller, {
    title: 'Other unverified artifact',
    content: 'Not from the worker or native evidence bridge',
  });
  await assert.rejects(
    f.service.submitResults(producer.worker, {
      id: exp.id,
      expectedRevision: exp.workflow.revision,
      artifactIds: [unrelated.id],
      reportArtifactId: report.id,
      summary: 'Invalid inherited evidence',
      requestId: f.id(),
    }),
    // The refusal names the artifact at fault and only it, so the worker drops exactly that.
    (error: MervError) =>
      error.code === 'invalid_evidence_author' &&
      error.message.includes(unrelated.id) &&
      !error.message.includes(report.id) &&
      /cite them by id/.test(error.message) &&
      JSON.stringify(error.details) === JSON.stringify({ artifactIds: [unrelated.id] }),
  );
  await f.work.commit(producer, { 'experiment.ts': 'console.log("remote results");\n' });
  exp = await f.work.run(
    producer,
    'customer_experiment.submit_results',
    {
      id: exp.id,
      expectedRevision: exp.workflow.revision,
      artifactIds: [report.id, remote.id],
      reportArtifactId: report.id,
      summary: 'Finished on internally selected compute.',
      requestId: f.id(),
    },
    (caller, input) => f.service.submitResults(caller, input),
  );
  assert.ok(exp.submission!.artifactIds.includes(remote.id));
  assert.equal(exp.workflow.data.computeEpoch, epoch);
  // Capture registration may finish while the local final code capture is being retained.
  const late = await f.artifacts.create(f.caller, {
    title: 'Retained remote log',
    content: 'Terminal native Capture registered during finalization',
  });
  captures.push(late.id);
  await f.finish(producer);
  assert.equal(
    (await f.service.reconcile(f.caller, exp.id)).workflow.state,
    'finalizing',
    'Local code capture cannot release review while native work is still active',
  );
  settled = true;
  exp = await f.service.reconcile(f.caller, exp.id);
  assert.equal(exp.workflow.state, 'results_review');
  assert.equal(exp.workflow.data.computeEpoch, epoch);
  assert.ok(exp.submission!.artifactIds.includes(late.id));
  assert.ok(exp.review!.artifactIds.includes(remote.id));
  assert.ok(exp.review!.artifactIds.includes(late.id));
  assert.ok(reads.length > 0);
  assert.ok(reads.every((read) => read.projectId === exp.projectId && read.instanceId === exp.id));
  assert.ok(reads.every((read) => JSON.stringify(read.attempts) === JSON.stringify([epoch])));
  await assert.rejects(
    f.state.transaction((tx) =>
      tx.run(
        "UPDATE customer_experiment_retained_outputs SET artifact_ids='[]' WHERE submission_id=?",
        exp.submission!.id,
      ),
    ),
    errorCode('state_constraint'),
  );
});

test('a report rendered final in an earlier session is refused with the advice to render it again here', async (t) => {
  const f = await fixture(t);
  const exp = await f.pay();
  const producer = await f.offer();
  // The same worker, in an earlier session, rendered the report and wrote other evidence. The
  // rows are written directly: that session is gone, so the artifact service would refuse it.
  const earlier = async (id: string) => {
    await f.state.transaction((tx) =>
      tx.run(
        `INSERT INTO artifacts(id,project_id,created_by,title,media_type,hash,size,created_at,session_id)
         VALUES(?,?,?,?,'text/markdown',?,1,?,'ses_earlier')`,
        id,
        exp.projectId,
        producer.worker.actorId,
        id,
        '0'.repeat(64),
        new Date().toISOString(),
      ),
    );
    return { id };
  };
  const report = await earlier('art_earlier_report');
  f.reports.claim(report.id, { kind: 'customer_experiment', id: exp.id });
  const notes = await earlier('art_earlier_notes');
  const submit = (artifactIds: string[]) =>
    f.service.submitResults(producer.worker, {
      id: exp.id,
      expectedRevision: exp.workflow.revision,
      artifactIds,
      reportArtifactId: report.id,
      summary: 'Report from an earlier session',
      requestId: f.id(),
    });
  // Only the report is at fault: render it again, with nothing said about other artifacts.
  await assert.rejects(
    submit([report.id]),
    (error: MervError) =>
      error.code === 'invalid_evidence_origin' &&
      /render it with final: true again here/.test(error.message) &&
      !/Leave the others/.test(error.message) &&
      JSON.stringify(error.details) === JSON.stringify({ artifactIds: [report.id] }),
  );
  // The report and another artifact: each gets its own advice.
  await assert.rejects(
    submit([report.id, notes.id]),
    (error: MervError) =>
      error.code === 'invalid_evidence_origin' &&
      error.message.includes(`these are not: ${report.id}, ${notes.id}.`) &&
      /render it with final: true again here\. Leave the others out of artifactIds/.test(
        error.message,
      ) &&
      JSON.stringify(error.details) === JSON.stringify({ artifactIds: [report.id, notes.id] }),
  );
  // Through the session's own admission, the workflow names the earlier artifact it refuses.
  await assert.rejects(
    f.work.run(
      producer,
      'customer_experiment.submit_results',
      {
        id: exp.id,
        expectedRevision: exp.workflow.revision,
        artifactIds: [notes.id],
        reportArtifactId: report.id,
        summary: 'Notes from an earlier session',
        requestId: f.id(),
      },
      (c, input) => f.service.submitResults(c, input),
    ),
    (error: MervError) =>
      error.code === 'execution_arguments_forbidden' &&
      error.message.includes(`${notes.id} is not among this assignment's artifacts`) &&
      /cite its id in one this session creates/.test(error.message) &&
      JSON.stringify(error.details) ===
        JSON.stringify({ field: 'artifactIds', reference: 'artifacts', outside: [notes.id] }),
  );
});

test('readiness rejects incomplete data and training/evaluation byte reuse', () => {
  const requirement = {
    id: 'train',
    label: 'Training',
    role: 'training' as const,
    format: 'csv' as const,
    columns: ['text', 'label'],
    labelColumn: 'label',
    minRows: 10,
  };
  const withData = {
    ...plan,
    dataRequirements: [requirement, { ...requirement, id: 'eval', role: 'evaluation' as const }],
  };
  assert.throws(() => validateAgreement(withData, []), errorCode('data_not_ready'));
  const file = {
    requirementId: 'train',
    artifactId: 'a',
    bucket: 'private',
    key: 'one',
    filename: 'one.csv',
    sha256: 'a'.repeat(64),
    size: 100,
    rows: 20,
    columns: ['text', 'label'],
    validationId: 'validated',
    validatedAt: new Date().toISOString(),
  };
  assert.throws(
    () =>
      validateAgreement(withData, [
        file,
        { ...file, requirementId: 'eval', artifactId: 'b', key: 'two' },
      ]),
    errorCode('data_leakage'),
  );
});

test('a full 24-hour, 500-million-token agreement fits both worker policies', () => {
  const limits = { wallMinutes: 1440, maxTokens: 500_000_000, maxAttempts: 2 };
  const accepted = planSchema.parse({ ...plan, limits });
  for (const review of [false, true]) {
    const policy = serviceExecution(review);
    assert.equal(policy.maxDurationSeconds, accepted.limits.wallMinutes * 60);
    assert.equal(policy.maxModelTokens, accepted.limits.maxTokens);
  }
});

test('service_experiment@4 grants the executor the progress its brief asks for', async () => {
  const names = (review: boolean, version: number) =>
    serviceExecution(review, version).tools.map((tool) => tool.name);
  // Version 3's running policy is published: it stays exactly as production pinned it.
  assert.deepEqual(names(false, 3), [
    'workflow.status_and_next',
    'workflow.assignment',
    'customer_experiment.get',
    'customer_experiment.files',
    'customer_experiment.file_download',
    'artifact.get',
    'artifact.read',
    'review.get',
    'artifact.create',
    'artifact.upload_begin',
    'artifact.upload_resume',
    'artifact.upload_complete',
    'code.commit',
    'code.operation',
    'report.open',
    'report.write',
    'report.clear',
    'report.check',
    'report.review_visual',
    'report.approve_visual',
    'report.render',
    'customer_experiment.submit_results',
  ]);
  assert.deepEqual(names(false, 4), [
    ...names(false, 3).slice(0, -1),
    'customer_experiment.progress',
    'customer_experiment.submit_results',
  ]);
  assert.deepEqual(
    serviceExecution(false, 4).tools.find((t) => t.name === 'customer_experiment.progress'),
    {
      name: 'customer_experiment.progress',
      alternatives: [{ id: { kind: 'target', field: 'instanceId' } }],
    },
  );
  assert.ok(!names(true, 4).includes('customer_experiment.progress'));
  // Only the version that grants it tells the worker to post progress.
  const brief = async (version: number) => {
    const ctx = {
      get: async () => ({ title: 'T', contract: {}, submission: null, review: null }),
      contractArtifact: async () => 'art_contract',
    };
    const running = executionPolicy(ctx as never, version).assignments!.find(
      (a) => a.state === 'running',
    )!;
    const built = await running.build!({
      caller: {},
      snapshot: { id: 'wf_1', version },
      tx: {},
    } as never);
    return (built as { brief: string }).brief;
  };
  assert.match(await brief(4), /post progress with customer_experiment\.progress/);
  assert.doesNotMatch(await brief(3), /customer_experiment\.progress/);
  // Compute advice follows the live offers, not a fixed provider order: a Modal sandbox cannot
  // outlive its offer's lifetime, and a machine still deleting holds one of the two slots.
  for (const version of [3, 4]) {
    const text = await brief(version);
    assert.doesNotMatch(text, /Modal first/);
    assert.match(text, /maximum lifetime against the job/);
    assert.match(text, /two machines at once, and one still deleting counts/);
  }
});

test('only the running worker reports progress, and the customer reads it in order', async (t) => {
  const f = await fixture(t);
  const exp = await f.pay();
  await assert.rejects(f.service.reportProgress(f.caller, { id: exp.id, text: 'Not the worker' }));
  const producer = await f.offer();
  await f.service.reportProgress(producer.worker, { id: exp.id, text: 'Rented a GPU' });
  await f.service.reportProgress(producer.worker, {
    id: exp.id,
    text: 'Clef: 17 of 24 correct',
    result: { name: 'Clef', score: 17, total: 24 },
    step: { done: 1, total: 5 },
  });
  await assert.rejects(
    f.service.reportProgress(producer.worker, { id: exp.id, text: 'x'.repeat(201) }),
  );
  const { paidAt, lines } = await f.service.progress(f.caller, exp.id);
  assert.ok(paidAt);
  assert.deepEqual(
    lines.map((line) => line.text),
    ['Rented a GPU', 'Clef: 17 of 24 correct'],
  );
  assert.deepEqual(lines[1]!.result, { name: 'Clef', score: 17, total: 24 });
  assert.deepEqual(lines[1]!.step, { done: 1, total: 5 });
  assert.equal(lines[0]!.attempt, 1);
});

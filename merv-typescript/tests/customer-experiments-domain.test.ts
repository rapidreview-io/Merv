import { ArtifactStore } from '@merv/artifacts';
import { DiskBlobs } from '@merv/blobs';
import { createService, type Caller } from '@merv/contracts';
import { ReviewService } from '@merv/reviews';
import { ProjectScope } from '@merv/scope';
import { WorkflowsService } from '@merv/workflows';
import { migrateNativeWorkflow } from '../packages/workflows/src/native-migration.js';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { CustomerExperiments } from '../packages/customer-experiments/src/domain.js';
import { plansDocument } from '../packages/customer-experiments/src/program.js';
import { validateAgreement } from '../packages/customer-experiments/src/schema.js';
import {
  SERVICE_MODEL,
  deliveryReady,
  type CustomerExperiment,
  type ExperimentPlan,
} from '../packages/customer-experiments/src/types.js';
import { registerWorkerTools } from '../packages/customer-experiments/src/worker-tools.js';
import { currentWork } from './fixtures/current-work.js';
import { legacyReports } from './fixtures/legacy-reports.js';
import { waitForManagedCode } from './fixtures/managed-code.js';
import { managedServices } from './fixtures/managed-services.js';
import { openState } from './fixtures/state.js';

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
  version = 5,
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
  service.startVersion = version === 6 ? 1 : version;
  // Exercise the active immutable-submission workflow.
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
  const create = async () => {
    const exp = await service.create(caller, { title: plan.title, requestId: id() });
    if (version !== 6) return exp;
    await state.transaction((tx) =>
      migrateNativeWorkflow(tx, {
        projectId: exp.projectId,
        instanceId: exp.id,
        expectedRevision: exp.workflow.revision,
        fromVersion: 1,
        toVersion: 6,
        actorId: caller.actorId,
        reason: 'Preserve structured intake while enabling native Git execution.',
      }),
    );
    return service.get(caller, exp.id);
  };
  const proposeDocument = async (exp: CustomerExperiment, question = plan.question) => {
    let document = await service.plan(caller, exp.id);
    document = await service.writePlan(caller, {
      id: exp.id,
      expectedRevision: document.revision,
      by: 'customer',
      document: `# ${plan.title}\n\n${question}\n\n${plan.executionSpec}`,
    });
    await service.submitPlan(caller, { id: exp.id, expectedRevision: document.revision });
    await service.verifyPlan(caller, {
      id: exp.id,
      revision: document.revision,
      decision: 'accept',
      question,
      criteria: plan.successCriteria,
      limits: plan.limits,
      files: [],
    });
    return service.get(caller, exp.id);
  };
  const prepare = async () => {
    const exp = await create();
    return plansDocument(exp.workflow.version)
      ? proposeDocument(exp)
      : service.propose(caller, {
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
    capabilities: ['code.v2', 'code.git.1'],
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
    proposeDocument,
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
    f.service.writePlan(f.caller, {
      id: exp.id,
      expectedRevision: (await f.service.plan(f.caller, exp.id)).revision,
      document: 'A changed plan after acceptance',
      by: 'customer',
    }),
    errorCode('plan_locked'),
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
    capabilities: ['code.v2', 'code.git.1'],
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
  exp = await f.proposeDocument(exp, 'Does a revised classification rule improve accuracy?');
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

for (const version of [5, 6])
  test(`v${version} dirty customer results freeze without a commit, then delivery waits for exact approved retention`, async (t) => {
    const f = await fixture(t, undefined, version);
    let exp = await f.pay();
    const producer = await f.offer();
    const epoch = exp.workflow.data.computeEpoch;
    assert.equal(producer.session.kind, 'work');
    if (producer.session.kind === 'work') {
      assert.deepEqual(producer.session.execution.policy.platform, SERVICE_MODEL);
      const workspacePolicy = producer.session.execution.policy.workspace;
      assert.ok(workspacePolicy && workspacePolicy.mode !== 'none');
      assert.equal(workspacePolicy.driver, 'code.git.1');
      assert.match(producer.session.assignment.brief, /ordinary Git/);
      assert.doesNotMatch(producer.session.assignment.brief, /code\.commit/);
      if (version === 6) {
        const declaration = await f.state.read((sql) =>
          sql.get<{ version: number }>('SELECT version FROM code_units WHERE unit_id=?', exp.id),
        );
        assert.equal(declaration!.version, 1, 'native execution preserves declaration provenance');
        assert.match(producer.session.assignment.brief, /dataset SHA-256/);
        assert.doesNotMatch(
          producer.session.assignment.brief,
          /customer_experiment\.file_download/,
        );
        await assert.rejects(
          f.tools.get('customer_experiment.files')!(producer.worker, { id: exp.id } as never),
          errorCode('not_found'),
        );
      }
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
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    const repository = f.managed.core.repositories.paths(f.caller.projectId).repository;
    const parent = git(producer.workspace.path, 'rev-parse', 'HEAD');
    const count = () => Number(git(repository, 'rev-list', '--all', '--count'));
    const before = count();
    const content = 'console.log({baseline:0.5,candidate:1});\n';
    writeFileSync(join(producer.workspace.path, 'experiment.ts'), content);
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
    assert.equal(exp.submission!.codeHead, parent);
    assert.equal(count(), before, 'submission must not create a commit');
    await assert.rejects(
      f.reviews.start(f.caller, exp.review!.id),
      errorCode('leased_review_required'),
    );
    const reviewer = await f.offer();
    assert.equal(reviewer.session.execution.references.computeKind, 'experiment');
    assert.equal(reviewer.session.execution.references.computeProfile, 'check');
    assert.notEqual(reviewer.worker.actorId, producer.worker.actorId);
    assert.equal(reviewer.workspace.readOnly, true);
    assert.equal(readFileSync(join(reviewer.workspace.path, 'experiment.ts'), 'utf8'), content);
    assert.equal(git(reviewer.workspace.path, 'rev-parse', 'HEAD'), parent);
    const tree = reviewer.workspace.snapshot!.submission!.treeOid;
    const storage = f.managed.code.gitRemote;
    let unavailable = true;
    f.managed.code.bindSubmissionStorage({
      verifySubmission: (...args) => storage.verifySubmission(...args),
      materializeSubmission: (...args) =>
        unavailable
          ? Promise.reject(new Error('Git retention unavailable'))
          : storage.materializeSubmission(...args),
    });
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
    await f.managed.code.submissions.reconcile();
    exp = await f.service.get(f.caller, exp.id);
    assert.equal(deliveryReady(exp), false, 'customer delivery waits for durable approved code');
    assert.equal(exp.submission!.codeHead, undefined);
    assert.equal(count(), before);
    unavailable = false;
    await f.managed.code.submissions.reconcile();
    exp = await f.service.get(f.caller, exp.id);
    assert.equal(deliveryReady(exp), true);
    const approved = exp.submission!.codeHead!;
    assert.notEqual(approved, parent);
    assert.equal(git(repository, 'rev-parse', `${approved}^{tree}`), tree);
    assert.equal(git(repository, 'show', `${approved}:experiment.ts`), content.trim());
    assert.equal(count(), before + 1);
    await f.managed.code.submissions.reconcile();
    assert.equal(count(), before + 1);
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

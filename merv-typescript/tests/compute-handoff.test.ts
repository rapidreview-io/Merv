import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Caller, Data, Task } from '@merv/contracts';
import type { SandboxCompute, SandboxRental } from '@merv/sandboxes/types';
import type { TaskService } from '@merv/tasks';
import { createApp } from './fixtures/app.js';
import { confirmedDelivery, reviewedFindings } from './fixtures/task-evidence.js';
import type { ExperimentService } from '@merv/experiments';
import type { Experiment } from '@merv/experiments/types';
import { feasibilityStatement, citedEvidence } from './feasibility-fixture.js';

test('real Sessions tools preserve the same rented GPU through task producer/reviewer handoff', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-compute-handoff-'));
  const app = await createApp({ directory, api: true, port: 0 });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const human = await app.ctx.scope.acceptVerifiedIdentity({
    issuer: 'https://identity.example/auth/v1',
    subject: randomUUID(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  const project = await app.ctx.scope.createProject(human, {
    name: 'Compute handoff',
    requestId: randomUUID(),
  });
  const operator = await app.ctx.scope.caller(human, project.id);
  let rents = 0,
    stops = 0,
    certs = 0;
  let rental: SandboxRental = {
    sandboxId: 'sbx_shared',
    state: 'ready',
    leaseExpiresAt: new Date(Date.now() + 1800000).toISOString(),
    hourlyPrice: { amount: '0.2', currency: 'USD' },
    reason: null,
  };
  const adapter: SandboxCompute = {
    since: '2000-01-01T00:00:00Z',
    async offers() {
      return { offers: [] };
    },
    async allowance() {
      return {};
    },
    async submit() {
      return 'run_capture';
    },
    async get() {
      return {
        id: 'run_capture',
        state: 'failed',
        reason: null,
        cost: null,
        result: { exit: 7 },
        outputState: 'committed',
        outputs: [
          {
            name: 'checkpoint.bin',
            objectId: 'obj_checkpoint',
            sizeBytes: 12,
            sha256: 'a'.repeat(64),
            expiresAt: null,
          },
        ],
      };
    },
    async retain() {},
    async cancel() {},
    async rent() {
      rents++;
      return rental;
    },
    async inspectRental() {
      return rental;
    },
    async releaseRental() {
      stops++;
      rental = { ...rental, state: 'stopped' };
      return rental;
    },
    async ssh(_project, sandboxId) {
      assert.equal(sandboxId, 'sbx_shared');
      return { certificate: `cert-${++certs}`, sandboxId };
    },
  };
  const tasks = app.ctx.tasks as TaskService;
  const unbind = tasks.bindCompute(adapter);
  t.after(unbind);
  const invoke = async <T = any>(worker: Caller, name: string, input: Data): Promise<T> =>
    (await app.ctx.tools.invoke(name, worker, input)).value as T;
  const offer = async (task: Task) => {
    const secret = `ms_${randomBytes(32).toString('base64url')}`;
    const session = await app.ctx.sessions.offer(operator, {
      instanceId: task.id,
      expectedRevision: task.workflow.revision,
      runnerId: 'handoff',
      requestId: randomUUID(),
      secret,
    });
    return { session, worker: await app.ctx.sessions.authenticate(secret) };
  };
  const task = await tasks.create(operator, {
    title: 'GPU handoff canary',
    goal: 'Retain a shared GPU environment for verification.',
    checks: ['The environment is available to an independent reviewer.'],
    requestId: randomUUID(),
  });
  const producer = await offer(task);
  await invoke(producer.worker, 'task.compute_run', {
    key: 'capture',
    provider: 'test',
    offerId: 'gpu',
    command: 'train',
    minutes: 5,
    maxUsd: 1,
    outputs: { files: [{ name: 'checkpoint.bin', path: '/tmp/checkpoint.bin' }], maxBytes: 1024 },
  });
  await tasks.computeTick();
  await tasks.computeTick();
  const capture = await invoke(producer.worker, 'task.compute_status', { runId: 'run_capture' });
  assert.ok(capture.artifactId);
  const rented = await invoke(producer.worker, 'task.compute_rent', {
    key: 'shared',
    provider: 'test',
    offerId: 'gpu',
    minutes: 30,
  });
  assert.equal(rented.state, 'queued');
  await tasks.computeTick();
  const first = await invoke(producer.worker, 'task.compute_ssh', {
    sandboxId: 'sbx_shared',
    publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEXAMPLE producer',
  });
  assert.equal(first.certificate, 'cert-1');
  await assert.rejects(
    invoke(producer.worker, 'task.compute_ssh', {
      taskId: 'other-task',
      sandboxId: 'sbx_shared',
      publicKey: 'ssh-ed25519 AAAA other',
    }),
    { code: 'execution_arguments_forbidden' },
  );
  const evidence = await invoke(producer.worker, 'artifact.create', {
    title: 'Handoff record',
    content:
      'Machine sbx_shared is intentionally retained for the reviewer. No long work is needed.',
  });
  const delivered = await invoke<Task>(
    producer.worker,
    'task.submit_delivery',
    confirmedDelivery({ artifactIds: [evidence.id, capture.artifactId], requestId: randomUUID() }),
  );
  await app.ctx.sessions.release(operator, { sessionId: producer.session.id, runnerId: 'handoff' });
  await app.ctx.domainEvents.drain();
  await tasks.computeTick();
  assert.equal(stops, 0, 'review handoff does not release compute');
  const reviewer = await offer(delivered);
  const retained = await invoke(reviewer.worker, 'artifact.get', {
    artifactId: capture.artifactId,
  });
  assert.equal(
    retained.files.length,
    1,
    'service-authored capture is pinned for independent review',
  );
  const assignment = await app.ctx.workflows.assignment(reviewer.worker, task.id);
  assert.match(assignment.brief, /sbx_shared/);
  assert.match(assignment.brief, /Compute is optional for review/);
  assert.match(assignment.brief, /do not launch training, full evaluations/);
  const available = await invoke(reviewer.worker, 'task.compute_machines', {});
  assert.equal(available[0].sandboxId, 'sbx_shared');
  const second = await invoke(reviewer.worker, 'task.compute_ssh', {
    sandboxId: 'sbx_shared',
    publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEXAMPLE reviewer',
  });
  assert.equal(second.certificate, 'cert-2');
  assert.equal(rents, 1);
  await assert.rejects(
    invoke(reviewer.worker, 'task.compute_run', {
      key: 'training',
      provider: 'test',
      offerId: 'gpu',
      command: 'train',
      minutes: 10,
      maxUsd: 1,
    }),
    { code: 'execution_tool_forbidden' },
  );
  const review = await app.ctx.reviews.get(operator, delivered.reviewId!);
  await invoke(reviewer.worker, 'review.submit', {
    verdict: 'pass',
    notes: 'Independent bounded check verified the retained machine.',
    ...reviewedFindings(review),
    requestId: randomUUID(),
  });
  await tasks.computeTick();
  assert.equal(stops, 1, 'terminal task releases its machine');
  await assert.rejects(
    tasks.computeSsh(producer.worker, task.id, 'sbx_shared', 'ssh-ed25519 AAAA stale'),
  );
});

test('experiment planning, both reviewers and execution share the work-owned rental', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-experiment-handoff-'));
  const app = await createApp({ directory, api: true, port: 0 });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const human = await app.ctx.scope.acceptVerifiedIdentity({
    issuer: 'https://identity.example/auth/v1',
    subject: randomUUID(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  const project = await app.ctx.scope.createProject(human, {
    name: 'Experiment handoff',
    requestId: randomUUID(),
  });
  const operator = await app.ctx.scope.caller(human, project.id);
  let rents = 0,
    stops = 0,
    certs = 0;
  let rental: SandboxRental = {
    sandboxId: 'sbx_experiment',
    state: 'ready',
    leaseExpiresAt: new Date(Date.now() + 3600000).toISOString(),
    hourlyPrice: null,
    reason: null,
  };
  const adapter: SandboxCompute = {
    since: '2000-01-01T00:00:00Z',
    async offers() {
      return { offers: [] };
    },
    async allowance() {
      return {};
    },
    async submit() {
      return 'unused';
    },
    async get() {
      throw Error('unused');
    },
    async cancel() {},
    async rent() {
      rents++;
      return rental;
    },
    async inspectRental() {
      return rental;
    },
    async releaseRental() {
      stops++;
      rental = { ...rental, state: 'stopped' };
      return rental;
    },
    async ssh() {
      return { certificate: `cert-${++certs}` };
    },
  };
  const experiments = app.ctx.experiments as ExperimentService;
  const unbind = experiments.bindCompute(adapter);
  t.after(unbind);
  const invoke = async <T = any>(worker: Caller, name: string, input: Data): Promise<T> =>
    (await app.ctx.tools.invoke(name, worker, input)).value as T;
  const offer = async (experiment: Experiment) => {
    const secret = `ms_${randomBytes(32).toString('base64url')}`;
    const session = await app.ctx.sessions.offer(operator, {
      instanceId: experiment.id,
      expectedRevision: experiment.workflow.revision,
      runnerId: 'handoff',
      requestId: randomUUID(),
      secret,
    });
    return { session, worker: await app.ctx.sessions.authenticate(secret) };
  };
  const release = async (sessionId: string) => {
    await app.ctx.sessions.release(operator, { sessionId, runnerId: 'handoff' });
    await app.ctx.domainEvents.drain();
  };
  let experiment = await experiments.create(operator, {
    name: 'shared-feasibility-environment',
    intent: 'Use the same retained environment for a small comparison.',
    requestId: randomUUID(),
  });
  const planner = await offer(experiment);
  await invoke(planner.worker, 'compute.rent', {
    key: 'shared',
    provider: 'test',
    offerId: 'gpu',
    minutes: 60,
  });
  await experiments.computeTick();
  assert.equal(
    (
      await invoke(planner.worker, 'compute.ssh', {
        sandboxId: rental.sandboxId,
        publicKey: 'ssh-ed25519 AAAA planner',
      })
    ).certificate,
    'cert-1',
  );
  const attach = async (worker: Caller, role: string, content: string) => {
    const artifact = await invoke(worker, 'artifact.create', {
      title: role,
      content,
      mediaType: role === 'feasibility' ? 'application/json' : 'text/markdown',
    });
    await invoke(worker, 'experiment.attach', {
      attemptIndex: experiment.attempt.index,
      artifactId: artifact.id,
      role,
      path: `${role}.md`,
      ...(role === 'result' ? { resultFormat: 'qualitative' } : {}),
      requestId: randomUUID(),
    });
  };
  await attach(
    planner.worker,
    'plan',
    '# Summary\nCompare A and B.\n# Objective & hypothesis\nA improves accuracy.\n# Evaluation\nUse identical held-out examples and compare accuracy against B.',
  );
  await attach(planner.worker, 'feasibility', feasibilityStatement());
  experiment = await invoke(planner.worker, 'experiment.transition', {
    transition: 'submit_design',
    requestId: randomUUID(),
  });
  await release(planner.session.id);
  const review = async (current: Experiment) => {
    const reviewer = await offer(current);
    assert.match(reviewer.session.assignment.brief, /sbx_experiment/);
    assert.match(reviewer.session.assignment.brief, /Compute is optional for review/);
    assert.equal(
      (await invoke(reviewer.worker, 'compute.machines', {}))[0].sandboxId,
      rental.sandboxId,
    );
    await invoke(reviewer.worker, 'compute.ssh', {
      sandboxId: rental.sandboxId,
      publicKey: 'ssh-ed25519 AAAA reviewer',
    });
    await assert.rejects(
      invoke(reviewer.worker, 'compute.run', {
        key: 'long',
        provider: 'test',
        offerId: 'gpu',
        command: 'train',
        minutes: 60,
        maxUsd: 1,
      }),
      { code: 'execution_tool_forbidden' },
    );
    const request = await app.ctx.reviews.get(operator, current.reviewId!);
    const findings = reviewedFindings(request) as {
      findings: Array<{ criterionNumber: number; evidenceIds: string[] }>;
    };
    for (const finding of findings.findings)
      finding.evidenceIds = citedEvidence(current, request, finding.criterionNumber);
    const next = await invoke<Experiment>(reviewer.worker, 'review.submit', {
      verdict: 'pass',
      notes: 'Independent brief verification of retained environment and evidence.',
      ...findings,
      requestId: randomUUID(),
    });
    await release(reviewer.session.id);
    return next;
  };
  experiment = await review(experiment);
  assert.equal(experiment.workflow.state, 'running');
  const executor = await offer(experiment);
  assert.match(executor.session.assignment.brief, /sbx_experiment/);
  await invoke(executor.worker, 'compute.ssh', {
    sandboxId: rental.sandboxId,
    publicKey: 'ssh-ed25519 AAAA executor',
  });
  await attach(executor.worker, 'result', 'Matched comparison produced equal observations.');
  await attach(
    executor.worker,
    'report',
    '# Summary\nA and B behaved alike.\n# Results\nThe matched observations were equal.\n# Deviations from plan\nNone.\n# Conclusion\nNo improvement observed.',
  );
  experiment = await invoke(executor.worker, 'experiment.transition', {
    transition: 'submit_results',
    requestId: randomUUID(),
  });
  await release(executor.session.id);
  await experiments.computeTick();
  assert.equal(stops, 0);
  experiment = await review(experiment);
  assert.equal(experiment.workflow.state, 'complete');
  await experiments.computeTick();
  assert.equal(rents, 1);
  assert.equal(certs, 4);
  assert.equal(stops, 1);
});

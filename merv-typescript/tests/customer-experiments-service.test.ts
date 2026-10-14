import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createService, MervError, type Caller } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { DiskBlobs } from '@merv/blobs';
import { ArtifactStore } from '@merv/artifacts';
import { WorkflowsService } from '@merv/workflows';
import { ReviewService } from '@merv/reviews';
import { ApiServer } from '../packages/api/src/http.js';
import { ToolRegistry } from '../packages/api/src/registry.js';
import type { AnyToolDefinition } from '@merv/api/types';
import type { PiRuntime, PiProfile } from '@merv/pi/types';
import { CustomerExperiments } from '../packages/customer-experiments/src/domain.js';
import { CustomerService } from '../packages/customer-experiments/src/service.js';
import { RequestStore } from '../packages/customer-experiments/src/store.js';
import { customerHttp } from '../packages/customer-experiments/src/http.js';
import type { ExperimentPlan } from '../packages/customer-experiments/src/types.js';
import type { DatasetStorage } from '../packages/customer-experiments/src/data.js';
import type { PaidCheckout, Payments } from '../packages/customer-experiments/src/payment.js';
import { openState } from './fixtures/state.js';
import { managedServices } from './fixtures/managed-services.js';

const plan: ExperimentPlan = {
  title: 'Compare fixed classification rules',
  question: 'Does the candidate improve accuracy?',
  decision: 'Choose the classifier for deployment.',
  rationale: 'The evaluation resolves a concrete model choice.',
  hypothesis: 'The candidate improves accuracy by five points.',
  method: ['Score both classifiers on the same fixed cases.'],
  baseline: 'Always predict the majority class.',
  metric: 'Accuracy',
  successCriteria: ['Accuracy improves by at least 0.05.'],
  research: [],
  code: null,
  models: [],
  dataRequirements: [],
  limits: { wallMinutes: 10, maxTokens: 10000, maxAttempts: 2 },
  turnaround: 'Within one hour once a worker is available',
  deliverables: ['Metrics, report, and runnable code'],
  executionSpec:
    'Generate 100 deterministic labeled integers, compare parity to the majority baseline using TypeScript, and retain the metrics.',
  feasibility: '100 cases, CPU only, no network or external services.',
};
const base = '/customer-experiments/requests';
const intakeKey = 'test-intake-invitation-only';

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'merv-customer-service-'));
  const state = await openState(dir);
  const scope = await createService(new ProjectScope(state));
  const sponsor = { issuer: 'https://identity.example', subject: 'service-sponsor' };
  const principal = await scope.members.acceptVerifiedIdentity({
    ...sponsor,
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  const project = await scope.members.createProject(principal, {
    name: 'Host fixture',
    requestId: 'host',
  });
  const owner = await scope.caller(principal, project.id);
  const artifacts = await createService(
    new ArtifactStore(state, scope, new DiskBlobs(join(dir, 'blobs'))),
  );
  const workflows = await createService(new WorkflowsService(state, scope));
  const reviews = await createService(new ReviewService(state, scope, artifacts));
  const managed = await managedServices(
    { state, scope, artifacts, workflows, reviews },
    dir,
    owner,
  );
  const domain = await createService(
    new CustomerExperiments(
      state,
      scope,
      artifacts,
      workflows,
      reviews,
      managed.code,
      managed.sessions,
    ),
  );
  const store = new RequestStore(state, 'fixture-key-never-valid-outside-this-test');
  await store.initialize();
  const profiles: PiProfile[] = [];
  const conversations: { id: string; projectId: string }[] = [];
  const pi = {
    registerProfile(profile: PiProfile) {
      profiles.push(profile);
      return () => {};
    },
    async createProfiled(caller: Caller, input: Parameters<PiRuntime['createProfiled']>[1]) {
      const previous = conversations.find(
        (conversation) => conversation.id === 'pi_' + input.requestId,
      );
      if (previous) return previous;
      const conversation = { id: 'pi_' + input.requestId, projectId: caller.projectId };
      conversations.push(conversation);
      return conversation;
    },
    async send() {
      return { id: 'command' };
    },
    async snapshot() {
      return {
        commands: [
          {
            messages: [{ role: 'assistant', text: 'What decision should this experiment settle?' }],
          },
        ],
        stage: { name: 'idle' },
      };
    },
  } as unknown as PiRuntime;
  const bytes = new Map<string, Buffer>();
  const provisioned: string[] = [];
  const storage: DatasetStorage = {
    bucket(id) {
      return 'fixture-private-' + id;
    },
    async provision(id) {
      provisioned.push(id);
    },
    async upload(id, sha256) {
      return {
        url: 'https://storage.example/' + id + '/' + sha256,
        headers: { 'If-None-Match': '*' },
        expiresAt: new Date(Date.now() + 600000).toISOString(),
      };
    },
    async read(id, sha256) {
      const value = bytes.get(id + ':' + sha256);
      assert.ok(value, 'fixture upload exists');
      return value;
    },
    async download(id, sha256) {
      return {
        url: 'https://storage.example/' + id + '/' + sha256,
        expiresAt: new Date(Date.now() + 600000).toISOString(),
      };
    },
    async close() {},
  };
  const checkoutCalls: Parameters<Payments['checkout']>[0][] = [];
  const computePreparations: string[] = [];
  const computeReads: string[] = [];
  const compute = {
    async options(caller: Caller) {
      computeReads.push(caller.projectId);
      return {
        checkedAt: new Date().toISOString(),
        source: 'sandboxes' as const,
        offers: [],
        notice: 'Current inventory, not a reservation.',
      };
    },
    async prepareExecution(caller: Caller) {
      assert.equal(
        state.ambient,
        undefined,
        'Compute provider calls must run outside transactions',
      );
      computePreparations.push(caller.projectId);
    },
  };
  const payments: Payments = {
    async checkout(input) {
      checkoutCalls.push(input);
      return {
        id: 'cs_' + input.requestId + '_' + input.generation,
        url: 'https://checkout.stripe.com/fixture',
        expiresAt: Date.now() / 1000 + 1800,
      };
    },
    verify(bytes, signature) {
      if (signature !== 'fixture-valid-signature')
        throw new MervError('invalid_webhook', 'Invalid signature', 400);
      return JSON.parse(bytes.toString()) as PaidCheckout;
    },
  };
  const service = new CustomerService(
    store,
    domain,
    scope,
    artifacts,
    pi,
    storage,
    payments,
    undefined,
    { publicOrigin: 'https://merv.example', sponsor, intakeKey, maxRequestsPerDay: 20 },
    compute,
  );
  const tools = new ToolRegistry(scope);
  const registered = new Map<string, AnyToolDefinition>();
  const register = tools.register.bind(tools);
  tools.register = ((definition: AnyToolDefinition) => {
    registered.set(definition.name, definition);
    return register(definition);
  }) as typeof tools.register;
  const disposers = await service.registerIntake(tools);
  const api = new ApiServer(scope, tools, { port: 0 });
  api.mount('/customer-experiments', customerHttp(service), { public: true });
  const url = await api.start();
  t.after(async () => {
    await api.stop();
    for (const dispose of disposers.reverse()) await dispose();
    await tools.close();
    domain.close();
    await managed.close();
    reviews.close();
    workflows.close();
    await state.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const send = async (
    path: string,
    token?: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ) => {
    const response = await fetch(url + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        'Content-Type': 'application/json',
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      headers: response.headers,
      body: response.headers.get('content-type')?.includes('application/json')
        ? await response.json()
        : await response.text(),
    };
  };
  const creationIds = new Map<string, string>();
  const create = async (label = 'first') => {
    if (!creationIds.has(label)) creationIds.set(label, randomUUID());
    const requestId = creationIds.get(label)!;
    const response = await send(base, intakeKey, { requestId, title: plan.title });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return {
      ...response.body,
      customerToken: new URL(response.body.customerUrl).hash.slice('#token='.length),
    } as { id: string; agentToken: string; customerToken: string; customerUrl: string };
  };
  const propose = async (id: string, next = plan) => {
    const record = await store.get(id);
    const caller = await service.caller(record);
    const definition = registered.get('customer_experiments.propose')!;
    return definition.handler(
      { ...caller, conversation: { id: record.conversationId } } as Caller,
      { id, plan: next },
    );
  };
  const experiment = async (id: string) => {
    const record = await store.get(id);
    return domain.get(await service.caller(record), record.experimentId!);
  };
  return {
    state,
    scope,
    domain,
    service,
    store,
    send,
    create,
    propose,
    experiment,
    profiles,
    conversations,
    bytes,
    provisioned,
    checkoutCalls,
    payments,
    compute,
    computeReads,
    computePreparations,
    tools,
    registered,
  };
}

test('request HTTP capabilities isolate customers, forbid agent approval, and keep public pages credential-free', async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.send(base, 'wrong', { requestId: randomUUID(), title: 'No invitation' })).status,
    401,
  );
  assert.equal(
    (await f.send(base, intakeKey, { requestId: 'predictable', title: plan.title })).status,
    400,
  );
  const a = await f.create();
  const replay = await f.create();
  const b = await f.create('second');
  assert.deepEqual(replay, a);
  assert.notEqual((await f.store.get(a.id)).projectId, (await f.store.get(b.id)).projectId);
  assert.equal(f.conversations.length, 2);
  assert.deepEqual(f.profiles[0].model, { id: 'gpt-6-astra', effort: 'medium' });
  assert.deepEqual(f.profiles[0].tools, [
    'customer_experiments.read',
    'customer_experiments.compute_options',
    'customer_experiments.propose',
  ]);
  assert.equal((await f.send(base + '/' + b.id, a.customerToken)).status, 401);
  assert.equal((await f.send(base + '/' + a.id)).status, 401);
  assert.equal(
    (
      await f.send(base + '/' + a.id + '/accept', a.agentToken, {
        contractVersion: 1,
        email: 'customer@example.com',
      })
    ).status,
    401,
  );
  const page = await f.send('/customer-experiments/r/' + a.id);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'private, no-store');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.ok(!page.body.includes(a.customerToken) && !page.body.includes(a.agentToken));
  const snapshot = await f.send(base + '/' + a.id, a.agentToken);
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.body.workflow.state, 'planning');
  assert.equal(snapshot.body.conversation[0].text, 'What decision should this experiment settle?');
});

test('a ready contract needs customer acceptance and a matching verified payment; webhook retries release it once', async (t) => {
  const f = await fixture(t);
  const a = await f.create();
  await f.propose(a.id);
  let exp = await f.experiment(a.id);
  assert.equal(exp.workflow.state, 'ready');
  const approval = { contractVersion: exp.contract!.version, email: 'customer@example.com' };
  assert.equal(
    (await f.send(base + '/' + a.id + '/checkout', a.customerToken, approval)).status,
    409,
  );
  assert.equal(
    (
      await f.send(base + '/' + a.id + '/accept', a.customerToken, {
        ...approval,
        contractVersion: 99,
      })
    ).status,
    409,
  );
  assert.equal(
    (await f.send(base + '/' + a.id + '/accept', a.customerToken, approval)).status,
    200,
  );
  assert.equal(
    (await f.send(base + '/' + a.id + '/accept', a.customerToken, approval)).status,
    200,
  );
  exp = await f.experiment(a.id);
  assert.equal(exp.workflow.state, 'awaiting_payment');
  assert.equal(
    (
      await f.send(base + '/' + a.id + '/messages', a.agentToken, {
        commandId: 'late',
        text: 'Change the model',
      })
    ).status,
    409,
  );
  const checkout = await f.send(base + '/' + a.id + '/checkout', a.customerToken, approval);
  assert.equal(checkout.status, 200);
  const paid: PaidCheckout = {
    eventId: 'evt_paid',
    requestId: a.id,
    contractHash: exp.contract!.hash,
    checkoutId: checkout.body.id,
    paymentId: 'pi_paid',
    amountCents: 500,
    currency: 'usd',
  };
  const webhook = (event: PaidCheckout, signature = 'fixture-valid-signature') =>
    f.send('/customer-experiments/stripe-webhook', undefined, event, {
      'Stripe-Signature': signature,
    });
  assert.equal((await webhook(paid, 'untrusted')).status, 400);
  assert.equal((await webhook({ ...paid, contractHash: 'not-the-accepted-contract' })).status, 409);
  assert.equal((await webhook({ ...paid, amountCents: 1 })).status, 409);
  assert.equal((await f.experiment(a.id)).workflow.state, 'awaiting_payment');
  await f.store.mutate(a.id, (record) => {
    record.checkout!.expiresAt = Date.now() / 1000 - 1;
  });
  const newerCheckout = await f.send(base + '/' + a.id + '/checkout', a.customerToken, approval);
  assert.equal(newerCheckout.status, 200);
  assert.notEqual(newerCheckout.body.id, checkout.body.id);
  assert.equal((await webhook(paid)).status, 200);
  exp = await f.experiment(a.id);
  assert.equal(exp.workflow.state, 'running');
  const revision = exp.workflow.revision;
  assert.equal((await webhook(paid)).status, 200);
  assert.equal((await webhook({ ...paid, eventId: 'evt_retry' })).status, 200);
  assert.equal((await f.experiment(a.id)).workflow.revision, revision);
  assert.equal(
    (await f.state.read((sql) => sql.all('SELECT * FROM customer_experiment_payments'))).length,
    1,
  );
  assert.equal(
    (await f.state.read((sql) => sql.all('SELECT * FROM customer_experiment_acceptances'))).length,
    1,
  );
});

test('required files remain planning until content validates; accepted manifest and request bucket stay fixed', async (t) => {
  const f = await fixture(t);
  const a = await f.create();
  const b = await f.create('other');
  const withData: ExperimentPlan = {
    ...plan,
    dataRequirements: [
      {
        id: 'eval',
        label: 'Held-out cases',
        role: 'evaluation',
        format: 'csv',
        columns: ['text', 'label'],
        labelColumn: 'label',
        minRows: 2,
      },
    ],
  };
  await f.propose(a.id, withData);
  assert.equal((await f.experiment(a.id)).workflow.state, 'planning');
  const bytes = Buffer.from('text,label\none,positive\ntwo,negative\n');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const input = {
    requirementId: 'eval',
    filename: 'eval.csv',
    sha256,
    size: bytes.length,
    mediaType: 'text/csv',
  };
  const upload = await f.send(base + '/' + a.id + '/uploads', a.customerToken, input);
  assert.equal(upload.status, 200);
  assert.deepEqual(f.provisioned, [a.id]);
  assert.equal((await f.experiment(a.id)).workflow.state, 'planning');
  assert.equal(
    (
      await f.send(
        base + '/' + b.id + '/uploads/' + upload.body.uploadId + '/complete',
        b.customerToken,
        {},
      )
    ).status,
    404,
  );
  f.bytes.set(a.id + ':' + sha256, bytes);
  const complete = await f.send(
    base + '/' + a.id + '/uploads/' + upload.body.uploadId + '/complete',
    a.customerToken,
    {},
  );
  assert.equal(complete.status, 200, JSON.stringify(complete.body));
  let exp = await f.experiment(a.id);
  assert.equal(exp.workflow.state, 'ready');
  assert.equal(exp.contract!.datasets[0].sha256, sha256);
  assert.equal(exp.contract!.datasets[0].bucket, 'fixture-private-' + a.id);
  assert.equal(exp.contract!.datasets[0].rows, 2);
  await f.send(base + '/' + a.id + '/accept', a.customerToken, {
    contractVersion: exp.contract!.version,
    email: 'customer@example.com',
  });
  const frozen = exp.contract;
  assert.equal(
    (
      await f.send(base + '/' + a.id + '/uploads', a.customerToken, {
        ...input,
        filename: 'replacement.csv',
      })
    ).status,
    409,
  );
  exp = await f.experiment(a.id);
  assert.deepEqual(exp.contract, frozen);
});

test('repeating the same intake proposal preserves the ready contract and workflow revision', async (t) => {
  const f = await fixture(t);
  const request = await f.create();
  await f.propose(request.id);
  const ready = await f.experiment(request.id);
  await f.propose(request.id);
  await f.propose(request.id);
  const repeated = await f.experiment(request.id);
  assert.equal(repeated.workflow.state, 'ready');
  assert.equal(repeated.workflow.revision, ready.workflow.revision);
  assert.deepEqual(repeated.contract, ready.contract);
  assert.equal(
    (await f.state.read((sql) => sql.all('SELECT id FROM customer_experiment_contracts'))).length,
    1,
  );
});

test('a replacement upload invalidates the offer until the newest file validates, then requires approval of its new contract', async (t) => {
  const f = await fixture(t);
  const request = await f.create();
  const withData: ExperimentPlan = {
    ...plan,
    dataRequirements: [
      {
        id: 'eval',
        label: 'Evaluation cases',
        role: 'evaluation',
        format: 'csv',
        columns: ['text', 'label'],
        labelColumn: 'label',
        minRows: 2,
      },
    ],
  };
  await f.propose(request.id, withData);
  const begin = async (content: string, filename: string) => {
    const bytes = Buffer.from(content);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    f.bytes.set(request.id + ':' + sha256, bytes);
    const response = await f.send(base + '/' + request.id + '/uploads', request.customerToken, {
      requirementId: 'eval',
      filename,
      sha256,
      size: bytes.length,
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return { id: response.body.uploadId as string, sha256 };
  };
  const complete = (uploadId: string) =>
    f.send(
      base + '/' + request.id + '/uploads/' + uploadId + '/complete',
      request.customerToken,
      {},
    );
  const original = await begin('text,label\none,positive\ntwo,negative\n', 'original.csv');
  assert.equal((await complete(original.id)).status, 200);
  const old = await f.experiment(request.id);
  assert.equal(old.workflow.state, 'ready');
  const replacement = await begin('text,label\nthree,negative\nfour,positive\n', 'replacement.csv');
  assert.equal((await f.experiment(request.id)).workflow.state, 'planning');
  await f.propose(request.id, withData);
  const pending = await f.experiment(request.id);
  assert.equal(
    pending.workflow.state,
    'planning',
    'an older validated file cannot satisfy a pending replacement',
  );
  assert.equal(
    pending.contract!.version,
    old.contract!.version,
    'no offer is produced while replacement is pending',
  );
  const staleApproval = { contractVersion: old.contract!.version, email: 'customer@example.com' };
  assert.equal(
    (await f.send(base + '/' + request.id + '/accept', request.customerToken, staleApproval))
      .status,
    409,
  );
  assert.equal((await complete(replacement.id)).status, 200);
  const ready = await f.experiment(request.id);
  assert.equal(ready.workflow.state, 'ready');
  assert.equal(ready.contract!.version, old.contract!.version + 1);
  assert.equal(ready.contract!.datasets.length, 1);
  assert.equal(ready.contract!.datasets[0].sha256, replacement.sha256);
  assert.notEqual(ready.contract!.datasets[0].sha256, original.sha256);
  assert.equal(ready.contract!.datasets[0].filename, 'replacement.csv');
  assert.equal(
    (await f.send(base + '/' + request.id + '/accept', request.customerToken, staleApproval))
      .status,
    409,
  );
  assert.equal(
    (
      await f.send(base + '/' + request.id + '/accept', request.customerToken, {
        ...staleApproval,
        contractVersion: ready.contract!.version,
      })
    ).status,
    200,
  );
  assert.equal((await f.experiment(request.id)).acceptedContractId, ready.contract!.id);
});

test('intake reads work in a read-only snapshot but ordinary project callers cannot use either intake tool', async (t) => {
  const f = await fixture(t);
  const request = await f.create();
  const record = await f.store.get(request.id);
  const owner = await f.service.caller(record);
  const conversationCaller = { ...owner, conversation: { id: record.conversationId } } as Caller;
  const head = await f.state.eventHead();
  const snapshot = await f.state.snapshot(() =>
    f.registered.get('customer_experiments.read')!.handler(conversationCaller, { id: request.id }),
  );
  assert.equal((snapshot as { id: string }).id, request.id);
  assert.equal(await f.state.eventHead(), head, 'the read tool does not write workflow state');
  const catalogTool = f.registered.get('customer_experiments.compute_options')!;
  assert.equal('readOnly' in catalogTool && catalogTool.readOnly, true);
  assert.equal('openWorld' in catalogTool && catalogTool.openWorld, true);
  await catalogTool.handler(conversationCaller, { id: request.id });
  assert.deepEqual(f.computeReads, [record.projectId]);
  assert.equal(f.computePreparations.length, 0, 'Planning never enables funded execution');
  const reader = await f.scope.credentials.issueActor(owner, {
    name: 'Ordinary reader',
    role: 'reader',
  });
  for (const caller of [
    owner,
    { actorId: reader.actor.id, projectId: record.projectId!, credentialId: reader.credential.id },
  ]) {
    await assert.rejects(f.tools.call('customer_experiments.read', caller, { id: request.id }), {
      code: 'forbidden',
    });
    await assert.rejects(
      f.tools.call('customer_experiments.compute_options', caller, { id: request.id }),
      {
        code: 'forbidden',
      },
    );
    await assert.rejects(
      f.tools.call('customer_experiments.propose', caller, { id: request.id, plan }),
      { code: 'forbidden' },
    );
  }
  const other = await f.create('other-intake');
  await assert.rejects(async () => catalogTool.handler(conversationCaller, { id: other.id }), {
    code: 'forbidden',
  });
  await assert.rejects(
    async () =>
      f.registered.get('customer_experiments.read')!.handler(conversationCaller, { id: other.id }),
    { code: 'forbidden' },
  );
  await assert.rejects(
    f.profiles[0].authorizeTool!({
      binding: { id: 'customer-experiments-intake', version: 1, requestId: request.id },
      caller: conversationCaller,
      name: 'customer_experiments.read',
      input: { id: other.id },
    }),
    { code: 'forbidden' },
  );
});

test('checkout rollover keeps the previous session across provider failures so retries cannot charge again', async (t) => {
  const f = await fixture(t);
  const request = await f.create();
  await f.propose(request.id);
  const exp = await f.experiment(request.id);
  const approval = { contractVersion: exp.contract!.version, email: 'customer@example.com' };
  await f.send(base + '/' + request.id + '/accept', request.customerToken, approval);
  const original = await f.send(
    base + '/' + request.id + '/checkout',
    request.customerToken,
    approval,
  );
  assert.equal(original.status, 200);
  await f.store.mutate(request.id, (record) => {
    record.checkout!.expiresAt = Date.now() / 1000 - 1;
  });
  const createCheckout = f.payments.checkout;
  const previousIds: (string | undefined)[] = [];
  f.payments.checkout = async (input) => {
    previousIds.push(input.previousId);
    if (input.previousId && previousIds.length === 1)
      throw new MervError('checkout_unavailable', 'Provider request failed temporarily', 503);
    if (input.previousId)
      throw new MervError(
        'payment_processing',
        'This session is already paid; waiting for confirmation',
        409,
      );
    return createCheckout(input);
  };
  assert.equal(
    (await f.send(base + '/' + request.id + '/checkout', request.customerToken, approval)).status,
    503,
  );
  assert.equal(
    (await f.send(base + '/' + request.id + '/checkout', request.customerToken, approval)).status,
    409,
  );
  assert.equal(
    (await f.send(base + '/' + request.id + '/checkout', request.customerToken, approval)).status,
    409,
  );
  assert.deepEqual(previousIds, [original.body.id, original.body.id, original.body.id]);
  assert.equal(
    f.checkoutCalls.length,
    1,
    'no new provider session is created after paid/settling response',
  );
});

test('unavailable internal compute prevents checkout and payment release, while funded preparation never dispatches unpaid work', async (t) => {
  const f = await fixture(t);
  const request = await f.create();
  await f.propose(request.id);
  const exp = await f.experiment(request.id);
  const approval = { contractVersion: exp.contract!.version, email: 'customer@example.com' };
  assert.equal(
    (await f.send(base + '/' + request.id + '/accept', request.customerToken, approval)).status,
    200,
  );
  const prepare = f.compute.prepareExecution;
  f.compute.prepareExecution = async () => {
    throw new MervError('customer_compute_unavailable', 'Compute allowance unavailable', 503);
  };
  assert.equal(
    (await f.send(base + '/' + request.id + '/checkout', request.customerToken, approval)).status,
    503,
  );
  assert.equal(f.checkoutCalls.length, 0);
  assert.equal((await f.experiment(request.id)).workflow.state, 'awaiting_payment');
  f.compute.prepareExecution = prepare;
  const checkout = await f.send(
    base + '/' + request.id + '/checkout',
    request.customerToken,
    approval,
  );
  assert.equal(checkout.status, 200);
  assert.equal((await f.experiment(request.id)).workflow.state, 'awaiting_payment');
  const payment: PaidCheckout = {
    eventId: 'evt_compute_retry',
    requestId: request.id,
    checkoutId: checkout.body.id,
    contractHash: exp.contract!.hash,
    paymentId: 'pi_compute_retry',
    amountCents: 500,
    currency: 'usd',
  };
  f.compute.prepareExecution = async () => {
    throw new MervError('customer_compute_unavailable', 'Compute allowance unavailable', 503);
  };
  await assert.rejects(f.service.paid(payment), { code: 'customer_compute_unavailable' });
  assert.equal((await f.experiment(request.id)).workflow.state, 'awaiting_payment');
  f.compute.prepareExecution = prepare;
  await f.service.paid(payment);
  assert.equal((await f.experiment(request.id)).workflow.state, 'running');
  f.compute.prepareExecution = async () => {
    throw new Error('duplicate event must not need a provider');
  };
  await f.service.paid(payment);
});

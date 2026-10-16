import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { legacyReports } from './fixtures/legacy-reports.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { check, createService, MervError, type Caller } from '@merv/contracts';
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
import { customerHttp, startHttp } from '../packages/customer-experiments/src/http.js';
import type {
  CustomerExperiment,
  ExperimentPlan,
  RequestFiles,
  StructuredContract,
} from '../packages/customer-experiments/src/types.js';
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

/** Requests start on service_experiment@2 here unless a test asks for the plan document (3). */
async function fixture(
  t: TestContext,
  publicIntake = false,
  maxRequestsPerDay = 20,
  version = 2,
  files?: RequestFiles,
) {
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
  domain.bindReports(legacyReports(state));
  domain.startVersion = version;
  const store = new RequestStore(state, 'fixture-key-never-valid-outside-this-test');
  await store.initialize();
  const profiles: PiProfile[] = [];
  const conversations: { id: string; projectId: string; profile?: { version: number } }[] = [];
  const sent: { id: string; input: { commandId: string; text: string } }[] = [];
  const turns: { id: string }[] = [];
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
      const conversation = {
        id: 'pi_' + input.requestId,
        projectId: caller.projectId,
        profile: input.profile,
      };
      conversations.push(conversation);
      return conversation;
    },
    async send(_caller: Caller, id: string, input: { commandId: string; text: string }) {
      if (pi.refuse) throw pi.refuse;
      sent.push({ id, input });
      if (!turns.some((turn) => turn.id === input.commandId)) turns.push({ id: input.commandId });
      return { id: input.commandId };
    },
    async snapshot() {
      return {
        conversation: { activeCommandId: pi.active },
        commands: [
          {
            id: 'initial',
            messages: [{ role: 'assistant', text: 'What decision should this experiment settle?' }],
          },
          ...turns.map((turn) => ({ id: turn.id, messages: [] })),
        ],
        stage: { name: 'idle' },
      };
    },
    /** The turn under way, if any, and an error the next send throws. */
    active: null as string | null,
    refuse: null as Error | null,
  };
  const runtime = pi as unknown as PiRuntime;
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
    runtime,
    storage,
    payments,
    undefined,
    { publicOrigin: 'https://merv.example', sponsor, intakeKey, publicIntake, maxRequestsPerDay },
    compute,
    files,
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
  api.mount(
    '/start',
    startHttp({ publicOrigin: 'https://merv.example', publicIntake, livePayments: false }, service),
    { public: true },
  );
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
    return domain.get(await service.caller(record), record.experimentId!) as Promise<
      CustomerExperiment & { contract: StructuredContract | null }
    >;
  };
  return {
    url,
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
    sent,
    pi,
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
    amountCents: 1000,
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
  for (const name of ['read', 'compute_options', 'propose']) {
    const tool = f.registered.get(`customer_experiments.${name}`)!;
    assert.equal(
      'conversationProfile' in tool && tool.conversationProfile,
      'customer-experiments-intake',
    );
  }
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
    amountCents: 1000,
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

test('the customer monitoring bookmark survives the agent intake expiry', async (t) => {
  const f = await fixture(t);
  const created = await f.create();
  const future = Date.now() + 31 * 86400_000;
  t.mock.method(Date, 'now', () => future);
  assert.equal(
    (await f.store.authorize(created.id, created.customerToken, ['customer'])).id,
    created.id,
  );
  await assert.rejects(f.store.authorize(created.id, created.agentToken, ['agent']), {
    code: 'access_expired',
  });
  await assert.rejects(f.store.authorize(created.id, created.customerToken, ['agent']), {
    code: 'unauthorized',
  });
});

test('public start page and agent guide are readable without exposing or bypassing invitation access', async (t) => {
  const f = await fixture(t);
  const page = await fetch(f.url + '/start');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /A good question/);
  assert.match(html, /Invitation-only preview/);
  assert.match(html, /no real charge/);
  assert.match(html, /href="\/start\/agent.md"/);
  assert.ok(!html.includes(intakeKey));
  const docs = await fetch(f.url + '/start/agent.md');
  assert.match(docs.headers.get('content-type')!, /text\/markdown/);
  const text = await docs.text();
  assert.match(text, /Authorization: Bearer <MERV_EXPERIMENT_INVITE>/);
  assert.match(text, /Never call \/accept or \/checkout/);
  assert.ok(!text.includes(intakeKey));
  const negotiated = await fetch(f.url + '/start', { headers: { Accept: 'text/markdown' } });
  assert.equal(await negotiated.text(), text);
  assert.equal((await fetch(f.url + '/start/requests', { method: 'POST' })).status, 404);
  assert.equal(
    (await f.send(base, undefined, { requestId: randomUUID(), title: 'No invitation' })).status,
    401,
  );
});

test('public intake issues private capabilities, preserves admission limits and requires human approval', async (t) => {
  const f = await fixture(t, true, 1);
  const input = {
    requestId: randomUUID(),
    title: plan.title,
    message: 'Test a bounded hypothesis.',
  };
  const created = await f.send('/start/requests', undefined, input);
  assert.equal(created.status, 200);
  assert.match(created.headers.get('cache-control') ?? '', /no-store/);
  assert.ok(created.body.agentToken);
  assert.ok(created.body.customerUrl.includes('#token='));
  const retry = await f.send('/start/requests', undefined, input);
  assert.deepEqual(retry.body, created.body);
  assert.equal(
    (await f.send('/start/requests', undefined, { ...input, title: 'Different' })).status,
    409,
  );
  assert.equal(
    (await f.send('/start/requests', undefined, { ...input, requestId: randomUUID() })).status,
    429,
  );
  assert.equal(
    (await f.send('/start/requests', undefined, { ...input, requestId: 'guessable' })).status,
    400,
  );
  const path = base + '/' + created.body.id;
  assert.equal((await f.send(path)).status, 401);
  assert.equal((await f.send(path, created.body.agentToken)).status, 200);
  for (const action of ['accept', 'checkout']) {
    assert.equal(
      (
        await f.send(path + '/' + action, created.body.agentToken, {
          contractVersion: 1,
          email: 'test@example.com',
        })
      ).status,
      401,
    );
  }
  assert.equal((await f.send(base, undefined, input)).status, 401);
  const guide = await fetch(f.url + '/start/agent.md').then((r) => r.text());
  assert.ok(guide.includes('Public intake; no invitation required.'));
  assert.ok(guide.includes('POST https://merv.example/start/requests'));
  assert.ok(!guide.includes(intakeKey));
  assert.ok(!guide.includes('MERV_EXPERIMENT_INVITE'));
  assert.equal((await f.experiment(created.body.id)).workflow.state, 'planning');
});

test('platform admin projection shows standalone state without private capabilities', async (t) => {
  const { adminOverview, requireAdmin } = await import('../packages/ui/src/admin.js');
  const f = await fixture(t);
  const created = await f.create();
  const identity = { issuer: 'https://identity.example', subject: 'admin' };
  const human = {
    kind: 'user' as const,
    user: { ...identity, createdAt: new Date().toISOString() },
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  requireAdmin(human, [identity]);
  for (const principal of [
    undefined,
    { ...human, user: { ...human.user, subject: 'other' } },
    { kind: 'actor', actor: { role: 'operator' } },
    { kind: 'key', key: { owner: identity } },
  ]) {
    assert.throws(
      () => requireAdmin(principal as never, [identity]),
      (e: unknown) => e instanceof MervError && e.status === 403,
    );
  }
  assert.throws(() => requireAdmin(human, []));
  const view = await adminOverview(f.state);
  const row = view.rows.find((r) => r.id === created.id || r.requestId === created.id);
  assert.ok(row);
  assert.equal(row.source, 'standalone');
  assert.equal(row.state, 'planning');
  assert.equal(row.paid, false);
  assert.ok(view.unavailable.includes('Project experiments'));
  const json = JSON.stringify(view);
  for (const secret of [created.agentToken, created.customerToken, intakeKey])
    assert.ok(!json.includes(secret));
  assert.ok(!json.includes('clientRequest'));
  assert.ok(!json.includes('checkout'));
});

const fileState = { deleted: false, etag: '' };
const files: RequestFiles = {
  async manifest(id) {
    return [
      { key: 'data/train.csv', size: 2048, etag: '"etag-' + id.slice(-4) + fileState.etag + '"' },
    ];
  },
  async deleted() {
    return fileState.deleted;
  },
};
async function planFixture(t: TestContext) {
  const f = await fixture(t, false, 20, 3, files);
  const a = await f.create();
  const record = await f.store.get(a.id);
  const intake = {
    ...(await f.service.caller(record)),
    conversation: { id: record.conversationId },
  } as Caller;
  const tool = (name: string, input: Record<string, unknown>) => {
    const definition = f.registered.get('customer_experiments.' + name) as unknown as {
      inputSchema: { parse(value: unknown): unknown };
      handler(caller: Caller, input: unknown): Promise<unknown>;
    };
    return definition.handler(
      intake,
      definition.inputSchema.parse({ id: a.id, ...input }),
    ) as Promise<unknown>;
  };
  // v3 customers are the capability plus the browser bound to the request.
  f.service.access.identity = {
    async verify(token) {
      check(token === 'browser', 'unauthorized', 'Authentication required', 401);
      return {
        issuer: 'https://identity.example',
        subject: 'anonymous-browser',
        anonymous: true,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      };
    },
    configuration: () => ({
      enabled: true,
      login: { url: 'https://identity.example', publishableKey: 'publishable' },
    }),
  };
  const browser = { 'X-Merv-Identity': 'browser' };
  const send: typeof f.send = (path, token, body, extra = {}) =>
    f.send(path, token, body, token === a.customerToken ? { ...browser, ...extra } : extra);
  assert.equal((await send(base + '/' + a.id + '/session', a.customerToken, {})).status, 200);
  const put = async (body: unknown, token = a.customerToken) => {
    const response = await fetch(f.url + base + '/' + a.id + '/plan', {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        ...(token === a.customerToken ? browser : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const plan = async () => (await f.send(base + '/' + a.id + '/plan', a.agentToken)).body;
  return { ...f, send, a, record, tool, put, plan };
}
const conflict = (code: string) => (error: unknown) =>
  error instanceof MervError && error.code === code;

test('v3 requests start on service_experiment@3 with the plan-document intake profile', async (t) => {
  const f = await planFixture(t);
  assert.equal((await f.experiment(f.a.id)).workflow.version, 3);
  // New requests talk to the lead (profile 6): proactive, short linked plans, fixed verdicts.
  assert.equal(f.conversations[0].profile!.version, 8);
  const profile = f.profiles.find((p) => p.version === 8)!;
  assert.match(profile.instructions, /never Merv's limits, compute, review/);
  assert.equal(f.profiles.find((p) => p.version === 7)!.shell, true);
  assert.match(profile.instructions, /"decision models"/);
  assert.match(profile.instructions, /\[Qwen3-8B\]\(https:/);
  assert.equal(f.profiles.find((p) => p.version === 6)!.shell, true);
  assert.equal(profile.shell, true);
  assert.match(profile.instructions, /up to \$1,000 of compute/);
  assert.match(profile.instructions, /Modal or Lambda/);
  assert.match(profile.instructions, /Plan not approved\./);
  assert.match(profile.instructions, /Never put commit hashes/);
  assert.equal(f.profiles.find((p) => p.version === 5)!.shell, true);
  assert.equal(f.profiles.find((p) => p.version === 4)!.shell, true);
  assert.equal(f.profiles.find((p) => p.version === 3)!.shell, undefined);
  assert.deepEqual(profile.tools, [
    'customer_experiments.read',
    'customer_experiments.compute_options',
    'customer_experiments.plan_read',
    'customer_experiments.plan_write',
    'customer_experiments.plan_verify',
    'customer_experiments.files',
    'customer_experiments.file_read',
    'customer_experiments.file_fetch',
    'web.search',
    'web.extract',
    'nisa.search',
    'nisa.semantic_search',
    'nisa.paper',
    'nisa.excerpts',
  ]);
  assert.match(profile.instructions, /At most two questions per turn/);
  assert.match(profile.instructions, /customer_experiments\.file_fetch/);
  // Earlier versions stay registered for the conversations already bound to them.
  assert.ok(f.profiles.find((p) => p.version === 2));
  assert.ok(f.profiles.find((p) => p.version === 3));
  // The structured offer stays on version 1 of the profile and is refused for v3 requests.
  assert.ok(
    f.profiles.find((p) => p.version === 1)!.tools.includes('customer_experiments.propose'),
  );
  await assert.rejects(f.propose(f.a.id), conflict('plan_document'));
  const snapshot = (await f.send(base + '/' + f.a.id, f.a.agentToken)).body;
  assert.equal(snapshot.version, 3);
  assert.equal(snapshot.planStatus, 'drafting');
  assert.equal(snapshot.planRevision, 0);
  assert.equal(snapshot.contractSummary, null);
  assert.deepEqual(await f.plan(), {
    revision: 0,
    document: '',
    updatedBy: null,
    updatedAt: null,
    status: 'drafting',
    feedback: null,
    submittedRevision: null,
    contract: null,
  });
});

test('the customer and the intake agent co-edit the plan under optimistic revisions', async (t) => {
  const f = await planFixture(t);
  assert.equal(
    (await f.put({ expectedRevision: 0, document: '# Plan' }, f.a.agentToken)).status,
    401,
  );
  const first = await f.put({ expectedRevision: 0, document: '# Plan\n\nCompare two rules.' });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.revision, 1);
  assert.equal(first.body.updatedBy, 'customer');
  // The agent wrote from the revision before the customer's edit: it must read again.
  await assert.rejects(
    f.tool('plan_write', { expectedRevision: 0, document: 'Stale' }),
    conflict('revision_conflict'),
  );
  const read = (await f.tool('plan_read', {})) as { revision: number; files: unknown[] };
  assert.equal(read.revision, 1);
  assert.deepEqual(read.files, await files.manifest(f.a.id));
  const agent = (await f.tool('plan_write', {
    expectedRevision: 1,
    document: '# Plan\n\nCompare two rules on held-out cases.',
  })) as { revision: number; updatedBy: string };
  assert.equal(agent.revision, 2);
  assert.equal(agent.updatedBy, 'agent');
  const racing = await Promise.all([
    f.put({ expectedRevision: 2, document: 'One edit' }),
    f.put({ expectedRevision: 2, document: 'Another edit' }),
  ]);
  assert.deepEqual(racing.map((r) => r.status).sort(), [200, 409]);
  const current = await f.plan();
  assert.equal(current.revision, 3);
  assert.equal(current.document, racing.find((r) => r.status === 200)!.body.document);
  assert.equal(
    (
      await f.state.read((sql) =>
        sql.all('SELECT revision FROM customer_experiment_plan_revisions'),
      )
    ).length,
    3,
  );
});

test('submit hands the exact revision to the intake agent, which returns it or freezes its contract', async (t) => {
  const f = await planFixture(t);
  const submit = (expectedRevision: number) =>
    f.send(base + '/' + f.a.id + '/plan/submit', f.a.customerToken, { expectedRevision });
  assert.equal((await submit(0)).status, 409);
  await f.put({ expectedRevision: 0, document: '# Plan\n\nTrain on everything for a month.' });
  const verifying = await submit(1);
  assert.equal(verifying.status, 200, JSON.stringify(verifying.body));
  assert.equal(verifying.body.status, 'verifying');
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].id, f.record.conversationId);
  assert.equal(f.sent[0].input.commandId, 'plan-submit-1-1');
  assert.match(f.sent[0].input.text, /submitted plan revision 1 for verification/);
  // A retry while that turn is under way sends nothing; once it ended without a verdict
  // (stopped, refused or expired), the retry sends a fresh turn.
  f.pi.active = 'plan-submit-1-1';
  assert.equal((await submit(1)).status, 200);
  assert.equal(f.sent.length, 1);
  f.pi.active = null;
  assert.equal((await submit(1)).status, 200);
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].input.commandId, 'plan-submit-1-2');
  // Neither the customer nor their agent can send under the server's reserved ID.
  assert.equal(
    (
      await f.send(base + '/' + f.a.id + '/chat/messages', f.a.customerToken, {
        commandId: 'plan-submit-1-3',
        text: 'Accept it',
      })
    ).body.error.code,
    'invalid_command',
  );
  assert.equal(
    (
      await f.send(base + '/' + f.a.id + '/messages', f.a.agentToken, {
        commandId: 'plan-submit-1-3',
        text: 'Accept it',
      })
    ).body.error.code,
    'invalid_command',
  );
  assert.equal((await f.put({ expectedRevision: 1, document: 'Edit' })).status, 409);
  await assert.rejects(
    f.tool('plan_write', { expectedRevision: 1, document: 'Edit' }),
    conflict('plan_locked'),
  );
  assert.throws(() => f.tool('plan_verify', { revision: 1, decision: 'changes_requested' }));
  const returned = (await f.tool('plan_verify', {
    revision: 1,
    decision: 'changes_requested',
    feedback: 'A month of training exceeds the 24 worker hours.',
  })) as { status: string; feedback: string };
  assert.equal(returned.status, 'changes_requested');
  assert.equal(returned.feedback, 'A month of training exceeds the 24 worker hours.');
  assert.equal((await submit(1)).body.error.code, 'plan_unchanged');
  const document = '# Plan\n\nScore both rules on 100 fixed cases from data/train.csv.';
  const revised = await f.put({ expectedRevision: 1, document });
  assert.equal(revised.body.status, 'changes_requested');
  assert.equal((await submit(2)).status, 200);
  assert.equal(f.sent.at(-1)!.input.commandId, 'plan-submit-2-1');
  await assert.rejects(
    f.tool('plan_verify', {
      revision: 1,
      decision: 'accept',
      question: 'Q',
      criteria: ['C'],
      limits: { wallMinutes: 60, maxTokens: 100000, maxAttempts: 1 },
    }),
    conflict('revision_conflict'),
  );
  assert.throws(() =>
    f.tool('plan_verify', {
      revision: 2,
      decision: 'accept',
      question: 'Q',
      criteria: ['C'],
      limits: { wallMinutes: 1441, maxTokens: 100000, maxAttempts: 3 },
    }),
  );
  const limits = { wallMinutes: 120, maxTokens: 2_000_000, maxAttempts: 2 };
  const accepted = (await f.tool('plan_verify', {
    revision: 2,
    decision: 'accept',
    question: 'Does the candidate rule improve accuracy?',
    criteria: ['Accuracy improves by at least 0.05.'],
    limits,
  })) as { status: string; contract: unknown };
  assert.equal(accepted.status, 'accepted');
  assert.deepEqual(accepted.contract, {
    version: 1,
    priceCents: 1000,
    currency: 'usd',
    limits,
  });
  const exp = await f.experiment(f.a.id);
  assert.equal(exp.workflow.state, 'ready');
  const { hash, id, createdAt, ...frozen } = exp.contract as unknown as Record<string, unknown>;
  assert.ok(hash && id && createdAt);
  assert.deepEqual(frozen, {
    version: 1,
    document,
    revision: 2,
    question: 'Does the candidate rule improve accuracy?',
    criteria: ['Accuracy improves by at least 0.05.'],
    limits,
    files: await files.manifest(f.a.id),
    model: { harness: 'codex', model: 'gpt-6-astra', effort: 'medium' },
    price: { amountCents: 1000, currency: 'usd' },
  });
  assert.equal((await f.put({ expectedRevision: 2, document: 'After' })).status, 409);
  assert.equal((await submit(2)).status, 409);
  const snapshot = (await f.send(base + '/' + f.a.id, f.a.customerToken)).body;
  assert.equal(snapshot.planStatus, 'accepted');
  assert.equal(snapshot.contractSummary.priceCents, 1000);
});

test('a submit the intake cannot take reopens the plan; it never stays verifying unsent', async (t) => {
  const f = await planFixture(t);
  await f.put({ expectedRevision: 0, document: '# Plan' });
  f.pi.refuse = new MervError('pi_turn_busy', 'This conversation already has an active turn', 409);
  const busy = await f.send(base + '/' + f.a.id + '/plan/submit', f.a.customerToken, {
    expectedRevision: 1,
  });
  assert.equal(busy.body.error.code, 'pi_turn_busy');
  assert.equal((await f.plan()).status, 'drafting');
  assert.equal((await f.put({ expectedRevision: 1, document: '# Plan\n\nMore.' })).status, 200);
  f.pi.refuse = null;
  const sent = await f.send(base + '/' + f.a.id + '/plan/submit', f.a.customerToken, {
    expectedRevision: 2,
  });
  assert.equal(sent.body.status, 'verifying');
  assert.equal(f.sent.at(-1)!.input.commandId, 'plan-submit-2-1');
});

test('v3 checkout refuses files that changed after acceptance and returns the plan; deleted files cannot be accepted', async (t) => {
  const f = await planFixture(t);
  const accept = {
    question: 'Q',
    criteria: ['C'],
    limits: { wallMinutes: 60, maxTokens: 1_000_000, maxAttempts: 1 },
  };
  await f.put({ expectedRevision: 0, document: '# Plan' });
  await f.send(base + '/' + f.a.id + '/plan/submit', f.a.customerToken, { expectedRevision: 1 });
  await f.tool('plan_verify', { revision: 1, decision: 'accept', ...accept });
  fileState.etag = '-changed';
  t.after(() => (fileState.etag = ''));
  const refused = await f.send(base + '/' + f.a.id + '/checkout', f.a.customerToken, {
    contractVersion: 1,
  });
  assert.equal(refused.body.error.code, 'files_changed');
  assert.equal(f.checkoutCalls.length, 0);
  assert.equal((await f.experiment(f.a.id)).workflow.state, 'planning');
  const reopened = await f.plan();
  assert.equal(reopened.status, 'changes_requested');
  assert.match(reopened.feedback, /files changed/);
  // The same revision may be submitted again, and its new contract carries the files as they are.
  await f.send(base + '/' + f.a.id + '/plan/submit', f.a.customerToken, { expectedRevision: 1 });
  fileState.deleted = true;
  t.after(() => (fileState.deleted = false));
  await assert.rejects(
    f.tool('plan_verify', { revision: 1, decision: 'accept', ...accept }),
    conflict('files_deleted'),
  );
  fileState.deleted = false;
  await f.tool('plan_verify', { revision: 1, decision: 'accept', ...accept });
  const opened = await f.send(base + '/' + f.a.id + '/checkout', f.a.customerToken, {
    contractVersion: 2,
  });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
});

test('v3 checkout accepts the frozen contract and opens a $10 Stripe checkout that collects the email', async (t) => {
  const f = await planFixture(t);
  await f.put({ expectedRevision: 0, document: '# Plan\n\nScore both rules.\n\nMore detail.' });
  await f.send(base + '/' + f.a.id + '/plan/submit', f.a.customerToken, { expectedRevision: 1 });
  const limits = { wallMinutes: 60, maxTokens: 1_000_000, maxAttempts: 1 };
  await f.tool('plan_verify', {
    revision: 1,
    decision: 'accept',
    question: 'Does the candidate rule improve accuracy?',
    criteria: ['Accuracy improves by at least 0.05.'],
    limits,
  });
  const checkout = (contractVersion: number, token = f.a.customerToken) =>
    f.send(base + '/' + f.a.id + '/checkout', token, { contractVersion });
  // The two-step approval with a typed email is refused; so is the agent.
  assert.equal(
    (
      await f.send(base + '/' + f.a.id + '/accept', f.a.customerToken, {
        contractVersion: 1,
        email: 'customer@example.com',
      })
    ).status,
    409,
  );
  assert.equal((await checkout(1, f.a.agentToken)).status, 401);
  assert.equal((await checkout(2)).body.error.code, 'stale_contract');
  assert.equal(f.checkoutCalls.length, 0);
  const opened = await checkout(1);
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.equal(opened.body.url, 'https://checkout.stripe.com/fixture');
  assert.equal(f.checkoutCalls.length, 1);
  assert.equal(f.checkoutCalls[0].contract.price.amountCents, 1000);
  assert.equal(f.checkoutCalls[0].contract.price.currency, 'usd');
  assert.equal(f.checkoutCalls[0].email, null);
  let exp = await f.experiment(f.a.id);
  assert.equal(exp.workflow.state, 'awaiting_payment');
  assert.equal(exp.email, null);
  // Repeating checkout reuses the acceptance.
  assert.equal((await checkout(1)).status, 200);
  assert.equal(
    (await f.state.read((sql) => sql.all('SELECT * FROM customer_experiment_acceptances'))).length,
    1,
  );
  const paid: PaidCheckout = {
    eventId: 'evt_v3',
    requestId: f.a.id,
    contractHash: exp.contract!.hash,
    checkoutId: opened.body.id,
    paymentId: 'pi_v3',
    amountCents: 1000,
    currency: 'usd',
    email: 'customer@example.com',
  };
  const webhook = await f.send('/customer-experiments/stripe-webhook', undefined, paid, {
    'Stripe-Signature': 'fixture-valid-signature',
  });
  assert.equal(webhook.status, 200, JSON.stringify(webhook.body));
  exp = await f.experiment(f.a.id);
  assert.equal(exp.workflow.state, 'running');
  assert.equal(exp.email, 'customer@example.com');
  const { customerReportSubject } =
    await import('../packages/customer-experiments/src/report-subject.js');
  const caller = await f.service.caller(f.record);
  const draft = await f.state.transaction((tx) =>
    customerReportSubject(f.domain).prefill(caller, exp.id, tx),
  );
  assert.match(draft.source, /# Does the candidate rule improve accuracy\?/);
  assert.match(draft.source, /Score both rules\./);
  assert.match(draft.source, /- Accuracy improves by at least 0\.05\./);
  // Merv's own limits are not the customer's constraints.
  assert.doesNotMatch(draft.source, /worker hours/);
  assert.match(draft.source, /\| data\/train\.csv \| Request file \| 2 KB \|/);
});

test('v2 requests keep the structured offer: no plan document, and their checkout is unchanged', async (t) => {
  const f = await fixture(t);
  const a = await f.create();
  assert.equal((await f.experiment(a.id)).workflow.version, 2);
  assert.equal(f.conversations[0].profile!.version, 1);
  assert.equal((await f.send(base + '/' + a.id + '/plan', a.agentToken)).status, 409);
  const snapshot = (await f.send(base + '/' + a.id, a.agentToken)).body;
  assert.equal(snapshot.version, 2);
  assert.ok(!('planStatus' in snapshot));
  await f.propose(a.id);
  const exp = await f.experiment(a.id);
  const approval = { contractVersion: exp.contract!.version, email: 'customer@example.com' };
  assert.equal(
    (await f.send(base + '/' + a.id + '/accept', a.customerToken, approval)).status,
    200,
  );
  const checkout = await f.send(base + '/' + a.id + '/checkout', a.customerToken, approval);
  assert.equal(checkout.status, 200, JSON.stringify(checkout.body));
  assert.equal(f.checkoutCalls[0].contract.price.amountCents, 1000);
  await assert.rejects(
    f.service.checkoutPlan(await f.store.get(a.id), { contractVersion: 1 }),
    conflict('plan_document_unavailable'),
  );
});

test('/start opens the customer app with public intake, and keeps the guide for agents', async () => {
  const serve = async (publicIntake: boolean, path: string, accept = 'text/html') => {
    const handler = startHttp(
      { publicOrigin: 'https://merv.example', publicIntake, livePayments: false },
      undefined,
      async () => '<!doctype html><title>customer app</title>',
    );
    let body = '';
    const res = { setHeader() {}, end: (text?: string) => void (body = text ?? '') };
    await handler(
      { method: 'GET', headers: { accept } } as never,
      res as never,
      { url: new URL('https://merv.example' + path) } as never,
    );
    return body;
  };
  assert.match(await serve(true, '/start'), /customer app/);
  assert.doesNotMatch(await serve(false, '/start'), /customer app/);
  assert.match(await serve(true, '/start/agent.md'), /# Merv experiment setup/);
  assert.match(await serve(true, '/start', 'text/markdown'), /# Merv experiment setup/);
});

test('each intake turn opens with the request files and what changed since the agent last looked', async (t) => {
  const f = await planFixture(t);
  const record = await f.store.get(f.a.id);
  const profile = f.profiles.find((p) => p.version === 8)!;
  const context = () =>
    profile.context!({
      binding: { id: profile.id, version: 8, requestId: f.a.id },
      caller: { projectId: record.projectId!, actorId: 'actor' } as Caller,
    });
  const first = await context();
  assert.match(first, /^Request files now \(1\): data\/train\.csv \(2048 bytes\)\./);
  assert.match(first, /New or changed since your last turn: data\/train\.csv\./);
  // Nothing changed: no news.
  assert.doesNotMatch(await context(), /since your last turn/);
  // A replaced upload (new ETag) is news again.
  fileState.etag = '-v2';
  t.after(() => void (fileState.etag = ''));
  assert.match(await context(), /New or changed since your last turn: data\/train\.csv\./);
});

test('the intake agent may search the web and the literature: only its request tools name the request', async (t) => {
  const f = await planFixture(t);
  const record = await f.store.get(f.a.id);
  const profile = f.profiles.find((p) => p.version === 8)!;
  const caller = {
    ...(await f.service.caller(record)),
    conversation: { id: record.conversationId },
  } as Caller;
  const binding = { id: profile.id, version: 8, requestId: f.a.id };
  // A web search carries no request id and is allowed.
  await profile.authorizeTool!({ binding, caller, name: 'web.search', input: { query: 'x' } });
  await profile.authorizeTool!({ binding, caller, name: 'nisa.search', input: { query: 'x' } });
  // The request's own tools still name exactly the bound request.
  await profile.authorizeTool!({
    binding,
    caller,
    name: 'customer_experiments.files',
    input: { id: f.a.id },
  });
  await assert.rejects(
    profile.authorizeTool!({
      binding,
      caller,
      name: 'customer_experiments.files',
      input: { id: 'ce_' + '0'.repeat(32) },
    }),
    (e: { code?: string }) => e.code === 'forbidden',
  );
});

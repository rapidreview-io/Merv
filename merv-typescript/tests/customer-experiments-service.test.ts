import type { AnyToolDefinition, NounDefinition, ToolDefinition, Tools } from '@merv/api/types';
import { ArtifactStore } from '@merv/artifacts';
import { DiskBlobs } from '@merv/blobs';
import { check, createService, MervError, type Caller } from '@merv/contracts';
import type { CheckoutInput, Paid } from '@merv/contracts/payments';
import type { PiProfile, PiRuntime } from '@merv/pi/types';
import { ReviewService } from '@merv/reviews';
import { ProjectScope } from '@merv/scope';
import { WorkflowsService } from '@merv/workflows';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ApiServer } from '../packages/api/src/http.js';
import { ToolRegistry } from '../packages/api/src/registry.js';
import { customerDocument } from '../packages/customer-experiments/src/customer-app.js';
import { SERVICE_VERSION } from '../packages/customer-experiments/src/program.js';
import type { DatasetStorage } from '../packages/customer-experiments/src/data.js';
import { CustomerExperiments } from '../packages/customer-experiments/src/domain.js';
import { customerHttp, startHttp } from '../packages/customer-experiments/src/http.js';
import type { ResultMailer } from '../packages/customer-experiments/src/mail.js';
import { CUSTOMER_PRODUCT, CustomerService } from '../packages/customer-experiments/src/service.js';
import { RequestStore } from '../packages/customer-experiments/src/store.js';
import type {
  CustomerExperiment,
  ExperimentPlan,
  RequestFiles,
  StructuredContract,
} from '../packages/customer-experiments/src/types.js';
import { migrateNativeWorkflow } from '../packages/workflows/src/native-migration.js';
import { PaymentsService } from '../packages/payments/src/index.js';
import { legacyReports } from './fixtures/legacy-reports.js';
import { managedServices } from './fixtures/managed-services.js';
import { models, fixture as piFixture } from './fixtures/pi.js';
import { openState } from './fixtures/state.js';
import { deferred } from './fixtures/deferred.js';

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
  const turns: { id: string; text: string }[] = [];
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
      if (!turns.some((turn) => turn.id === input.commandId))
        turns.push({ id: input.commandId, text: input.text });
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
          ...turns.map(({ id, text }) => ({ id, messages: [{ role: 'user', text }] })),
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
  const checkoutCalls: CheckoutInput[] = [];
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
  // Payments over a fake Stripe: the real webhook's dispatch, a fake signature.
  const payments = new PaymentsService({
    live: false,
    async checkout(input) {
      checkoutCalls.push(input);
      return {
        id: 'cs_' + input.reference + '_' + input.idempotencyKey.split('-').at(-1),
        url: 'https://checkout.stripe.com/fixture',
        expiresAt: Date.now() / 1000 + 1800,
      };
    },
    async verify(bytes, signature) {
      if (signature !== 'fixture-valid-signature')
        throw new MervError('invalid_webhook', 'Invalid signature', 400);
      return JSON.parse(bytes.toString()) as Paid;
    },
  });
  const emails: Parameters<ResultMailer['send']>[0][] = [];
  const delivery = { fail: false };
  const mailer: ResultMailer = {
    async send(input) {
      if (delivery.fail) throw new Error('Mail temporarily unavailable');
      emails.push(input);
    },
  };
  const service = new CustomerService(
    store,
    domain,
    scope,
    artifacts,
    runtime,
    storage,
    () => payments,
    mailer,
    { publicOrigin: 'https://merv.example', sponsor, intakeKey, publicIntake, maxRequestsPerDay },
    compute,
    files,
  );
  payments.fulfil(CUSTOMER_PRODUCT, (paid) => service.paid(paid));
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
  // This fixture's Pi runtime is a stub; invoke the registered noun with its real schema.
  // The stored-v8 test below uses a real Pi runtime and the full registry authorization path.
  const intake = async (address: string, caller: Caller, args: object) => {
    const [name, action] = address.split(':');
    const definition = registered.get(name!) as ToolDefinition;
    return definition.handler(caller, definition.inputSchema.parse({ action, [action!]: args }));
  };
  const propose = async (id: string, next = plan) => {
    const record = await store.get(id);
    const caller = await service.caller(record);
    return intake(
      'intake.write:propose',
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
    emails,
    mailer,
    delivery,
    payments,
    compute,
    computeReads,
    computePreparations,
    tools,
    registered,
    intake,
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
  for (const title of [undefined, '', '   ', 'x'.repeat(161)]) {
    assert.equal((await f.send(base, intakeKey, { requestId: randomUUID(), title })).status, 400);
  }
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
  const addresses: Record<string, string> = {
    read: 'intake.read:request',
    plan_read: 'intake.read:plan',
    files: 'intake.read:files',
    file_read: 'intake.read:file',
    file_fetch: 'intake.read:file_link',
    compute_options: 'intake.read:compute',
    plan_write: 'intake.write:edit_plan',
    plan_verify: 'intake.write:verify_plan',
    propose: 'intake.write:propose',
  };
  const tool = (name: string, input: Record<string, unknown>) =>
    f.intake(addresses[name]!, intake, { id: a.id, ...input });
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

test('submit hands the exact revision to the intake agent, which returns it or freezes its contract', async (t) => {
  const f = await planFixture(t);
  const submit = (expectedRevision: number) =>
    f.send(base + '/' + f.a.id + '/plan/submit', f.a.customerToken, {
      expectedRevision,
      email: 'customer@example.com',
    });
  assert.equal((await submit(0)).status, 409);
  await f.put({ expectedRevision: 0, document: '# Plan\n\nTrain on everything for a month.' });
  const verifying = await submit(1);
  assert.equal(verifying.status, 200, JSON.stringify(verifying.body));
  assert.equal(verifying.body.status, 'verifying');
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].id, f.record.conversationId);
  assert.equal(f.sent[0].input.commandId, 'plan-submit-1-1');
  assert.match(f.sent[0].input.text, /submitted plan revision 1 for verification/);
  // The customer's snapshot reads that turn as their own chat does: their press of Submit.
  const { conversation } = await f.service.snapshot(await f.store.get(f.a.id));
  assert.deepEqual(conversation.at(-1), { role: 'user', text: 'Submitted the plan.' });
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
  await assert.rejects(f.tool('plan_verify', { revision: 1, decision: 'changes_requested' }), {
    name: 'ZodError',
  });
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
  await assert.rejects(
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
    email: 'customer@example.com',
    expectedRevision: 1,
  });
  assert.equal(busy.body.error.code, 'pi_turn_busy');
  assert.equal((await f.plan()).status, 'drafting');
  assert.equal((await f.put({ expectedRevision: 1, document: '# Plan\n\nMore.' })).status, 200);
  f.pi.refuse = null;
  const sent = await f.send(base + '/' + f.a.id + '/plan/submit', f.a.customerToken, {
    email: 'customer@example.com',
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
  await f.send(base + '/' + f.a.id + '/plan/submit', f.a.customerToken, {
    expectedRevision: 1,
    email: 'customer@example.com',
  });
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
  await f.send(base + '/' + f.a.id + '/plan/submit', f.a.customerToken, {
    expectedRevision: 1,
    email: 'customer@example.com',
  });
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

test('customer delivery stays pending after a verdict until its exact approved code is durable', async (t) => {
  const f = await fixture(t, false, 20, 5);
  const created = await f.create();
  const record = await f.store.get(created.id);
  const caller = await f.service.caller(record);
  const initial = await f.domain.get(caller, record.experimentId!);
  const artifact = await f.domain.artifacts.create(caller, {
    title: 'Approved measurements',
    content: 'Retained result evidence.',
  });
  const retainedAt = new Date().toISOString();
  let durable = false;
  const result = (): CustomerExperiment => ({
    ...initial,
    workflow: { ...initial.workflow, state: 'complete' },
    codeReady: durable,
    ...(durable ? { codeReadyAt: retainedAt } : {}),
    email: 'customer@example.test',
    acceptedContractId: 'approved-contract',
    paymentId: 'paid-fixture',
    submission: {
      id: 'approved-results',
      contractId: 'approved-contract',
      artifactIds: [artifact.id],
      summary: 'Reviewed results.',
      producerId: caller.actorId,
      sessionId: 'producer-fixture',
      executionRevision: 1,
      createdAt: retainedAt,
      report: {
        sourceArtifactId: artifact.id,
        pdfArtifactId: artifact.id,
        pageArtifactIds: [artifact.id],
      },
    },
  });
  t.mock.method(f.domain, 'get', async () => result());
  t.mock.method(f.domain, 'reconcile', async () => result());
  const pending = await f.service.snapshot(record);
  assert.equal(pending.state, 'finalizing');
  assert.equal(pending.progress?.stage, 'reviewing');
  assert.deepEqual(pending.result?.pages, []);
  assert.deepEqual(pending.result?.artifacts, []);
  await assert.rejects(f.service.artifact(record, artifact.id), { code: 'not_found' });
  await f.service.reconcile();
  assert.equal(f.emails.length, 0);
  durable = true;
  const delivered = await f.service.snapshot(record);
  assert.equal(delivered.state, 'complete');
  assert.equal(delivered.progress?.stage, 'complete');
  assert.equal(delivered.progress?.entered.complete, retainedAt);
  assert.deepEqual(delivered.result?.pages, [artifact.id]);
  assert.equal(delivered.result?.artifacts.length, 1);
  await f.service.reconcile();
  assert.equal(f.emails.length, 1);
  await f.service.reconcile();
  assert.equal(f.emails.length, 1, 'durable delivery notification is idempotent');
});

test('an older email acknowledgement cannot clear a newer address notification', async (t) => {
  const f = await planFixture(t);
  await f.put({ expectedRevision: 0, document: '# Plan\n\nScore 100 fixed cases.' });
  const pending = deferred(),
    release = deferred();
  t.after(() => release.resolve());
  const sent: string[] = [];
  let failNew = true;
  f.mailer.send = async (input) => {
    if (input.to === 'old@example.com') {
      pending.resolve();
      await release.promise;
    } else if (failNew) throw new Error('provider unavailable');
    sent.push(input.to);
  };
  const first = f.service.submitPlan(await f.store.get(f.a.id), {
    expectedRevision: 1,
    email: 'old@example.com',
  });
  await pending.promise;
  await f.service.submitPlan(await f.store.get(f.a.id), {
    expectedRevision: 1,
    email: 'new@example.com',
  });
  release.resolve();
  await first;
  assert.equal(
    (await f.store.get(f.a.id)).submissionEmailPending,
    true,
    'new address still needs its notification',
  );
  failNew = false;
  await f.service.reconcile();
  assert.deepEqual(sent, ['old@example.com', 'new@example.com']);
  assert.equal((await f.store.get(f.a.id)).submissionEmailPending, false);
});

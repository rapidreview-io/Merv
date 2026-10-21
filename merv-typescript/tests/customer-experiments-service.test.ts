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
  const paid: Paid = {
    product: CUSTOMER_PRODUCT,
    eventId: 'evt_paid',
    reference: a.id,
    metadata: { contractHash: exp.contract!.hash },
    paymentId: 'pi_paid',
    amountUsd: 10,
    createdAt: new Date().toISOString(),
  };
  const webhook = (event: Paid, signature = 'fixture-valid-signature') =>
    f.send('/customer-experiments/stripe-webhook', undefined, event, {
      'Stripe-Signature': signature,
    });
  assert.equal((await webhook(paid, 'untrusted')).status, 400);
  assert.equal(
    (await webhook({ ...paid, metadata: { contractHash: 'not-the-accepted-contract' } })).status,
    409,
  );
  assert.equal((await webhook({ ...paid, amountUsd: 0.01 })).status, 409);
  assert.equal((await f.experiment(a.id)).workflow.state, 'awaiting_payment');
  await f.store.mutate(a.id, (record) => {
    record.checkout!.expiresAt = Date.now() / 1000 - 1;
  });
  const newerCheckout = await f.send(base + '/' + a.id + '/checkout', a.customerToken, approval);
  assert.equal(newerCheckout.status, 200);
  assert.notEqual(newerCheckout.body.id, checkout.body.id);
  assert.equal(f.emails.length, 0);
  assert.equal((await webhook(paid)).status, 200);
  assert.equal(f.emails.length, 1);
  assert.equal(f.emails[0].kind, 'submitted');
  assert.equal(f.emails[0].url, a.customerUrl);
  exp = await f.experiment(a.id);
  assert.equal(exp.workflow.state, 'running');
  // Paid, with no visit live, it is queued to the customer, unless an executor ended its visit
  // to wait for its compute: that run is running.
  const shown = async () => (await f.service.snapshot(await f.store.get(a.id))).state;
  assert.equal(await shown(), 'queued');
  const waiting = t.mock.method(f.domain.sessions.computeWaits, 'waiting', async () => true);
  assert.equal(await shown(), 'running');
  assert.deepEqual(waiting.mock.calls[0]!.arguments, [exp.projectId, exp.id]);
  waiting.mock.restore();
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

test('migrating structured intake from v1 to v6 preserves links, drafts, uploads and declaration provenance', async (t) => {
  const f = await fixture(t, false, 20, 1);
  const a = await f.create();
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
  const bytes = Buffer.from('text,label\none,positive\ntwo,negative\n');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const upload = await f.send(base + '/' + a.id + '/uploads', a.customerToken, {
    requirementId: 'eval',
    filename: 'eval.csv',
    sha256,
    size: bytes.length,
    mediaType: 'text/csv',
  });
  assert.equal(upload.status, 200);
  f.bytes.set(a.id + ':' + sha256, bytes);
  const record = await f.store.get(a.id);
  const request = () =>
    f.state.read((sql) => sql.get('SELECT * FROM customer_experiment_requests WHERE id=?', a.id));
  const declaration = () =>
    f.state.read((sql) =>
      sql.get<{ version: number }>(
        'SELECT * FROM code_units WHERE unit_id=?',
        record.experimentId!,
      ),
    );
  const before = {
    request: await request(),
    declaration: await declaration(),
    conversations: structuredClone(f.conversations),
  };
  const oldPage = await customerDocument(f.service, a.id, async () => 'document app');
  assert.equal(before.declaration!.version, 1);
  const source = await f.experiment(a.id);
  const migrationCaller = await f.service.caller(record);
  await f.state.transaction((tx) =>
    migrateNativeWorkflow(tx, {
      projectId: source.projectId,
      instanceId: source.id,
      expectedRevision: source.workflow.revision,
      fromVersion: 1,
      toVersion: 6,
      actorId: migrationCaller.actorId,
      reason: 'Preserve structured intake while enabling native Git execution.',
    }),
  );
  assert.equal(SERVICE_VERSION, 5, 'new requests retain the default document intake');
  assert.equal((await f.experiment(a.id)).workflow.version, 6);
  assert.deepEqual(await request(), before.request);
  assert.deepEqual(await declaration(), before.declaration);
  assert.deepEqual(f.conversations, before.conversations);
  assert.equal(f.conversations[0]!.profile!.version, 1);
  assert.equal(await customerDocument(f.service, a.id, async () => 'document app'), oldPage);
  assert.equal(
    (await f.send(base + '/' + a.id, a.customerToken)).status,
    200,
    'the existing customer capability still acts without sign-in',
  );
  assert.equal((await f.send(base + '/' + a.id + '/session', a.customerToken, {})).status, 404);
  assert.equal(
    (await f.send(base + '/' + a.id + '/plan', a.customerToken)).body.error.code,
    'plan_document_unavailable',
  );
  const completed = await f.send(
    base + '/' + a.id + '/uploads/' + upload.body.uploadId + '/complete',
    a.customerToken,
    {},
  );
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  const exp = await f.experiment(a.id);
  assert.equal(exp.workflow.state, 'ready');
  assert.deepEqual(exp.contract!.plan, withData);
  assert.equal(exp.contract!.datasets[0]!.sha256, sha256);
  assert.deepEqual(f.bytes.get(a.id + ':' + sha256), bytes);
  assert.equal(
    (await f.create()).customerUrl,
    a.customerUrl,
    'creation replay preserves the original private link',
  );
  assert.equal(f.conversations.length, 1);
  const approval = { contractVersion: exp.contract!.version, email: 'customer@example.com' };
  assert.equal(
    (await f.send(base + '/' + a.id + '/accept', a.customerToken, approval)).status,
    200,
  );
  assert.equal(
    (await f.send(base + '/' + a.id + '/checkout', a.customerToken, approval)).status,
    200,
  );
  assert.deepEqual((await f.experiment(a.id)).contract, exp.contract);
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
  const payment: Paid = {
    product: CUSTOMER_PRODUCT,
    eventId: 'evt_compute_retry',
    reference: request.id,
    metadata: { contractHash: exp.contract!.hash },
    paymentId: 'pi_compute_retry',
    amountUsd: 10,
    createdAt: new Date().toISOString(),
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

test('migrating v3 to v5 preserves the accepted contract, checkout replay and payment identity', async (t) => {
  const f = await planFixture(t);
  await f.put({ expectedRevision: 0, document: '# Plan\n\nCompare both rules.' });
  assert.equal(
    (
      await f.send(base + '/' + f.a.id + '/plan/submit', f.a.customerToken, {
        expectedRevision: 1,
        email: 'customer@example.com',
      })
    ).status,
    200,
  );
  await f.tool('plan_verify', {
    revision: 1,
    decision: 'accept',
    question: plan.question,
    criteria: plan.successCriteria,
    limits: plan.limits,
  });
  const checkout = await f.send(base + '/' + f.a.id + '/checkout', f.a.customerToken, {
    contractVersion: 1,
  });
  assert.equal(checkout.status, 200, JSON.stringify(checkout.body));
  const exp = await f.experiment(f.a.id);
  assert.equal(exp.workflow.state, 'awaiting_payment');
  const preserved = () =>
    f.state.read(async (sql) => ({
      request: await sql.get('SELECT * FROM customer_experiment_requests WHERE id=?', f.a.id),
      contracts: await sql.all(
        'SELECT * FROM customer_experiment_contracts WHERE experiment_id=?',
        exp.id,
      ),
      acceptances: await sql.all(
        'SELECT * FROM customer_experiment_acceptances WHERE experiment_id=?',
        exp.id,
      ),
      identity: await sql.get(
        'SELECT * FROM customer_experiment_identities WHERE request_id=?',
        f.a.id,
      ),
      declaration: await sql.get('SELECT * FROM code_units WHERE unit_id=?', exp.id),
    }));
  const before = await preserved();
  const migrationCaller = await f.service.caller(f.record);
  await f.state.transaction((tx) =>
    migrateNativeWorkflow(tx, {
      projectId: exp.projectId,
      instanceId: exp.id,
      expectedRevision: exp.workflow.revision,
      fromVersion: 3,
      toVersion: 5,
      actorId: migrationCaller.actorId,
      reason: 'Preserve the accepted customer contract and checkout under native Git.',
    }),
  );
  assert.deepEqual(await preserved(), before);
  assert.deepEqual((await f.experiment(f.a.id)).contract, exp.contract);
  const replay = await f.send(base + '/' + f.a.id + '/checkout', f.a.customerToken, {
    contractVersion: 1,
  });
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.id, checkout.body.id);
  assert.equal(replay.body.url, checkout.body.url);
  assert.equal(f.checkoutCalls.length, 2);
  const { previousId: _old, ...originalInput } = f.checkoutCalls[0]!;
  const { previousId, ...replayedInput } = f.checkoutCalls[1]!;
  assert.deepEqual(
    replayedInput,
    originalInput,
    'payment idempotency, contract metadata and amount stay unchanged',
  );
  assert.equal(previousId, checkout.body.id);
  const paid: Paid = {
    product: CUSTOMER_PRODUCT,
    eventId: 'evt_legacy_checkout',
    reference: f.a.id,
    metadata: { contractHash: exp.contract!.hash },
    paymentId: 'pi_legacy_checkout',
    amountUsd: 10,
    createdAt: new Date().toISOString(),
  };
  const webhook = (event: Paid) =>
    f.send('/customer-experiments/stripe-webhook', undefined, event, {
      'Stripe-Signature': 'fixture-valid-signature',
    });
  assert.equal((await webhook(paid)).status, 200);
  const running = await f.experiment(f.a.id);
  assert.equal(running.workflow.version, 5);
  assert.equal(running.workflow.state, 'running');
  assert.equal(running.paymentId, paid.paymentId);
  assert.deepEqual(running.contract, exp.contract);
  assert.equal((await webhook(paid)).status, 200);
  assert.equal((await webhook({ ...paid, eventId: 'evt_legacy_checkout_replayed' })).status, 200);
  assert.equal((await f.experiment(f.a.id)).workflow.revision, running.workflow.revision);
  const rows = await f.state.read((sql) =>
    sql.all('SELECT * FROM customer_experiment_payments WHERE experiment_id=?', exp.id),
  );
  assert.equal(rows.length, 1);
  assert.equal((await preserved()).declaration!.version, 3);
  assert.deepEqual((await preserved()).contracts, before.contracts);
  assert.deepEqual((await preserved()).acceptances, before.acceptances);
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

test('submitting a plan requires an explicit email and sends its link before checkout', async (t) => {
  const f = await planFixture(t);
  await f.put({ expectedRevision: 0, document: '# Plan\n\nCompare both rules.' });
  const path = base + '/' + f.a.id + '/plan/submit';
  assert.equal((await f.send(path, f.a.customerToken, { expectedRevision: 1 })).status, 400);
  assert.equal(
    (await f.send(path, f.a.customerToken, { expectedRevision: 1, email: 'invalid' })).status,
    400,
  );
  assert.equal(f.emails.length, 0);
  assert.equal(
    (await f.send(path, f.a.customerToken, { expectedRevision: 1, email: 'owner@example.com' }))
      .status,
    200,
  );
  assert.equal(f.emails.length, 1);
  assert.equal(f.emails[0].to, 'owner@example.com');
  assert.equal(f.emails[0].url, f.a.customerUrl);
  assert.equal(f.checkoutCalls.length, 0);
  assert.equal((await f.service.snapshot(await f.store.get(f.a.id))).submissionEmailSent, true);
});

test('a stored v8 intake offers nouns, checks nested request IDs, and executes its pre-release frozen names', async (t) => {
  const f = await piFixture(t, {
    pi: {
      models: models.map((model) =>
        model.id === 'gpt-6-astra' ? { ...model, effort: 'medium' as const } : model,
      ),
    },
  });
  const records = new Map<
    string,
    { id: string; projectId: string; conversationId: string; toldFiles?: string[] }
  >();
  const request = { id: 'request_stored_v8', projectId: f.operator.projectId!, conversationId: '' };
  records.set(request.id, request);
  records.set('request_other', {
    ...request,
    id: 'request_other',
    conversationId: 'another-conversation',
  });
  const service = new CustomerService(
    {
      get: async (id: string) => records.get(id),
      mutate: async (id: string, change: (record: object) => void) => change(records.get(id)!),
    } as never,
    {} as never,
    {} as never,
    { registerFileProvider: () => () => {} } as never,
    f.pi,
    undefined,
    () => undefined,
    undefined,
    {} as never,
  );
  service.agentSnapshot = async (record) => ({ id: record.id }) as never;
  const nouns = new Map<string, NounDefinition>();
  const disposers = await service.registerIntake({
    noun: (name: string, definition: NounDefinition) => {
      nouns.set(name, definition);
      return async () => {};
    },
  } as unknown as Tools);
  t.after(async () => {
    for (const dispose of disposers.reverse()) await dispose();
  });
  // Before the release, the v8 profile stores its original hash and freezes the flat tools.
  const old = [...nouns.values()].flatMap((noun) =>
    Object.values(noun.actions).map((action) =>
      f.tools.register({
        name: action.was![0]!,
        description: action.description,
        inputSchema: action.input,
        readOnly: noun.readOnly,
        openWorld: action.openWorld,
        conversationProfile: 'customer-experiments-intake',
        handler: action.handler,
      }),
    ),
  );
  const conversation = await f.pi.createProfiled(f.operator, {
    requestId: 'stored-v8',
    title: 'Stored intake',
    profile: { id: 'customer-experiments-intake', version: 8, requestId: request.id },
  });
  request.conversationId = conversation.id;
  const frozen = await f.claimed(await f.send(conversation));
  assert.ok(frozen.work.tools.some((tool) => tool.name === 'customer_experiments.read'));
  await f.pi.begin(frozen.token, frozen.input);
  for (const dispose of old) await dispose();
  for (const [name, definition] of nouns) f.tools.noun(name, definition);
  const call = (turn: typeof frozen, name: string, input: object) =>
    f.pi.tool(turn.token, { ...turn.input, name, input });
  assert.deepEqual(await call(frozen, 'customer_experiments.read', { id: request.id }), {
    id: request.id,
  });
  await assert.rejects(call(frozen, 'customer_experiments.read', { id: 'request_other' }), {
    code: 'forbidden',
  });
  assert.equal(
    (
      (await call(frozen, 'customer_experiments.read', { id: request.id, action: 'request' })) as {
        error: { code: string };
      }
    ).error.code,
    'invalid_input',
  );
  await assert.rejects(
    call(frozen, 'intake.read', { action: 'request', request: { id: request.id } }),
    { code: 'pi_tool_forbidden' },
  );
  await f.pi.complete(frozen.token, f.completion(frozen.input));
  const command = await f.send(conversation);
  await f.fleet.tick();
  await f.fleet.tick();
  const { work } = await f.pi.next(frozen.token, { workerId: 'worker_1' });
  assert.ok(work);
  const next = { token: frozen.token, work, input: { ...frozen.input, commandId: command.id } };
  assert.deepEqual(next.work.tools.map((tool) => tool.name).sort(), [
    'intake.read',
    'intake.write',
  ]);
  const schema = next.work.tools.find((tool) => tool.name === 'intake.write')!.inputSchema as {
    properties: { action: { enum: string[] } };
  };
  assert.deepEqual(schema.properties.action.enum, ['edit_plan', 'verify_plan']);
  await f.pi.begin(next.token, next.input);
  await assert.rejects(
    call(next, 'intake.read', { action: 'request', request: { id: 'request_other' } }),
    { code: 'forbidden' },
  );
  await assert.rejects(
    call(next, 'intake.write', {
      action: 'edit_plan',
      edit_plan: { id: 'request_other', expectedRevision: 0, document: '# Plan' },
    }),
    { code: 'forbidden' },
  );
  await assert.rejects(
    call(next, 'intake.write', { action: 'propose', propose: { id: request.id, plan } }),
    { code: 'pi_profile_action_forbidden' },
  );
  assert.deepEqual(
    await call(next, 'intake.read', { action: 'request', request: { id: request.id } }),
    { id: request.id },
  );
  await f.pi.complete(next.token, f.completion(next.input));
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

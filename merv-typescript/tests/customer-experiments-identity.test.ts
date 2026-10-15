import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { createService, MervError, type Caller, type VerifiedIdentity } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { ApiServer } from '../packages/api/src/http.js';
import { ToolRegistry } from '../packages/api/src/registry.js';
import type { PiRuntime, PiSnapshot } from '@merv/pi/types';
import { SupabaseIdentity } from '../packages/identity/src/index.js';
import { CustomerService } from '../packages/customer-experiments/src/service.js';
import { RequestStore } from '../packages/customer-experiments/src/store.js';
import { customerHttp } from '../packages/customer-experiments/src/http.js';
import { customerChat } from '../packages/customer-experiments/src/chat-http.js';
import type { CustomerExperiments } from '../packages/customer-experiments/src/domain.js';
import { openState } from './fixtures/state.js';

const base = '/customer-experiments/requests';
const issuer = 'https://auth.example/auth/v1';
const login = { url: 'https://auth.example', publishableKey: 'sb_publishable_fixture' };

/** The sponsor's whole view, carrying everything the customer must not see. */
function sponsorSnapshot(id: string): PiSnapshot {
  return {
    stage: { name: 'idle', since: '2026-10-14T00:00:00.000Z' },
    now: '2026-10-14T00:00:01.000Z',
    available: true,
    conversation: {
      id,
      projectId: 'prj_sponsor_secret',
      userId: 'sponsor-person-key',
      title: 'Intake',
      revision: 3,
      activeCommandId: null,
      checkpoint: { hash: 'checkpoint-hash', size: 10, commandId: 'c1' },
      previousCheckpoint: null,
      model: 'gpt-6-astra',
      createdAt: '2026-10-14T00:00:00.000Z',
      updatedAt: '2026-10-14T00:00:00.000Z',
    },
    commands: [
      {
        id: 'c1',
        conversationId: id,
        epoch: 7,
        runtimeId: 'alloc_secret',
        hostId: 'pih_secret',
        machine: 'large',
        model: 'gpt-6-astra',
        effort: 'medium',
        status: 'completed',
        messages: [
          { role: 'user', text: 'Hello' },
          { role: 'assistant', text: 'What decision should this settle?' },
        ],
        outcomes: [
          {
            callId: 'call1',
            name: 'customer_experiments.compute_options',
            input: { id: 'x' },
            output: { offers: [{ provider: 'catalog-secret', hourlyUsd: 3.21 }] },
          },
        ],
        error: null,
        createdAt: '2026-10-14T00:00:00.000Z',
        startedAt: '2026-10-14T00:00:00.100Z',
        expiresAt: '2026-10-14T01:00:00.000Z',
        completedAt: '2026-10-14T00:00:02.000Z',
        proposals: [{ id: 'pip_1', name: 'secret.tool', input: {}, at: '2026-10-14T00:00:00Z' }],
      },
    ],
    host: {
      machine: {
        key: 'large',
        label: 'Large',
        vcpu: 8,
        memoryGiB: 32,
        diskGB: 100,
        maxHourlyUsd: 9.99,
      },
      preferred: 'large',
      catalog: [
        {
          key: 'large',
          label: 'Large',
          vcpu: 8,
          memoryGiB: 32,
          diskGB: 100,
          maxHourlyUsd: 9.99,
          available: true,
        },
      ],
      state: 'ready',
      idleEndsAt: '2026-10-14T00:10:00.000Z',
      idleSeconds: 600,
      moving: { to: 'standard', by: 'agent', since: '2026-10-14T00:00:00.000Z' },
      lastMove: null,
    },
    models: [{ id: 'gpt-6-astra', label: 'Astra' }],
    screen: { id: 'ask_1', show: { record: 'prj_other_project' } },
    streamId: 'stream-1',
    sequence: 4,
    tail: [{ sequence: 4, commandId: 'c1', type: 'text', text: 'What decision' }],
  };
}

async function fixture(t: TestContext, options: { version?: number; identity?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'merv-customer-identity-'));
  const state = await openState(dir);
  const scope = await createService(new ProjectScope(state));
  const sponsor = { issuer: 'https://identity.example', subject: 'service-sponsor' };
  const principal = await scope.members.acceptVerifiedIdentity({
    ...sponsor,
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  const project = await scope.members.createProject(principal, {
    name: 'Customer request',
    requestId: 'customer-request',
  });
  const store = new RequestStore(state, 'fixture-key-never-valid-outside-this-test');
  await store.initialize();
  let record = await store.create(randomUUID(), 'Intake', 10);
  await store.mutate(record.id, (r) => {
    r.projectId = project.id;
    r.experimentId = 'exp_fixture';
    r.conversationId = 'pi_fixture';
  });
  record = await store.get(record.id);
  const version = options.version ?? 3;
  const domain = {
    async get() {
      return {
        id: 'exp_fixture',
        workflow: { state: 'planning', version, revision: 1, data: {} },
        contract: null,
        submission: null,
      };
    },
    async plan() {
      return { revision: 0, document: '', status: 'drafting', feedback: null, contract: null };
    },
  } as unknown as CustomerExperiments;
  const calls: { method: string; caller: Caller; id: string; input?: unknown }[] = [];
  const pi = {
    async snapshot(caller: Caller, id: string) {
      calls.push({ method: 'snapshot', caller, id });
      return sponsorSnapshot(id);
    },
    async send(caller: Caller, id: string, input: unknown) {
      calls.push({ method: 'send', caller, id, input });
      return { id: 'command' };
    },
    async voice(
      caller: Caller,
      input: { id: string; sdp: string },
      options: { allowProfile: boolean },
    ) {
      assert.deepEqual(options, { allowProfile: true });
      calls.push({ method: 'voice', caller, id: input.id, input });
      return { sdp: 'answer', sessionId: 'private-session' };
    },
    async stop(caller: Caller, id: string) {
      calls.push({ method: 'stop', caller, id });
      return sponsorSnapshot(id);
    },
    async authorizeStream(caller: Caller, id: string) {
      calls.push({ method: 'authorizeStream', caller, id });
    },
    streams: {
      snapshot: () => ({ streamId: 'stream-1', sequence: 4, tail: [] }),
      subscribe: () => () => {},
    },
  } as unknown as PiRuntime;
  const service = new CustomerService(
    store,
    domain,
    scope,
    undefined as never,
    pi,
    undefined,
    undefined,
    undefined,
    {
      publicOrigin: 'https://merv.example',
      sponsor,
      intakeKey: 'unused-intake-key',
      maxRequestsPerDay: 10,
    },
  );
  // Browsers' anonymous Supabase users; 'account' is a signed-in account, also accepted.
  const people: Record<string, Omit<VerifiedIdentity, 'expiresAt'>> = {
    alice: { issuer, subject: 'alice', anonymous: true },
    bob: { issuer, subject: 'bob', anonymous: true },
    account: { issuer, subject: 'account' },
  };
  const verifications: { allowAnonymous?: boolean }[] = [];
  if (options.identity !== false)
    service.access.identity = {
      async verify(token, options = {}) {
        verifications.push(options);
        const person = people[token];
        if (!person || (person.anonymous && !options.allowAnonymous))
          throw new MervError('unauthorized', 'Authentication required', 401);
        return { ...person, expiresAt: new Date(Date.now() + 3600000).toISOString() };
      },
      configuration: () => ({ enabled: true, login }),
    };
  const tools = new ToolRegistry(scope);
  const api = new ApiServer(scope, tools, { port: 0 });
  api.mount('/customer-experiments', customerHttp(service), { public: true });
  const url = await api.start();
  t.after(async () => {
    await api.stop();
    await tools.close();
    await state.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const send = async (
    path: string,
    token?: string,
    person?: string,
    body?: unknown,
    method = body === undefined ? 'GET' : 'POST',
  ) => {
    const response = await fetch(url + base + '/' + record.id + path, {
      method,
      headers: {
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(person ? { 'X-Merv-Identity': person } : {}),
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      body: response.headers.get('content-type')?.includes('application/json')
        ? await response.json()
        : await response.text(),
    };
  };
  return {
    url,
    record,
    store,
    service,
    calls,
    verifications,
    send,
    customer: store.token(record, 'customer'),
    agent: store.token(record, 'agent'),
    sponsorCaller: await service.caller(record),
  };
}

test('the first browser binds a v3 request; another is refused until it takes over', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.send('/session', f.agent)).status, 401);
  assert.deepEqual((await f.send('/session', f.customer)).body, {
    version: 3,
    bound: false,
    login,
  });
  assert.equal((await f.send('/session', f.customer, undefined, {})).status, 401);
  assert.equal((await f.send('/session', f.customer, 'forged', {})).status, 401);
  assert.equal((await f.send('/session', f.agent, 'alice', {})).status, 401);
  assert.equal((await f.send('/chat', f.customer, 'alice')).body.error.code, 'identity_unbound');
  assert.deepEqual((await f.send('/session', f.customer, 'alice', {})).body, { bound: true });
  assert.deepEqual((await f.send('/session', f.customer, 'alice', {})).body, { bound: true });
  assert.ok(f.verifications.every((options) => options.allowAnonymous === true));
  const elsewhere = await f.send('/session', f.customer, 'bob', {});
  assert.equal(elsewhere.status, 409);
  assert.equal(elsewhere.body.error.code, 'bound_elsewhere');
  assert.equal((await f.send('/chat', f.customer, 'bob')).body.error.code, 'bound_elsewhere');
  assert.equal((await f.store.binding(f.record.id))!.subject, 'alice');
  assert.deepEqual((await f.send('/session', f.customer)).body, { version: 3, bound: true, login });
  // Taking over needs the capability, and moves the customer role to the new browser.
  assert.equal((await f.send('/session', f.agent, 'bob', { takeOver: true })).status, 401);
  assert.equal((await f.send('/session', f.customer, 'bob', { takeOver: 1 })).status, 400);
  assert.deepEqual((await f.send('/session', f.customer, 'bob', { takeOver: true })).body, {
    bound: true,
  });
  assert.equal((await f.send('/chat', f.customer, 'bob')).status, 200);
  assert.equal((await f.send('/chat', f.customer, 'alice')).body.error.code, 'bound_elsewhere');
  // A signed-in account binds the same way.
  await f.send('/session', f.customer, 'account', { takeOver: true });
  assert.equal((await f.send('/chat', f.customer, 'account')).status, 200);
});

test('v3 customer routes need the capability and the bound sign-in; the agent keeps its own', async (t) => {
  const f = await fixture(t);
  await f.send('/session', f.customer, 'alice', {});
  // The link alone no longer acts as the customer, anywhere.
  for (const path of ['', '/chat'])
    assert.equal((await f.send(path, f.customer)).status, 401, path);
  assert.equal((await f.send('/chat', f.customer, 'bob')).status, 409);
  // The agent capability never chats as the customer, approves or pays, with or without a browser.
  for (const path of ['/chat', '/chat/events'])
    assert.equal((await f.send(path, f.agent, 'alice')).status, 401, path);
  for (const path of ['/chat/messages', '/chat/stop', '/accept', '/checkout'])
    assert.equal(
      (await f.send(path, f.agent, 'alice', { commandId: 'x', text: 'hi', contractVersion: 1 }))
        .status,
      401,
      path,
    );
  assert.equal((await f.send('', f.agent)).status, 200);
  assert.equal((await f.send('', f.customer, 'alice')).status, 200);
  // Approval reaches the existing domain flow as the bound customer; v3 accepts with checkout.
  const accepted = await f.send('/accept', f.customer, 'alice', {
    contractVersion: 1,
    email: 'customer@example.com',
  });
  assert.equal(accepted.body.error.code, 'plan_document');
  assert.equal(
    (await f.send('/accept', f.customer, 'bob', { contractVersion: 1, email: 'c@example.com' }))
      .status,
    409,
  );
});

test('the chat adapter reaches the intake conversation as the sponsor, redacted', async (t) => {
  const f = await fixture(t);
  await f.send('/session', f.customer, 'alice', {});
  const chat = await f.send('/chat', f.customer, 'alice');
  assert.equal(chat.status, 200);
  assert.deepEqual(chat.body, customerChat(sponsorSnapshot('pi_fixture')));
  const sent = await f.send('/chat/messages', f.customer, 'alice', {
    commandId: 'cmd-1',
    text: 'We need to pick a tokenizer',
  });
  assert.equal(sent.status, 200);
  assert.equal(
    (
      await f.send('/chat/messages', f.customer, 'alice', {
        commandId: 'cmd-2',
        text: 'x',
        model: 'm',
      })
    ).status,
    400,
  );
  assert.equal((await f.send('/chat/stop', f.customer, 'alice', {})).status, 200);
  const send = f.calls.find((call) => call.method === 'send')!;
  assert.deepEqual(send.input, { commandId: 'cmd-1', text: 'We need to pick a tokenizer' });
  for (const call of f.calls) {
    assert.equal(call.id, 'pi_fixture');
    assert.equal(call.caller.actorId, f.sponsorCaller.actorId);
    assert.equal(call.caller.projectId, f.record.projectId);
  }
  assert.ok(f.calls.some((call) => call.method === 'stop'));

  const controller = new AbortController();
  const response = await fetch(`${f.url}${base}/${f.record.id}/chat/events`, {
    headers: { Authorization: 'Bearer ' + f.customer, 'X-Merv-Identity': 'alice' },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const reader = response.body!.getReader();
  let text = '';
  while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
  controller.abort();
  const [event, data] = text.split('\n');
  assert.equal(event, 'event: snapshot');
  assert.deepEqual(
    JSON.parse(data!.slice('data: '.length)),
    customerChat(sponsorSnapshot('pi_fixture')),
  );
});

test('the customer view of a snapshot keeps Pi’s shape and drops every sponsor-only field', () => {
  const view = customerChat(sponsorSnapshot('pi_1'));
  const text = JSON.stringify(view);
  for (const secret of [
    'prj_sponsor_secret',
    'sponsor-person-key',
    'checkpoint-hash',
    'alloc_secret',
    'pih_secret',
    'catalog-secret',
    'secret.tool',
    'gpt-6-astra',
    '9.99',
    'prj_other_project',
    'large',
  ])
    assert.ok(!text.includes(secret), secret);
  assert.deepEqual(view.commands[0]!.messages, sponsorSnapshot('pi_1').commands[0]!.messages);
  assert.deepEqual(view.commands[0]!.outcomes, []);
  assert.equal(view.host.state, 'ready');
  assert.deepEqual(view.models, []);
  assert.deepEqual(view.tail, sponsorSnapshot('pi_1').tail);
  assert.equal(view.stage.name, 'idle');
  assert.equal('screen' in view, false);
});

test('the server’s plan verification turn reads as the customer’s Submit, with the agent’s reply', () => {
  const sponsor = sponsorSnapshot('pi_1');
  const reply = { role: 'assistant' as const, text: 'Accepted.' };
  sponsor.commands.push({
    ...sponsor.commands[0]!,
    id: 'plan-submit-2-1',
    messages: [
      { role: 'user', text: 'The customer submitted plan revision 2 for verification. Read it…' },
      reply,
    ],
  });
  assert.deepEqual(customerChat(sponsor).commands.at(-1)!.messages, [
    { role: 'user', text: 'Submitted the plan.' },
    reply,
  ]);
});

test('v1/v2 requests keep capability-only customers and get no chat', async (t) => {
  const f = await fixture(t, { version: 2 });
  assert.equal((await f.send('', f.customer)).status, 200);
  assert.equal((await f.send('/chat', f.customer)).status, 404);
  assert.equal((await f.send('/session', f.customer, 'alice', {})).status, 404);
  const accepted = await f.send('/accept', f.customer, undefined, { contractVersion: 1 });
  assert.equal(accepted.status, 400);
});

test('without identity, v3 customers are refused with 503 and the agent is unaffected', async (t) => {
  const f = await fixture(t, { identity: false });
  assert.equal((await f.send('/session', f.customer)).status, 503);
  assert.equal((await f.send('/chat', f.customer, 'alice')).status, 503);
  assert.equal((await f.send('', f.customer, 'alice')).status, 503);
  assert.equal((await f.send('', f.agent)).status, 200);
});

test('identity verifies anonymous users only for a caller that opts in', async (t) => {
  const name = `MERV_IDENTITY_TEST_${randomUUID().replaceAll('-', '_')}`;
  const secret = 'synthetic-shared-identity-secret-at-least-thirty-two-bytes';
  process.env[name] = secret;
  t.after(() => delete process.env[name]);
  const provider = new SupabaseIdentity({
    supabaseUrl: 'https://auth.example',
    mode: 'hs256',
    secretEnv: name,
  });
  const token = (claims: Record<string, unknown>) =>
    new SignJWT({
      iss: issuer,
      aud: 'authenticated',
      sub: 'person',
      exp: Math.floor(Date.now() / 1000) + 3600,
      role: 'authenticated',
      ...claims,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .sign(new TextEncoder().encode(secret));
  const anonymous = await token({ is_anonymous: true });
  await assert.rejects(provider.verify(anonymous), { status: 401 });
  await assert.rejects(provider.verify(anonymous, { allowAnonymous: false }), { status: 401 });
  const verified = await provider.verify(anonymous, { allowAnonymous: true });
  assert.equal(verified.anonymous, true);
  assert.equal(verified.subject, 'person');
  const account = await provider.verify(await token({}), { allowAnonymous: true });
  assert.equal('anonymous' in account, false);
  // Scope never makes an anonymous browser a member.
  const dir = mkdtempSync(join(tmpdir(), 'merv-customer-identity-scope-'));
  const state = await openState(dir);
  t.after(async () => {
    await state.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const scope = await createService(new ProjectScope(state));
  await assert.rejects(scope.members.acceptVerifiedIdentity(verified), { status: 401 });
});

test('customer voice uses only the bound request conversation and requires customer identity', async (t) => {
  const f = await fixture(t);
  await f.send('/session', f.customer, 'alice', {});
  const answer = await f.send('/chat/voice', f.customer, 'alice', { sdp: 'offer' });
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body, { sdp: 'answer' });
  const call = f.calls.find((call) => call.method === 'voice')!;
  assert.equal(call.id, 'pi_fixture');
  assert.deepEqual(call.input, { id: 'pi_fixture', sdp: 'offer' });
  assert.notEqual((await f.send('/chat/voice', f.customer, 'bob', { sdp: 'offer' })).status, 200);
  assert.notEqual((await f.send('/chat/voice', f.agent, 'alice', { sdp: 'offer' })).status, 200);
  assert.notEqual(
    (await f.send('/chat/voice', f.customer, 'alice', { id: 'other', sdp: 'offer' })).status,
    200,
  );
  assert.equal(f.calls.filter((call) => call.method === 'voice').length, 1);
});

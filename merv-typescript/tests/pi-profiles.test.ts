import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { MervError } from '@merv/contracts';
import { piModelRelay } from '../packages/pi/src/relay.js';
import type { PiProfile } from '../packages/pi/src/types.js';
import { code, fixture, models } from './fixtures/pi.js';
import { registerWorkerTools } from '../packages/customer-experiments/src/worker-tools.js';
import type { CustomerExperiments } from '../packages/customer-experiments/src/domain.js';
import { CustomerService } from '../packages/customer-experiments/src/service.js';
import { retired } from '../packages/sandboxes/src/host.js';

const astraModels = models.map((model) =>
  model.id === 'gpt-6-astra' ? { ...model, effort: 'medium' as const } : model,
);
const profile: PiProfile = {
  id: 'customer-experiments-intake',
  version: 1,
  model: { id: 'gpt-6-astra', effort: 'medium' },
  instructions: 'Interview the customer agent about this bounded experiment. Never execute it.',
  tools: ['customer_experiments.read'],
  context: async ({ binding }) => `Private request ${binding.requestId}`,
};
const input = {
  requestId: 'intake-create-request_1',
  title: 'Experiment intake',
  profile: { id: profile.id, version: 1, requestId: 'request_1' },
};

test('trusted intake binds the request and exact Astra/medium model, offers only its tools and context', async (t) => {
  const f = await fixture(t, { pi: { models: [...models] } });
  let calls = 0;
  let authorizations = 0;
  f.tools.register({
    name: 'customer_experiments.read',
    conversationProfile: profile.id,
    description: 'Read only this request',
    readOnly: true,
    inputSchema: z.object({ requestId: z.string() }).strict(),
    handler: () => {
      calls++;
      return { title: 'Bounded experiment' };
    },
  });
  f.pi.registerProfile({
    ...profile,
    authorizeTool: async ({ binding, caller, name, input }) => {
      authorizations++;
      assert.ok(caller.conversation);
      assert.equal(name, 'customer_experiments.read');
      if (input.requestId !== binding.requestId)
        throw new MervError('request_forbidden', 'Wrong request', 403);
    },
  });
  const conversation = await f.pi.createProfiled(f.operator, input);
  assert.deepEqual(await f.pi.createProfiled(f.operator, input), conversation);
  assert.equal(conversation.model, 'gpt-6-astra');
  const bound = await f.claimed(await f.send(conversation));
  assert.equal(bound.work.model, 'gpt-6-astra');
  assert.equal(bound.work.command.effort, 'medium');
  assert.equal(bound.work.instructions, profile.instructions);
  assert.equal(bound.work.context, 'Private request request_1');
  assert.deepEqual(
    bound.work.tools.map(({ name }) => name),
    profile.tools,
  );
  assert.equal((await f.pi.prompt(f.operator, conversation.id)).instructions, profile.instructions);
  await f.pi.begin(bound.token, bound.input);
  await assert.rejects(
    f.pi.tool(bound.token, {
      ...bound.input,
      name: 'project.get',
      input: {},
    }),
    code('pi_tool_forbidden'),
  );
  await assert.rejects(
    f.pi.tool(bound.token, {
      ...bound.input,
      name: 'customer_experiments.read',
      input: { requestId: 'request_other' },
    }),
    code('request_forbidden'),
  );
  assert.equal(calls, 0);
  assert.deepEqual(
    await f.pi.tool(bound.token, {
      ...bound.input,
      name: 'customer_experiments.read',
      input: { requestId: 'request_1' },
    }),
    { title: 'Bounded experiment' },
  );
  assert.equal(calls, 1);
  assert.equal(authorizations, 2);
  const grant = await f.pi.authorizeModel(bound.work.modelToken);
  assert.equal(grant.model, 'gpt-6-astra');
  assert.deepEqual(grant.toolNames, ['customer_experiments_read']);
  // A role without a terminal is offered none.
  assert.equal(bound.work.shell, undefined);
  await f.pi.validateModel(grant);
  await f.pi.complete(bound.token, f.completion(bound.input));
  assert.equal((await f.pi.snapshot(f.operator, conversation.id)).commands[0].effort, 'medium');
});

test('customer tools do not overflow a full ordinary producer tool catalog or displace Nisa', async (t) => {
  const f = await fixture(t);
  const first = await f.claimed(await f.send(await f.create()));
  await f.pi.begin(first.token, first.input);
  await f.pi.complete(first.token, f.completion(first.input));
  const extra = 128 - first.work.tools.length;
  assert.ok(extra >= 2);
  for (let i = 0; i < extra; i++)
    f.tools.register({
      name: i === 0 ? 'nisa.search' : i === 1 ? 'nisa.research' : `ordinary.tool_${i}`,
      description: 'Ordinary producer tool',
      inputSchema: z.object({}),
      handler: () => ({}),
    });
  for (const name of ['read', 'compute_options', 'propose'])
    f.tools.register({
      name: `customer_experiments.${name}`,
      conversationProfile: profile.id,
      description: 'Bound intake tool',
      inputSchema: z.object({}),
      handler: () => ({}),
    });
  const dispose = registerWorkerTools(f.tools, {} as CustomerExperiments);
  t.after(dispose);
  const normal = await f.begun(f.operator);
  assert.equal(normal.work.tools.length, 128);
  assert.ok(normal.work.tools.some((t) => t.name === 'nisa.search'));
  assert.ok(normal.work.tools.some((t) => t.name === 'nisa.research'));
  assert.ok(normal.work.tools.every((t) => !t.name.startsWith('customer_experiment')));
  await assert.rejects(
    f.pi.tool(normal.token, { ...normal.input, name: 'customer_experiments.read', input: {} }),
    code('pi_tool_forbidden'),
  );
  await f.pi.complete(normal.token, f.completion(normal.input));
});

test('public creation cannot set a profile, and the trusted request binding and model cannot change', async (t) => {
  const f = await fixture(t, { pi: { models: astraModels } });
  f.pi.registerProfile(profile);
  await assert.rejects(f.pi.create(f.operator, input), code('invalid_pi_input'));
  const conversation = await f.pi.createProfiled(f.operator, input);
  await assert.rejects(
    f.pi.createProfiled(f.operator, {
      ...input,
      profile: { ...input.profile, requestId: 'request_other' },
    }),
    code('pi_request_conflict'),
  );
  await assert.rejects(
    f.pi.create(f.operator, {
      requestId: input.requestId,
      title: input.title,
    }),
    code('pi_request_conflict'),
  );
  await assert.rejects(
    f.pi.setModel(f.operator, {
      id: conversation.id,
      model: 'gpt-6-luna',
    }),
    code('pi_profile_fixed'),
  );
  await assert.rejects(
    f.pi.voice(f.operator, {
      id: conversation.id,
      sdp: 'offer',
    }),
    code('pi_profile_fixed'),
  );
  assert.deepEqual((await f.pi.snapshot(f.operator, conversation.id)).models, [
    { id: 'gpt-6-astra', label: 'GPT-6 Astra' },
  ]);
  assert.equal(
    (await f.create()).model,
    'gpt-6-luna',
    'ordinary conversations retain their default',
  );
});

test('missing profile, changed profile version contents, and withdrawn profile model fail closed', async (t) => {
  const f = await fixture(t, { pi: { models: astraModels } });
  await assert.rejects(f.pi.createProfiled(f.operator, input), code('pi_profile_unavailable'));
  let unregister = f.pi.registerProfile(profile);
  const conversation = await f.pi.createProfiled(f.operator, input);
  unregister();
  await assert.rejects(f.send(conversation), code('pi_profile_unavailable'));
  unregister = f.pi.registerProfile({ ...profile, tools: ['project.get'] });
  await assert.rejects(f.send(conversation), code('pi_profile_unavailable'));
  unregister();
  f.pi.registerProfile(profile);
  await f.restart({ models: models.filter((model) => model.id !== 'gpt-6-astra') });
  f.pi.registerProfile(profile);
  await assert.rejects(f.send(conversation), code('pi_profile_model_unavailable'));
  await assert.rejects(
    f.pi.createProfiled(f.operator, {
      ...input,
      requestId: 'another',
    }),
    code('pi_profile_model_unavailable'),
  );
  assert.equal((await f.create()).model, 'gpt-6-luna');
});

test('unloading a trusted role revokes active turn tool and model authority', async (t) => {
  const f = await fixture(t, { pi: { models: astraModels } });
  const unregister = f.pi.registerProfile({ ...profile, tools: ['project.get'] });
  const conversation = await f.pi.createProfiled(f.operator, input);
  const bound = await f.claimed(await f.send(conversation));
  await f.pi.begin(bound.token, bound.input);
  const grant = await f.pi.authorizeModel(bound.work.modelToken);
  unregister();
  await assert.rejects(f.pi.authorizeModel(bound.work.modelToken), code('pi_profile_unavailable'));
  await assert.rejects(f.pi.validateModel(grant), code('pi_profile_unavailable'));
  await assert.rejects(
    f.pi.tool(bound.token, {
      ...bound.input,
      name: 'project.get',
      input: {},
    }),
    code('pi_profile_unavailable'),
  );
  assert.equal(f.reads, 0);
});

test('Pi relay always supplies medium for Astra even when a worker asks for less effort', async () => {
  const { piModels } = await import('../deploy/schema.mjs');
  assert.deepEqual(piModels(astraModels, 'MERV_PI_MODELS'), astraModels);
  const relay = piModelRelay({
    models: astraModels,
    providerKey: () => '',
    authority: {
      authorize: async () => {
        throw Error('unused');
      },
      validate: async () => {},
    },
  });
  const payload = relay.payload(
    {
      model: 'gpt-6-astra',
      store: false,
      stream: true,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      reasoning: { effort: 'none' },
    },
    {
      id: 'grant',
      userId: 'person',
      projectId: 'project',
      conversationId: 'conversation',
      commandId: 'command',
      runtimeId: 'runtime',
      epoch: 1,
      expiresAt: '2026-10-13T00:00:00Z',
      model: 'gpt-6-astra',
      toolNames: [],
    },
  );
  assert.ok(payload);
  assert.deepEqual((payload as Record<string, unknown>).reasoning, { effort: 'medium' });
});

test('a trusted adapter can open profiled voice without changing the intake model or tools', async (t) => {
  const keyEnv = 'MERV_TEST_CUSTOMER_VOICE_KEY';
  const previous = process.env[keyEnv];
  process.env[keyEnv] = 'fixture-only';
  t.after(() => {
    if (previous === undefined) delete process.env[keyEnv];
    else process.env[keyEnv] = previous;
  });
  const f = await fixture(t, { pi: { models: [...models], modelApiKeyEnv: keyEnv } });
  const unregister = f.pi.registerProfile(profile);
  const conversation = await f.pi.createProfiled(f.operator, input);
  let opened = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    opened++;
    const body = JSON.parse(init.body as string);
    assert.deepEqual(body.session.delegation, { type: 'client' });
    return Response.json({ session: { id: 'voice-fixture' }, transport: { sdp: 'answer' } });
  });
  await assert.rejects(
    f.pi.voice(f.operator, { id: conversation.id, sdp: 'offer' }),
    code('pi_profile_fixed'),
  );
  assert.deepEqual(
    await f.pi.voice(f.operator, { id: conversation.id, sdp: 'offer' }, { allowProfile: true }),
    { sessionId: 'voice-fixture', sdp: 'answer' },
  );
  assert.equal(
    (await f.pi.snapshot(f.operator, conversation.id)).conversation.model,
    'gpt-6-astra',
  );
  unregister();
  await assert.rejects(
    f.pi.voice(f.operator, { id: conversation.id, sdp: 'offer' }, { allowProfile: true }),
    code('pi_profile_unavailable'),
  );
  assert.equal(opened, 1);
});

test('a role with a terminal is told so, and its model may call the terminal tools', async (t) => {
  const f = await fixture(t, { pi: { models: [...models] } });
  f.tools.register({
    name: 'customer_experiments.read',
    conversationProfile: profile.id,
    description: 'Read only this request',
    readOnly: true,
    inputSchema: z.object({ requestId: z.string() }).strict(),
    handler: () => ({}),
  });
  f.pi.registerProfile({ ...profile, version: 2, shell: true });
  // The flag is the role's: a public profile definition cannot carry anything but true.
  assert.throws(
    () => f.pi.registerProfile({ ...profile, version: 3, shell: false as unknown as true }),
    code('pi_profile_invalid'),
  );
  const conversation = await f.pi.createProfiled(f.operator, {
    ...input,
    requestId: 'intake-create-shell',
    profile: { ...input.profile, version: 2 },
  });
  const bound = await f.claimed(await f.send(conversation));
  assert.equal(bound.work.shell, true);
  await f.pi.begin(bound.token, bound.input);
  // The library's own tools are not Merv tools: Main offers only its own, the worker adds them.
  assert.deepEqual(
    bound.work.tools.map(({ name }) => name),
    ['customer_experiments.read'],
  );
  const grant = await f.pi.authorizeModel(bound.work.modelToken);
  assert.deepEqual(grant.toolNames, [
    'customer_experiments_read',
    'bash',
    'read',
    'write',
    'ls',
    'grep',
  ]);
  await f.pi.validateModel(grant);
});

test('a turn runs the retired tool names it was offered as the tools they became, healer v1 and v2 included', async (t) => {
  const f = await fixture(t, { pi: { models: astraModels } });
  const healers: PiProfile[] = [];
  await new CustomerService(
    {} as never,
    {} as never,
    {} as never,
    { registerFileProvider: () => () => {} } as never,
    { registerProfile: (healer: PiProfile) => (healers.push(healer), () => {}) } as never,
    undefined,
    () => undefined,
    undefined,
    { publicOrigin: 'https://merv.example', sponsor: { issuer: 'i', subject: 's' } } as never,
  ).registerIntake({ register: () => () => {} } as never);
  const bound = healers.filter((p) => p.id === 'customer-experiments-healer' && p.version < 3);
  const retiredNames = bound[0]!.tools.filter((name) => name.startsWith('sandbox'));
  assert.deepEqual(
    bound.map(({ tools }) => tools.filter((name) => name.startsWith('sandbox'))),
    [retiredNames, retiredNames],
  );
  // The tools they became, as Sandboxes registers them, and the table that runs the old names.
  f.tools.register({
    name: 'sandboxes.sandbox',
    description: 'Machines',
    inputSchema: z
      .object({
        action: z.enum(['list', 'get', 'providers', 'create', 'delete']).default('list'),
        sandbox_id: z.string().optional(),
      })
      .strict(),
    reads: ({ action }) => !['create', 'delete'].includes(action),
    handler: (_caller, input) => ({ tool: 'sandbox', ...input }),
  });
  f.tools.register({
    name: 'sandboxes.spend',
    description: 'Spend',
    readOnly: true,
    inputSchema: z.object({ action: z.enum(['status', 'report']).default('status') }).strict(),
    handler: (_caller, input) => ({ tool: 'spend', ...input }),
  });
  t.after(f.tools.alias(retired));
  for (const healer of [undefined, ...bound]) {
    // Its turn was offered the old tools before the release that retired them.
    const old = retiredNames.map((name) =>
      f.tools.register({
        name,
        description: name,
        inputSchema: z.object({ id: z.string().optional() }).strict(),
        handler: () => assert.fail('retired'),
      }),
    );
    let conversation = await f.create();
    if (healer) {
      f.pi.registerProfile({ ...healer, context: async () => '' });
      const request = `request_${healer.version}`;
      conversation = await f.pi.createProfiled(f.operator, {
        requestId: `healer-${request}`,
        title: 'Healer',
        profile: { id: healer.id, version: healer.version, requestId: request },
      });
    }
    // One person's turns share their machine, which runs after the first.
    const command = await f.send(conversation);
    const token = await f.token(command.runtimeId);
    await f.fleet.tick();
    await f.fleet.tick();
    const { work } = await f.pi.next(token, { workerId: 'worker_1' });
    const turn = {
      conversationId: conversation.id,
      commandId: work!.command.id,
      workerId: 'worker_1',
    };
    for (const unregister of old) await unregister();
    await f.pi.begin(token, turn);
    const call = (name: string, input: object) => f.pi.tool(token, { ...turn, name, input });
    assert.deepEqual(await call('sandboxes.sandbox_list', {}), { tool: 'sandbox', action: 'list' });
    assert.deepEqual(await call('sandboxes.providers_list', {}), {
      tool: 'sandbox',
      action: 'providers',
    });
    assert.deepEqual(await call('sandboxes.spend_status', {}), { tool: 'spend', action: 'status' });
    // Its old arguments, renamed, and its own action whatever the input says.
    assert.deepEqual(await call('sandbox.release', { id: 'sbx_1', action: 'create' }), {
      tool: 'sandbox',
      action: 'delete',
      sandbox_id: 'sbx_1',
    });
    await f.pi.complete(token, f.completion(turn));
  }
  // A profile may name any tool the registry may, one without a dot included.
  f.pi.registerProfile({ ...profile, id: 'fleet-role', tools: ['fleet'] });
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { MervError } from '@merv/contracts';
import { piModelRelay } from '../packages/pi/src/relay.js';
import type { PiProfile } from '../packages/pi/src/types.js';
import { code, fixture, models } from './fixtures/pi.js';
import { registerWorkerTools } from '../packages/customer-experiments/src/worker-tools.js';
import type { CustomerExperiments } from '../packages/customer-experiments/src/domain.js';

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

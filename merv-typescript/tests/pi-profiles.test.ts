import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { intakeProfiles } from './fixtures/intake.js';
import { PiProfiles } from '../packages/pi/src/profiles.js';
import { webTools } from '../packages/web/src/tools.js';
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

const hashes: Record<string, string> = JSON.parse(
  readFileSync(new URL('./fixtures/intake-profile-hashes.json', import.meta.url), 'utf8'),
);

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
  // A later version's tool of the same profile is not this version's: its pinned list is.
  f.tools.register({
    name: 'customer_experiments.propose',
    conversationProfile: profile.id,
    description: 'Propose a plan',
    inputSchema: z.object({}).strict(),
    handler: () => ({}),
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

test('a turn runs the retired tool names it was offered, and a new turn of healer v1 and v2 is offered them', async (t) => {
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
  ).registerIntake({ noun: () => () => {} } as never);
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
    // A plain conversation's turn was offered the old tools before the release that retired them;
    // a healer's turn is offered them now, as its profile names them.
    const old = (healer ? [] : retiredNames).map((name) =>
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
    const offered = new Map(work!.tools.map((tool) => [tool.name, tool]));
    assert.deepEqual(
      retiredNames.filter((name) => !offered.has(name)),
      [],
    );
    // Its old arguments, as the model is told them.
    assert.deepEqual(
      Object.keys(offered.get('sandbox.release')!.inputSchema.properties as object),
      ['id'],
    );
    const turn = {
      conversationId: conversation.id,
      commandId: work!.command.id,
      workerId: 'worker_1',
    };
    for (const unregister of old) await unregister();
    await f.pi.begin(token, turn);
    // What each call is, as the person's page shows it while it runs: a read, or a change.
    const run = f.tools.call.bind(f.tools);
    const shown: (string | undefined)[] = [];
    f.tools.call = async (...args) => (
      shown.push((await f.pi.snapshot(f.operator, conversation.id)).stage.detail),
      run(...args)
    );
    const call = (name: string, input: object) => f.pi.tool(token, { ...turn, name, input });
    assert.deepEqual(await call('sandboxes.sandbox_list', {}), { tool: 'sandbox', action: 'list' });
    assert.deepEqual(await call('sandboxes.providers_list', {}), {
      tool: 'sandbox',
      action: 'providers',
    });
    assert.deepEqual(await call('sandboxes.spend_status', {}), { tool: 'spend', action: 'status' });
    // Its old arguments, renamed, and no other: not even its own action.
    assert.deepEqual(await call('sandbox.release', { id: 'sbx_1' }), {
      tool: 'sandbox',
      action: 'delete',
      sandbox_id: 'sbx_1',
    });
    assert.equal(
      (
        (await call('sandbox.release', { id: 'sbx_1', action: 'create' })) as {
          error: { code: string };
        }
      ).error.code,
      'invalid_input',
    );
    f.tools.call = run;
    assert.deepEqual(shown, [
      'Reading',
      'Reading',
      'Reading',
      'Making a change',
      'Making a change',
    ]);
    await f.pi.complete(token, f.completion(turn));
  }
  // A profile may name any tool the registry may, one without a dot included.
  f.pi.registerProfile({ ...profile, id: 'fleet-role', tools: ['fleet'] });
});

test('intake v9 and healer v4 register addresses while all stored earlier profile hashes survive', async () => {
  // Every intake/healer version registered at c06127657, including its latest healer v3.
  assert.deepEqual(Object.keys(hashes), [
    ...Array.from({ length: 8 }, (_, i) => `customer-experiments-intake@${i + 1}`),
    ...Array.from({ length: 3 }, (_, i) => `customer-experiments-healer@${i + 1}`),
  ]);
  const registry = new PiProfiles();
  const { profiles } = await intakeProfiles();
  for (const profile of profiles) registry.register(profile);
  for (const [key, definitionHash] of Object.entries(hashes)) {
    const [id, version] = key.split('@');
    const binding = { id: id!, version: Number(version), requestId: 'stored-request' };
    assert.equal(registry.bind(binding).definitionHash, definitionHash, key);
    assert.equal(
      registry.get({ ...binding, definitionHash: String(definitionHash) }).version,
      Number(version),
    );
  }
  const intake = registry.get(
    registry.bind({ id: 'customer-experiments-intake', version: 9, requestId: 'r' }),
  );
  assert.ok(intake.tools.includes('intake.read:request'));
  assert.ok(intake.tools.includes('intake.write:verify_plan'));
  assert.ok(intake.tools.includes('nisa.read:excerpts'));
  assert.ok(!intake.tools.includes('intake.write:propose'));
  const healer = registry.get(
    registry.bind({ id: 'customer-experiments-healer', version: 4, requestId: 'r' }),
  );
  assert.ok(healer.tools.includes('web.read:search'));
});

test('a base healer v3 binding loads after deployment and its frozen web tools still execute', async (t) => {
  const f = await fixture(t, { pi: { models: astraModels } });
  const { profiles } = await intakeProfiles();
  const healer = profiles.find((p) => p.id === 'customer-experiments-healer' && p.version === 3)!;
  // Recreate the base grants before freezing a turn. Pin the stored hash independently of
  // today's registration, so changing v3 in place cannot silently update this test's binding.
  const base = {
    ...healer,
    tools: healer.tools.map((name) =>
      name === 'web.read:search'
        ? 'web.search'
        : name === 'web.read:extract'
          ? 'web.extract'
          : name,
    ),
    context: async () => 'Stored healer request',
  };
  const unregister = f.pi.registerProfile(base);
  const web = webTools({
    reads: true,
    search: async (_caller, input) => ({ query: input.query, results: [], result_count: 0 }),
    extract: async (_caller, input) => ({
      url: input.url,
      content: 'Provider documentation',
      section: false,
      status: 'success',
    }),
    close: () => {},
  });
  const old = Object.values(web.actions).map((action) =>
    f.tools.register({
      name: action.was![0]!,
      description: action.description,
      inputSchema: action.input,
      readOnly: web.readOnly,
      openWorld: action.openWorld,
      handler: action.handler,
    }),
  );
  const conversation = await f.pi.createProfiled(f.operator, {
    requestId: 'base-healer-v3',
    title: 'Stored healer',
    profile: { id: healer.id, version: 3, requestId: 'request_base_v3' },
  });
  const stored = await f.state.read((sql) =>
    sql.get<{ data_json: string }>(
      'SELECT data_json FROM pi_conversations WHERE id=?',
      conversation.id,
    ),
  );
  assert.equal(
    JSON.parse(stored!.data_json).profile.definitionHash,
    hashes['customer-experiments-healer@3'],
  );
  const frozen = await f.claimed(await f.send(conversation));
  assert.deepEqual(frozen.work.tools.map(({ name }) => name).sort(), ['web.extract', 'web.search']);
  await f.pi.begin(frozen.token, frozen.input);

  // Deployment reloads the profiles and retires the flat web tools while the turn is working.
  unregister();
  for (const profile of profiles)
    f.pi.registerProfile({ ...profile, context: async () => 'Stored healer request' });
  for (const dispose of old) await dispose();
  f.tools.noun(web.name, web);
  assert.equal((await f.pi.prompt(f.operator, conversation.id)).instructions, base.instructions);
  const call = (name: string, input: object) =>
    f.pi.tool(frozen.token, { ...frozen.input, name, input });
  assert.deepEqual(await call('web.search', { query: 'provider error' }), {
    query: 'provider error',
    results: [],
    result_count: 0,
  });
  assert.deepEqual(await call('web.extract', { url: 'https://example.com/docs' }), {
    url: 'https://example.com/docs',
    content: 'Provider documentation',
    section: false,
    status: 'success',
  });
  await f.pi.complete(frozen.token, f.completion(frozen.input));

  // The same stored binding can claim another turn with its grants translated to the noun.
  const command = await f.send(conversation);
  const { work } = await f.pi.next(frozen.token, { workerId: 'worker_1' });
  assert.ok(work);
  assert.equal(work.command.id, command.id);
  assert.deepEqual(
    work.tools.map(({ name }) => name),
    ['web.read'],
  );
  const next = { ...frozen.input, commandId: command.id };
  await f.pi.begin(frozen.token, next);
  assert.deepEqual(
    await f.pi.tool(frozen.token, {
      ...next,
      name: 'web.read',
      input: { action: 'search', search: { query: 'provider error' } },
    }),
    { query: 'provider error', results: [], result_count: 0 },
  );
  await f.pi.complete(frozen.token, f.completion(next));
});

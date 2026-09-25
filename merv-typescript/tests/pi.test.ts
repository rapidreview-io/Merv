import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test, { type TestContext } from 'node:test';
import { z } from 'zod';
import {
  check,
  MervError,
  recorded,
  type Caller,
  type HumanPrincipal,
  type Permission,
  type Role,
} from '@merv/contracts';
import { PiHttp } from '../packages/pi/src/api.js';
import { PiModelRelay } from '../packages/pi/src/relay.js';
import { PiService, type PiConfig } from '../packages/pi/src/index.js';
import { messageChars } from '../packages/pi/src/limits.js';
import type { PiBootstrap, PiStage } from '../packages/pi/src/types.js';
import { countWrites } from './fixtures/state.js';
import { checkpointTree, code, fixture, models, sha, type PiFixture } from './fixtures/pi.js';

test('opening is idempotent without allocating Fleet capacity or creating a task', async (t) => {
  const f = await fixture(t);
  const conversation = await f.pi.create(f.operator, { requestId: 'same', title: 'Research' });
  assert.deepEqual(
    await f.pi.create(f.operator, { requestId: 'same', title: 'Research' }),
    conversation,
  );
  await assert.rejects(
    f.pi.create(f.operator, { requestId: 'same', title: 'Changed' }),
    code('pi_request_conflict'),
  );
  assert.deepEqual(Object.keys(conversation).sort(), [
    'activeCommandId',
    'checkpoint',
    'createdAt',
    'id',
    'model',
    'previousCheckpoint',
    'projectId',
    'revision',
    'title',
    'updatedAt',
    'userId',
  ]);
  assert.deepEqual(await f.fleet.list(f.hostCaller), []);
  assert.deepEqual(await f.hosts(), []);
  assert.equal((await f.pi.list(f.operator)).length, 1);
  assert.equal((await f.pi.snapshot(f.operator, conversation.id)).commands.length, 0);
  assert.equal(
    (
      await f.state.read((sql) =>
        sql.get<{ name: string | null }>("SELECT to_regclass('tasks')::text AS name"),
      )
    )?.name,
    null,
  );
});

test('a model catalog Pi cannot use is refused at start, naming the field, and by the render first', async (t) => {
  const f = await fixture(t);
  // The render's dry run makes the same checks, so it catches a catalog that would stop Main.
  const { piModels } = await import('../deploy/schema.mjs');
  assert.deepEqual(piModels(models, 'MERV_PI_MODELS'), models);
  const [luna] = models;
  for (const [catalog, at] of [
    [[{ ...luna, id: '-luna' }], 'models.0.id'],
    [[luna, luna], 'models'],
    [Array.from({ length: 9 }, (_, index) => ({ ...luna, id: `model-${index}` })), 'models'],
    [[{ ...luna, outputUsdPerM: undefined }], 'models.0.outputUsdPerM'],
    [[{ ...luna, effort: 'high' }], 'models.0.effort'],
    [[{ ...luna, provider: 'openai' }], 'models.0'],
    [[{ ...luna, label: 'GPT-6 Luna, the everyday one' }], 'models.0.label'],
  ] as const) {
    assert.throws(
      () =>
        new PiService(f.state, f.scope, f.fleet, f.tools, f.blobs, {
          models: catalog,
        } as unknown as PiConfig),
      (error: MervError) =>
        error.code === 'pi_configuration' &&
        error.status === 503 &&
        error.message === `Invalid Pi configuration at ${at}`,
    );
    assert.throws(() => piModels(catalog, 'MERV_PI_MODELS'), /MERV_PI_MODELS/);
  }
});

test('send commits a command, its host and the Fleet request atomically, deduplicates, and serializes turns', async (t) => {
  const f = await fixture(t);
  const first = await f.create();
  const second = await f.create();
  const original = f.fleet.request.bind(f.fleet);
  f.fleet.request = async (...args) => {
    await original(...args);
    throw new Error('failed after Fleet request');
  };
  try {
    await assert.rejects(
      f.pi.send(f.operator, first.id, { commandId: 'rollback', text: 'once' }),
      /failed after Fleet request/,
    );
  } finally {
    f.fleet.request = original;
  }
  assert.equal((await f.pi.snapshot(f.operator, first.id)).commands.length, 0);
  assert.deepEqual(await f.fleet.list(f.hostCaller), []);
  assert.deepEqual(await f.hosts(), []);
  const [one, two] = await Promise.allSettled([
    f.pi.send(f.operator, first.id, { commandId: 'a', text: 'first' }),
    f.pi.send(f.operator, first.id, { commandId: 'b', text: 'second' }),
  ]);
  assert.equal([one, two].filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(
    [one, two].filter(
      (result) => result.status === 'rejected' && code('pi_turn_busy')(result.reason),
    ).length,
    1,
  );
  const accepted =
    one.status === 'fulfilled'
      ? one.value
      : (two as PromiseFulfilledResult<Awaited<ReturnType<typeof f.pi.send>>>).value;
  assert.deepEqual(
    await f.pi.send(f.operator, first.id, {
      commandId: accepted.id,
      text: accepted.messages[0].text,
    }),
    accepted,
  );
  await assert.rejects(
    f.pi.send(f.operator, first.id, { commandId: accepted.id, text: 'changed' }),
    code('pi_command_conflict'),
  );
  // The person's other conversation here shares the machine: no second request, no retry.
  const other = await f.send(second);
  assert.deepEqual(
    [other.hostId, other.runtimeId, other.machine],
    [accepted.hostId, accepted.runtimeId, 'standard'],
  );
  assert.equal((await f.fleet.list(f.hostCaller)).length, 1);
});

test('a send after the idle timeout ends that host and starts a fresh one at once', async (t) => {
  const f = await fixture(t);
  const conversation = await f.create();
  const bound = await f.claimed(await f.send(conversation));
  await f.finish(bound);
  f.advance(5_000);
  const next = await f.send(conversation);
  assert.notEqual(next.hostId, bound.work.command.hostId);
  assert.notEqual(next.runtimeId, bound.work.command.runtimeId);
  assert.equal((await f.allocation(bound.work.command.runtimeId)).intent, 'stop');
  assert.equal((await f.host(bound.work.command)).ended?.reason, 'idle');
  assert.equal(next.status, 'waiting');
});

test('each send carries the person’s current role; a removed member is refused', async (t) => {
  const f = await fixture(t);
  const login = (subject: string) =>
    f.scope.acceptVerifiedIdentity({
      issuer: 'https://identity.example/auth/v1',
      subject,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
  const alice = await login('alice');
  const bob = await login('bob');
  const project = await f.scope.createProject(alice, { name: 'Humans', requestId: 'humans' });
  await f.scope.addMember(alice, project.id, { subject: 'bob', role: 'producer' });
  const producer = await f.scope.caller(bob, project.id);
  const conversation = await f.create(producer);
  const bound = await f.claimed(await f.send(conversation, 'hello', producer));
  await f.finish(bound);
  await f.scope.changeMemberRole(alice, project.id, { subject: 'bob', role: 'reader' });
  const reader = await f.scope.caller(bob, project.id);
  const command = await f.pi.send(reader, conversation.id, { commandId: 'after', text: 'here' });
  // The machine is the host's, so it stays; the turn reads as the reader now.
  assert.equal(command.runtimeId, bound.work.command.runtimeId);
  const record = await f.state.read((sql) =>
    sql.get<{ data_json: string }>(
      'SELECT data_json FROM pi_conversations WHERE id=?',
      conversation.id,
    ),
  );
  assert.deepEqual(JSON.parse(record!.data_json).source, await f.scope.delegationSource(reader));
  await f.scope.removeMember(alice, project.id, 'bob');
  await assert.rejects(
    f.pi.send(reader, conversation.id, { commandId: 'removed', text: 'hello' }),
    code('membership_required'),
  );
});

test('conversations list most recently updated first', async (t) => {
  const f = await fixture(t);
  const opened = [];
  for (let index = 0; index < 4; index++) {
    f.advance(1000);
    opened.push(await f.create());
  }
  const ids = async () => (await f.pi.list(f.operator)).map((conversation) => conversation.id);
  assert.deepEqual(await ids(), opened.map((conversation) => conversation.id).reverse());
  f.advance(1000);
  await f.send(opened[0]);
  assert.deepEqual(
    await ids(),
    [opened[0], ...opened.slice(1).reverse()].map(({ id }) => id),
  );
});

/** The provider behind the relay as Pi's naming call meets it: every request it was sent. */
function provider(t: TestContext, reply: () => Promise<Response>) {
  const asked: Record<string, unknown>[] = [];
  const { fetch: original } = globalThis;
  const key = process.env.MERV_PI_MODEL_API_KEY;
  process.env.MERV_PI_MODEL_API_KEY = 'title-test-key';
  globalThis.fetch = (async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer title-test-key');
    asked.push(JSON.parse(String(init?.body)));
    return reply();
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
    if (key === undefined) delete process.env.MERV_PI_MODEL_API_KEY;
    else process.env.MERV_PI_MODEL_API_KEY = key;
  });
  return asked;
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('Pi names a new conversation from its first exchange, once, without holding up the turn', async (t) => {
  const f = await fixture(t);
  let answer!: () => void;
  const answered = new Promise<void>((resolve) => (answer = resolve));
  const asked = provider(t, async () => {
    await answered;
    return Response.json({
      output: [
        { type: 'reasoning', summary: [] },
        {
          type: 'message',
          content: [{ type: 'output_text', text: '"**Protein folding** basics."\n' }],
        },
      ],
    });
  });
  const conversation = await f.pi.create(f.operator, { requestId: 'unnamed' });
  assert.equal(conversation.title, 'New conversation');
  const first = await f.claimed(
    await f.send(conversation, `How do proteins fold? ${'x'.repeat(3000)}`),
  );
  await f.pi.begin(first.token, first.input);
  // The turn is saved while the naming call is still out.
  assert.deepEqual(await f.pi.complete(first.token, f.completion(first.input)), { saved: true });
  const title = async () => (await f.pi.snapshot(f.operator, conversation.id)).conversation.title;
  assert.equal(await title(), 'New conversation');
  answer();
  for (let wait = 0; wait < 100 && (await title()) === 'New conversation'; wait++) await pause(10);
  assert.equal(await title(), 'Protein folding basics');
  assert.equal(asked.length, 1);
  assert.equal(asked[0].model, 'gpt-6-luna');
  assert.equal(asked[0].max_output_tokens, 24);
  assert.equal(asked[0].tools, undefined);
  assert.match(String(asked[0].input), /^User: How do proteins fold\?/);
  assert.ok(String(asked[0].input).length < 2100);
  await f.send(conversation, 'And misfolding?');
  const next = (await f.pi.next(first.token, { workerId: 'worker_2' })).work;
  const input = {
    conversationId: conversation.id,
    commandId: next!.command.id,
    workerId: 'worker_2',
  };
  await f.pi.begin(first.token, input);
  const again = f.completion(input, checkpointTree('second'));
  assert.deepEqual(await f.pi.complete(first.token, again), { saved: true });
  await pause(20);
  assert.equal(asked.length, 1);
  assert.equal(await title(), 'Protein folding basics');
});

test('a naming call that fails keeps the default title, and the turn is saved regardless', async (t) => {
  const f = await fixture(t);
  const asked = provider(t, async () =>
    Response.json(
      { output: [{ type: 'message', content: [{ type: 'output_text', text: 'Unused' }] }] },
      { status: 503 },
    ),
  );
  const conversation = await f.pi.create(f.operator, { requestId: 'unnamed' });
  const bound = await f.claimed(await f.send(conversation));
  assert.deepEqual(await f.finish(bound), { saved: true });
  await pause(20);
  const snapshot = await f.pi.snapshot(f.operator, conversation.id);
  assert.equal(asked.length, 1);
  assert.equal(snapshot.conversation.title, 'New conversation');
  assert.equal(snapshot.commands[0].status, 'completed');
});

test('concurrent sends to separate conversations share one host and one machine', async (t) => {
  const f = await fixture(t);
  const left = await f.create();
  const right = await f.create();
  const [one, two] = await Promise.all([f.send(left), f.send(right)]);
  assert.equal(one.hostId, two.hostId);
  assert.equal(one.runtimeId, two.runtimeId);
  assert.equal((await f.fleet.list(f.hostCaller)).length, 1);
  assert.equal((await f.hosts()).length, 1);
});

/** A project a signed-in operator made, with a member of every role signed in, holding a user key
 * and represented by an actor credential: every kind of source a conversation can have. */
async function sources(f: PiFixture) {
  const login = (subject: string) =>
    f.scope.acceptVerifiedIdentity({
      issuer: 'https://identity.example/auth/v1',
      subject,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
  const principals = {
    operator: await login('olive'),
    producer: await login('pat'),
    reviewer: await login('rae'),
    reader: await login('reid'),
  };
  const project = await f.scope.createProject(principals.operator, {
    name: 'Sources',
    requestId: 'sources',
  });
  for (const [role, principal] of Object.entries(principals))
    if (role !== 'operator')
      await f.scope.addMember(principals.operator, project.id, {
        subject: principal.user.subject,
        role: role as Role,
      });
  const admin = await f.scope.caller(principals.operator, project.id);
  const all: { kind: string; role: Role; caller: Caller }[] = [];
  for (const [role, principal] of Object.entries(principals) as [Role, HumanPrincipal][]) {
    all.push({ kind: 'human', role, caller: await f.scope.caller(principal, project.id) });
    const { token } = await f.scope.createKey(principal, { projectId: project.id });
    const key = await f.scope.caller({ kind: 'key', key: await f.scope.authenticateKey(token) });
    all.push({ kind: 'key', role, caller: { ...key, projectId: project.id } });
    const issued = await f.scope.issueActor(admin, { name: `${role} robot`, role });
    all.push({
      kind: 'actor',
      role,
      caller: {
        projectId: project.id,
        actorId: issued.actor.id,
        credentialId: issued.credential.id,
      },
    });
  }
  return { project, principals, admin, all };
}

/** Tools that each need one permission and count their runs, with the flags a registration can
 * carry. */
function probes(f: PiFixture, t: TestContext) {
  const runs: Record<string, number> = {};
  const probe = (
    name: string,
    permission: Permission,
    options: {
      readOnly?: boolean;
      conversation?: 'never' | 'propose' | 'secret';
      result?: unknown;
    } = {},
  ) =>
    t.after(
      f.tools.register({
        name,
        description: `Probe ${name}`,
        readOnly: options.readOnly,
        conversation: options.conversation,
        inputSchema: z.object({}).strict(),
        handler: (caller: Caller) =>
          f.state.transaction(async (tx) => {
            await f.scope.require(caller, permission, tx);
            runs[name] = (runs[name] ?? 0) + 1;
            if (permission !== 'read') await recorded(f.state, tx, caller, name, 'probe', {});
            return options.result ?? { ran: name };
          }),
      }),
    );
  probe('probe.read', 'read', { readOnly: true });
  probe('probe.write', 'write');
  probe('probe.review', 'review');
  probe('probe.admin', 'admin');
  probe('probe.propose', 'write', { conversation: 'propose' });
  probe('probe.secret', 'admin', { conversation: 'secret', result: { token: 'secret' } });
  probe('probe.leaky', 'read', { readOnly: true, result: { issued: [{ token: 'secret' }] } });
  probe('probe.never', 'read', { readOnly: true, conversation: 'never' });
  probe('pi.probe', 'read', { readOnly: true });
  return runs;
}

test('the agent has exactly its person’s permissions, never more', async (t) => {
  const f = await fixture(t, { machines: 16 });
  const runs = probes(f, t);
  t.after(
    f.tools.register({
      name: 'actor.credentials',
      description: 'Read credential metadata',
      readOnly: true,
      inputSchema: z.object({ actorId: z.string().min(1).optional() }).strict(),
      handler: (caller: Caller, input: { actorId?: string }) =>
        f.scope.actorCredentials(caller, input.actorId),
    }),
  );
  const { all, admin } = await sources(f);
  const someone = await f.scope.issueActor(admin, { name: 'Someone', role: 'reader' });
  const reads = ['actor.credentials', 'probe.leaky', 'probe.read', 'project.get', 'shell.run'];
  const writes = ['probe.admin', 'probe.propose', 'probe.review', 'probe.secret', 'probe.write'];
  for (const { kind, role, caller } of all) {
    const label = `${kind} ${role}`;
    const { token, work, input } = await f.begun(caller);
    const offered = work.tools.map(({ name }) => name).filter((name) => name !== 'machine.switch');
    assert.deepEqual(
      offered,
      [...reads, ...(role === 'reader' ? [] : [...writes, 'task.create'])].sort(),
      label,
    );
    const agent = (name: string, value: object = {}) =>
      f.pi.tool(token, { ...input, name, input: value });
    for (const name of ['probe.read', 'probe.write', 'probe.review', 'probe.admin']) {
      const before = runs[name] ?? 0;
      const direct = await f.tools.call(name, caller, {}).then(
        () => true,
        (error) => (assert.equal(error.code, 'forbidden', label), false),
      );
      const via = offered.includes(name)
        ? await agent(name)
        : await assert.rejects(agent(name), code('pi_tool_forbidden'));
      if (direct) assert.deepEqual(via, { ran: name }, `${label} ${name}`);
      else if (offered.includes(name))
        assert.equal((via as { error: { code: string } }).error.code, 'forbidden', label);
      assert.equal(runs[name] ?? 0, before + (direct ? 2 : 0), `${label} ${name}`);
    }
    assert.equal((await f.pi.snapshot(caller, input.conversationId)).commands[0].status, 'working');
    assert.equal(
      ((await agent('probe.leaky')) as { error: { code: string } }).error.code,
      'tool_result_secret',
    );
    for (const name of ['probe.never', 'pi.probe', '_remote.read', 'task.list'])
      await assert.rejects(agent(name), code('pi_tool_forbidden'), `${label} ${name}`);
    // The real actor tools: only an operator reads another actor's credentials, and never
    // through a key, directly or through the agent.
    // What only the person may run is proposed, never run; Run runs it as them, with exactly the
    // outcome of their own direct call.
    const proposed: string[] = [];
    if (role !== 'reader')
      for (const name of ['probe.propose', 'probe.secret']) {
        const reply = (await agent(name)) as { proposed: { id: string; name: string } };
        assert.equal(reply.proposed.name, name, label);
        proposed.push(reply.proposed.id);
      }
    const other = { actorId: someone.actor.id };
    const allowed = role === 'operator' && kind !== 'key';
    const direct = await f.tools.call('actor.credentials', caller, other).then(
      () => true,
      () => false,
    );
    const via = (await agent('actor.credentials', other)) as { error?: { code: string } };
    assert.deepEqual([direct, !via.error], [allowed, allowed], label);
    for (const name of ['probe.propose', 'probe.secret', 'probe.never', 'pi.probe'])
      assert.equal(runs[name], undefined);
    await f.pi.complete(token, f.completion(input));
    for (const [index, proposalId] of proposed.entries()) {
      const name = ['probe.propose', 'probe.secret'][index];
      const direct = await f.tools.call(name, caller, {}).then(
        () => true,
        () => false,
      );
      const ran = await f.pi
        .run(caller, { id: input.conversationId, commandId: input.commandId, proposalId })
        .then(
          () => true,
          (error) => (assert.equal(error.code, 'forbidden', label), false),
        );
      assert.equal(ran, direct, `${label} ${name}`);
      delete runs[name];
    }
  }
  assert.equal(f.mutations, 0);
});

test('a write runs as the person and is recorded as the agent’s', async (t) => {
  const f = await fixture(t);
  probes(f, t);
  const { all } = await sources(f);
  const producer = all.find(({ kind, role }) => kind === 'human' && role === 'producer')!.caller;
  const { token, work, input } = await f.begun(producer);
  assert.deepEqual(await f.pi.tool(token, { ...input, name: 'probe.write', input: {} }), {
    ran: 'probe.write',
  });
  const [event] = (await f.state.events(producer.projectId)).filter(
    ({ type }) => type === 'probe.write',
  );
  assert.equal(event.actorId, producer.actorId);
  assert.deepEqual(event.data.source, {
    kind: 'conversation',
    conversationId: input.conversationId,
    commandId: input.commandId,
  });
  const agent: Caller = {
    actorId: producer.actorId,
    projectId: producer.projectId,
    conversation: {
      id: input.conversationId,
      commandId: input.commandId,
      runtimeId: work.command.runtimeId,
      epoch: work.command.epoch,
    },
  };
  assert.deepEqual(await f.scope.delegationSource(agent), await f.scope.delegationSource(producer));
  const grant = await f.pi.authorizeModel(work.modelToken);
  assert.ok(grant.toolNames.includes('probe_write'));
  const result = f.completion(input);
  result.outcomes = [
    { callId: 'write_1', name: 'probe.write', input: {}, output: { ran: 'probe.write' } },
  ];
  assert.deepEqual(await f.pi.complete(token, result), { saved: true });
  assert.deepEqual(
    (await f.pi.snapshot(producer, input.conversationId)).commands[0].outcomes,
    result.outcomes,
  );
});

test('a role change ends the running turn, the next offers the new role’s tools, and the host project has no agent', async (t) => {
  const f = await fixture(t);
  probes(f, t);
  const { all, principals, project } = await sources(f);
  const producer = all.find(({ kind, role }) => kind === 'human' && role === 'producer')!.caller;
  const { token, input } = await f.begun(producer);
  await f.scope.changeMemberRole(principals.operator, project.id, {
    subject: principals.producer.user.subject,
    role: 'reader',
  });
  await assert.rejects(
    f.pi.tool(token, { ...input, name: 'probe.read', input: {} }),
    code('pi_authority_stale'),
  );
  const reader = await f.scope.caller(principals.producer, project.id);
  await f.pi.stop(reader, input.conversationId);
  const next = await f.pi.send(reader, input.conversationId, { commandId: 'after', text: 'now' });
  const { work } = await f.pi.next(token, { workerId: 'worker_1' });
  assert.equal(work?.command.id, next.id);
  assert.ok(work!.tools.every(({ readOnly }) => readOnly));
  assert.ok(work!.tools.some(({ name }) => name === 'probe.read'));
  await assert.rejects(
    f.pi.create(f.hostCaller, { requestId: 'host', title: 'Chat' }),
    code('pi_forbidden'),
  );
});

test('the hand-off: the agent proposes, the person runs it once as themselves, and a secret stays theirs', async (t) => {
  const f = await fixture(t);
  const runs = probes(f, t);
  // A gate only a signed-in person passes, as code.publication.merge and workflow.extend_limit keep.
  t.after(
    f.tools.register({
      name: 'probe.signed',
      description: 'Signed-in person only',
      conversation: 'propose',
      inputSchema: z.object({ note: z.string().optional() }).strict(),
      handler: (caller: Caller) => {
        check(caller.human && !caller.key, 'forbidden', 'A signed-in person must do this', 403);
        return { signed: true };
      },
    }),
  );
  const { all } = await sources(f);
  const human = all.find(({ kind, role }) => kind === 'human' && role === 'operator')!.caller;
  const key = all.find(({ kind, role }) => kind === 'key' && role === 'operator')!.caller;
  const turn = await f.begun(human);
  const agent = (name: string, value: object = {}) =>
    f.pi.tool(turn.token, { ...turn.input, name, input: value });
  const ids: string[] = [];
  for (let index = 0; index < 16; index++)
    ids.push(
      ((await agent(index ? 'probe.signed' : 'probe.secret')) as { proposed: { id: string } })
        .proposed.id,
    );
  assert.deepEqual(
    ((await agent('probe.signed')) as { error: { code: string } }).error.code,
    'too_many_proposals',
  );
  assert.equal(
    ((await agent('probe.signed', { note: 7 })) as { error: { code: string } }).error.code,
    'invalid_input',
  );
  const run = (caller: Caller, proposalId: string, commandId = turn.input.commandId) =>
    f.pi.run(caller, { id: turn.input.conversationId, commandId, proposalId });
  await assert.rejects(run(human, ids[1]), code('pi_turn_busy'));
  const conversationCaller: Caller = {
    actorId: human.actorId,
    projectId: human.projectId,
    conversation: {
      id: turn.input.conversationId,
      commandId: turn.input.commandId,
      runtimeId: turn.work.command.runtimeId,
      epoch: turn.work.command.epoch,
    },
  };
  await assert.rejects(run(conversationCaller, ids[1]), code('pi_forbidden'));
  const result = f.completion(turn.input);
  result.outcomes = [
    { callId: 'propose_1', name: 'probe.secret', input: {}, output: { proposed: {} } },
  ];
  await f.pi.complete(turn.token, result);
  assert.deepEqual(await run(human, ids[0]), { result: { token: 'secret' } });
  assert.equal(runs['probe.secret'], 1);
  await assert.rejects(run(human, ids[0]), code('pi_proposal_ran'));
  assert.equal(runs['probe.secret'], 1);
  await assert.rejects(run(human, 'pip_missing'), code('pi_not_found'));
  // The signed-in gate passes when the person presses Run, and fails through their key.
  assert.deepEqual(await run(human, ids[1]), { result: { signed: true } });
  const keyTurn = await f.begun(key);
  await f.pi.tool(keyTurn.token, { ...keyTurn.input, name: 'probe.signed', input: {} });
  await f.pi.complete(keyTurn.token, f.completion(keyTurn.input));
  const [keyProposal] = (await f.pi.snapshot(key, keyTurn.input.conversationId)).commands[0]
    .proposals!;
  await assert.rejects(
    f.pi.run(key, {
      id: keyTurn.input.conversationId,
      commandId: keyTurn.input.commandId,
      proposalId: keyProposal.id,
    }),
    code('forbidden'),
  );
  const shown = (await f.pi.snapshot(human, turn.input.conversationId)).commands[0];
  assert.deepEqual(
    shown.proposals!.slice(0, 2).map(({ name, secret, ran }) => [name, secret, ran?.ok]),
    [
      ['probe.secret', true, true],
      ['probe.signed', undefined, true],
    ],
  );
  // Nothing keeps a secret result: not the command, its outcomes or its messages.
  assert.ok(!JSON.stringify(shown).includes('"token":"secret"'));
  const stored = await f.state.read((sql) =>
    sql.all<{ data_json: string }>('SELECT data_json FROM pi_commands'),
  );
  assert.ok(stored.every(({ data_json }) => !data_json.includes('"token":"secret"')));
});

test('a Fleet halt the person runs from a proposal is recorded as theirs', async (t) => {
  const f = await fixture(t);
  t.after(
    f.fleet.registerOwner('workflow', {
      valid: async () => true,
      bootstrap: async () => '',
      observe: async () => 'running',
    }),
  );
  t.after(
    f.tools.register({
      name: 'fleet.halt',
      description: 'Halt an allocation',
      conversation: 'propose',
      inputSchema: z.object({ id: z.string() }).strict(),
      handler: (caller: Caller, input: { id: string }) => f.fleet.cancel(caller, input.id),
    }),
  );
  const { all } = await sources(f);
  const human = all.find(({ kind, role }) => kind === 'human' && role === 'operator')!.caller;
  const robot = all.find(({ kind, role }) => kind === 'actor' && role === 'producer')!.caller;
  const allocation = await f.fleet.request(robot, {
    requestId: 'robot_work',
    owner: { kind: 'workflow', id: 'robot_work' },
  });
  const turn = await f.begun(human);
  const { proposed } = (await f.pi.tool(turn.token, {
    ...turn.input,
    name: 'fleet.halt',
    input: { id: allocation.id },
  })) as { proposed: { id: string } };
  await f.pi.complete(turn.token, f.completion(turn.input));
  await f.pi.run(human, {
    id: turn.input.conversationId,
    commandId: turn.input.commandId,
    proposalId: proposed.id,
  });
  const halted = (await f.state.events(human.projectId)).filter(
    ({ type, subjectId }) => type === 'fleet.changed' && subjectId === allocation.id,
  );
  assert.equal(halted.at(-1)?.actorId, human.actorId);
  assert.equal(halted.at(-1)?.data.intent, 'stop');
});

test('each turn says whom the agent serves, where, on what, what the project lacks, and what a stopped answer made', async (t) => {
  const f = await fixture(t);
  probes(f, t);
  t.after(
    f.tools.register({
      name: 'paper.read',
      description: 'Read the paper',
      readOnly: true,
      inputSchema: z.object({ kind: z.string().optional() }).strict(),
      handler: () => ({
        current: {
          sections: [
            { id: 'problem', content: 'Why proteins misfold' },
            { id: 'scope', content: '  ' },
            { id: 'goals', content: 'A model' },
            { id: 'constraints', content: 'None' },
          ],
        },
      }),
    }),
  );
  const { all, project } = await sources(f);
  const producer = all.find(({ kind, role }) => kind === 'human' && role === 'producer')!.caller;
  const reviewer = all.find(({ kind, role }) => kind === 'human' && role === 'reviewer')!.caller;
  const first = await f.begun(producer);
  assert.deepEqual(first.work.notes.slice(0, 5), [
    'Model: you are GPT-6 Luna (gpt-6-luna). Earlier answers in this conversation may come from other models the person picked; if asked which model you are, say GPT-6 Luna.',
    `You serve ${producer.actorId}, a producer in project ${project.id}: they, and so you, can read everything and create and change work, but not review it or administer the project. actor.whoami and project.get name them.`,
    'Today is 2026-09-23 (UTC).',
    'Empty Problem sections: scope.',
    'The Introduction is empty.',
  ]);
  assert.match(first.work.notes[5], /^Machine: Standard/);
  assert.match(first.work.instructions!, /^You are this person's own agent in Merv/);
  assert.match(first.work.instructions!, /never call yourself ChatGPT/);
  // The agent writes, then its answer is stopped: the next turn says what it had made.
  await f.pi.tool(first.token, { ...first.input, name: 'probe.write', input: {} });
  await f.pi.stop(producer, first.input.conversationId);
  await f.pi.send(producer, first.input.conversationId, { commandId: 'again', text: 'Go on' });
  const { work } = await f.pi.next(first.token, { workerId: 'worker_1' });
  assert.equal(
    work!.notes[5],
    'Your previous answer here stopped before it finished, after it had made: probe.write probe',
  );
  assert.equal(work!.instructions, first.work.instructions);
  // A reviewer writes no paper: no Problem or Introduction line.
  const other = await f.begun(reviewer);
  assert.deepEqual(
    other.work.notes.filter((note) => /Problem|Introduction/.test(note)),
    [],
  );
  assert.match(other.work.notes[1], /a reviewer in project/);
});

test('recoverable tool failures and oversized results come back to the model as results', async (t) => {
  const f = await fixture(t);
  const content = 'line "quoted"\n'.repeat(12_000);
  const register = (name: string, handler: (input: Record<string, unknown>) => unknown) =>
    t.after(
      f.tools.register({
        name,
        description: name,
        readOnly: true,
        inputSchema: z.record(z.unknown()),
        handler: (_caller: Caller, input: Record<string, unknown>) => handler(input),
      }),
    );
  register('artifact.read', ({ artifactId }) => {
    check(String(artifactId).startsWith('art_b'), 'not_found', 'Artifact not found', 404);
    return artifactId === 'art_big'
      ? {
          artifact: { id: 'art_big' },
          content: content.slice(100),
          encoding: 'utf8',
          offset: 100,
          total: content.length,
        }
      : { artifact: { id: 'art_bin' }, content: 'AAAA'.repeat(10), encoding: 'base64' };
  });
  const tasks = (count: number, goal?: string) =>
    Array.from({ length: count }, (_, index) => ({
      id: `task_${index}`,
      title: `T${index}`,
      status: 'open',
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, count - index)).toISOString(),
      ...(goal && { goal }),
      deliverables: [{ text: 'd'.repeat(500) }],
    }));
  register('task.list', ({ count, goal }) => ({ tasks: tasks(Number(count), goal as string) }));
  register('project.records', () => ({ note: 'x'.repeat(100_000) }));
  register('refused.forbidden', () => {
    throw new MervError('forbidden', 'Actor lacks write permission', 403, { need: 'write' });
  });
  register('refused.conflict', () => {
    throw new MervError('task_conflict', 'Task changed; reread it', 409);
  });
  register('refused.crash', () => {
    throw new Error('private stack details');
  });
  const conversation = await f.create();
  const { token, input } = await f.claimed(await f.send(conversation));
  await f.pi.begin(token, input);
  const call = (name: string, value: object = {}) =>
    f.pi.tool(token, { ...input, name, input: value });
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  assert.deepEqual(await call('artifact.read', { artifactId: 'art_missing' }), {
    error: { code: 'not_found', message: 'Artifact not found' },
  });
  // A long text keeps its start and says where to read on.
  const text = (await call('artifact.read', { artifactId: 'art_big' })) as {
    content: string;
    note: string;
  };
  assert.ok(bytes(text) <= 32_000 && text.content.length > 20_000);
  assert.ok(content.slice(100).startsWith(text.content));
  const end = 100 + text.content.length;
  assert.equal(
    text.note,
    `Characters 100–${end} of ${content.length} are shown; read on with offset ${end}`,
  );
  // Bytes are never shown.
  assert.deepEqual(await call('artifact.read', { artifactId: 'art_bin' }), {
    artifact: { id: 'art_bin' },
    encoding: 'base64',
    note: 'Binary content (30 bytes) is not shown',
  });
  // 340 records come back as an index of every one; more than that fits keeps the newest.
  const listed = (await call('task.list', { count: 340 })) as {
    index: { tasks: { id: string; goal: string; deliverables?: unknown }[] };
    note: string;
  };
  assert.equal(listed.note, 'Shown as an index: read one record with its get tool');
  assert.deepEqual(
    listed.index.tasks.map(({ id }) => id),
    tasks(340).map(({ id }) => id),
  );
  assert.equal(listed.index.tasks[0].deliverables, undefined);
  const clipped = (await call('task.list', { count: 60, goal: 'y'.repeat(400) })) as typeof listed;
  assert.equal(clipped.index.tasks[0].goal, `${'y'.repeat(300)}…`);
  const newest = (await call('task.list', { count: 2000 })) as typeof listed;
  const shown = newest.index.tasks.length;
  assert.ok(bytes(newest) <= 32_000 && shown > 100 && shown < 2000);
  assert.deepEqual(newest.index.tasks[0].id, 'task_0');
  assert.equal(
    newest.note,
    `Shown as an index: read one record with its get tool. tasks: ${shown} of 2000 shown, newest`,
  );
  const partial = (await call('project.records')) as { partial: string; truncated: string };
  assert.ok(bytes(partial) <= 32_000 && partial.partial.startsWith('{"note":"xxx'));
  assert.match(partial.truncated, /^Only the first \d+ of 100011 bytes are shown$/);
  // A refusal of any kind is the model's to explain, and the turn goes on.
  assert.deepEqual(await call('refused.forbidden'), {
    error: {
      code: 'forbidden',
      message: 'Actor lacks write permission',
      details: { need: 'write' },
    },
  });
  assert.deepEqual(await call('refused.conflict'), {
    error: { code: 'task_conflict', message: 'Task changed; reread it' },
  });
  assert.deepEqual(await call('refused.crash'), {
    error: { code: 'tool_failed', message: 'The tool failed unexpectedly' },
  });
  assert.equal((await f.pi.snapshot(f.operator, conversation.id)).commands[0].status, 'working');
  // Once the turn stops, a failing call ends with it.
  await f.pi.stop(f.operator, conversation.id);
  await assert.rejects(call('refused.conflict'), code('pi_command_stale'));
});

test('a call already refused in the turn is not run again: the model is told to change it or answer', async (t) => {
  const f = await fixture(t);
  let runs = 0;
  t.after(
    f.tools.register({
      name: 'experiment.create',
      description: 'Create an experiment',
      inputSchema: z.record(z.unknown()),
      handler: (_caller: Caller, input: Record<string, unknown>) => {
        runs++;
        check(!input.baseTaskId, 'invalid_workspace', 'baseTaskId is only for workspace "git"');
        check(!input.busy, 'experiment_conflict', 'Changed; reread it', 409);
        check(!input.missing, 'not_found', 'No such base', 404);
        return { id: 'exp_1' };
      },
    }),
  );
  t.after(
    f.tools.register({
      name: 'research.end',
      description: 'End a cycle',
      conversation: 'propose',
      inputSchema: z.object({ id: z.string() }).strict(),
      handler: () => ({}),
    }),
  );
  const { token, input } = await f.claimed(await f.send(await f.create()));
  await f.pi.begin(token, input);
  const call = (value: object) =>
    f.pi.tool(token, { ...input, name: 'experiment.create', input: value });
  const refusal = { code: 'invalid_workspace', message: 'baseTaskId is only for workspace "git"' };
  assert.deepEqual(await call({ baseTaskId: 'x', title: 'A' }), { error: refusal });
  assert.deepEqual(await call({ title: 'A', baseTaskId: 'x' }), {
    error: {
      code: 'already_refused',
      message:
        'This exact call was already refused with invalid_workspace: change the input or answer the person',
    },
  });
  assert.equal(runs, 1);
  // Another input runs; a conflict may pass once reread, and what is missing may be made in the
  // same turn, so neither is held back.
  assert.deepEqual(await call({ title: 'A' }), { id: 'exp_1' });
  for (const value of [{ busy: true }, { busy: true }, { missing: true }, { missing: true }])
    await call(value);
  assert.equal(runs, 6);
  // A proposal's invalid input is held back the same way.
  const propose = () =>
    f.pi.tool(token, { ...input, name: 'research.end', input: { id: 'r', extra: 1 } });
  assert.equal(((await propose()) as { error: { code: string } }).error.code, 'invalid_input');
  assert.equal(((await propose()) as { error: { code: string } }).error.code, 'already_refused');
});

test('a finished turn whose tool outputs exceed the result limit keeps its answer', async (t) => {
  const f = await fixture(t);
  const conversation = await f.create();
  const bound = await f.claimed(await f.send(conversation));
  await f.pi.begin(bound.token, bound.input);
  const result = f.completion(bound.input);
  result.outcomes = [1, 2, 3].map((index) => ({
    callId: `read_${index}`,
    name: 'project.get',
    input: {},
    output: { text: '字'.repeat(40_000) },
  }));
  assert.deepEqual(await f.pi.complete(bound.token, result), { saved: true });
  const [command] = (await f.pi.snapshot(f.operator, conversation.id)).commands;
  assert.equal(command.status, 'completed');
  assert.deepEqual(command.messages.slice(1), result.messages);
  assert.deepEqual(
    command.outcomes.map((outcome) => outcome.output),
    [1, 2, 3].map(() => ({ omitted: true })),
  );
});

test('duplicate begin interrupts ambiguous prompts and fences worker/model tools', async (t) => {
  const f = await fixture(t);
  const conversation = await f.create();
  const { token, work, input } = await f.claimed(await f.send(conversation));
  // A claimed turn is never handed to another worker.
  assert.equal((await f.pi.next(token, { workerId: 'other_worker' })).work, null);
  assert.deepEqual(await f.pi.begin(token, input), { apply: true });
  assert.deepEqual(await f.pi.begin(token, input), { apply: false });
  assert.equal(
    (await f.pi.snapshot(f.operator, conversation.id)).commands[0].error,
    'ambiguous_prompt',
  );
  await assert.rejects(
    f.pi.progress(token, { ...input, events: [{ type: 'text', text: 'no' }] }),
    code('pi_command_stale'),
  );
  await assert.rejects(f.pi.authorizeModel(work.modelToken), code('pi_unauthorized'));
});

test('checkpoint save failure keeps canonical result and previous pointer; exact retry restores full bytes', async (t) => {
  const f = await fixture(t);
  const conversation = await f.create();
  const first = await f.claimed(await f.send(conversation));
  await f.pi.begin(first.token, first.input);
  const tree = checkpointTree('first', 'sibling');
  const completed = f.completion(first.input, tree);
  assert.deepEqual(await f.pi.complete(first.token, completed), { saved: true });
  const pointer = (await f.pi.snapshot(f.operator, conversation.id)).conversation.checkpoint;
  assert.deepEqual(pointer, {
    hash: sha(tree),
    size: Buffer.byteLength(tree),
    commandId: first.input.commandId,
  });
  assert.deepEqual(await f.pi.complete(first.token, completed), { saved: true });
  await assert.rejects(
    f.pi.complete(first.token, {
      ...completed,
      messages: [{ role: 'assistant', text: 'revised' }],
    }),
    code('pi_result_conflict'),
  );
  await f.send(conversation, 'next');
  const next = (await f.pi.next(first.token, { workerId: 'worker_2' })).work;
  assert.equal(next?.checkpoint?.content, tree);
  assert.equal(next?.checkpoint?.hash, sha(tree));
  const input = {
    conversationId: conversation.id,
    commandId: next!.command.id,
    workerId: 'worker_2',
  };
  await f.pi.begin(first.token, input);
  const newer = checkpointTree('second');
  const result = f.completion(input, newer);
  f.failStorage(true);
  assert.deepEqual(await f.pi.complete(first.token, result), { saved: false });
  let snapshot = await f.pi.snapshot(f.operator, conversation.id);
  assert.equal(snapshot.commands[1].status, 'saving');
  assert.deepEqual(snapshot.commands[1].messages, [
    { role: 'user', text: 'next' },
    ...result.messages,
  ]);
  assert.equal(snapshot.commands[1].error, 'checkpoint_unavailable');
  assert.deepEqual(snapshot.conversation.checkpoint, pointer);
  await assert.rejects(
    f.pi.complete(first.token, { ...result, messages: [{ role: 'assistant', text: 'different' }] }),
    code('pi_result_conflict'),
  );
  f.failStorage(false);
  assert.deepEqual(await f.pi.complete(first.token, result), { saved: true });
  snapshot = await f.pi.snapshot(f.operator, conversation.id);
  assert.equal(snapshot.commands[1].status, 'completed');
  assert.deepEqual(snapshot.conversation.previousCheckpoint, pointer);
  assert.deepEqual(
    await f.disk.get(f.operator.projectId, snapshot.conversation.checkpoint!.hash),
    Buffer.from(newer),
  );
  assert.deepEqual(await f.pi.complete(first.token, result), { saved: true });
});

test('rejects invalid checkpoint digest and corrupted stored bytes before delivery', async (t) => {
  const f = await fixture(t);
  const conversation = await f.create();
  const bound = await f.claimed(await f.send(conversation));
  await f.pi.begin(bound.token, bound.input);
  const result = f.completion(bound.input);
  await assert.rejects(
    f.pi.complete(bound.token, { ...result, checkpointHash: '0'.repeat(64) }),
    code('pi_checkpoint_invalid'),
  );
  assert.equal((await f.pi.snapshot(f.operator, conversation.id)).commands[0].status, 'working');
  const invalid = '{"tree":true}';
  await assert.rejects(
    f.pi.complete(bound.token, { ...result, checkpoint: invalid, checkpointHash: sha(invalid) }),
    code('pi_checkpoint_invalid'),
  );
  await f.pi.complete(bound.token, result);
  await f.send(conversation, 'restore');
  const original = f.blobs.get;
  f.blobs.get = async () => Buffer.from('corrupt');
  try {
    // Never delivered: that turn ends, and the machine serves on.
    assert.deepEqual(await f.pi.next(bound.token, { workerId: 'worker_restore' }), { work: null });
  } finally {
    f.blobs.get = original;
  }
  const ended = (await f.pi.snapshot(f.operator, conversation.id)).commands.at(-1)!;
  assert.deepEqual([ended.status, ended.error], ['interrupted', 'worker_interrupted']);
});

test('concurrent identical completion saves once and preserves the previous checkpoint', async (t) => {
  const f = await fixture(t);
  const conversation = await f.create();
  const bound = await f.claimed(await f.send(conversation));
  await f.pi.begin(bound.token, bound.input);
  const result = f.completion(bound.input);
  const original = f.blobs.put;
  let arrived = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.blobs.put = async (namespace, bytes) => {
    if (++arrived === 2) release();
    await ready;
    return original(namespace, bytes);
  };
  try {
    assert.deepEqual(
      await Promise.all([f.pi.complete(bound.token, result), f.pi.complete(bound.token, result)]),
      [{ saved: true }, { saved: true }],
    );
  } finally {
    f.blobs.put = original;
    release();
  }
  const snapshot = await f.pi.snapshot(f.operator, conversation.id);
  assert.equal(snapshot.commands[0].status, 'completed');
  assert.equal(snapshot.commands[0].messages.length, 2);
  assert.equal(snapshot.conversation.previousCheckpoint, null);
  assert.equal(snapshot.conversation.checkpoint?.hash, result.checkpointHash);
});

test('cancel during checkpoint storage keeps canonical results but fences pointer publication', async (t) => {
  const f = await fixture(t);
  const conversation = await f.create();
  const bound = await f.claimed(await f.send(conversation));
  await f.pi.begin(bound.token, bound.input);
  const result = f.completion(bound.input);
  const original = f.blobs.put;
  f.blobs.put = async (namespace, bytes) => {
    await f.pi.stop(f.operator, conversation.id);
    return original(namespace, bytes);
  };
  try {
    await assert.rejects(f.pi.complete(bound.token, result), code('pi_command_stale'));
  } finally {
    f.blobs.put = original;
  }
  const snapshot = await f.pi.snapshot(f.operator, conversation.id);
  assert.equal(snapshot.commands[0].status, 'interrupted');
  assert.equal(snapshot.commands[0].error, 'cancelled');
  assert.deepEqual(snapshot.commands[0].messages.slice(1), result.messages);
  assert.equal(snapshot.conversation.checkpoint, null);
});

test('progress bursts do not add durable writes; stop ends only the turn and fences its work', async (t) => {
  const f = await fixture(t);
  const conversation = await f.create();
  const bound = await f.claimed(await f.send(conversation));
  await f.pi.begin(bound.token, bound.input);
  const writes = countWrites(f.state);
  const before = writes();
  for (let batch = 0; batch < 24; batch++) {
    assert.deepEqual(
      await f.pi.progress(bound.token, {
        ...bound.input,
        events: Array.from({ length: 32 }, (_, index) => ({
          type: 'text',
          text: `token ${batch}:${index}`,
        })),
      }),
      { accepted: true },
    );
  }
  // Only the first text is recorded, as when the answer began to show.
  assert.equal(writes() - before, 1);
  const kicks = f.kicks;
  const stopped = await f.pi.stop(f.operator, conversation.id);
  assert.ok(f.kicks > kicks);
  assert.equal(stopped.commands[0].error, 'cancelled');
  // The machine is the person's, not the conversation's: it serves on, now idle.
  assert.equal((await f.allocation(bound.work.command.runtimeId)).intent, 'run');
  assert.ok(stopped.host.idleEndsAt);
  await assert.rejects(
    f.pi.tool(bound.token, { ...bound.input, name: 'project.get', input: {} }),
    code('pi_command_stale'),
  );
  // Only the claim's own read, for its notes.
  assert.equal(f.reads, 1);
});

test('a turn still streaming runs past the old five-minute deadline; one silent that long ends', async (t) => {
  const f = await fixture(t);
  const [talking, silent] = [await f.create(), await f.create()];
  const a = await f.claimed(await f.send(talking));
  await f.pi.begin(a.token, a.input);
  // The person's machine takes the other conversation's turn too.
  const other = await f.send(silent);
  const { work } = await f.pi.next(a.token, { workerId: 'worker_1' });
  assert.equal(work?.command.id, other.id);
  await f.pi.begin(a.token, { ...a.input, conversationId: silent.id, commandId: other.id });
  const turn = async (id: string) => (await f.pi.snapshot(f.operator, id)).commands[0];
  for (let minute = 1; minute <= 15; minute++) {
    f.advance(60_000);
    await f.pi.progress(a.token, { ...a.input, events: [{ type: 'text', text: `${minute} ` }] });
    await f.pi.tick();
  }
  assert.equal((await turn(talking.id)).status, 'working');
  assert.deepEqual(
    [(await turn(silent.id)).status, (await turn(silent.id)).error],
    ['interrupted', 'turn_expired'],
  );
  // A heartbeat is no progress: the talking turn ends five minutes after its last word.
  f.advance(299_000);
  await f.pi.progress(a.token, { ...a.input, events: [] });
  await f.pi.tick();
  assert.equal((await turn(talking.id)).status, 'working');
  f.advance(1_000);
  await f.pi.tick();
  const ended = await turn(talking.id);
  assert.deepEqual([ended.status, ended.error], ['interrupted', 'turn_expired']);
  assert.equal(ended.messages[1].text, Array.from({ length: 15 }, (_, i) => `${i + 1} `).join(''));
});

test('a page opened mid-answer reads the whole answer so far, however far past the tail', async (t) => {
  const f = await fixture(t);
  const conversation = await f.create();
  const bound = await f.claimed(await f.send(conversation));
  await f.pi.begin(bound.token, bound.input);
  // Five times the stream's 64 KB tail.
  const words = Array.from({ length: 40 }, (_, index) => `${index}`.padEnd(8192, '.'));
  for (let at = 0; at < words.length; at += 32)
    await f.pi.progress(bound.token, {
      ...bound.input,
      events: words.slice(at, at + 32).map((text) => ({ type: 'text', text })),
    });
  const { tail, sequence } = await f.pi.snapshot(f.operator, conversation.id);
  const text = tail.filter((event) => event.type === 'text');
  assert.equal(text.length, 1);
  assert.equal(text[0].text, words.join(''));
  assert.equal(text[0].commandId, bound.input.commandId);
  assert.ok(text[0].sequence > 0 && text[0].sequence <= sequence);
});

test('a turn ended early keeps the words it streamed, bounded like any message, as its answer', async (t) => {
  const f = await fixture(t);
  const conversation = await f.create();
  const bound = await f.claimed(await f.send(conversation, 'What is known?'));
  await f.pi.begin(bound.token, bound.input);
  const say = (input: typeof bound.input, ...events: [string, string][]) =>
    f.pi.progress(bound.token, {
      ...input,
      events: events.map(([type, text]) => ({ type, text })),
    });
  await say(bound.input, ['text', 'Two findings '], ['progress', 'Reading'], ['text', 'so far']);
  const stopped = (await f.pi.stop(f.operator, conversation.id)).commands[0];
  assert.deepEqual(
    [stopped.status, stopped.error, stopped.messages.map(({ text }) => text)],
    ['interrupted', 'cancelled', ['What is known?', 'Two findings so far']],
  );
  // Stopped before any words, a turn keeps only its question.
  await f.send(conversation, 'And then?');
  await f.pi.stop(f.operator, conversation.id);
  // Any other ending keeps them too: here a restart, after which only State remembers them.
  const long = await f.send(conversation, 'Everything?');
  const { work } = await f.pi.next(bound.token, { workerId: 'worker_1' });
  const input = { ...bound.input, commandId: work!.command.id };
  await f.pi.begin(bound.token, input);
  // Past messageChars, the bound falling inside a character.
  const smile = '\u{1F600}';
  let xs = Math.floor(messageChars / 8191);
  if ((messageChars - xs * 8191) % 2 === 0) xs--;
  const events = Array.from({ length: xs + 2 }, (_, i): [string, string] => [
    'text',
    i < xs ? 'x'.repeat(8191) : smile.repeat(4096),
  ]);
  for (let at = 0; at < events.length; at += 32) await say(input, ...events.slice(at, at + 32));
  await f.restart();
  const commands = (await f.pi.snapshot(f.operator, conversation.id)).commands;
  assert.deepEqual(commands[0], stopped);
  assert.deepEqual(
    commands.slice(1).map(({ id, error, messages }) => [id, error, messages.length]),
    [
      [commands[1].id, 'cancelled', 1],
      [long.id, 'service_unavailable', 2],
    ],
  );
  // The cap falls inside a character: its half becomes U+FFFD, so Postgres still reads the row.
  assert.equal(
    commands[2].messages[1].text,
    `${'x'.repeat(8191 * xs)}${smile.repeat((messageChars - 8191 * xs - 1) / 2)}\uFFFD`,
  );
  const statuses = await f.state.read((sql) =>
    sql.all<{ status: string }>("SELECT data_json::jsonb->>'status' AS status FROM pi_commands"),
  );
  assert.equal(statuses.filter(({ status }) => status === 'interrupted').length, 3);
});

test('revoking the person’s credential fails their turn, not the machine', async (t) => {
  const f = await fixture(t);
  const issued = await f.scope.issueActor(f.operator, { name: 'Revocable reader', role: 'reader' });
  const reader: Caller = {
    projectId: f.operator.projectId,
    actorId: issued.actor.id,
    credentialId: issued.credential.id,
  };
  const conversation = await f.create(reader);
  const bound = await f.claimed(await f.send(conversation, 'Read this', reader));
  await f.pi.begin(bound.token, bound.input);
  await f.scope.revokeCredential(f.operator, issued.credential.id);
  await assert.rejects(
    f.pi.tool(bound.token, { ...bound.input, name: 'project.get', input: {} }),
    code('pi_authority_stale'),
  );
  // Only the claim's own read, for its notes.
  assert.equal(f.reads, 1);
  // The worker still ends the turn; its machine, rented by the host, keeps its admission.
  await f.pi.fail(bound.token, bound.input);
  const row = await f.state.read((sql) =>
    sql.get<{ data_json: string }>(
      'SELECT data_json FROM pi_commands WHERE id=?',
      bound.input.commandId,
    ),
  );
  assert.equal(JSON.parse(row!.data_json).error, 'worker_interrupted');
  await f.pi.authenticateWorker(bound.token);
  await f.fleet.tick();
  assert.equal((await f.allocation(bound.work.command.runtimeId)).intent, 'run');
});

test('a restart releases every machine; the next send restores the full tree on a new one', async (t) => {
  const f = await fixture(t);
  const conversation = await f.create();
  const first = await f.claimed(await f.send(conversation));
  const fullTree = checkpointTree('restored', 'sibling');
  await f.finish(first, fullTree);
  await f.fleet.tick();
  assert.equal((await f.allocation(first.work.command.runtimeId)).intent, 'run');
  assert.deepEqual(f.runtimes.stopped, []);
  await f.restart();
  assert.equal((await f.allocation(first.work.command.runtimeId)).intent, 'stop');
  assert.equal((await f.host(first.work.command)).ended?.reason, 'restart');
  await f.fleet.tick();
  assert.deepEqual(f.runtimes.stopped, ['sbx_1']);
  await assert.rejects(f.pi.authenticateWorker(first.token), code('pi_unauthorized'));
  const second = await f.claimed(await f.send(conversation, 'Continue'), 'restored_worker');
  assert.notEqual(second.work.command.runtimeId, first.work.command.runtimeId);
  assert.equal(second.work.checkpoint?.content, fullTree);
  assert.equal(second.work.checkpoint?.hash, sha(fullTree));
  await assert.rejects(f.pi.next(first.token, { workerId: 'old_worker' }), code('pi_unauthorized'));
});

test('Fleet outcomes end a turn with their own reason; a missing row counts as lost', async (t) => {
  const f = await fixture(t);
  const conversation = await f.create();
  const latest = async () => {
    const snapshot = await f.pi.snapshot(f.operator, conversation.id);
    return { error: snapshot.commands.at(-1)!.error, state: snapshot.host.state };
  };
  const rewrite = async (id: string, change: object) => {
    const allocation = await f.allocation(id);
    await f.state.transaction((tx) =>
      tx.run(
        "UPDATE fleet_allocations SET phase='released',data_json=? WHERE id=?",
        JSON.stringify({ ...allocation, phase: 'released', intent: 'stop', ...change }),
        id,
      ),
    );
  };
  await rewrite((await f.send(conversation)).runtimeId, { error: 'runtime_refused' });
  await f.pi.tick();
  // With its only machine gone the host ends; the next send starts another.
  assert.deepEqual(await latest(), { error: 'runtime_refused', state: 'none' });
  // A lost machine's turn that has shown nothing starts again, once, on a fresh one.
  const deleted = (await f.send(conversation)).runtimeId;
  await f.state.transaction((tx) => tx.run('DELETE FROM fleet_allocations WHERE id=?', deleted));
  await f.pi.tick();
  assert.deepEqual(await latest(), { error: null, state: 'starting' });
  // Fleet stops a failed machine itself; that is a lost runtime, not an operator's stop.
  const machine = { sandboxId: 'sbx_failed', state: 'failed', ready: false, launch: null };
  const { commands } = await f.pi.snapshot(f.operator, conversation.id);
  await rewrite(commands.at(-1)!.runtimeId, { runtime: machine });
  await f.pi.tick();
  assert.deepEqual(await latest(), { error: 'runtime_lost', state: 'none' });
  const bound = await f.claimed(await f.send(conversation));
  await f.pi.begin(bound.token, bound.input);
  await f.fleet.drain(f.hostCaller, bound.work.command.runtimeId);
  await f.pi.tick();
  assert.equal((await latest()).error, 'runtime_stopped');
  await f.fleet.tick();
  assert.equal((await f.allocation(bound.work.command.runtimeId)).intent, 'stop');
});

test('a queued turn waits for capacity; its clock restarts out of the queue and at the claim', async (t) => {
  const f = await fixture(t);
  const conversation = await f.create();
  const { runtimeId } = await f.send(conversation);
  f.advance(3_500_000);
  await f.pi.tick();
  const [queued] = (await f.pi.snapshot(f.operator, conversation.id)).commands;
  assert.deepEqual([queued.status, queued.error], ['waiting', null]);
  await f.fleet.tick();
  // Fleet may restart the machine's deadline as it leaves the queue.
  const allocation = await f.allocation(runtimeId);
  await f.state.transaction((tx) =>
    tx.run(
      'UPDATE fleet_allocations SET data_json=? WHERE id=?',
      JSON.stringify({ ...allocation, deadlineAt: '2026-09-23T01:58:20.000Z' }),
      runtimeId,
    ),
  );
  await f.pi.tick();
  const snapshot = await f.pi.snapshot(f.operator, conversation.id);
  assert.equal(snapshot.commands[0].status, 'starting');
  assert.equal(snapshot.commands[0].expiresAt, '2026-09-23T01:03:20.000Z');
  f.advance(100_000);
  const bound = await f.claimed(snapshot.commands[0]);
  // Claimed, only the machine's deadline bounds it; a stall ends it sooner.
  assert.equal(bound.work.command.expiresAt, '2026-09-23T01:58:20.000Z');
  await f.finish(bound);
  // A warm machine needs no queue.
  assert.equal((await f.send(conversation)).status, 'starting');
});

test('warming rents the person’s machine once, for the latest empty conversation, and a turn shares it', async (t) => {
  const f = await fixture(t);
  f.runtimes.connected = () => false;
  const unavailable = await f.pi.warm(f.operator, { requestId: 'warm_1' });
  assert.deepEqual([unavailable.available, unavailable.stage.name], [false, 'idle']);
  // A question refused as the page expects: it reads as the agent being unavailable here.
  await assert.rejects(f.send(unavailable.conversation), code('sandbox_not_connected'));
  assert.deepEqual(await f.fleet.list(f.hostCaller), []);
  f.runtimes.connected = () => true;
  const warmed = await f.pi.warm(f.operator, { requestId: 'warm_2' });
  assert.equal(warmed.conversation.id, unavailable.conversation.id);
  assert.deepEqual([warmed.commands, warmed.stage.name], [[], 'machine']);
  assert.ok(f.kicks > 0);
  assert.deepEqual([warmed.host.state, warmed.host.machine?.key], ['starting', 'standard']);
  const [allocation] = await f.fleet.list(f.hostCaller);
  const [host] = await f.hosts();
  assert.deepEqual(allocation.owner, { kind: 'pi-host', id: `${host.id}:1` });
  for (const input of [
    { requestId: 'warm_3' },
    { requestId: 'warm_4', conversationId: warmed.conversation.id },
  ])
    assert.deepEqual((await f.pi.warm(f.operator, input)).conversation, warmed.conversation);
  assert.equal((await f.fleet.list(f.hostCaller)).length, 1);
  const command = await f.send(warmed.conversation);
  assert.equal(command.runtimeId, allocation.id);
  // The one conversation now has a turn: a new one opens on the same machine.
  const other = await f.pi.warm(f.operator, { requestId: 'warm_5' });
  assert.notEqual(other.conversation.id, warmed.conversation.id);
  assert.deepEqual([other.host.state, other.stage.name], ['starting', 'machine']);
  await f.finish(await f.claimed(command));
  await f.pi.warm(f.operator, { requestId: 'warm_6', conversationId: other.conversation.id });
  assert.equal((await f.fleet.list(f.hostCaller)).length, 1);
  assert.equal((await f.allocation(allocation.id)).intent, 'run');
});

test('a warm machine shows its stages and, unused, is released after the idle timeout', async (t) => {
  const f = await fixture(t);
  const { conversation } = await f.pi.warm(f.operator, { requestId: 'warm' });
  const stage = async () => (await f.pi.snapshot(f.operator, conversation.id)).stage.name;
  await f.fleet.tick();
  assert.equal(await stage(), 'machine');
  await f.fleet.tick();
  assert.equal(await stage(), 'agent');
  const [host] = await f.hosts();
  const token = await f.token(host.current!.allocationId);
  assert.equal((await f.pi.next(token, { workerId: 'worker_1' })).work, null);
  assert.equal(await stage(), 'ready');
  f.advance(5_000);
  assert.equal(await stage(), 'idle');
  assert.equal((await f.pi.snapshot(f.operator, conversation.id)).host.state, 'none');
  // Warming again ends the idle host and rents afresh; nothing to retry.
  await f.pi.warm(f.operator, { requestId: 'again', conversationId: conversation.id });
  assert.equal((await f.allocation(host.current!.allocationId)).intent, 'stop');
  assert.notEqual((await f.hosts())[0].id, host.id);
});

test('Pi’s own pass tells open pages each move of a warm-up, and a turn each tool it uses', async (t) => {
  const f = await fixture(t);
  const { conversation } = await f.pi.warm(f.operator, { requestId: 'warm' });
  const { id } = conversation;
  const sequence = () => f.pi.streams.snapshot(id).sequence;
  // The stage a pass published, read back without publishing again; null when it published none.
  const pass = async () => {
    const before = sequence();
    await f.pi.tick();
    if (sequence() === before) return null;
    const { stage } = await f.pi.snapshot(f.operator, id);
    assert.equal(sequence(), before + 1);
    return stage.name;
  };
  assert.equal(await pass(), null);
  await f.fleet.tick();
  assert.equal(await pass(), null);
  await f.fleet.tick();
  assert.equal(await pass(), 'agent');
  const [host] = await f.hosts();
  const token = await f.token(host.current!.allocationId);
  assert.equal((await f.pi.next(token, { workerId: 'worker_1' })).work, null);
  assert.equal(await pass(), 'ready');
  assert.equal(await pass(), null);
  const commandId = (await f.send(conversation)).id;
  await f.pi.next(token, { workerId: 'worker_1' });
  const input = { conversationId: id, commandId, workerId: 'worker_1' };
  await f.pi.begin(token, input);
  // Each tool's phrase is published as it starts, and the return to thinking as it ends.
  const call = f.tools.call.bind(f.tools);
  const shown: (string | undefined)[] = [];
  f.tools.call = async (...args) => (
    shown.push((await f.pi.snapshot(f.operator, id)).stage.detail),
    call(...args)
  );
  for (const name of ['project.get', 'shell.run']) {
    const before = sequence();
    await f.pi.tool(token, { ...input, name, input: {} });
    assert.equal(sequence(), before + 2);
  }
  assert.deepEqual(shown, ['Using project.get', 'Using shell.run']);
  // Once the machine stops, the conversation's stage is forgotten.
  await f.pi.stopMachine(f.operator);
  await f.pi.tick();
  assert.equal(f.pi['live'].has(id), false);
});

test('each conversation keeps its model; a pick is the person’s default for new ones here', async (t) => {
  const f = await fixture(t);
  // One from before models were chosen, with history and no model stored.
  const old = await f.create();
  await f.finish(await f.claimed(await f.send(old)));
  await f.state.transaction((tx) =>
    tx.run(
      "UPDATE pi_conversations SET data_json=(data_json::jsonb - 'model')::text WHERE id=?",
      old.id,
    ),
  );
  f.advance(1000);
  const first = await f.create();
  assert.equal(first.model, 'gpt-6-luna');
  const listed = async () => (await f.pi.list(f.operator)).map(({ id }) => id);
  const order = await listed();
  const picked = await f.pi.setModel(f.operator, { id: old.id, model: 'gpt-6-sol' });
  assert.equal(picked.conversation.model, 'gpt-6-sol');
  // The picker's catalog carries no effort.
  assert.deepEqual(
    picked.models.map((model) => Object.keys(model).sort()),
    Array(3).fill(['id', 'inputUsdPerM', 'label', 'outputUsdPerM']),
  );
  // A pick moves nothing in the list and leaves the other conversations as they were.
  assert.deepEqual(await listed(), order);
  assert.equal((await f.pi.snapshot(f.operator, first.id)).conversation.model, 'gpt-6-luna');
  // A new conversation opens on the latest pick; its own record, not the machine's.
  assert.equal((await f.create()).model, 'gpt-6-sol');
  await f.pi.setModel(f.operator, { id: first.id, model: 'gpt-6-astra' });
  assert.equal((await f.create()).model, 'gpt-6-astra');
  assert.equal(await f.person(`${first.userId}:${first.projectId}`), null);
  assert.deepEqual(await f.person(`model:${first.userId}:${first.projectId}`), {
    model: 'gpt-6-astra',
  });
});

test('a page showing another model sends nothing; a retry is the same message', async (t) => {
  const f = await fixture(t);
  const chat = await f.create();
  await f.pi.setModel(f.operator, { id: chat.id, model: 'gpt-6-astra' });
  const send = (commandId: string, model?: string) =>
    f.pi.send(f.operator, chat.id, { commandId, text: 'hello', ...(model && { model }) });
  await assert.rejects(
    send('stale', 'gpt-6-luna'),
    (error: MervError) =>
      error.code === 'pi_model_changed' &&
      error.status === 409 &&
      error.message === 'This conversation now answers on GPT-6 Astra. Send again to use it.',
  );
  assert.equal((await f.pi.snapshot(f.operator, chat.id)).commands.length, 0);
  const sent = await send('shown', 'gpt-6-astra');
  assert.deepEqual(await send('shown', 'gpt-6-luna'), sent);
  assert.deepEqual(await send('shown'), sent);
  // A caller that names no model (MCP, the canary) sends on the conversation's.
  await f.finish(await f.claimed(sent));
  assert.equal((await send('plain')).status, 'starting');
});

test('a turn answers on the model its conversation has when a worker claims it', async (t) => {
  const f = await fixture(t);
  const chat = await f.create();
  const waiting = await f.send(chat);
  assert.equal(waiting.model, undefined);
  // Picked while the turn waits: the claim takes it.
  await f.pi.setModel(f.operator, { id: chat.id, model: 'gpt-6-sol' });
  const bound = await f.claimed(waiting);
  assert.deepEqual([bound.work.model, bound.work.command.model], ['gpt-6-sol', 'gpt-6-sol']);
  // The agent is told what it runs on, and has no model tool.
  assert.equal(
    bound.work.notes[0],
    'Model: you are GPT-6 Sol (gpt-6-sol). Earlier answers in this conversation may come from other models the person picked; if asked which model you are, say GPT-6 Sol.',
  );
  assert.ok(bound.work.tools.every(({ name }) => !name.startsWith('pi.')));
  await f.pi.begin(bound.token, bound.input);
  const grant = await f.pi.authorizeModel(bound.work.modelToken);
  assert.equal(grant.model, 'gpt-6-sol');
  await f.pi.progress(bound.token, {
    ...bound.input,
    events: [{ type: 'text', text: 'Partial answer' }],
  });
  // Picked after the claim: the answer under way keeps its model, and streams on.
  const mid = await f.pi.setModel(f.operator, { id: chat.id, model: 'gpt-6-astra' });
  assert.ok(mid.tail.some((event) => event.type === 'text' && event.text === 'Partial answer'));
  assert.deepEqual([mid.conversation.model, mid.commands[0].model], ['gpt-6-astra', 'gpt-6-sol']);
  await f.pi.validateModel(grant);
  await f.pi.complete(bound.token, f.completion(bound.input));
  const next = await f.send(chat);
  const { work } = await f.pi.next(bound.token, { workerId: 'worker_1' });
  assert.deepEqual([work?.command.id, work?.model], [next.id, 'gpt-6-astra']);
});

test('the note naming the model stays within the worker’s limit, however long the names', async (t) => {
  const [id, label] = [`m${'-'.repeat(99)}`, 'L'.repeat(24)];
  const f = await fixture(t, {
    pi: { models: [{ id, label, inputUsdPerM: 1, outputUsdPerM: 1, effort: 'none' }] },
  });
  const { work } = await f.claimed(await f.send(await f.create()));
  assert.ok(work.notes[0].startsWith(`Model: you are ${label} (${id}).`));
  assert.ok(work.notes.every((note) => note.length <= 300));
});

test('only the person picks a conversation’s model', async (t) => {
  const f = await fixture(t);
  const chat = await f.create();
  const bound = await f.claimed(await f.send(chat));
  for (const caller of [
    {
      ...f.operator,
      conversation: {
        id: chat.id,
        epoch: bound.work.command.epoch,
        commandId: bound.work.command.id,
        runtimeId: bound.work.command.runtimeId,
      },
    },
    { ...f.operator, session: { id: 'session_1' } },
    {
      ...f.operator,
      managed: { allocationId: 'flt_1', epoch: 1, credentialHash: 'x'.repeat(64) },
    },
  ])
    await assert.rejects(
      f.pi.setModel(caller, { id: chat.id, model: 'gpt-6-sol' }),
      code('pi_forbidden'),
    );
  const other = await f.scope.bootstrap({ projectName: 'Other', actorName: 'Other' });
  await assert.rejects(
    f.pi.setModel(
      {
        projectId: other.project.id,
        actorId: other.actor.id,
        credentialId: other.credential.id,
      },
      { id: chat.id, model: 'gpt-6-sol' },
    ),
    code('pi_not_found'),
  );
  await assert.rejects(
    f.pi.setModel(f.operator, { id: chat.id, model: 'gpt-4' }),
    code('pi_model_unavailable'),
  );
  assert.equal((await f.pi.snapshot(f.operator, chat.id)).conversation.model, 'gpt-6-luna');
});

test('a model withdrawn at a restart leaves its conversations on the default', async (t) => {
  const f = await fixture(t);
  const chat = await f.create();
  await f.pi.setModel(f.operator, { id: chat.id, model: 'gpt-6-sol' });
  // A restart ends every turn, so none was claimed on the model withdrawn.
  await f.restart({ models: [models[0], models[2]] });
  assert.equal((await f.pi.snapshot(f.operator, chat.id)).conversation.model, 'gpt-6-luna');
  await assert.rejects(
    f.pi.send(f.operator, chat.id, { commandId: 'stale', text: 'hello', model: 'gpt-6-sol' }),
    code('pi_model_changed'),
  );
  const bound = await f.claimed(await f.send(chat));
  await f.pi.begin(bound.token, bound.input);
  assert.equal(bound.work.model, 'gpt-6-luna');
  assert.equal((await f.pi.authorizeModel(bound.work.modelToken)).model, 'gpt-6-luna');
  assert.equal((await f.create()).model, 'gpt-6-luna');
});

test('warming and stopping a machine leave a conversation where it was in the list', async (t) => {
  const f = await fixture(t);
  const older = await f.create();
  f.advance(1000);
  const newer = await f.create();
  const listed = async () =>
    (await f.pi.list(f.operator)).map(({ id, updatedAt }) => ({ id, updatedAt }));
  const before = await listed();
  assert.equal(before[0].id, newer.id);
  f.advance(1000);
  const warmed = await f.pi.warm(f.operator, { requestId: 'warm', conversationId: older.id });
  assert.equal(warmed.host.state, 'starting');
  assert.equal((await f.pi.stopMachine(f.operator)).state, 'none');
  assert.deepEqual(await listed(), before);
  // A question is the conversation's own move.
  await f.send(older);
  assert.equal((await listed())[0].id, older.id);
});

test('a cold turn shows what it waits on, from the queue to the answer; a held worker gets the next at once', async (t) => {
  const f = await fixture(t);
  const conversation = await f.create();
  const command = await f.send(conversation);
  assert.ok(f.kicks > 0);
  const snapshot = () => f.pi.snapshot(f.operator, conversation.id);
  const stage = async () => (await snapshot()).stage;
  assert.equal((await stage()).name, 'machine');
  // Still queued a while later means capacity is full; Pi's own pass tells open pages.
  f.advance(3_001);
  const sequence = f.pi.streams.snapshot(conversation.id).sequence;
  await f.pi.tick();
  assert.equal(f.pi.streams.snapshot(conversation.id).sequence, sequence + 1);
  assert.equal((await stage()).name, 'queued');
  await f.fleet.tick();
  assert.equal((await stage()).name, 'machine');
  await f.fleet.tick();
  assert.equal((await stage()).name, 'agent');
  const { token, input } = await f.claimed(command);
  // A live worker has picked the turn up: the person sees it thinking from here, not loading.
  const claimed = await stage();
  assert.equal(claimed.name, 'thinking');
  await f.pi.begin(token, input);
  const { startedAt } = (await snapshot()).commands[0];
  assert.deepEqual(await stage(), claimed);
  assert.ok(claimed.since <= startedAt!);
  const call = f.tools.call.bind(f.tools);
  let reading: PiStage | undefined;
  f.tools.call = async (...args) => ((reading = await stage()), call(...args));
  await f.pi.tool(token, { ...input, name: 'project.get', input: {} });
  f.tools.call = call;
  assert.deepEqual([reading?.name, reading?.detail], ['tool', 'Using project.get']);
  assert.equal((await stage()).name, 'thinking');
  f.advance(1000);
  await f.pi.progress(token, { ...input, events: [{ type: 'text', text: 'Answer' }] });
  const { firstTextAt } = (await snapshot()).commands[0];
  assert.equal(Date.parse(firstTextAt!) - Date.parse(startedAt!), 1000);
  assert.deepEqual(await stage(), { name: 'writing', since: firstTextAt });
  // Seconds are counted against the server's own clock, not the reader's.
  assert.equal((await snapshot()).now, firstTextAt);
  const result = f.completion(input);
  f.failStorage(true);
  assert.deepEqual(await f.pi.complete(token, result), { saved: false });
  assert.equal((await stage()).name, 'saving');
  f.failStorage(false);
  await f.pi.complete(token, result);
  assert.equal((await stage()).name, 'ready');
  assert.equal((await f.pi.next(token, { workerId: 'worker_2' }, 50)).work, null);
  const held = f.pi.next(token, { workerId: 'worker_2' }, 5_000);
  await pause(50);
  const sentAt = Date.now();
  const sent = await f.send(conversation, 'More');
  assert.equal((await held).work?.command.id, sent.id);
  assert.ok(Date.now() - sentAt < 1000);
  // Warming during a turn leaves the machine serving it.
  await f.pi.warm(f.operator, { requestId: 'warm', conversationId: conversation.id });
  assert.equal((await f.allocation(sent.runtimeId)).intent, 'run');
});

test('idle timeout releases only after successful retention, never while a checkpoint is saving', async (t) => {
  const f = await fixture(t);
  const conversation = await f.create();
  const bound = await f.claimed(await f.send(conversation));
  await f.pi.begin(bound.token, bound.input);
  f.failStorage(true);
  const result = f.completion(bound.input);
  assert.deepEqual(await f.pi.complete(bound.token, result), { saved: false });
  f.advance(5_100);
  await f.fleet.tick();
  assert.equal((await f.allocation(bound.work.command.runtimeId)).intent, 'run');
  assert.deepEqual(f.runtimes.stopped, []);
  f.failStorage(false);
  assert.deepEqual(await f.pi.complete(bound.token, result), { saved: true });
  await f.fleet.tick();
  assert.equal((await f.allocation(bound.work.command.runtimeId)).intent, 'run');
  f.advance(5_100);
  await f.fleet.tick();
  assert.equal((await f.allocation(bound.work.command.runtimeId)).intent, 'stop');
  assert.deepEqual(f.runtimes.stopped, ['sbx_1']);
});

test(
  'real SDK worker reads through HTTP relay, checkpoints, then restores on a replacement Fleet runtime',
  { timeout: 20_000 },
  async (t) => {
    const { runPiWorker } = await import('../packages/pi/src/worker.js');
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    const f = await fixture(t, { baseUrl: origin, startTime: Date.now() });
    let http = new PiHttp(f.pi);
    let modelRequests = 0;
    const requests: Record<string, unknown>[] = [];
    const relay = new PiModelRelay({
      enabled: true,
      models: f.pi.config.models,
      providerKey: () => 'server-only-test-key',
      authority: {
        authorize: (token) => f.pi.authorizeModel(token),
        validate: (grant) => f.pi.validateModel(grant),
      },
      fetchImpl: async (url, init) => {
        assert.equal(url, 'https://api.openai.com/v1/responses');
        assert.equal(
          new Headers(init?.headers).get('authorization'),
          'Bearer server-only-test-key',
        );
        const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push(request);
        const tools = request.tools as { name: string }[];
        const output =
          ++modelRequests === 1
            ? {
                type: 'function_call',
                id: 'fc_read',
                call_id: 'call_read',
                name: tools[0].name,
                arguments: '{}',
              }
            : {
                type: 'message',
                id: `msg_${modelRequests}`,
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: 'Project verified', annotations: [] }],
              };
        const events = [
          { type: 'response.created', response: { id: `resp_${modelRequests}` } },
          { type: 'response.output_item.added', output_index: 0, item: output },
          ...(output.type === 'message'
            ? [
                {
                  type: 'response.output_text.delta',
                  output_index: 0,
                  content_index: 0,
                  delta: 'Project verified',
                },
              ]
            : []),
          { type: 'response.output_item.done', output_index: 0, item: output },
          {
            type: 'response.completed',
            response: {
              id: `resp_${modelRequests}`,
              status: 'completed',
              output: [output],
              usage: { input_tokens: 10, output_tokens: 5 },
            },
          },
        ];
        return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    });
    server.on('request', (req, res) => {
      void (req.url?.startsWith('/pi-model/') ? relay.handle(req, res) : http.worker(req, res));
    });
    t.after(() => {
      http.close();
      relay.close();
      server.closeAllConnections();
      server.close();
    });
    const conversation = await f.create();
    async function runTurn(text: string) {
      const command = await f.send(conversation, text);
      const allocation = await f.allocation(command.runtimeId);
      const bootstrap = JSON.parse(await f.pi.bootstrap(allocation)) as PiBootstrap;
      await f.fleet.tick();
      await f.fleet.tick();
      const controller = new AbortController();
      const worker = runPiWorker(bootstrap, { signal: controller.signal, pollIntervalMs: 250 });
      const completed = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          clearInterval(poll);
          reject(new Error('Worker did not finish'));
        }, 6000);
        const poll = setInterval(() => {
          void f.pi
            .snapshot(f.operator, conversation.id)
            .then((snapshot) => {
              const latest = snapshot.commands.at(-1)!;
              if (latest.status !== 'completed' && latest.status !== 'interrupted') return;
              clearInterval(poll);
              clearTimeout(timeout);
              if (latest.status === 'completed') resolve();
              else reject(new Error(`Worker interrupted: ${latest.error}`));
            })
            .catch((error) => {
              clearInterval(poll);
              clearTimeout(timeout);
              reject(error);
            });
        }, 20);
      });
      try {
        await Promise.race([
          completed,
          worker.then(() => {
            throw new Error('Worker exited before completion');
          }),
        ]);
      } finally {
        controller.abort();
        await worker;
      }
      return command;
    }
    const first = await runTurn('Read this project');
    let snapshot = await f.pi.snapshot(f.operator, conversation.id);
    // The claim's read for its notes, and the agent's.
    assert.equal(f.reads, 2);
    assert.equal(snapshot.commands[0].outcomes[0].name, 'project.get');
    assert.equal(snapshot.commands[0].messages.at(-1)?.text, 'Project verified');
    const checkpoint = snapshot.conversation.checkpoint;
    assert.ok(checkpoint);
    await f.restart();
    http.close();
    http = new PiHttp(f.pi);
    await f.fleet.tick();
    f.runtimes.release('sbx_1');
    await f.fleet.tick();
    // The person switches to Astra between the turns; the history comes along.
    await f.pi.setModel(f.operator, { id: conversation.id, model: 'gpt-6-astra' });
    const second = await runTurn('Continue from the saved conversation');
    assert.notEqual(second.runtimeId, first.runtimeId);
    snapshot = await f.pi.snapshot(f.operator, conversation.id);
    assert.equal(snapshot.commands.length, 2);
    assert.deepEqual(snapshot.conversation.previousCheckpoint, checkpoint);
    assert.equal(modelRequests, 3);
    assert.match(JSON.stringify(requests[2].input), /Read this project/);
    assert.match(JSON.stringify(requests[2].input), /Project verified/);
    // Each call runs, and tells the agent it runs, on its turn's model at the catalog's effort.
    assert.deepEqual(
      requests.map(({ model, reasoning, include }) => [model, reasoning, include]),
      [
        ['gpt-6-luna', { effort: 'none' }, undefined],
        ['gpt-6-luna', { effort: 'none' }, undefined],
        ['gpt-6-astra', { effort: 'low' }, ['reasoning.encrypted_content']],
      ],
    );
    assert.match(JSON.stringify(requests[0].input), /Model: you are GPT-6 Luna \(gpt-6-luna\)\./);
    assert.match(JSON.stringify(requests[2].input), /Model: you are GPT-6 Astra \(gpt-6-astra\)\./);
    assert.equal(f.mutations, 0);
  },
);

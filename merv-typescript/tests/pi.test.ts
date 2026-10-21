import {
  MervError,
  recorded,
  type Caller,
  type HumanPrincipal,
  type Permission,
  type Role,
} from '@merv/contracts';
import type { Sessions } from '@merv/sessions/types';
import type { Context } from 'cordis';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test, { type TestContext } from 'node:test';
import { z } from 'zod';
import { ApiServer } from '../packages/api/src/http.js';
import { ModelRelay, type RelayTuning } from '../packages/fleet/src/model-relay.js';
import { CredentialStore, tokenDigest } from '../packages/identity/src/credentials.js';
import { PiHttp } from '../packages/pi/src/api.js';
import { type PiConfig } from '../packages/pi/src/index.js';
import { piModelRelay, type PiRelayConfig } from '../packages/pi/src/relay.js';
import type { PiBootstrap } from '../packages/pi/src/types.js';
import { sessionsToolsPlugin } from '../packages/sessions/src/tools.js';
import { checkpointTree, code, fixture, sha, type PiFixture } from './fixtures/pi.js';

/** Pi's relay hooks over the shared core, as the API mounts them. */
const piRelay = (config: PiRelayConfig & RelayTuning) =>
  new ModelRelay(piModelRelay(config), config);

test('Pi offers and runs project.read status in a conversation', async (t) => {
  const f = await fixture(t);
  const sessions = {
    dispatch: {
      projectStatus: async (caller: Caller) => {
        assert.equal(caller.projectId, f.operator.projectId);
        return {
          observedAt: '2026-09-26T00:00:00Z',
          dispatch: { enabled: false, ownMachines: true, fleet: false },
          runnerTotal: 0,
          runners: [],
          liveSessionCount: 0,
          sessionTotal: 0,
          sessions: [],
          queueTotal: 0,
          queue: [],
          stuck: { total: 0, counts: {}, items: [], truncated: false },
        };
      },
    },
    statusSections: async () => ({}),
  } as unknown as Sessions;
  sessionsToolsPlugin.apply({
    sessions,
    tools: f.tools,
    effect: (register: () => unknown) => register(),
  } as unknown as Context);
  const bound = await f.begun(f.operator);
  assert.ok(bound.work.tools.some((tool) => tool.name === 'project.read'));
  assert.deepEqual(
    (
      (await f.pi.tool(bound.token, {
        ...bound.input,
        name: 'project.read',
        input: { action: 'status' },
      })) as {
        dispatch: unknown;
      }
    ).dispatch,
    { enabled: false, state: 'paused', ownMachines: true, fleet: false },
  );
});

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

test('each send carries the person’s current role; a removed member is refused', async (t) => {
  const f = await fixture(t);
  const login = (subject: string) =>
    f.scope.members.acceptVerifiedIdentity({
      issuer: 'https://identity.example/auth/v1',
      subject,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
  const alice = await login('alice');
  const bob = await login('bob');
  const project = await f.scope.members.createProject(alice, {
    name: 'Humans',
    requestId: 'humans',
  });
  await f.scope.members.addMember(alice, project.id, { subject: 'bob', role: 'producer' });
  const producer = await f.scope.caller(bob, project.id);
  const conversation = await f.create(producer);
  const bound = await f.claimed(await f.send(conversation, 'hello', producer));
  await f.finish(bound);
  await f.scope.members.changeMemberRole(alice, project.id, { subject: 'bob', role: 'reader' });
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
  await f.scope.members.removeMember(alice, project.id, 'bob');
  await assert.rejects(
    f.pi.send(reader, conversation.id, { commandId: 'removed', text: 'hello' }),
    code('membership_required'),
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

/** A project a signed-in operator made, with a member of every role signed in, holding a user key
 * and represented by an actor credential: every kind of source a conversation can have. */
async function sources(f: PiFixture) {
  const login = (subject: string) =>
    f.scope.members.acceptVerifiedIdentity({
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
  const project = await f.scope.members.createProject(principals.operator, {
    name: 'Sources',
    requestId: 'sources',
  });
  for (const [role, principal] of Object.entries(principals))
    if (role !== 'operator')
      await f.scope.members.addMember(principals.operator, project.id, {
        subject: principal.user.subject,
        role: role as Role,
      });
  const admin = await f.scope.caller(principals.operator, project.id);
  const all: { kind: string; role: Role; caller: Caller }[] = [];
  for (const [role, principal] of Object.entries(principals) as [Role, HumanPrincipal][]) {
    all.push({ kind: 'human', role, caller: await f.scope.caller(principal, project.id) });
    const { token } = await f.scope.userKeys.create(principal, { projectId: project.id });
    const key = await f.scope.caller({
      kind: 'key',
      key: await f.scope.userKeys.authenticate(token),
    });
    all.push({ kind: 'key', role, caller: { ...key, projectId: project.id } });
    const issued = await f.scope.credentials.issueActor(admin, { name: `${role} robot`, role });
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
      tier?: 'ui';
      result?: unknown;
    } = {},
  ) =>
    t.after(
      f.tools.register({
        name,
        description: `Probe ${name}`,
        readOnly: options.readOnly,
        tier: options.tier,
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
  probe('probe.leaky', 'read', { readOnly: true, result: { issued: [{ token: 'secret' }] } });
  probe('probe.never', 'read', { readOnly: true, tier: 'ui' });
  probe('pi.probe', 'read', { readOnly: true, tier: 'ui' });
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
        f.scope.credentials.actorCredentials(caller, input.actorId),
    }),
  );
  const { all, admin } = await sources(f);
  const someone = await f.scope.credentials.issueActor(admin, { name: 'Someone', role: 'reader' });
  // A tool whose other actions write is offered for its reads (`reads`), to a reader as well.
  t.after(
    f.tools.register({
      name: 'probe.mixed',
      description: 'Read or write',
      inputSchema: z.object({ action: z.enum(['read', 'write']) }).strict(),
      reads: ({ action }) => action === 'read',
      handler: async (caller: Caller, { action }: { action: 'read' | 'write' }) => {
        await f.scope.require(caller, action);
        return { ran: action };
      },
    }),
  );
  const reads = [
    'actor.credentials',
    'probe.leaky',
    'probe.mixed',
    'probe.read',
    'project.get',
    'shell.run',
  ];
  const writes = ['probe.admin', 'probe.review', 'probe.write'];
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
    assert.deepEqual(await agent('probe.mixed', { action: 'read' }), { ran: 'read' });
    if (role === 'reader')
      assert.equal(
        ((await agent('probe.mixed', { action: 'write' })) as { error: { code: string } }).error
          .code,
        'forbidden',
      );
    assert.equal((await f.pi.snapshot(caller, input.conversationId)).commands[0].status, 'working');
    assert.equal(
      ((await agent('probe.leaky')) as { error: { code: string } }).error.code,
      'tool_result_secret',
    );
    for (const name of ['probe.never', 'pi.probe', '_remote.read', 'task.list'])
      await assert.rejects(agent(name), code('pi_tool_forbidden'), `${label} ${name}`);
    // The real actor tools: only an operator reads another actor's credentials, never through a
    // key, and never through the agent.
    const other = { actorId: someone.actor.id };
    const allowed = role === 'operator' && kind !== 'key';
    const direct = await f.tools.call('actor.credentials', caller, other).then(
      () => true,
      () => false,
    );
    const via = (await agent('actor.credentials', other)) as { error?: { code: string } };
    assert.deepEqual([direct, !via.error], [allowed, false], label);
    for (const name of ['probe.never', 'pi.probe']) assert.equal(runs[name], undefined);
    await f.pi.complete(token, f.completion(input));
  }
  assert.equal(f.mutations, 0);
});

test('a role change ends the running turn, the next offers the new role’s tools, and the host project has no agent', async (t) => {
  const f = await fixture(t);
  probes(f, t);
  const { all, principals, project } = await sources(f);
  const producer = all.find(({ kind, role }) => kind === 'human' && role === 'producer')!.caller;
  const { token, input } = await f.begun(producer);
  await f.scope.members.changeMemberRole(principals.operator, project.id, {
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

test('a Fleet halt the agent makes is recorded as its person’s', async (t) => {
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
  await f.pi.tool(turn.token, { ...turn.input, name: 'fleet.halt', input: { id: allocation.id } });
  await f.pi.complete(turn.token, f.completion(turn.input));
  const halted = (await f.state.events(human.projectId)).filter(
    ({ type, subjectId }) => type === 'fleet.changed' && subjectId === allocation.id,
  );
  assert.equal(halted.at(-1)?.actorId, human.actorId);
  assert.equal(halted.at(-1)?.data.intent, 'stop');
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
  // Blobs checks every read against its hash, as the real stores do.
  f.blobs.get = async () => {
    throw new MervError('blob_corrupt', 'Stored blob failed its integrity check', 500);
  };
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

test('revoking the person’s credential fails their turn, not the machine', async (t) => {
  const f = await fixture(t);
  const issued = await f.scope.credentials.issueActor(f.operator, {
    name: 'Revocable reader',
    role: 'reader',
  });
  const reader: Caller = {
    projectId: f.operator.projectId,
    actorId: issued.actor.id,
    credentialId: issued.credential.id,
  };
  const conversation = await f.create(reader);
  const bound = await f.claimed(await f.send(conversation, 'Read this', reader));
  await f.pi.begin(bound.token, bound.input);
  await f.scope.credentials.revokeCredential(f.operator, issued.credential.id);
  await assert.rejects(
    f.pi.tool(bound.token, { ...bound.input, name: 'project.get', input: {} }),
    code('pi_authority_stale'),
  );
  // No project read: a claim's notes read only the paper.
  assert.equal(f.reads, 0);
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

test('revoking a model credential at Identity fences an already admitted Pi relay grant', async (t) => {
  const f = await fixture(t);
  const conversation = await f.create();
  const bound = await f.claimed(await f.send(conversation));
  await f.pi.begin(bound.token, bound.input);
  const grant = await f.pi.authorizeModel(bound.work.modelToken);
  await new CredentialStore(f.state).revoke(tokenDigest(bound.work.modelToken), 'pi');
  await assert.rejects(f.pi.authorizeModel(bound.work.modelToken), code('pi_unauthorized'));
  await assert.rejects(f.pi.validateModel(grant), code('pi_authority_stale'));
  await f.pi.authenticateWorker(bound.token);
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
    // A free port, for the API server the worker reaches.
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const address = probe.address();
    assert.ok(address && typeof address === 'object');
    await new Promise((resolve) => probe.close(resolve));
    const origin = `http://127.0.0.1:${address.port}`;
    const f = await fixture(t, { baseUrl: origin, startTime: Date.now() });
    let http = new PiHttp(f.pi);
    let modelRequests = 0;
    const requests: Record<string, unknown>[] = [];
    const relay = piRelay({
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
    // As Pi's API adapter mounts them, on the PiHttp of the running service.
    const api = new ApiServer(f.scope, f.tools, { host: '127.0.0.1', port: address.port });
    api.credential('piw_', {
      ...http.credential,
      authenticate: (token) => http.credential.authenticate!(token),
    });
    api.mount('/pi-worker', (req, res, r) => http.worker(req, res, r));
    api.mount('/pi-model', relay.handle, { public: true });
    await api.start();
    t.after(async () => {
      http.close();
      relay.close();
      await api.stop();
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
    // Only the agent's: a claim's notes read only the paper.
    assert.equal(f.reads, 1);
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

test('Pi’s model relay charges a worker’s call before it runs and settles it to what it used', async (t) => {
  // The relay checks a grant's expiry against the real clock.
  const f = await fixture(t, { startTime: Date.now() });
  const conversation = await f.create();
  const bound = await f.claimed(await f.send(conversation));
  await f.pi.begin(bound.token, bound.input);
  const grant = await f.pi.authorizeModel(bound.work.modelToken);
  const { fetch: send } = globalThis;
  const asked = provider(t, async () => {
    const completed = {
      type: 'response.completed',
      response: {
        id: 'resp_1',
        status: 'completed',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    };
    return new Response(`data: ${JSON.stringify(completed)}\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  // The relay Pi's API adapter mounts at /pi-model.
  const relay = f.pi.modelRelay();
  const server = createServer((req, res) => void relay.handle(req, res, undefined as never));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    relay.close();
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address() as { port: number };
  const body = {
    model: grant.model,
    store: false,
    stream: true,
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
  };
  const response = await send(`http://127.0.0.1:${port}/pi-model/responses`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bound.work.modelToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200, await response.text());
  assert.equal(asked.length, 1);
  const spent = () =>
    f.state.read((sql) =>
      sql.all<{ tokens: number | string }>(
        'SELECT tokens FROM pi_model_usage WHERE person=?',
        grant.userId,
      ),
    );
  // The charge made the day's row and the settlement brought it to what the call used; usage
  // settles as its frame passes, beside the response.
  for (let tries = 0; tries < 50 && Number((await spent())[0]?.tokens) !== 15; tries++)
    await pause(10);
  assert.deepEqual(
    (await spent()).map(({ tokens }) => Number(tokens)),
    [15],
  );
});

test('a person’s Agent tokens are charged before each call and settled after, and refused at the day’s ceiling', async (t) => {
  const f = await fixture(t, { pi: { dailyTokensPerPerson: 1_000 } as PiConfig });
  const conversation = await f.create();
  const bound = await f.claimed(await f.send(conversation));
  await f.pi.begin(bound.token, bound.input);
  const grant = await f.pi.authorizeModel(bound.work.modelToken);
  const body = { model: grant.model, input: [], max_output_tokens: 600 };
  const charged = await f.pi.tokens.reserve(grant, body);
  assert.equal(charged.tokens, Math.ceil(JSON.stringify(body).length / 4) + 600);
  assert.match(charged.day, /^\d{4}-\d{2}-\d{2}$/);
  // A second call at its most would pass the ceiling while the first is still out.
  await assert.rejects(f.pi.tokens.reserve(grant, body), code('pi_model_ceiling'));
  // Settled to what it used, the day has room again.
  await f.pi.tokens.settle({ inputTokens: 40, outputTokens: 10 }, grant, charged);
  assert.deepEqual(await f.pi.tokens.reserve(grant, body), charged);
  // A call settles to the day it was charged to, whatever the day is when it finishes.
  await f.state.transaction((tx) =>
    tx.run(
      'INSERT INTO pi_model_usage(person,day,tokens) VALUES(?,?,?)',
      grant.userId,
      '2000-01-01',
      10,
    ),
  );
  await f.pi.tokens.settle({ inputTokens: 1, outputTokens: 2 }, grant, {
    day: '2000-01-01',
    tokens: 10,
  });
  const days = await f.state.read((sql) =>
    sql.all<{ day: string; tokens: number | string }>(
      'SELECT day, tokens FROM pi_model_usage WHERE person=? ORDER BY day',
      grant.userId,
    ),
  );
  assert.deepEqual(
    days.map(({ day, tokens }) => ({ day, tokens: Number(tokens) })),
    [
      { day: '2000-01-01', tokens: 3 },
      { day: charged.day, tokens: 50 + charged.tokens },
    ],
  );
  // The platform admin's read: each window's tokens against the ceiling, none for a person without.
  const tomorrow = new Date(Date.parse(charged.day) + 86_400_000).toISOString().slice(0, 10);
  assert.deepEqual(await f.pi.tokensUsed([grant.userId, 'nobody'], charged.day, tomorrow), [
    { used: 50 + charged.tokens, limit: 1_000, own: false },
    { used: 0, limit: 1_000, own: false },
  ]);
  assert.deepEqual(
    (await f.pi.tokensUsed([grant.userId], '1970-01-01', tomorrow)).map(({ used }) => used),
    [3 + 50 + charged.tokens],
  );
  assert.deepEqual(
    (await f.pi.tokensUsed([grant.userId], '2000-01-01', '2000-01-02')).map(({ used }) => used),
    [3],
  );
});

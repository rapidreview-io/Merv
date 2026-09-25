import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test, { type TestContext } from 'node:test';
import { z } from 'zod';
import { check, type Caller } from '@merv/contracts';
import { PiHttp } from '../packages/pi/src/api.js';
import { PiModelRelay } from '../packages/pi/src/relay.js';
import type { PiBootstrap, PiStage } from '../packages/pi/src/types.js';
import { countWrites } from './fixtures/state.js';
import { checkpointTree, code, fixture, sha } from './fixtures/pi.js';

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

test('a reader can chat but cannot request workflow capacity; worker claims and audits a native read only', async (t) => {
  const f = await fixture(t);
  const issued = await f.scope.issueActor(f.operator, { name: 'Reader', role: 'reader' });
  const reader: Caller = {
    projectId: f.operator.projectId,
    actorId: issued.actor.id,
    credentialId: issued.credential.id,
  };
  const conversation = await f.create(reader);
  const unregister = f.fleet.registerOwner('workflow', {
    valid: async () => true,
    bootstrap: async () => '',
    observe: async () => 'running',
  });
  try {
    await assert.rejects(
      f.fleet.request(reader, {
        requestId: 'workflow_attempt',
        owner: { kind: 'workflow', id: 'write_only' },
      }),
      code('forbidden'),
    );
  } finally {
    unregister();
  }
  const command = await f.send(conversation, 'What project is this?', reader);
  assert.equal(command.status, 'waiting');
  const { token, work, input } = await f.claimed(command);
  assert.equal(work.command.status, 'starting');
  assert.deepEqual(
    work.tools.map((tool) => tool.name),
    ['project.get'],
  );
  assert.deepEqual(await f.pi.begin(token, input), { apply: true });
  const project = await f.pi.tool(token, { ...input, name: 'project.get', input: {} });
  assert.deepEqual(project, await f.scope.project(reader));
  assert.equal(f.reads, 1);
  await assert.rejects(
    f.pi.tool(token, { ...input, name: 'task.create', input: {} }),
    code('tool_forbidden'),
  );
  await assert.rejects(
    f.pi.tool(token, { ...input, name: 'shell.run', input: {} }),
    code('tool_forbidden'),
  );
  await assert.rejects(
    f.pi.tool(token, { ...input, name: '_remote.read', input: {} }),
    code('tool_forbidden'),
  );
  assert.equal(
    (
      (await f.pi.tool(token, {
        ...input,
        name: 'project.get',
        input: { projectId: reader.projectId },
      })) as { error: { code: string } }
    ).error.code,
    'invalid_input',
  );
  assert.equal(f.mutations, 0);
  assert.equal((await f.pi.snapshot(reader, conversation.id)).commands[0].status, 'working');
  const result = f.completion(input, checkpointTree('What project is this?'));
  result.outcomes = [
    {
      callId: 'read_1',
      name: 'project.get',
      input: {},
      output: JSON.parse(JSON.stringify(project)),
    },
  ];
  assert.deepEqual(await f.pi.complete(token, result), { saved: true });
  assert.deepEqual(
    (await f.pi.snapshot(reader, conversation.id)).commands[0].outcomes,
    result.outcomes,
  );
});

test('recoverable tool failures and oversized results come back to the model as results', async (t) => {
  const f = await fixture(t);
  const content = 'line "quoted"\n'.repeat(12_000);
  t.after(
    f.tools.register({
      name: 'artifact.read',
      description: 'Read artifact',
      readOnly: true,
      inputSchema: z.object({ artifactId: z.string().min(1) }).strict(),
      handler: async (_caller, input: { artifactId: string }) => {
        check(input.artifactId.startsWith('art_b'), 'not_found', 'Artifact not found', 404);
        return input.artifactId === 'art_big'
          ? { artifact: { id: 'art_big' }, content, encoding: 'utf8' }
          : { artifact: { id: 'art_bin' }, content: 'AAAA'.repeat(10_000), encoding: 'base64' };
      },
    }),
  );
  t.after(
    f.tools.register({
      name: 'artifact.list',
      description: 'List artifacts',
      readOnly: true,
      inputSchema: z.object({}).strict(),
      handler: async () =>
        Array.from({ length: 1000 }, (_, index) => ({
          id: `art_${index}`,
          title: 'Meeting notes',
        })),
    }),
  );
  const conversation = await f.create();
  const { token, input } = await f.claimed(await f.send(conversation));
  await f.pi.begin(token, input);
  const read = (artifactId: string) =>
    f.pi.tool(token, { ...input, name: 'artifact.read', input: { artifactId } });
  assert.deepEqual(await read('art_missing'), {
    error: { code: 'not_found', message: 'Artifact not found' },
  });
  // A result stays a small part of the worker model's 32,000-token context.
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  const result = (await read('art_big')) as { content: string; truncated: string };
  assert.ok(bytes(result) <= 24_000);
  assert.ok(result.content.length > 15_000 && content.startsWith(result.content));
  assert.equal(
    result.truncated,
    `Only the first ${result.content.length} of ${content.length} characters are shown`,
  );
  assert.deepEqual(await read('art_bin'), {
    error: { code: 'tool_result_too_large', message: 'The result is too large to show' },
  });
  const list = (await f.pi.tool(token, { ...input, name: 'artifact.list', input: {} })) as {
    items: { id: string }[];
    truncated: string;
  };
  assert.ok(bytes(list) <= 24_000 && list.items.length > 500);
  assert.equal(list.items.at(-1)!.id, `art_${list.items.length - 1}`);
  assert.equal(list.truncated, `Only the first ${list.items.length} of 1000 items are shown`);
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
  assert.equal(f.reads, 0);
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
  const smile = '\u{1F600}';
  await say(
    input,
    ...Array.from({ length: 16 }, (_, i): [string, string] => [
      'text',
      i < 15 ? 'x'.repeat(8191) : smile.repeat(4096),
    ]),
  );
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
  assert.equal(commands[2].messages[1].text, `${'x'.repeat(8191 * 15)}${smile.repeat(2567)}\uFFFD`);
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

test('Fleet outcomes end a turn at once with their own reason; a missing row counts as lost', async (t) => {
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
  const deleted = (await f.send(conversation)).runtimeId;
  await f.state.transaction((tx) => tx.run('DELETE FROM fleet_allocations WHERE id=?', deleted));
  await f.pi.tick();
  assert.deepEqual(await latest(), { error: 'runtime_lost', state: 'none' });
  // Fleet stops a failed machine itself; that is a lost runtime, not an operator's stop.
  const machine = { sandboxId: 'sbx_failed', state: 'failed', ready: false, launch: null };
  await rewrite((await f.send(conversation)).runtimeId, { runtime: machine });
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
  assert.equal(bound.work.command.expiresAt, '2026-09-23T01:05:00.000Z');
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
  for (const name of ['project.get', 'task.list']) {
    const before = sequence();
    await f.pi.tool(token, { ...input, name, input: {} });
    assert.equal(sequence(), before + 2);
  }
  assert.deepEqual(shown, ['Reading the project', 'Listing tasks']);
  // Once the machine stops, the conversation's stage is forgotten.
  await f.pi.stopMachine(f.operator);
  await f.pi.tick();
  assert.equal(f.pi['live'].has(id), false);
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
  assert.deepEqual([reading?.name, reading?.detail], ['tool', 'Reading the project']);
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
      model: f.pi.config.model,
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
    const second = await runTurn('Continue from the saved conversation');
    assert.notEqual(second.runtimeId, first.runtimeId);
    snapshot = await f.pi.snapshot(f.operator, conversation.id);
    assert.equal(snapshot.commands.length, 2);
    assert.deepEqual(snapshot.conversation.previousCheckpoint, checkpoint);
    assert.equal(modelRequests, 3);
    assert.match(JSON.stringify(requests[2].input), /Read this project/);
    assert.match(JSON.stringify(requests[2].input), /Project verified/);
    assert.equal(f.mutations, 0);
  },
);

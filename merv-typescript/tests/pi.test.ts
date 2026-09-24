import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { z } from 'zod';
import { DiskBlobs } from '@merv/blobs';
import { check, createService, type Blobs, type Caller, type MervError } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import type { SandboxRuntimeHandle, SandboxRuntimes } from '@merv/sandboxes';
import { ToolRegistry } from '../packages/api/src/registry.js';
import { FleetService } from '../packages/fleet/src/index.js';
import { PiService } from '../packages/pi/src/index.js';
import { PiHttp } from '../packages/pi/src/api.js';
import { PiModelRelay } from '../packages/pi/src/relay.js';
import { maxTextChars } from '../packages/pi/src/relay-schema.js';
import type { PiBootstrap, PiCompletion, PiConversation } from '../packages/pi/src/types.js';
import { countWrites, openState } from './fixtures/state.js';

process.env.MERV_PI_SECRET ??= 'pi-service-integration-tests-only-32-characters';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const code = (name: string) => (error: unknown) => (error as MervError)?.code === name;

function checkpointTree(text = 'Earlier', branch = 'active'): string {
  return JSON.stringify({
    version: 1,
    header: {
      type: 'session',
      version: 3,
      id: 'session_test',
      cwd: '/pi-worker',
      timestamp: '2026-09-23T00:00:00Z',
    },
    entries: [
      {
        type: 'message',
        id: 'root',
        parentId: null,
        timestamp: '2026-09-23T00:00:00Z',
        message: { role: 'user', content: text, timestamp: 1790121600000 },
      },
      {
        type: 'message',
        id: 'sibling',
        parentId: 'root',
        timestamp: '2026-09-23T00:00:01Z',
        message: { role: 'user', content: 'Other branch', timestamp: 1790121601000 },
      },
      {
        type: 'message',
        id: 'active',
        parentId: 'root',
        timestamp: '2026-09-23T00:00:02Z',
        message: { role: 'user', content: 'Active branch', timestamp: 1790121602000 },
      },
    ],
    leafId: branch,
  });
}

class FakeRuntimes implements SandboxRuntimes {
  profileId = 'pi-test-profile';
  connected = () => true;
  readonly handles = new Map<string, SandboxRuntimeHandle>();
  readonly launched: string[] = [];
  readonly stopped: string[] = [];

  async provision(_projectId: string, key: string): Promise<SandboxRuntimeHandle> {
    let handle = this.handles.get(key);
    if (!handle) {
      handle = {
        sandboxId: `sbx_${this.handles.size + 1}`,
        state: 'ready',
        ready: true,
        deleted: false,
        leaseExpiresAt: '2099-01-01T00:00:00Z',
        revision: 1,
        launch: null,
      };
      this.handles.set(key, handle);
    }
    return structuredClone(handle);
  }
  async inspect(_projectId: string, current: SandboxRuntimeHandle): Promise<SandboxRuntimeHandle> {
    const handle = [...this.handles.values()].find((item) => item.sandboxId === current.sandboxId);
    assert.ok(handle);
    return structuredClone(handle);
  }
  async launch(
    _projectId: string,
    current: SandboxRuntimeHandle,
    key: string,
  ): Promise<SandboxRuntimeHandle> {
    const handle = [...this.handles.values()].find((item) => item.sandboxId === current.sandboxId);
    assert.ok(handle);
    this.launched.push(key);
    handle.launch ??= {
      sandboxId: handle.sandboxId,
      launchId: `rln_${handle.sandboxId}`,
      operationKey: key,
      releaseId: 'pi-test-release',
      jobId: `job_${handle.sandboxId}`,
      state: 'pending',
      deliveryState: 'launched',
      expiresAt: '2099-01-01T00:00:00Z',
    };
    return structuredClone(handle);
  }
  async acknowledge(
    _projectId: string,
    current: SandboxRuntimeHandle,
  ): Promise<SandboxRuntimeHandle> {
    const handle = [...this.handles.values()].find((item) => item.sandboxId === current.sandboxId);
    assert.ok(handle?.launch);
    handle.launch.state = 'consumed';
    return structuredClone(handle);
  }
  async stop(_projectId: string, current: SandboxRuntimeHandle): Promise<SandboxRuntimeHandle> {
    const handle = [...this.handles.values()].find((item) => item.sandboxId === current.sandboxId);
    assert.ok(handle);
    this.stopped.push(handle.sandboxId);
    handle.state = 'deleting';
    handle.ready = false;
    handle.revision++;
    return structuredClone(handle);
  }
  async renew(_projectId: string, current: SandboxRuntimeHandle) {
    return this.inspect(_projectId, current);
  }
  release(sandboxId: string) {
    const handle = [...this.handles.values()].find((item) => item.sandboxId === sandboxId);
    assert.ok(handle);
    handle.state = 'stopped';
    handle.deleted = true;
    handle.ready = false;
    handle.revision++;
  }
}

async function fixture(
  t: TestContext,
  baseUrl = 'http://127.0.0.1:31415/',
  startTime = Date.parse('2026-09-23T00:00:00Z'),
) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-pi-service-'));
  const state = await openState(directory);
  const scope = await createService(new ProjectScope(state));
  const admin = await scope.bootstrap({ projectName: 'Pi integration', actorName: 'Operator' });
  const operator: Caller = {
    projectId: admin.project.id,
    actorId: admin.actor.id,
    credentialId: admin.credential.id,
  };
  const runtimes = new FakeRuntimes();
  let now = startTime;
  const clock = () => now;
  const tools = new ToolRegistry(scope);
  let reads = 0;
  let mutations = 0;
  tools.register({
    name: 'project.get',
    description: 'Get current project',
    readOnly: true,
    inputSchema: z.object({}).strict(),
    handler: async (caller) => {
      const project = await scope.project(caller);
      reads++;
      return project;
    },
  });
  tools.register({
    name: 'task.create',
    description: 'Create task',
    inputSchema: z.object({}).strict(),
    handler: () => {
      mutations++;
      return { id: 'should-not-exist' };
    },
  });
  tools.register({
    name: 'shell.run',
    description: 'Run shell',
    readOnly: true,
    inputSchema: z.object({}).strict(),
    handler: () => {
      mutations++;
      return 'should-not-run';
    },
  });
  await tools.createCatalog('remote').replace([
    {
      kind: 'mcp',
      name: 'read',
      description: 'Mounted read',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      handler: async () => {
        mutations++;
        return { content: [{ type: 'text', text: 'should-not-run' }] };
      },
    },
  ]);
  const fleet = await createService(
    new FleetService(
      state,
      scope,
      runtimes,
      { enabled: true, globalLimit: 4, projectLimit: 4 },
      clock,
    ),
  );
  const disk = new DiskBlobs(join(directory, 'blobs'));
  let failPut = false;
  const blobs: Blobs = {
    put: (namespace, bytes) =>
      failPut ? Promise.reject(new Error('disk unavailable')) : disk.put(namespace, bytes),
    get: (namespace, digest) => disk.get(namespace, digest),
  };
  let pi = await createService(
    new PiService(
      state,
      scope,
      fleet,
      tools,
      blobs,
      {
        enabled: true,
        baseUrl,
        pollIntervalMs: 30_000,
        idleTimeoutSeconds: 5,
      },
      clock,
    ),
  );
  let sequence = 0;
  t.after(async () => {
    await pi.close();
    await fleet.close();
    await tools.close();
    await state.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const create = (caller = operator) =>
    pi.create(caller, { requestId: `open_${++sequence}`, title: 'Chat' });
  const send = (conversation: PiConversation, text = 'hello', caller = operator) =>
    pi.send(caller, conversation.id, { commandId: `turn_${++sequence}`, text });
  async function claimed(conversation: PiConversation, workerId = 'worker_1', caller = operator) {
    const allocation = await fleet.inspect(caller, conversation.runtimeId!);
    const token = (JSON.parse(await pi.bootstrap(allocation)) as PiBootstrap).workerToken;
    await fleet.tick();
    await fleet.tick();
    assert.equal((await fleet.inspect(caller, conversation.runtimeId!)).phase, 'starting');
    const work = await pi.next(token, { workerId });
    assert.ok(work);
    return { token, work, input: { commandId: work.command.id, workerId } };
  }
  const completion = (commandId: string, workerId: string, checkpoint: string): PiCompletion => ({
    commandId,
    workerId,
    messages: [{ role: 'assistant', text: `answer ${commandId}` }],
    outcomes: [],
    checkpoint,
    checkpointHash: sha(checkpoint),
  });
  return {
    state,
    scope,
    operator,
    runtimes,
    fleet,
    tools,
    blobs,
    disk,
    create,
    send,
    claimed,
    completion,
    get pi() {
      return pi;
    },
    get reads() {
      return reads;
    },
    get mutations() {
      return mutations;
    },
    failStorage: (value: boolean) => {
      failPut = value;
    },
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    restart: async () => {
      await pi.close();
      pi = await createService(
        new PiService(
          state,
          scope,
          fleet,
          tools,
          blobs,
          {
            enabled: true,
            baseUrl,
            pollIntervalMs: 30_000,
            idleTimeoutSeconds: 5,
          },
          clock,
        ),
      );
    },
  };
}

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
  assert.equal(conversation.runtimeId, null);
  assert.equal(conversation.epoch, 0);
  assert.deepEqual(await f.fleet.list(f.operator), []);
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

test('send commits a command and Fleet request atomically, deduplicates, and serializes turns and users', async (t) => {
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
  assert.deepEqual(await f.fleet.list(f.operator), []);
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
  assert.equal((await f.fleet.list(f.operator)).length, 1);
  await assert.rejects(f.send(second), code('pi_runtime_busy'));
  assert.equal((await f.pi.snapshot(f.operator, second.id)).commands.length, 0);
});

test('one runtime per person: a working one is named, an idle one is released for the retry', async (t) => {
  const f = await fixture(t);
  const first = await f.create();
  const second = await f.create();
  await f.send(first);
  const bound = await f.claimed((await f.pi.snapshot(f.operator, first.id)).conversation);
  const retry = { commandId: 'second_turn', text: 'hello' };
  await assert.rejects(
    f.pi.send(f.operator, second.id, retry),
    (error: MervError) =>
      error.code === 'pi_runtime_busy' &&
      error.message ===
        'Your conversation “Chat” in this project is still working; wait for it or stop it',
  );
  await f.pi.begin(bound.token, bound.input);
  await f.pi.complete(
    bound.token,
    f.completion(bound.input.commandId, bound.input.workerId, checkpointTree()),
  );
  await assert.rejects(f.pi.send(f.operator, second.id, retry), code('pi_runtime_releasing'));
  assert.equal((await f.fleet.inspect(f.operator, bound.work.command.runtimeId)).intent, 'stop');
  await f.fleet.tick();
  f.runtimes.release('sbx_1');
  await f.fleet.tick();
  await f.pi.tick();
  assert.equal((await f.pi.send(f.operator, second.id, retry)).status, 'waiting');
});

test('a send after the idle timeout releases the runtime instead of racing its release', async (t) => {
  const f = await fixture(t);
  const conversation = await f.create();
  await f.send(conversation);
  const bound = await f.claimed((await f.pi.snapshot(f.operator, conversation.id)).conversation);
  await f.pi.begin(bound.token, bound.input);
  await f.pi.complete(
    bound.token,
    f.completion(bound.input.commandId, bound.input.workerId, checkpointTree()),
  );
  f.advance(5_000);
  await assert.rejects(f.send(conversation), code('pi_runtime_releasing'));
  assert.equal((await f.fleet.inspect(f.operator, bound.work.command.runtimeId)).intent, 'stop');
});

test('a role change rebinds the conversation on a fresh runtime; a removed member is refused', async (t) => {
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
  const owner = await f.scope.caller(alice, project.id);
  await f.scope.addMember(alice, project.id, { subject: 'bob', role: 'producer' });
  const producer = await f.scope.caller(bob, project.id);
  const conversation = await f.create(producer);
  await f.send(conversation, 'hello', producer);
  const snapshot = await f.pi.snapshot(producer, conversation.id);
  const bound = await f.claimed(snapshot.conversation, 'worker_1', owner);
  await f.pi.begin(bound.token, bound.input);
  await f.pi.complete(
    bound.token,
    f.completion(bound.input.commandId, bound.input.workerId, checkpointTree()),
  );
  await f.scope.changeMemberRole(alice, project.id, { subject: 'bob', role: 'reader' });
  const reader = await f.scope.caller(bob, project.id);
  const retry = { commandId: 'after_role_change', text: 'still here' };
  await assert.rejects(f.pi.send(reader, conversation.id, retry), code('pi_runtime_releasing'));
  await f.fleet.tick();
  f.runtimes.release('sbx_1');
  await f.fleet.tick();
  await f.pi.tick();
  const command = await f.pi.send(reader, conversation.id, retry);
  assert.deepEqual(
    (await f.fleet.inspect(owner, command.runtimeId)).source,
    await f.scope.delegationSource(reader),
  );
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

test('concurrent sends to separate conversations bind at most one runtime per user', async (t) => {
  const f = await fixture(t);
  const left = await f.create();
  const right = await f.create();
  const attempts = await Promise.allSettled([f.send(left), f.send(right)]);
  assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(
    attempts.filter(
      (result) => result.status === 'rejected' && code('pi_runtime_busy')(result.reason),
    ).length,
    1,
  );
  assert.equal((await f.fleet.list(f.operator)).length, 1);
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
  const bound = (await f.pi.snapshot(reader, conversation.id)).conversation;
  const { token, work, input } = await f.claimed(bound);
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
  const checkpoint = checkpointTree('What project is this?');
  const result = f.completion(input.commandId, input.workerId, checkpoint);
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

test('recoverable tool failures and oversized reads come back to the model as results', async (t) => {
  const f = await fixture(t);
  const content = 'line "quoted"\n'.repeat(12_000);
  t.after(
    f.tools.register({
      name: 'artifact.read',
      description: 'Read artifact',
      readOnly: true,
      inputSchema: z.object({ artifactId: z.string().min(1) }).strict(),
      handler: async (_caller, input: { artifactId: string }) => {
        check(input.artifactId === 'art_big', 'not_found', 'Artifact not found', 404);
        return { artifact: { id: 'art_big' }, content, encoding: 'utf8' };
      },
    }),
  );
  const conversation = await f.create();
  await f.send(conversation);
  const { token, input } = await f.claimed(
    (await f.pi.snapshot(f.operator, conversation.id)).conversation,
  );
  await f.pi.begin(token, input);
  const read = (artifactId: string) =>
    f.pi.tool(token, { ...input, name: 'artifact.read', input: { artifactId } });
  assert.deepEqual(await read('art_missing'), {
    error: { code: 'not_found', message: 'Artifact not found' },
  });
  const result = (await read('art_big')) as { content: string; truncated: string };
  assert.ok(JSON.stringify(result).length <= maxTextChars);
  assert.ok(result.content.length > 50_000 && content.startsWith(result.content));
  assert.equal(
    result.truncated,
    `Only the first ${result.content.length} of ${content.length} characters are shown`,
  );
});

test('a finished turn whose tool outputs exceed the result limit keeps its answer', async (t) => {
  const f = await fixture(t);
  const conversation = await f.create();
  await f.send(conversation);
  const bound = await f.claimed((await f.pi.snapshot(f.operator, conversation.id)).conversation);
  await f.pi.begin(bound.token, bound.input);
  const result = f.completion(bound.input.commandId, bound.input.workerId, checkpointTree());
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
  await f.send(conversation);
  const { token, work, input } = await f.claimed(
    (await f.pi.snapshot(f.operator, conversation.id)).conversation,
  );
  await assert.rejects(f.pi.next(token, { workerId: 'other_worker' }), code('pi_worker_conflict'));
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
  await f.send(conversation);
  const first = await f.claimed((await f.pi.snapshot(f.operator, conversation.id)).conversation);
  await f.pi.begin(first.token, first.input);
  const tree = checkpointTree('first', 'sibling');
  const completed = f.completion(first.input.commandId, first.input.workerId, tree);
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
  const next = await f.pi.next(first.token, { workerId: 'worker_2' });
  assert.equal(next?.checkpoint?.content, tree);
  assert.equal(next?.checkpoint?.hash, sha(tree));
  const input = { commandId: next!.command.id, workerId: 'worker_2' };
  await f.pi.begin(first.token, input);
  const newer = checkpointTree('second');
  const result = f.completion(input.commandId, input.workerId, newer);
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
  await f.send(conversation);
  const bound = await f.claimed((await f.pi.snapshot(f.operator, conversation.id)).conversation);
  await f.pi.begin(bound.token, bound.input);
  const result = f.completion(bound.input.commandId, bound.input.workerId, checkpointTree());
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
    await assert.rejects(
      f.pi.next(bound.token, { workerId: 'worker_restore' }),
      code('pi_checkpoint_invalid'),
    );
  } finally {
    f.blobs.get = original;
  }
});

test('concurrent identical completion saves once and preserves the previous checkpoint', async (t) => {
  const f = await fixture(t);
  const conversation = await f.create();
  await f.send(conversation);
  const bound = await f.claimed((await f.pi.snapshot(f.operator, conversation.id)).conversation);
  await f.pi.begin(bound.token, bound.input);
  const result = f.completion(bound.input.commandId, bound.input.workerId, checkpointTree());
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
  await f.send(conversation);
  const bound = await f.claimed((await f.pi.snapshot(f.operator, conversation.id)).conversation);
  await f.pi.begin(bound.token, bound.input);
  const result = f.completion(bound.input.commandId, bound.input.workerId, checkpointTree());
  const original = f.blobs.put;
  f.blobs.put = async (namespace, bytes) => {
    await f.pi.stop(f.operator, conversation.id);
    return original(namespace, bytes);
  };
  try {
    await assert.rejects(f.pi.complete(bound.token, result), code('pi_runtime_stale'));
  } finally {
    f.blobs.put = original;
  }
  const snapshot = await f.pi.snapshot(f.operator, conversation.id);
  assert.equal(snapshot.commands[0].status, 'interrupted');
  assert.equal(snapshot.commands[0].error, 'cancelled');
  assert.deepEqual(snapshot.commands[0].messages.slice(1), result.messages);
  assert.equal(snapshot.conversation.checkpoint, null);
});

test('progress bursts do not add durable writes; stop and revocation fence work', async (t) => {
  const f = await fixture(t);
  const conversation = await f.create();
  await f.send(conversation);
  const bound = await f.claimed((await f.pi.snapshot(f.operator, conversation.id)).conversation);
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
  assert.equal(writes() - before, 0);
  const stopped = await f.pi.stop(f.operator, conversation.id);
  assert.equal(stopped.commands[0].error, 'cancelled');
  assert.equal((await f.fleet.inspect(f.operator, bound.work.command.runtimeId)).intent, 'stop');
  await assert.rejects(
    f.pi.tool(bound.token, { ...bound.input, name: 'project.get', input: {} }),
    code('pi_runtime_stale'),
  );
  assert.equal(f.reads, 0);
});

test('revoking the source credential fences a claimed worker and stops Fleet admission', async (t) => {
  const f = await fixture(t);
  const issued = await f.scope.issueActor(f.operator, { name: 'Revocable reader', role: 'reader' });
  const reader: Caller = {
    projectId: f.operator.projectId,
    actorId: issued.actor.id,
    credentialId: issued.credential.id,
  };
  const conversation = await f.create(reader);
  await f.send(conversation, 'Read this', reader);
  const bound = await f.claimed((await f.pi.snapshot(reader, conversation.id)).conversation);
  await f.pi.begin(bound.token, bound.input);
  await f.scope.revokeCredential(f.operator, issued.credential.id);
  await assert.rejects(
    f.pi.tool(bound.token, { ...bound.input, name: 'project.get', input: {} }),
    code('pi_runtime_stale'),
  );
  await assert.rejects(f.pi.authenticateWorker(bound.token), code('pi_runtime_stale'));
  assert.equal(f.reads, 0);
  await f.fleet.tick();
  assert.equal((await f.fleet.inspect(f.operator, bound.work.command.runtimeId)).intent, 'stop');
});

test('idle release waits for retained checkpoint; restarted service restores full tree on a new runtime', async (t) => {
  const f = await fixture(t);
  const conversation = await f.create();
  await f.send(conversation);
  const first = await f.claimed((await f.pi.snapshot(f.operator, conversation.id)).conversation);
  await f.pi.begin(first.token, first.input);
  const fullTree = checkpointTree('restored', 'sibling');
  await f.pi.complete(
    first.token,
    f.completion(first.input.commandId, first.input.workerId, fullTree),
  );
  await f.fleet.tick();
  assert.equal((await f.fleet.inspect(f.operator, first.work.command.runtimeId)).intent, 'run');
  assert.deepEqual(f.runtimes.stopped, []);
  await f.restart();
  assert.equal((await f.fleet.inspect(f.operator, first.work.command.runtimeId)).intent, 'stop');
  await f.fleet.tick();
  assert.deepEqual(f.runtimes.stopped, ['sbx_1']);
  f.runtimes.release('sbx_1');
  await f.fleet.tick();
  await f.pi.tick();
  const released = (await f.pi.snapshot(f.operator, conversation.id)).conversation;
  assert.equal(released.runtimeId, null);
  assert.equal(released.checkpoint?.hash, sha(fullTree));
  await assert.rejects(f.pi.authenticateWorker(first.token), code('pi_unauthorized'));
  await f.send(conversation, 'Continue');
  const second = await f.claimed(
    (await f.pi.snapshot(f.operator, conversation.id)).conversation,
    'restored_worker',
  );
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
    return { error: snapshot.commands.at(-1)!.error, runtimeId: snapshot.conversation.runtimeId };
  };
  const refused = await f.fleet.inspect(f.operator, (await f.send(conversation)).runtimeId);
  await f.state.transaction((tx) =>
    tx.run(
      "UPDATE fleet_allocations SET phase='released',data_json=? WHERE id=?",
      JSON.stringify({ ...refused, phase: 'released', intent: 'stop', error: 'runtime_refused' }),
      refused.id,
    ),
  );
  await f.pi.tick();
  assert.deepEqual(await latest(), { error: 'runtime_refused', runtimeId: null });
  const deleted = (await f.send(conversation)).runtimeId;
  await f.state.transaction((tx) => tx.run('DELETE FROM fleet_allocations WHERE id=?', deleted));
  await f.pi.tick();
  assert.deepEqual(await latest(), { error: 'runtime_lost', runtimeId: null });
  await f.send(conversation);
  const bound = await f.claimed((await f.pi.snapshot(f.operator, conversation.id)).conversation);
  await f.pi.begin(bound.token, bound.input);
  await f.fleet.drain(f.operator, bound.work.command.runtimeId);
  await f.pi.tick();
  assert.equal((await latest()).error, 'runtime_stopped');
  await f.fleet.tick();
  assert.equal((await f.fleet.inspect(f.operator, bound.work.command.runtimeId)).intent, 'stop');
});

test('a turn that expires before its machine launches releases the allocation unrented', async (t) => {
  const f = await fixture(t);
  const conversation = await f.create();
  const command = await f.send(conversation);
  f.advance(300_001);
  await f.pi.tick();
  const snapshot = await f.pi.snapshot(f.operator, conversation.id);
  assert.equal(snapshot.commands[0].error, 'turn_expired');
  assert.equal(snapshot.conversation.runtimeId, null);
  assert.equal((await f.fleet.inspect(f.operator, command.runtimeId)).phase, 'released');
  await f.fleet.tick();
  assert.deepEqual(f.runtimes.launched, []);
});

test('a machine being prepared reads as starting, and the turn clock starts at the claim', async (t) => {
  const f = await fixture(t);
  const conversation = await f.create();
  await f.send(conversation);
  f.advance(200_000);
  await f.fleet.tick();
  await f.pi.tick();
  const snapshot = await f.pi.snapshot(f.operator, conversation.id);
  assert.equal(snapshot.commands[0].status, 'starting');
  const { work } = await f.claimed(snapshot.conversation);
  assert.equal(work.command.expiresAt, new Date(Date.parse('2026-09-23T00:08:20Z')).toISOString());
});

test('idle timeout releases only after successful retention, never while a checkpoint is saving', async (t) => {
  const f = await fixture(t);
  const conversation = await f.create();
  await f.send(conversation);
  const bound = await f.claimed((await f.pi.snapshot(f.operator, conversation.id)).conversation);
  await f.pi.begin(bound.token, bound.input);
  f.failStorage(true);
  const result = f.completion(bound.input.commandId, bound.input.workerId, checkpointTree());
  assert.deepEqual(await f.pi.complete(bound.token, result), { saved: false });
  f.advance(5_100);
  await f.fleet.tick();
  assert.equal((await f.fleet.inspect(f.operator, bound.work.command.runtimeId)).intent, 'run');
  assert.deepEqual(f.runtimes.stopped, []);
  f.failStorage(false);
  assert.deepEqual(await f.pi.complete(bound.token, result), { saved: true });
  await f.fleet.tick();
  assert.equal((await f.fleet.inspect(f.operator, bound.work.command.runtimeId)).intent, 'run');
  f.advance(5_100);
  await f.fleet.tick();
  assert.equal((await f.fleet.inspect(f.operator, bound.work.command.runtimeId)).intent, 'stop');
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
    const f = await fixture(t, origin, Date.now());
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
      const allocation = await f.fleet.inspect(f.operator, command.runtimeId);
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
    await f.pi.tick();
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

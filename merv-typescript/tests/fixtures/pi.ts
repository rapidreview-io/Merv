import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { z } from 'zod';
import { DiskBlobs } from '@merv/blobs';
import { createService, type Blobs, type Caller, type MervError } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { ToolRegistry } from '../../packages/api/src/registry.js';
import { FleetService } from '../../packages/fleet/src/index.js';
import { PiService, type PiConfig } from '../../packages/pi/src/index.js';
import type {
  PiBootstrap,
  PiCommand,
  PiConversation,
  PiHostRecord,
  PiPersonRecord,
} from '../../packages/pi/src/types.js';
import { FakeRuntimes } from './runtimes.js';
import { openState } from './state.js';

export { FakeRuntimes, offers } from './runtimes.js';

process.env.MERV_PI_SECRET ??= 'pi-service-integration-tests-only-32-characters';
export const sha = (text: string) => createHash('sha256').update(text).digest('hex');
export const code = (name: string) => (error: unknown) => (error as MervError)?.code === name;

export function checkpointTree(text = 'Earlier', branch = 'active'): string {
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

/** Explicit legacy catalog: keeps model-selection and upgrade regressions independent of defaults. */
export const models = [
  { id: 'gpt-6-luna', label: 'GPT-6 Luna', inputUsdPerM: 0.1, outputUsdPerM: 0.5, effort: 'none' },
  { id: 'gpt-6-sol', label: 'GPT-6 Sol', inputUsdPerM: 2, outputUsdPerM: 10, effort: 'none' },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra', inputUsdPerM: 10, outputUsdPerM: 50, effort: 'low' },
] as const;

/** Pi on Postgres with its own host project, whose key rents every machine, and a person's
 * project with an operator. Tests tick Fleet and Pi themselves. */
export async function fixture(
  t: TestContext,
  options: { baseUrl?: string; startTime?: number; pi?: PiConfig; machines?: number } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-pi-service-'));
  const state = await openState(directory);
  const scope = await createService(new ProjectScope(state));
  const hostBoot = await scope.bootstrap({ projectName: 'Pi host', actorName: 'Pi host' });
  const hostCaller: Caller = {
    projectId: hostBoot.project.id,
    actorId: hostBoot.actor.id,
    credentialId: hostBoot.credential.id,
  };
  const credentialEnv = `MERV_PI_HOST_KEY_${randomUUID().replaceAll('-', '')}`;
  process.env[credentialEnv] = hostBoot.token;
  const admin = await scope.bootstrap({ projectName: 'Pi integration', actorName: 'Operator' });
  const operator: Caller = {
    projectId: admin.project.id,
    actorId: admin.actor.id,
    credentialId: admin.credential.id,
  };
  const runtimes = new FakeRuntimes();
  let now = options.startTime ?? Date.parse('2026-09-23T00:00:00Z');
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
      {
        enabled: true,
        globalLimit: options.machines ?? 8,
        projectLimit: options.machines ?? 8,
        allocationTimeoutSeconds: 3600,
        // As deployed: Fleet's host is Pi's, and Pi's own rules must not notice.
        hostProjectId: hostBoot.project.id,
      },
      clock,
    ),
  );
  // Tests tick Fleet themselves; a kick is only counted.
  let kicks = 0;
  fleet.kick = () => void kicks++;
  const disk = new DiskBlobs(join(directory, 'blobs'));
  let failPut = false;
  const blobs: Blobs = {
    put: (namespace, bytes) =>
      failPut ? Promise.reject(new Error('disk unavailable')) : disk.put(namespace, bytes),
    get: (namespace, digest) => disk.get(namespace, digest),
  };
  const config: PiConfig = {
    enabled: true,
    baseUrl: options.baseUrl ?? 'http://127.0.0.1:31415/',
    pollIntervalMs: 30_000,
    idleTimeoutSeconds: 5,
    host: { projectId: hostBoot.project.id, credentialEnv },
    machines: [
      { key: 'standard', label: 'Standard', slots: 3 },
      { key: 'large', label: 'Large', slots: 4, agent: true },
    ],
    agentMoves: true,
    models: [...models],
    ...options.pi,
  };
  const start = () =>
    createService(new PiService(state, scope, fleet, tools, blobs, config, clock));
  let pi = await start();
  let sequence = 0;
  t.after(async () => {
    await pi.close();
    await fleet.close();
    await tools.close();
    await state.close();
    delete process.env[credentialEnv];
    rmSync(directory, { recursive: true, force: true });
  });
  const create = (caller = operator) =>
    pi.create(caller, { requestId: `open_${++sequence}`, title: 'Chat' });
  const send = (conversation: PiConversation, text = 'hello', caller = operator) =>
    pi.send(caller, conversation.id, { commandId: `turn_${++sequence}`, text });
  const allocation = (id: string) => fleet.inspect(hostCaller, id);
  /** The worker credential of a slot's machine, as Fleet's launch would deliver it. */
  const token = async (allocationId: string) =>
    (JSON.parse(await pi.bootstrap(await allocation(allocationId))) as PiBootstrap).workerToken;
  /** The host a turn runs on, or every live one. */
  const host = async (command: Pick<PiCommand, 'hostId'>) =>
    (await state.read((sql) =>
      sql
        .get<{ data_json: string }>('SELECT data_json FROM pi_hosts WHERE id=?', command.hostId!)
        .then((row) => JSON.parse(row!.data_json) as PiHostRecord),
    ))!;
  const hosts = () =>
    state.read(async (sql) =>
      (
        await sql.all<{ data_json: string }>(
          "SELECT data_json FROM pi_hosts WHERE status='live' ORDER BY created_at,id",
        )
      ).map((row) => JSON.parse(row.data_json) as PiHostRecord),
    );
  const person = (key: string) =>
    state.read(async (sql) => {
      const row = await sql.get<{ data_json: string }>(
        'SELECT data_json FROM pi_people WHERE key=?',
        key,
      );
      return row ? (JSON.parse(row.data_json) as PiPersonRecord) : null;
    });
  /** Fleet provisions and launches the slot's machine, and a worker claims the command. */
  async function claimed(command: PiCommand, workerId = 'worker_1') {
    const credential = await token(command.runtimeId);
    await fleet.tick();
    await fleet.tick();
    assert.equal((await allocation(command.runtimeId)).phase, 'starting');
    const { work } = await pi.next(credential, { workerId });
    assert.ok(work);
    const input = { conversationId: command.conversationId, commandId: work.command.id, workerId };
    return { token: credential, work, input };
  }
  const completion = (
    input: { conversationId: string; commandId: string; workerId: string },
    checkpoint = checkpointTree(),
  ) => ({
    ...input,
    messages: [{ role: 'assistant' as const, text: `answer ${input.commandId}` }],
    outcomes: [] as { callId: string; name: string; input: object; output: unknown }[],
    checkpoint,
    checkpointHash: sha(checkpoint),
  });
  /** `caller`'s new conversation, with a turn a worker has claimed and begun on its person's
   * host, which may already run. */
  async function begun(caller: Caller, text = 'hello') {
    const conversation = await create(caller);
    const command = await send(conversation, text, caller);
    const credential = await token(command.runtimeId);
    await fleet.tick();
    await fleet.tick();
    const { work } = await pi.next(credential, { workerId: 'worker_1' });
    assert.ok(work);
    const input = {
      conversationId: conversation.id,
      commandId: work.command.id,
      workerId: 'worker_1',
    };
    assert.deepEqual(await pi.begin(credential, input), { apply: true });
    return { conversation, token: credential, work, input };
  }
  /** Begins and completes a claimed turn. */
  const finish = async (bound: Awaited<ReturnType<typeof claimed>>, tree?: string) => {
    await pi.begin(bound.token, bound.input);
    return pi.complete(bound.token, completion(bound.input, tree));
  };
  return {
    state,
    scope,
    operator,
    hostCaller,
    runtimes,
    fleet,
    tools,
    blobs,
    disk,
    create,
    send,
    allocation,
    token,
    host,
    hosts,
    person,
    claimed,
    begun,
    completion,
    finish,
    get pi() {
      return pi;
    },
    get reads() {
      return reads;
    },
    get mutations() {
      return mutations;
    },
    get kicks() {
      return kicks;
    },
    failStorage: (value: boolean) => {
      failPut = value;
    },
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    /** A new service on the same state, with `changes` to its configuration. */
    restart: async (changes: PiConfig = {}) => {
      await pi.close();
      Object.assign(config, changes);
      pi = await start();
    },
  };
}
export type PiFixture = Awaited<ReturnType<typeof fixture>>;

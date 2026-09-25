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
import type { SandboxRuntimeHandle, SandboxRuntimes } from '@merv/sandboxes';
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
import { openState } from './state.js';

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

/** The production catalog (MERV_PI_MODELS): Luna the default, Astra the one that reasons. */
export const models = [
  { id: 'gpt-6-luna', label: 'GPT-6 Luna', inputUsdPerM: 0.1, outputUsdPerM: 0.5, effort: 'none' },
  { id: 'gpt-6-sol', label: 'GPT-6 Sol', inputUsdPerM: 2, outputUsdPerM: 10, effort: 'none' },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra', inputUsdPerM: 10, outputUsdPerM: 50, effort: 'low' },
] as const;

/** Offers as Sandboxes describes Cloudflare standard-1 and standard-3. */
export const offers: Record<string, Awaited<ReturnType<SandboxRuntimes['describe']>>> = {
  standard: { key: 'standard', vcpu: 0.5, memoryGiB: 4, diskGB: 8, maxHourlyUsd: 0.074 },
  large: { key: 'large', vcpu: 2, memoryGiB: 8, diskGB: 16, maxHourlyUsd: 0.22 },
};

export class FakeRuntimes implements SandboxRuntimes {
  profileId = 'pi-test-profile';
  leaseSeconds = 600;
  get profiles() {
    return [
      { key: 'standard', id: this.profileId, leaseSeconds: this.leaseSeconds },
      { key: 'large', id: 'pi-test-large', leaseSeconds: this.leaseSeconds },
    ];
  }
  describe = async (_projectId: string, key: string) => offers[key] ?? null;
  connected: (projectId: string) => boolean = () => true;
  readonly handles = new Map<string, SandboxRuntimeHandle>();
  readonly launched: string[] = [];
  readonly stopped: string[] = [];

  private find(sandboxId: string): SandboxRuntimeHandle {
    const handle = [...this.handles.values()].find((item) => item.sandboxId === sandboxId);
    assert.ok(handle);
    return handle;
  }
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
    return structuredClone(this.find(current.sandboxId));
  }
  async launch(
    _projectId: string,
    current: SandboxRuntimeHandle,
    key: string,
  ): Promise<SandboxRuntimeHandle> {
    const handle = this.find(current.sandboxId);
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
    const handle = this.find(current.sandboxId);
    assert.ok(handle.launch);
    handle.launch.state = 'consumed';
    return structuredClone(handle);
  }
  async stop(_projectId: string, current: SandboxRuntimeHandle): Promise<SandboxRuntimeHandle> {
    const handle = this.find(current.sandboxId);
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
    const handle = this.find(sandboxId);
    handle.state = 'stopped';
    handle.deleted = true;
    handle.ready = false;
    handle.revision++;
  }
}

/** Pi on Postgres with its own host project, whose key rents every machine, and a person's
 * project with an operator. Tests tick Fleet and Pi themselves. */
export async function fixture(
  t: TestContext,
  options: { baseUrl?: string; startTime?: number; pi?: PiConfig } = {},
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
      { enabled: true, globalLimit: 8, projectLimit: 8, allocationTimeoutSeconds: 3600 },
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

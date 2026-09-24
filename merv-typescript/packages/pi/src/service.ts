import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  check,
  digest,
  newId,
  plain,
  MervError,
  type Blobs,
  type Caller,
  type Data,
  type DelegationSource,
  type Scope,
  type Sql,
  type State,
  type Transaction,
} from '@merv/contracts';
import type { Tools } from '@merv/api/types';
import type { Fleet, FleetAllocation, FleetOwner } from '@merv/fleet/types';
import {
  commandInput,
  completionInput,
  createInput,
  defaultTitle,
  migration,
  piConfig,
  sendInput,
  warmInput,
  workerInput,
  type PiConfig,
} from './schema.js';
import { PiStreams } from './stream.js';
import { decodeCheckpoint } from './checkpoint.js';
import { piTitle } from './relay.js';
import { piModelToolName } from './tool-names.js';
import type {
  Pi,
  PiBootstrap,
  PiCommand,
  PiCommandRecord,
  PiCompletion,
  PiConversation,
  PiConversationRecord,
  PiInterruption,
  PiMessage,
  PiSnapshot,
  PiStage,
  PiStageName,
  PiToolOutcome,
  PiWork,
} from './types.js';

const active = new Set(['waiting', 'starting', 'working', 'saving']);
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const equal = (left: string, right: string) =>
  left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const constraints: Record<string, z.ZodTypeAny> = {
  'project.get': z.object({}).strict(),
  'task.list': z.object({}).strict(),
  'artifact.list': z.object({}).strict(),
  'artifact.get': z.object({ artifactId: z.string().min(1).max(200) }).strict(),
  'artifact.read': z.object({ artifactId: z.string().min(1).max(200) }).strict(),
};
export const piReadTools = Object.freeze(Object.keys(constraints));
const phrases: Record<string, string> = {
  'project.get': 'Reading the project',
  'task.list': 'Listing tasks',
  'artifact.list': 'Listing files',
  'artifact.get': 'Reading a file',
  'artifact.read': 'Reading a file',
};
/** Fleet reserves within a second of a send, so a request queued this long waits for capacity. */
const queuedMs = 3000;
/** A quarter of the worker model's 32,000-token window, which replays each result in later turns.
 * UTF-8 bytes track tokens better than characters and stay inside the relay's string limit. */
const resultBytes = 24_000;
const decode = <T>(row: { data_json: string }): T => JSON.parse(row.data_json) as T;
const publicConversation = (record: PiConversationRecord): PiConversation => {
  const {
    source: _source,
    runtimeEpoch: _epoch,
    runtimeExpiresAt: _expires,
    idleSince: _idle,
    ...value
  } = record;
  return value;
};
const publicCommand = (record: PiCommandRecord): PiCommand => {
  const { inputHash: _input, workerId: _worker, resultHash: _result, ...value } = record;
  return value;
};
function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(plain(value));
  check(parsed.success, 'invalid_pi_input', 'Invalid conversation request');
  return parsed.data;
}

export class PiService implements Pi, FleetOwner {
  readonly sourcePermission = 'read' as const;
  readonly streams = new PiStreams();
  readonly config: z.output<typeof piConfig>;
  private readonly secret: string;
  private readonly disposers: (() => void)[] = [];
  /** Memory only, never State: the stage each live conversation last showed, what its worker last
   * reported within a turn, and the runtime whose worker has asked for work. */
  private readonly live = new Map<
    string,
    { stage?: PiStage; turn?: PiStage & { commandId: string }; runtimeId?: string | null }
  >();
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private closed = false;

  constructor(
    private readonly state: State,
    private readonly scope: Scope,
    private readonly fleet: Fleet,
    private readonly tools: Tools,
    private readonly blobs: Blobs,
    config: PiConfig = {},
    private readonly clock: () => number = Date.now,
  ) {
    this.config = parse(piConfig, config);
    this.secret = process.env[this.config.secretEnv] ?? '';
    check(
      !this.config.enabled || (this.secret.length >= 32 && this.config.baseUrl),
      'pi_configuration',
      'Enabled Pi needs a private signing secret and API URL',
      503,
    );
    if (this.config.baseUrl) {
      const url = new URL(this.config.baseUrl);
      check(
        !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          url.pathname === '/' &&
          (url.protocol === 'https:' ||
            (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))),
        'pi_configuration',
        'Pi requires an HTTPS API origin',
      );
    }
  }

  async initialize(): Promise<void> {
    await this.state.migrate('pi', [migration]);
    if (!this.config.enabled) return;
    this.disposers.push(this.fleet.registerOwner('pi', this));
    this.disposers.push(
      this.scope.registerConversationAuthority({
        require: (caller, tx) => this.requireConversation(caller, tx),
      }),
    );
    this.disposers.push(
      this.tools.registerConversationPolicy({
        allowsTool: async (caller, name) => {
          await this.scope.require(caller, 'read');
          return Object.hasOwn(constraints, name);
        },
        validate: async (caller, name, input) => {
          await this.scope.require(caller, 'read');
          check(
            Object.hasOwn(constraints, name) && constraints[name].safeParse(input).success,
            'pi_tool_forbidden',
            'Conversation tool or arguments are not allowed',
            403,
          );
        },
      }),
    );
    await this.tick();
    this.timer = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, this.config.pollIntervalMs);
    this.timer.unref();
  }

  private ready(): void {
    check(
      this.config.enabled && !this.closed,
      'pi_unavailable',
      'Agent conversations are unavailable',
      503,
    );
  }
  private time(): string {
    return new Date(this.clock()).toISOString();
  }
  private read<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.state.snapshot(() => this.state.transaction(fn));
  }
  private async conversation(sql: Sql, id: string): Promise<PiConversationRecord> {
    const row = await sql.get<{ data_json: string }>(
      'SELECT data_json FROM pi_conversations WHERE id=?',
      id,
    );
    check(row, 'pi_not_found', 'Conversation not found', 404);
    return decode(row);
  }
  private async command(sql: Sql, conversationId: string, id: string): Promise<PiCommandRecord> {
    const row = await sql.get<{ data_json: string }>(
      'SELECT data_json FROM pi_commands WHERE conversation_id=? AND id=?',
      conversationId,
      id,
    );
    check(row, 'pi_command_not_found', 'Conversation command not found', 404);
    return decode(row);
  }
  private async saveConversation(
    tx: Transaction,
    conversation: PiConversationRecord,
  ): Promise<void> {
    conversation.revision++;
    conversation.updatedAt = this.time();
    await tx.run(
      'UPDATE pi_conversations SET runtime_id=?,data_json=? WHERE id=?',
      conversation.runtimeId,
      JSON.stringify(conversation),
      conversation.id,
    );
  }
  private async saveCommand(tx: Transaction, command: PiCommandRecord): Promise<void> {
    await tx.run(
      'UPDATE pi_commands SET status=?,data_json=? WHERE conversation_id=? AND id=?',
      command.status,
      JSON.stringify(command),
      command.conversationId,
      command.id,
    );
  }
  private async user(caller: Caller, tx: Transaction): Promise<string> {
    check(
      !caller.session && !caller.managed && !caller.conversation,
      'pi_forbidden',
      'Workers cannot control conversations',
      403,
    );
    const actor = await this.scope.require(caller, 'read', tx);
    return digest(
      actor.user
        ? { issuer: actor.user.issuer, subject: actor.user.subject }
        : { projectId: caller.projectId, actorId: caller.actorId },
    );
  }
  private async owned(caller: Caller, id: string, tx: Transaction): Promise<PiConversationRecord> {
    const userId = await this.user(caller, tx);
    const conversation = await this.conversation(tx, id);
    check(
      conversation.projectId === caller.projectId && conversation.userId === userId,
      'pi_not_found',
      'Conversation not found',
      404,
    );
    return conversation;
  }
  private signature(kind: string, value: unknown): string {
    return createHmac('sha256', this.secret)
      .update(JSON.stringify([kind, value]))
      .digest('base64url');
  }
  private workerToken(conversation: PiConversationRecord): string {
    return `piw_${conversation.runtimeId}.${this.signature('worker', [conversation.id, conversation.runtimeId, conversation.epoch])}`;
  }
  private modelToken(command: PiCommandRecord): string {
    return `pir_${this.signature('model', [command.conversationId, command.id, command.epoch, command.runtimeId])}`;
  }

  async create(caller: Caller, input: unknown): Promise<PiConversation> {
    this.ready();
    const value = parse(createInput, input);
    return this.state.transaction(async (tx) => {
      const userId = await this.user(caller, tx);
      const existing = await tx.get<{ data_json: string; input_hash: string }>(
        'SELECT data_json,input_hash FROM pi_conversations WHERE project_id=? AND user_id=? AND request_id=?',
        caller.projectId,
        userId,
        value.requestId,
      );
      if (existing) {
        check(
          existing.input_hash === digest(value),
          'pi_request_conflict',
          'Conversation request was reused with different input',
          409,
        );
        return publicConversation(decode(existing));
      }
      const source = await this.scope.delegationSource(caller, tx);
      const conversation: PiConversationRecord = {
        id: newId('pic'),
        projectId: caller.projectId,
        userId,
        title: value.title,
        revision: 1,
        epoch: 0,
        runtimeId: null,
        runtimeEpoch: null,
        runtimeExpiresAt: null,
        activeCommandId: null,
        checkpoint: null,
        previousCheckpoint: null,
        source,
        idleSince: null,
        createdAt: this.time(),
        updatedAt: this.time(),
      };
      await tx.run(
        'INSERT INTO pi_conversations(id,project_id,user_id,request_id,input_hash,runtime_id,data_json) VALUES(?,?,?,?,?,?,?)',
        conversation.id,
        conversation.projectId,
        userId,
        value.requestId,
        digest(value),
        null,
        JSON.stringify(conversation),
      );
      return publicConversation(conversation);
    });
  }

  async list(caller: Caller): Promise<PiConversation[]> {
    this.ready();
    return this.read(async (tx) => {
      const userId = await this.user(caller, tx);
      return (
        await tx.all<{ data_json: string }>(
          "SELECT data_json FROM pi_conversations WHERE project_id=? AND user_id=? ORDER BY data_json::jsonb->>'updatedAt' DESC,id DESC LIMIT 100",
          caller.projectId,
          userId,
        )
      ).map((row) => publicConversation(decode(row)));
    });
  }

  async snapshot(caller: Caller, id: string): Promise<PiSnapshot> {
    this.ready();
    await this.authorizeStream(caller, id);
    const transient = this.streams.snapshot(id);
    const { conversation, commands, allocation } = await this.read(async (tx) => {
      const conversation = await this.owned(caller, id, tx);
      const rows = await tx.all<{ data_json: string }>(
        'SELECT data_json FROM pi_commands WHERE conversation_id=? ORDER BY created_at,id',
        id,
      );
      const runtime = conversation.runtimeId && (await this.allocation(conversation.runtimeId, tx));
      return {
        conversation,
        commands: rows.map(decode<PiCommandRecord>),
        allocation: runtime || null,
      };
    });
    await this.scope.require(caller, 'read');
    const turn = commands.find((command) => command.id === conversation.activeCommandId);
    return {
      stage: this.stage(conversation, turn ?? null, allocation),
      available: this.fleet.connected(caller.projectId),
      conversation: publicConversation(conversation),
      commands: commands.map(publicCommand),
      ...transient,
    };
  }
  /** What the person waits on now, from the turn, its machine and what the worker last reported. */
  private stage(
    conversation: PiConversationRecord,
    command: PiCommandRecord | null,
    allocation: FleetAllocation | null,
  ): PiStage {
    const { id } = conversation;
    const live = this.live.get(id);
    if (command?.status === 'saving') return this.show(id, { name: 'saving' });
    if (command?.status === 'working')
      return this.show(
        id,
        live?.turn?.commandId === command.id
          ? live.turn
          : command.firstTextAt
            ? { name: 'writing', since: command.firstTextAt }
            : { name: 'thinking', since: command.startedAt },
      );
    if (
      allocation?.intent !== 'run' ||
      ['releasing', 'released'].includes(allocation.phase) ||
      (!command && this.idle(conversation))
    )
      return this.show(id, { name: 'idle', since: conversation.updatedAt });
    if (allocation.runtime?.launch?.deliveryState !== 'launched') {
      const waited = Date.parse(allocation.createdAt) + queuedMs < this.clock();
      return this.show(id, {
        name: allocation.phase === 'queued' && waited ? 'queued' : 'machine',
      });
    }
    return this.show(id, {
      name: command || live?.runtimeId !== allocation.id ? 'agent' : 'ready',
    });
  }
  /** Keeps a stage's start while it lasts, and wakes open pages when it moves. */
  private show(id: string, next: Omit<PiStage, 'since'> & { since?: string }): PiStage {
    const live = this.live.get(id);
    const last = live?.stage ?? { name: 'idle', since: next.since ?? this.time() };
    if (last.name === next.name && last.detail === next.detail) return last;
    const stage: PiStage = { name: next.name, since: next.since ?? this.time() };
    if (next.detail) stage.detail = next.detail;
    if (next.name === 'idle') this.live.delete(id);
    else this.live.set(id, { ...live, stage });
    this.streams.publish(id, { commandId: '', type: 'changed', text: '' });
    return stage;
  }
  /** What the worker does within its turn: kept in memory and shown at once. */
  private report(id: string, commandId: string, name: PiStageName, detail?: string): void {
    const turn = { name, since: this.time(), commandId, detail };
    this.live.set(id, { ...this.live.get(id), turn });
    this.show(id, turn);
  }
  /** A turn or runtime moved: open pages reload it, and Fleet reconciles now, not at its tick. */
  private changed(id: string, commandId?: string): void {
    this.streams.changed(id, commandId);
    this.fleet.kick();
  }
  async authorizeStream(caller: Caller, id: string): Promise<void> {
    this.ready();
    await this.read((tx) => this.owned(caller, id, tx));
  }

  async send(caller: Caller, id: string, input: unknown): Promise<PiCommand> {
    this.ready();
    const value = parse(sendInput, input);
    // A string result is the reason a previous runtime is releasing: commit that, then refuse.
    const result = await this.state.transaction(async (tx): Promise<PiCommand | string> => {
      const conversation = await this.owned(caller, id, tx);
      const existing = await tx.get<{ data_json: string }>(
        'SELECT data_json FROM pi_commands WHERE conversation_id=? AND id=?',
        id,
        value.commandId,
      );
      if (existing) {
        const command = decode<PiCommandRecord>(existing);
        check(
          command.inputHash === digest(value),
          'pi_command_conflict',
          'Command ID was reused with different input',
          409,
        );
        return publicCommand(command);
      }
      check(
        !conversation.activeCommandId,
        'pi_turn_busy',
        'This conversation already has an active turn',
        409,
      );
      const count = await tx.get<{ count: number }>(
        'SELECT COUNT(*)::integer AS count FROM pi_commands WHERE conversation_id=?',
        id,
      );
      check(
        (count?.count ?? 0) < 100,
        'pi_conversation_full',
        'Open a new conversation to continue',
        409,
      );
      conversation.activeCommandId = value.commandId;
      const allocation = await this.runtime(caller, conversation, tx);
      if (typeof allocation === 'string') return allocation;
      conversation.idleSince = null;
      const queued = allocation.phase === 'queued';
      const expiry = this.turnEnd(conversation, queued);
      check(expiry > this.clock(), 'pi_expired', 'Conversation source has expired', 403);
      const command: PiCommandRecord = {
        id: value.commandId,
        conversationId: id,
        epoch: conversation.epoch,
        runtimeId: conversation.runtimeId!,
        status: queued ? 'waiting' : 'starting',
        messages: [{ role: 'user', text: value.text }],
        outcomes: [],
        error: null,
        createdAt: this.time(),
        expiresAt: new Date(expiry).toISOString(),
        completedAt: null,
        inputHash: digest(value),
        workerId: null,
        resultHash: null,
      };
      await tx.run(
        'INSERT INTO pi_commands(id,conversation_id,status,relay_hash,created_at,data_json) VALUES(?,?,?,?,?,?)',
        command.id,
        id,
        command.status,
        hash(this.modelToken(command)),
        command.createdAt,
        JSON.stringify(command),
      );
      await this.saveConversation(tx, conversation);
      return publicCommand(command);
    });
    if (typeof result === 'string') throw new MervError('pi_runtime_releasing', result, 409);
    this.streams.changed(id, result.id);
    return result;
  }

  async warm(caller: Caller, input: unknown): Promise<PiSnapshot> {
    this.ready();
    const value = parse(warmInput, input);
    const empty = async (tx: Transaction) =>
      tx.get<{ id: string }>(
        `SELECT id FROM pi_conversations c WHERE project_id=? AND user_id=?
          AND NOT EXISTS (SELECT 1 FROM pi_commands WHERE conversation_id=c.id)
          ORDER BY data_json::jsonb->>'updatedAt' DESC,id DESC LIMIT 1`,
        caller.projectId,
        await this.user(caller, tx),
      );
    const id =
      value.conversationId ??
      (await this.read(empty))?.id ??
      (await this.create(caller, { requestId: value.requestId })).id;
    if (!this.fleet.connected(caller.projectId)) return this.snapshot(caller, id);
    // A string is why an earlier runtime is releasing; a turn elsewhere keeps the person's runtime.
    const result = await this.state
      .transaction(async (tx): Promise<string | boolean> => {
        const conversation = await this.owned(caller, id, tx);
        if (conversation.activeCommandId) return false;
        const fresh = !conversation.runtimeId;
        // Unused, a warm runtime is released after the idle timeout like any other.
        if (fresh) conversation.idleSince = this.time();
        const allocation = await this.runtime(caller, conversation, tx);
        if (typeof allocation === 'string') return allocation;
        if (fresh) await this.saveConversation(tx, conversation);
        return fresh;
      })
      .catch((error: unknown) => {
        if (error instanceof MervError && error.code === 'pi_runtime_busy') return false;
        throw error;
      });
    if (typeof result === 'string') throw new MervError('pi_runtime_releasing', result, 409);
    if (result) this.streams.changed(id);
    return this.snapshot(caller, id);
  }
  /** The conversation's runtime, requested when it has none; a string says why an earlier one is
   * releasing, to commit and then refuse. One runtime per person across projects. */
  private async runtime(
    caller: Caller,
    conversation: PiConversationRecord,
    tx: Transaction,
  ): Promise<FleetAllocation | string> {
    if (conversation.runtimeId) {
      const allocation = await this.allocation(conversation.runtimeId, tx);
      // Reuse only a runtime Fleet keeps (not idle past its release) that holds the caller's
      // current authority: a role change issues a new membership, so rebind on a new runtime.
      if (
        allocation?.intent === 'run' &&
        !['releasing', 'released'].includes(allocation.phase) &&
        allocation.deadlineAt > this.time() &&
        !this.idle(conversation) &&
        digest(await this.scope.delegationSource(caller, tx)) === digest(conversation.source)
      )
        return allocation;
      await this.release(conversation.runtimeId, tx);
      return 'The previous agent is still releasing; retry shortly';
    }
    const row = await tx.get<{ data_json: string }>(
      'SELECT data_json FROM pi_conversations WHERE user_id=? AND runtime_id IS NOT NULL',
      conversation.userId,
    );
    if (row) {
      // An idle one elsewhere is released for this request's retry.
      const other = decode<PiConversationRecord>(row);
      const where = other.projectId === conversation.projectId ? 'this' : 'another';
      check(
        !other.activeCommandId,
        'pi_runtime_busy',
        `Your conversation “${other.title}” in ${where} project is still working; wait for it or stop it`,
        409,
      );
      await this.release(other.runtimeId!, tx);
      return `Your agent in “${other.title}” in ${where} project is being released; retry shortly`;
    }
    conversation.source = await this.scope.delegationSource(caller, tx);
    conversation.epoch++;
    await this.saveConversation(tx, conversation);
    const owner = `${conversation.id}:${conversation.epoch}`;
    const allocation = await this.fleet.request(
      caller,
      { requestId: owner, owner: { kind: 'pi', id: owner } },
      tx,
    );
    conversation.runtimeId = allocation.id;
    conversation.runtimeEpoch = allocation.epoch;
    conversation.runtimeExpiresAt = allocation.deadlineAt;
    return allocation;
  }
  /** The earliest of the runtime deadline, the source's expiry and, unless queued, a full turn. */
  private turnEnd(conversation: PiConversationRecord, queued = false): number {
    return Math.min(
      queued ? Infinity : this.clock() + this.config.turnTimeoutSeconds * 1000,
      Date.parse(conversation.runtimeExpiresAt!),
      conversation.source.kind === 'human' || !conversation.source.expiresAt
        ? Infinity
        : Date.parse(conversation.source.expiresAt),
    );
  }
  private idle(conversation: PiConversationRecord): boolean {
    return (
      !!conversation.idleSince &&
      Date.parse(conversation.idleSince) + this.config.idleTimeoutSeconds * 1000 <= this.clock()
    );
  }
  /** An operator may delete a stuck allocation row; Pi then treats the runtime as lost. */
  private allocation(id: string, tx?: Transaction): Promise<FleetAllocation | null> {
    return this.fleet.inspectOwned(this, id, tx).catch((error: unknown) => {
      if (error instanceof MervError && error.code === 'fleet_not_found') return null;
      throw error;
    });
  }
  private async release(id: string, tx: Transaction): Promise<void> {
    if (await this.allocation(id, tx)) await this.fleet.cancelOwned(this, id, tx);
  }

  async valid(allocation: FleetAllocation, tx: Transaction): Promise<boolean> {
    if (this.closed || !this.config.enabled || allocation.owner.kind !== 'pi') return false;
    const [id, epoch] = allocation.owner.id.split(':');
    const conversation = await this.conversation(tx, id);
    return (
      conversation.epoch === Number(epoch) &&
      (!conversation.runtimeId || conversation.runtimeId === allocation.id) &&
      digest(conversation.source) === digest(allocation.source) &&
      // Idle, a runtime stays warm once launched, or until its idle time ends while it starts.
      (conversation.activeCommandId !== null ||
        (conversation.idleSince !== null &&
          (allocation.runtime?.launch?.deliveryState === 'launched' || !this.idle(conversation))))
    );
  }

  async bootstrap(allocation: FleetAllocation): Promise<string> {
    this.ready();
    return this.read(async (tx) => {
      check(
        await this.valid(allocation, tx),
        'pi_runtime_stale',
        'Conversation runtime is stale',
        403,
      );
      const conversation = await this.conversation(tx, allocation.owner.id.split(':')[0]);
      check(
        conversation.runtimeId === allocation.id,
        'pi_runtime_stale',
        'Conversation runtime is stale',
        403,
      );
      const bootstrap: PiBootstrap = {
        kind: 'pi',
        baseUrl: new URL(this.config.baseUrl!).origin,
        projectId: conversation.projectId,
        conversationId: conversation.id,
        runtimeId: allocation.id,
        epoch: conversation.epoch,
        workerToken: this.workerToken(conversation),
        expiresAt: allocation.deadlineAt,
      };
      return JSON.stringify(bootstrap);
    });
  }

  async observe(allocation: FleetAllocation): Promise<'starting' | 'running' | 'finished'> {
    return this.read(async (tx) => {
      const conversation = await this.conversation(tx, allocation.owner.id.split(':')[0]);
      if (conversation.runtimeId !== allocation.id || !(await this.valid(allocation, tx)))
        return 'finished';
      if (conversation.activeCommandId) {
        const command = await this.command(tx, conversation.id, conversation.activeCommandId);
        return command.workerId ? 'running' : 'starting';
      }
      // A drained runtime has finished its turn; release it without waiting out the idle time.
      return allocation.intent !== 'run' || this.idle(conversation) ? 'finished' : 'running';
    });
  }

  private async worker(token: string, tx: Transaction): Promise<PiConversationRecord> {
    this.ready();
    const match = /^piw_(flt_[A-Za-z0-9]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
    check(match, 'pi_unauthorized', 'Invalid conversation worker credential', 401);
    const row = await tx.get<{ data_json: string }>(
      'SELECT data_json FROM pi_conversations WHERE runtime_id=?',
      match[1],
    );
    check(row, 'pi_unauthorized', 'Conversation runtime is unavailable', 401);
    const conversation = decode<PiConversationRecord>(row);
    check(
      equal(token, this.workerToken(conversation)),
      'pi_unauthorized',
      'Invalid conversation worker credential',
      401,
    );
    check(
      await this.fleet.admits(conversation.runtimeId!, conversation.runtimeEpoch!, tx),
      'pi_runtime_stale',
      'Conversation runtime no longer admits work',
      401,
    );
    await this.scope.requireDelegation(conversation.source, 'read', tx);
    return conversation;
  }
  async authenticateWorker(token: string): Promise<void> {
    await this.read((tx) => this.worker(token, tx));
  }

  private async bound(
    token: string,
    input: { commandId: string; workerId: string },
    tx: Transaction,
  ): Promise<{ conversation: PiConversationRecord; command: PiCommandRecord }> {
    const conversation = await this.worker(token, tx);
    check(
      conversation.activeCommandId === input.commandId,
      'pi_command_stale',
      'Conversation command is no longer active',
      409,
    );
    const command = await this.command(tx, conversation.id, input.commandId);
    check(
      command.epoch === conversation.epoch &&
        command.runtimeId === conversation.runtimeId &&
        command.workerId === input.workerId &&
        command.expiresAt > this.time(),
      'pi_command_stale',
      'Conversation command is no longer active',
      409,
    );
    return { conversation, command };
  }

  async next(token: string, input: unknown, holdMs = 0): Promise<PiWork | null> {
    const value = parse(workerInput, input);
    const lookup = async (tx: Transaction) => {
      const conversation = await this.worker(token, tx);
      const command = conversation.activeCommandId
        ? await this.command(tx, conversation.id, conversation.activeCommandId)
        : null;
      if (!command || !['waiting', 'starting'].includes(command.status)) return { conversation };
      if (command.expiresAt <= this.time()) return { conversation };
      check(
        !command.workerId || command.workerId === value.workerId,
        'pi_worker_conflict',
        'This turn was delivered to another worker',
        409,
      );
      return { conversation, command };
    };
    let record = await this.read(lookup);
    const { id, runtimeId } = record.conversation;
    this.live.set(id, { ...this.live.get(id), runtimeId });
    // Held until a send commits work (its stream event wakes this) or the hold ends.
    for (const end = Date.now() + holdMs; !record.command && Date.now() < end;) {
      this.ready();
      const woken = this.streams.wait(id, end - Date.now());
      record = await this.read(lookup);
      if (!record.command) await woken;
    }
    if (record.command && !record.command.workerId) {
      record = await this.state.transaction(async (tx) => {
        const current = await lookup(tx);
        if (current.command && !current.command.workerId) {
          current.command.status = 'starting';
          current.command.workerId = value.workerId;
          // Queueing and cold start spent the send-time budget; the model gets a full turn.
          current.command.expiresAt = new Date(this.turnEnd(current.conversation)).toISOString();
          await this.saveCommand(tx, current.command);
        }
        return current;
      });
    }
    const { conversation, command } = record;
    if (!command) return null;
    let checkpoint: PiWork['checkpoint'] = null;
    if (conversation.checkpoint) {
      const bytes = await this.blobs.get(conversation.projectId, conversation.checkpoint.hash);
      check(
        bytes.length === conversation.checkpoint.size &&
          hash(bytes) === conversation.checkpoint.hash,
        'pi_checkpoint_invalid',
        'Saved conversation checkpoint failed verification',
        503,
      );
      checkpoint = { content: bytes.toString('utf8'), hash: conversation.checkpoint.hash };
    }
    await this.read((tx) =>
      this.bound(token, { commandId: command.id, workerId: value.workerId }, tx),
    );
    const caller = this.conversationCaller(conversation, command);
    const tools = (await this.tools.describe(caller)).map((tool) => {
      const artifact = tool.name === 'artifact.get' || tool.name === 'artifact.read';
      const inputSchema: Data = {
        type: 'object',
        properties: artifact
          ? { artifactId: { type: 'string', minLength: 1, maxLength: 200 } }
          : {},
        required: artifact ? ['artifactId'] : [],
        additionalProperties: false,
      };
      const description =
        tool.name === 'artifact.read'
          ? 'Read immutable artifact content in this project. Only inline reads are available; no download URLs. Long content is truncated.'
          : (tool.description ?? tool.name);
      return { name: tool.name, description, inputSchema };
    });
    this.streams.changed(conversation.id, command.id);
    return {
      command: publicCommand(command),
      checkpoint,
      model: this.config.model,
      modelBaseUrl: `${new URL(this.config.baseUrl!).origin}/pi-model`,
      modelToken: this.modelToken(command),
      tools,
    };
  }

  async begin(token: string, input: unknown): Promise<{ apply: boolean }> {
    const value = parse(commandInput, input);
    const result = await this.state.transaction(async (tx) => {
      const { conversation, command } = await this.bound(token, value, tx);
      if (command.status !== 'starting') {
        if (command.status === 'working')
          await this.interrupt(tx, conversation, command, 'ambiguous_prompt');
        return { id: conversation.id, apply: false };
      }
      command.status = 'working';
      command.startedAt = this.time();
      await this.saveCommand(tx, command);
      return { id: conversation.id, apply: true };
    });
    if (!result.apply) this.fleet.kick();
    this.streams.changed(result.id, value.commandId);
    return { apply: result.apply };
  }

  private conversationCaller(conversation: PiConversationRecord, command: PiCommandRecord): Caller {
    return {
      actorId: conversation.source.actorId,
      projectId: conversation.projectId,
      conversation: {
        id: conversation.id,
        commandId: command.id,
        runtimeId: command.runtimeId,
        epoch: command.epoch,
      },
    };
  }
  private async requireConversation(caller: Caller, tx: Transaction): Promise<DelegationSource> {
    this.ready();
    check(caller.conversation, 'pi_forbidden', 'Conversation authority is required', 403);
    const conversation = await this.conversation(tx, caller.conversation.id);
    const command = await this.command(tx, conversation.id, caller.conversation.commandId);
    check(
      conversation.activeCommandId === command.id &&
        conversation.source.actorId === caller.actorId &&
        conversation.projectId === caller.projectId &&
        conversation.epoch === caller.conversation.epoch &&
        conversation.runtimeId === caller.conversation.runtimeId &&
        command.epoch === conversation.epoch &&
        command.runtimeId === conversation.runtimeId &&
        ['starting', 'working'].includes(command.status) &&
        command.expiresAt > this.time(),
      'pi_authority_stale',
      'Conversation authority is no longer active',
      403,
    );
    check(
      await this.fleet.admits(conversation.runtimeId!, conversation.runtimeEpoch!, tx),
      'pi_runtime_stale',
      'Conversation runtime no longer admits work',
      403,
    );
    return structuredClone(conversation.source);
  }

  async tool(token: string, input: unknown): Promise<unknown> {
    const value = parse(
      commandInput
        .extend({ name: z.string().min(1).max(128), input: z.record(z.unknown()) })
        .strict(),
      input,
    );
    const { conversation, command } = await this.read((tx) => this.bound(token, value, tx));
    check(
      command.status === 'working',
      'pi_command_stale',
      'Conversation turn is not working',
      409,
    );
    this.report(conversation.id, command.id, 'tool', phrases[value.name]);
    const result = await this.tools
      .call(value.name, this.conversationCaller(conversation, command), value.input)
      .catch((error: unknown) => {
        // A wrong ID or input is the model's to correct; authority failures still end the call.
        if (error instanceof MervError && [400, 404].includes(error.status))
          return { error: { code: error.code, message: error.message } };
        throw error;
      })
      .finally(() => this.report(conversation.id, command.id, 'thinking'));
    const size = (part: unknown) => Buffer.byteLength(JSON.stringify(part ?? null));
    let bytes = size(result);
    if (bytes <= resultBytes) return result;
    // Text and lists keep their start; anything else is only an error the model can explain.
    const read =
      value.name === 'artifact.read' && (result as { encoding?: unknown }).encoding === 'utf8';
    const whole = read
      ? (result as { content: string }).content
      : Array.isArray(result)
        ? result
        : null;
    if (!whole)
      return {
        error: { code: 'tool_result_too_large', message: 'The result is too large to show' },
      };
    const part = (shown: number) =>
      read
        ? { ...(result as object), content: whole.slice(0, shown) }
        : { items: whole.slice(0, shown) };
    let shown = whole.length;
    for (const budget = resultBytes - 200; bytes > budget && shown > 0; bytes = size(part(shown)))
      shown = Math.floor((shown * budget) / bytes);
    const unit = read ? 'characters' : 'items';
    return {
      ...part(shown),
      truncated: `Only the first ${shown} of ${whole.length} ${unit} are shown`,
    };
  }

  async progress(token: string, input: unknown): Promise<{ accepted: true }> {
    const value = parse(
      commandInput
        .extend({
          events: z
            .array(
              z.object({ type: z.enum(['text', 'progress']), text: z.string().max(8192) }).strict(),
            )
            .max(32),
        })
        .strict(),
      input,
    );
    const { conversation, command } = await this.read((tx) => this.bound(token, value, tx));
    check(
      command.status === 'working',
      'pi_command_stale',
      'Conversation turn is not working',
      409,
    );
    const text = value.events.some((event) => event.type === 'text');
    // When the answer began to show: one write per turn, never one per token.
    if (text && !command.firstTextAt)
      await this.state.transaction(async (tx) => {
        const current = (await this.bound(token, value, tx)).command;
        current.firstTextAt ??= this.time();
        await this.saveCommand(tx, current);
      });
    for (const event of value.events)
      this.streams.publish(conversation.id, { ...event, commandId: command.id });
    if (text) this.report(conversation.id, command.id, 'writing');
    return { accepted: true };
  }

  async complete(token: string, input: unknown): Promise<{ saved: boolean }> {
    const value = parse(completionInput, input) as PiCompletion;
    const bytes = Buffer.from(value.checkpoint);
    check(
      bytes.length <= 2_000_000 && hash(bytes) === value.checkpointHash,
      'pi_checkpoint_invalid',
      'Conversation checkpoint failed verification',
    );
    try {
      decodeCheckpoint({ content: value.checkpoint, hash: value.checkpointHash });
    } catch {
      throw new MervError(
        'pi_checkpoint_invalid',
        'Conversation checkpoint must contain a valid session tree',
      );
    }
    const resultHash = digest({
      messages: value.messages,
      outcomes: value.outcomes,
      checkpointHash: value.checkpointHash,
    });
    // Tool outputs are also in the checkpoint; keeping them must not fail a finished turn.
    const fits = (outcomes: PiToolOutcome[]) =>
      Buffer.byteLength(JSON.stringify({ messages: value.messages, outcomes })) <= 256_000;
    const outcomes = fits(value.outcomes)
      ? value.outcomes
      : value.outcomes.map((outcome) => ({ ...outcome, output: { omitted: true } }));
    check(
      fits(outcomes),
      'pi_result_too_large',
      'Canonical conversation result exceeds its limit',
      413,
    );
    const retained = await this.state.transaction(async (tx) => {
      const conversation = await this.worker(token, tx);
      const command = await this.command(tx, conversation.id, value.commandId);
      if (command.status === 'completed') {
        check(
          command.resultHash === resultHash && command.workerId === value.workerId,
          'pi_result_conflict',
          'Turn result changed on replay',
          409,
        );
        return { conversation, command, complete: true };
      }
      await this.bound(token, value, tx);
      check(
        ['working', 'saving'].includes(command.status),
        'pi_command_stale',
        'Conversation turn cannot accept a result',
        409,
      );
      check(
        !command.resultHash || command.resultHash === resultHash,
        'pi_result_conflict',
        'Turn result changed on replay',
        409,
      );
      check(
        value.messages.every((message) => message.role === 'assistant'),
        'pi_result_invalid',
        'Worker results must contain assistant messages',
      );
      check(
        value.outcomes.every(
          (outcome) =>
            Object.hasOwn(constraints, outcome.name) &&
            constraints[outcome.name].safeParse(outcome.input).success,
        ),
        'pi_result_invalid',
        'Turn result contains an unsupported tool',
      );
      if (!command.resultHash) {
        command.messages.push(...value.messages);
        command.outcomes = outcomes;
        command.resultHash = resultHash;
        command.status = 'saving';
        await this.saveCommand(tx, command);
      }
      return { conversation, command, complete: false };
    });
    if (retained.complete) return { saved: true };
    this.streams.changed(retained.conversation.id, value.commandId);
    let stored: { hash: string; size: number };
    try {
      stored = await this.blobs.put(retained.conversation.projectId, bytes);
      check(
        stored.hash === value.checkpointHash && stored.size === bytes.length,
        'pi_checkpoint_invalid',
        'Checkpoint storage receipt mismatch',
      );
      const verified = await this.blobs.get(retained.conversation.projectId, stored.hash);
      check(
        hash(verified) === stored.hash && verified.length === stored.size,
        'pi_checkpoint_invalid',
        'Stored checkpoint failed verification',
      );
    } catch {
      await this.state.transaction(async (tx) => {
        const command = await this.command(tx, retained.conversation.id, value.commandId);
        if (command.status === 'saving' && command.error !== 'checkpoint_unavailable') {
          command.error = 'checkpoint_unavailable';
          await this.saveCommand(tx, command);
        }
      });
      this.streams.changed(retained.conversation.id, value.commandId);
      return { saved: false };
    }
    const first = await this.state.transaction(async (tx) => {
      const current = await this.worker(token, tx);
      const existing = await this.command(tx, current.id, value.commandId);
      if (existing.status === 'completed') {
        check(
          existing.resultHash === resultHash && existing.workerId === value.workerId,
          'pi_result_conflict',
          'Turn result changed on replay',
          409,
        );
        return false;
      }
      const { conversation, command } = await this.bound(token, value, tx);
      check(
        command.status === 'saving' &&
          command.resultHash === resultHash &&
          digest(conversation.checkpoint) === digest(retained.conversation.checkpoint),
        'pi_checkpoint_conflict',
        'Conversation changed while saving its checkpoint',
        409,
      );
      const first = !conversation.checkpoint && conversation.title === defaultTitle;
      conversation.previousCheckpoint = conversation.checkpoint;
      conversation.checkpoint = { ...stored, commandId: command.id };
      conversation.activeCommandId = null;
      conversation.idleSince = this.time();
      command.status = 'completed';
      command.error = null;
      command.completedAt = this.time();
      await this.saveCommand(tx, command);
      await this.saveConversation(tx, conversation);
      return first;
    });
    this.changed(retained.conversation.id, value.commandId);
    if (first) void this.name(retained.conversation.id, retained.command.messages).catch(() => {});
    return { saved: true };
  }

  /** Once, after the first answer: the model names a conversation still called the default. */
  private async name(id: string, [asked, ...answer]: PiMessage[]): Promise<void> {
    const key = process.env[this.config.modelApiKeyEnv];
    if (!key) return;
    const reply = answer.map((message) => message.text).join('\n\n');
    const title = await piTitle(this.config.model, key, asked.text, reply);
    if (!title) return;
    const named = await this.state.transaction(async (tx) => {
      const conversation = await this.conversation(tx, id);
      if (conversation.title !== defaultTitle) return false;
      conversation.title = title;
      await this.saveConversation(tx, conversation);
      return true;
    });
    // A turn may be streaming by now: say the conversation changed without dropping its text.
    if (named) this.streams.publish(id, { commandId: '', type: 'changed', text: '' });
  }

  private async interrupt(
    tx: Transaction,
    conversation: PiConversationRecord,
    command: PiCommandRecord,
    reason: PiInterruption,
  ): Promise<void> {
    if (!active.has(command.status)) return;
    command.status = 'interrupted';
    command.error = reason;
    command.completedAt = this.time();
    conversation.activeCommandId = null;
    conversation.idleSince = this.time();
    await this.saveCommand(tx, command);
    await this.saveConversation(tx, conversation);
  }

  async fail(token: string, input: unknown): Promise<{ interrupted: true }> {
    const value = parse(commandInput, input);
    const id = await this.state.transaction(async (tx) => {
      const { conversation, command } = await this.bound(token, value, tx);
      await this.interrupt(tx, conversation, command, 'worker_interrupted');
      return conversation.id;
    });
    this.changed(id, value.commandId);
    return { interrupted: true };
  }

  async stop(caller: Caller, id: string): Promise<PiSnapshot> {
    this.ready();
    await this.state.transaction(async (tx) => {
      const conversation = await this.owned(caller, id, tx);
      if (conversation.activeCommandId)
        await this.interrupt(
          tx,
          conversation,
          await this.command(tx, id, conversation.activeCommandId),
          'cancelled',
        );
      if (conversation.runtimeId) await this.release(conversation.runtimeId, tx);
    });
    this.changed(id);
    return this.snapshot(caller, id);
  }

  async authorizeModel(token: string) {
    this.ready();
    check(
      /^pir_[A-Za-z0-9_-]{43}$/.test(token),
      'pi_unauthorized',
      'Invalid model credential',
      401,
    );
    return this.read(async (tx) => {
      const row = await tx.get<{ data_json: string }>(
        'SELECT data_json FROM pi_commands WHERE relay_hash=?',
        hash(token),
      );
      check(row, 'pi_unauthorized', 'Invalid model credential', 401);
      const command = decode<PiCommandRecord>(row);
      const conversation = await this.conversation(tx, command.conversationId);
      check(
        equal(token, this.modelToken(command)) && command.status === 'working',
        'pi_unauthorized',
        'Model credential is no longer active',
        401,
      );
      await this.requireConversation(this.conversationCaller(conversation, command), tx);
      await this.scope.requireDelegation(conversation.source, 'read', tx);
      return {
        id: `${conversation.id}:${command.id}`,
        userId: conversation.userId,
        projectId: conversation.projectId,
        conversationId: conversation.id,
        commandId: command.id,
        runtimeId: command.runtimeId,
        epoch: command.epoch,
        expiresAt: command.expiresAt,
        model: this.config.model,
        toolNames: piReadTools.map(piModelToolName),
      };
    });
  }

  async validateModel(grant: Awaited<ReturnType<PiService['authorizeModel']>>): Promise<void> {
    this.ready();
    await this.read(async (tx) => {
      const conversation = await this.conversation(tx, grant.conversationId);
      const command = await this.command(tx, conversation.id, grant.commandId);
      check(
        grant.userId === conversation.userId &&
          grant.projectId === conversation.projectId &&
          grant.runtimeId === command.runtimeId &&
          grant.epoch === command.epoch &&
          grant.expiresAt === command.expiresAt &&
          grant.model === this.config.model &&
          command.status === 'working',
        'pi_authority_stale',
        'Model authority is no longer active',
        403,
      );
      await this.requireConversation(this.conversationCaller(conversation, command), tx);
      await this.scope.requireDelegation(conversation.source, 'read', tx);
    });
  }

  tick(): Promise<void> {
    if (this.closed || !this.config.enabled) return Promise.resolve();
    return (this.pending ??= this.reconcile().finally(() => {
      this.pending = undefined;
    }));
  }

  private async reconcile(): Promise<void> {
    const records = await this.state.read((sql) =>
      sql.all<{ data_json: string }>(
        'SELECT data_json FROM pi_conversations WHERE runtime_id IS NOT NULL',
      ),
    );
    for (const record of records) {
      const previous = decode<PiConversationRecord>(record);
      let allocation = await this.allocation(previous.runtimeId!);
      const previousCommand = previous.activeCommandId
        ? await this.state.read((sql) => this.command(sql, previous.id, previous.activeCommandId!))
        : null;
      if (
        allocation &&
        allocation.phase !== 'released' &&
        (!previousCommand ||
          (allocation.intent === 'run' &&
            previousCommand.expiresAt > this.time() &&
            (previousCommand.status !== 'waiting' || allocation.phase === 'queued')))
      ) {
        // Fleet's progress is what an open page is waiting on.
        this.stage(previous, previousCommand, allocation);
        continue;
      }
      const changed = await this.state.transaction(async (tx) => {
        const conversation = await this.conversation(tx, previous.id);
        if (conversation.runtimeId !== previous.runtimeId) return false;
        let changed = false;
        if (conversation.activeCommandId) {
          const command = await this.command(tx, conversation.id, conversation.activeCommandId);
          // Fleet also stops a failed machine, but no one chose that. (A revoked launch or a
          // deleting machine is what an operator's stop leaves too, so those stay 'stopped'.)
          const reason: PiInterruption | null =
            allocation?.error === 'runtime_refused'
              ? 'runtime_refused'
              : !allocation ||
                  (allocation.intent === 'run' && allocation.phase === 'released') ||
                  allocation.runtime?.state === 'failed'
                ? 'runtime_lost'
                : allocation.intent !== 'run'
                  ? 'runtime_stopped'
                  : command.expiresAt <= this.time()
                    ? 'turn_expired'
                    : null;
          if (reason) {
            await this.interrupt(tx, conversation, command, reason);
            // A turn that ends before its machine launched must not rent one for nothing.
            if (allocation && allocation.runtime?.launch?.deliveryState !== 'launched')
              allocation = await this.fleet.cancelOwned(this, allocation.id, tx);
            changed = true;
          } else if (allocation && command.status === 'waiting' && allocation.phase !== 'queued') {
            // Out of the queue: cold start gets a turn's time, within the deadline Fleet now keeps.
            conversation.runtimeExpiresAt = allocation.deadlineAt;
            command.status = 'starting';
            command.expiresAt = new Date(this.turnEnd(conversation)).toISOString();
            await this.saveCommand(tx, command);
            await this.saveConversation(tx, conversation);
            changed = true;
          }
        }
        if (!allocation || allocation.phase === 'released') {
          conversation.runtimeId = null;
          conversation.runtimeEpoch = null;
          conversation.runtimeExpiresAt = null;
          conversation.idleSince = null;
          await this.saveConversation(tx, conversation);
          changed = true;
        }
        return changed;
      });
      if (!allocation || allocation.phase === 'released') this.live.delete(previous.id);
      if (changed) this.changed(previous.id);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    await this.pending?.catch(() => undefined);
    if (this.config.enabled) {
      await this.state.transaction(async (tx) => {
        const records = await tx.all<{ data_json: string }>(
          'SELECT data_json FROM pi_conversations WHERE runtime_id IS NOT NULL',
        );
        for (const row of records) {
          const conversation = decode<PiConversationRecord>(row);
          if (conversation.activeCommandId)
            await this.interrupt(
              tx,
              conversation,
              await this.command(tx, conversation.id, conversation.activeCommandId),
              'service_unavailable',
            );
          await this.release(conversation.runtimeId!, tx);
        }
      });
    }
    for (const dispose of this.disposers.reverse()) dispose();
    this.streams.close();
  }
}

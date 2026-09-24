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
  migration,
  piConfig,
  sendInput,
  workerInput,
  type PiConfig,
} from './schema.js';
import { PiStreams } from './stream.js';
import { decodeCheckpoint } from './checkpoint.js';
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
  PiSnapshot,
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
          'SELECT data_json FROM pi_conversations WHERE project_id=? AND user_id=? ORDER BY id DESC LIMIT 100',
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
    const value = await this.read(async (tx) => ({
      conversation: publicConversation(await this.owned(caller, id, tx)),
      commands: (
        await tx.all<{ data_json: string }>(
          'SELECT data_json FROM pi_commands WHERE conversation_id=? ORDER BY created_at,id',
          id,
        )
      ).map((row) => publicCommand(decode(row))),
    }));
    await this.scope.require(caller, 'read');
    return { available: this.fleet.connected(caller.projectId), ...value, ...transient };
  }
  async authorizeStream(caller: Caller, id: string): Promise<void> {
    this.ready();
    await this.read((tx) => this.owned(caller, id, tx));
  }

  async send(caller: Caller, id: string, input: unknown): Promise<PiCommand> {
    this.ready();
    const value = parse(sendInput, input);
    const result = await this.state.transaction(async (tx) => {
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
      if (!conversation.runtimeId) {
        const occupied = await tx.get(
          'SELECT id FROM pi_conversations WHERE user_id=? AND runtime_id IS NOT NULL',
          conversation.userId,
        );
        check(
          !occupied,
          'pi_runtime_busy',
          'Your other conversation is still releasing its agent',
          409,
        );
        conversation.source = await this.scope.delegationSource(caller, tx);
        conversation.epoch++;
        conversation.activeCommandId = value.commandId;
        await this.saveConversation(tx, conversation);
        const allocation = await this.fleet.request(
          caller,
          {
            requestId: `${id}:${conversation.epoch}`,
            owner: { kind: 'pi', id: `${id}:${conversation.epoch}` },
          },
          tx,
        );
        conversation.runtimeId = allocation.id;
        conversation.runtimeEpoch = allocation.epoch;
        conversation.runtimeExpiresAt = allocation.deadlineAt;
      } else {
        const allocation = await this.fleet.inspectOwned(this, conversation.runtimeId, tx);
        check(
          allocation.intent === 'run' &&
            !['releasing', 'released'].includes(allocation.phase) &&
            allocation.deadlineAt > this.time(),
          'pi_runtime_releasing',
          'The previous agent is still releasing; retry shortly',
          409,
        );
        await this.scope.requireDelegation(conversation.source, 'read', tx);
      }
      conversation.activeCommandId = value.commandId;
      conversation.idleSince = null;
      const expiry = Math.min(
        this.clock() + this.config.turnTimeoutSeconds * 1000,
        Date.parse(conversation.runtimeExpiresAt!),
        conversation.source.kind === 'human' || !conversation.source.expiresAt
          ? Infinity
          : Date.parse(conversation.source.expiresAt),
      );
      check(expiry > this.clock(), 'pi_expired', 'Conversation source has expired', 403);
      const command: PiCommandRecord = {
        id: value.commandId,
        conversationId: id,
        epoch: conversation.epoch,
        runtimeId: conversation.runtimeId!,
        status: 'waiting',
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
    this.streams.changed(id, result.id);
    return result;
  }

  async valid(allocation: FleetAllocation, tx: Transaction): Promise<boolean> {
    if (this.closed || !this.config.enabled || allocation.owner.kind !== 'pi') return false;
    const [id, epoch] = allocation.owner.id.split(':');
    const conversation = await this.conversation(tx, id);
    return (
      conversation.epoch === Number(epoch) &&
      (!conversation.runtimeId || conversation.runtimeId === allocation.id) &&
      digest(conversation.source) === digest(allocation.source) &&
      (conversation.activeCommandId !== null || conversation.idleSince !== null)
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
        return command.status === 'waiting' ? 'starting' : 'running';
      }
      return conversation.idleSince &&
        Date.parse(conversation.idleSince) + this.config.idleTimeoutSeconds * 1000 <= this.clock()
        ? 'finished'
        : 'running';
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

  async next(token: string, input: unknown): Promise<PiWork | null> {
    const value = parse(workerInput, input);
    const lookup = async (tx: Transaction) => {
      const conversation = await this.worker(token, tx);
      if (!conversation.activeCommandId) return null;
      const command = await this.command(tx, conversation.id, conversation.activeCommandId);
      if (!['waiting', 'starting'].includes(command.status) || command.expiresAt <= this.time())
        return null;
      check(
        !command.workerId || command.workerId === value.workerId,
        'pi_worker_conflict',
        'This turn was delivered to another worker',
        409,
      );
      return { conversation, command };
    };
    let record = await this.read(lookup);
    if (record?.command.status === 'waiting') {
      record = await this.state.transaction(async (tx) => {
        const current = await lookup(tx);
        if (current?.command.status === 'waiting') {
          current.command.status = 'starting';
          current.command.workerId = value.workerId;
          await this.saveCommand(tx, current.command);
        }
        return current;
      });
    }
    if (!record) return null;
    const { conversation, command } = record;
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
          ? 'Read immutable artifact content in this project. Only inline reads are available; no download URLs.'
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
      await this.saveCommand(tx, command);
      return { id: conversation.id, apply: true };
    });
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
    return this.tools.call(value.name, this.conversationCaller(conversation, command), value.input);
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
    for (const event of value.events)
      this.streams.publish(conversation.id, { ...event, commandId: command.id });
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
    check(
      Buffer.byteLength(JSON.stringify({ messages: value.messages, outcomes: value.outcomes })) <=
        256_000,
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
        command.outcomes = value.outcomes;
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
    await this.state.transaction(async (tx) => {
      const current = await this.worker(token, tx);
      const existing = await this.command(tx, current.id, value.commandId);
      if (existing.status === 'completed') {
        check(
          existing.resultHash === resultHash && existing.workerId === value.workerId,
          'pi_result_conflict',
          'Turn result changed on replay',
          409,
        );
        return;
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
      conversation.previousCheckpoint = conversation.checkpoint;
      conversation.checkpoint = { ...stored, commandId: command.id };
      conversation.activeCommandId = null;
      conversation.idleSince = this.time();
      command.status = 'completed';
      command.error = null;
      command.completedAt = this.time();
      await this.saveCommand(tx, command);
      await this.saveConversation(tx, conversation);
    });
    this.streams.changed(retained.conversation.id, value.commandId);
    return { saved: true };
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
    this.streams.changed(id, value.commandId);
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
      if (conversation.runtimeId) {
        await this.fleet.cancelOwned(this, conversation.runtimeId, tx);
      }
    });
    this.streams.changed(id);
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
      const allocation = await this.fleet.inspectOwned(this, previous.runtimeId!);
      const previousCommand = previous.activeCommandId
        ? await this.state.read((sql) => this.command(sql, previous.id, previous.activeCommandId!))
        : null;
      if (
        allocation.phase !== 'released' &&
        (!previousCommand ||
          (allocation.intent === 'run' && previousCommand.expiresAt > this.time()))
      )
        continue;
      const changed = await this.state.transaction(async (tx) => {
        const conversation = await this.conversation(tx, previous.id);
        if (conversation.runtimeId !== allocation.id) return false;
        let changed = false;
        if (conversation.activeCommandId) {
          const command = await this.command(tx, conversation.id, conversation.activeCommandId);
          if (
            allocation.phase === 'released' ||
            allocation.intent !== 'run' ||
            command.expiresAt <= this.time()
          ) {
            await this.interrupt(
              tx,
              conversation,
              command,
              allocation.phase === 'released' ? 'runtime_lost' : 'turn_expired',
            );
            changed = true;
          }
        }
        if (allocation.phase === 'released') {
          conversation.runtimeId = null;
          conversation.runtimeEpoch = null;
          conversation.runtimeExpiresAt = null;
          conversation.idleSince = null;
          await this.saveConversation(tx, conversation);
          changed = true;
        }
        return changed;
      });
      if (changed) this.streams.changed(previous.id);
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
          await this.fleet.cancelOwned(this, conversation.runtimeId!, tx);
        }
      });
    }
    for (const dispose of this.disposers.reverse()) dispose();
    this.streams.close();
  }
}

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
  hostMigration,
  machineInput,
  migration,
  nextInput,
  piConfig,
  runInput,
  sendInput,
  switchMachineInput,
  warmInput,
  type PiConfig,
} from './schema.js';
import { PiStreams } from './stream.js';
import { decodeCheckpoint } from './checkpoint.js';
import { messageChars, turnCeilingMs } from './limits.js';
import { moveNotes, moveRefusal, moveTool, type PiMoveContext } from './moves.js';
import { piTitle } from './relay.js';
import { piTool } from './relay-schema.js';
import { conversationUse, isRemoteTool } from '@merv/api/registry';
import { piModelToolName } from './tool-names.js';
import type {
  Pi,
  PiBootstrap,
  PiCommand,
  PiCommandRecord,
  PiCompletion,
  PiConversation,
  PiConversationRecord,
  PiEvent,
  PiHostRecord,
  PiHostView,
  PiInterruption,
  PiMachine,
  PiMachineChoice,
  PiMachineOption,
  PiMessage,
  PiMove,
  PiMoveBy,
  PiMoveFailure,
  PiNextReply,
  PiNextSlot,
  PiPersonRecord,
  PiProposal,
  PiSlot,
  PiSnapshot,
  PiStage,
  PiStageName,
  PiSwitchMachineResult,
  PiTurnInput,
  PiWork,
} from './types.js';

const active = new Set(['waiting', 'starting', 'working', 'saving']);
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const equal = (left: string, right: string) =>
  left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
/** Fleet reserves within a second of a send, so a request queued this long waits for capacity. */
const queuedMs = 3000;
/** A quarter of the worker model's 32,000-token window, which replays each result in later turns.
 * UTF-8 bytes track tokens better than characters and stay inside the relay's string limit. */
const resultBytes = 24_000;
/** A next slot proves ready within this, or the move fails and the current one serves on (T6). */
const readyMs = 180_000;
/** A current slot this close to its deadline is replaced by a fresh one of its machine (T10). */
const rolloverMs = 15 * 60_000;
/** A move holds two machines, so it starts only with room left for someone else's first. */
const moveRoom = 3;
/** The host's slots: C serves new turns, N starts to replace it, D finishes C's claimed turns. */
const roles = ['current', 'next', 'draining'] as const;
type Role = (typeof roles)[number];
const roleOf = (host: PiHostRecord, allocationId: string) =>
  roles.find((role) => host[role]?.allocationId === allocationId);
/** Fleet no longer runs this allocation for the host. */
const gone = (a: FleetAllocation | null | undefined, now: string) =>
  !a ||
  a.intent !== 'run' ||
  ['releasing', 'released'].includes(a.phase) ||
  a.runtime?.state === 'failed' ||
  a.deadlineAt <= now;
/** Why a turn on a gone slot ended. Fleet stops a failed machine too, but no one chose that. */
const lost = (a: FleetAllocation | null | undefined): PiInterruption =>
  a?.error === 'runtime_refused'
    ? 'runtime_refused'
    : a && a.intent !== 'run' && a.runtime?.state !== 'failed'
      ? 'runtime_stopped'
      : 'runtime_lost';
const decode = <T>(row: { data_json: string }): T => JSON.parse(row.data_json) as T;
const publicConversation = ({ source: _source, ...value }: PiConversationRecord): PiConversation =>
  value;
const publicCommand = (record: PiCommandRecord): PiCommand => {
  const {
    inputHash: _input,
    workerId: _worker,
    resultHash: _result,
    canMove: _move,
    tools: _tools,
    ...value
  } = record;
  return value;
};
function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(plain(value));
  check(parsed.success, 'invalid_pi_input', 'Invalid conversation request');
  return parsed.data;
}
/** What /next hands a worker: retirement, a probe to echo, or a claimed turn. */
type Taken = {
  retire?: true;
  probe?: string;
  claim?: {
    conversation: PiConversationRecord;
    command: PiCommandRecord;
    offered: PiWork['tools'][number] | null;
    notes: string[];
  };
};

export class PiService implements Pi, FleetOwner {
  readonly sourcePermission = 'read' as const;
  readonly streams = new PiStreams();
  readonly config: z.output<typeof piConfig>;
  private readonly secret: string;
  private readonly disposers: (() => void)[] = [];
  /** Memory only, never State: the stage each open conversation last showed, what its worker
   * last reported within a turn, and the answer it has streamed so far, which a turn ended early
   * keeps (interrupt). */
  private readonly live = new Map<
    string,
    {
      stage?: PiStage;
      turn?: PiStage & { commandId: string };
      streamed?: { commandId: string; text: string };
    }
  >();
  /** Memory only, like `live` (a restart ends every turn): when each claimed turn, keyed
   * `conversationId:commandId`, last showed progress (its claim, a streamed word, a tool call),
   * which turnTimeoutSeconds bounds; and authority reads trusted for a second, as the relay
   * trusts a grant's: worker credentials, and turns /progress found their worker holding. */
  private readonly progressAt = new Map<string, number>();
  private readonly trusted = new Map<string, number>();
  /** Owner ids Fleet is admitting now: valid() accepts a slot before its host records it. */
  private readonly renting = new Set<string>();
  /** Conversations whose turns a transaction ended or moved, announced after it commits; a spare
   * announcement only makes an open page read again. */
  private readonly unsent = new Set<string>();
  /** Conversations sharing a host a transaction saved: they read it from their own snapshots. */
  private readonly sharers = new Set<string>();
  /** The Pi host identity, which rents every slot; never the person. */
  private renter?: Caller;
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
      'Enabled Pi needs a private signing secret and an API URL',
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
    await this.state.migrate('pi', [migration, hostMigration]);
    if (!this.config.enabled) return;
    this.disposers.push(this.fleet.registerOwner('pi-host', this));
    this.disposers.push(
      this.scope.registerConversationAuthority({
        require: (caller, tx) => this.requireConversation(caller, tx),
      }),
    );
    this.disposers.push(
      // Every native tool but Pi's own, run as the person: Scope applies their live role, and each
      // tool's own registration says what only the person may run (ToolDefinition.conversation).
      this.tools.registerConversationPolicy({
        allowsTool: async (_caller, name) => !name.startsWith('pi.'),
        validate: async () => {},
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
  private get hostProject(): string {
    return this.config.host!.projectId;
  }
  /** One host per person per project (the ruling), or per person with runtimeKey 'person'. */
  private key(userId: string, projectId: string): string {
    return this.config.runtimeKey === 'project' ? `${userId}:${projectId}` : userId;
  }
  private slots(machine: string): number {
    return this.config.machines.find(({ key }) => key === machine)?.slots ?? 1;
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
  private async saveConversation(tx: Transaction, conversation: PiConversationRecord) {
    conversation.revision++;
    conversation.updatedAt = this.time();
    await tx.run(
      'UPDATE pi_conversations SET data_json=? WHERE id=?',
      JSON.stringify(conversation),
      conversation.id,
    );
  }
  /** The relay hash follows the turn's slot, which a cut-over may change before it is claimed. */
  private async saveCommand(tx: Transaction, command: PiCommandRecord): Promise<void> {
    await tx.run(
      'UPDATE pi_commands SET status=?,relay_hash=?,data_json=? WHERE conversation_id=? AND id=?',
      command.status,
      hash(this.modelToken(command)),
      JSON.stringify(command),
      command.conversationId,
      command.id,
    );
  }
  private async host(sql: Sql, id: string): Promise<PiHostRecord | null> {
    const row = await sql.get<{ data_json: string }>(
      'SELECT data_json FROM pi_hosts WHERE id=?',
      id,
    );
    return row ? decode(row) : null;
  }
  private async liveHost(sql: Sql, key: string): Promise<PiHostRecord | null> {
    const row = await sql.get<{ data_json: string }>(
      "SELECT data_json FROM pi_hosts WHERE key=? AND status='live'",
      key,
    );
    return row ? decode(row) : null;
  }
  /** Each open page of the conversations sharing the host re-reads once the transaction commits
   * (announce). */
  private async saveHost(tx: Transaction, host: PiHostRecord): Promise<void> {
    host.revision++;
    await tx.run(
      'INSERT INTO pi_hosts(id,key,status,created_at,data_json) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data_json=excluded.data_json',
      host.id,
      host.key,
      host.status,
      host.createdAt,
      JSON.stringify(host),
    );
    for (const { id } of await this.sharing(tx, host.userId, host.key)) this.sharers.add(id);
  }
  /** The person's conversations that share the host `key`. */
  private async sharing(sql: Sql, userId: string, key: string) {
    return (
      await sql.all<{ id: string; project_id: string }>(
        'SELECT id,project_id FROM pi_conversations WHERE user_id=?',
        userId,
      )
    ).filter(({ project_id }) => this.key(userId, project_id) === key);
  }
  /** The host's turns that have not ended, oldest first. */
  private async turns(sql: Sql, hostId: string): Promise<PiCommandRecord[]> {
    return (
      await sql.all<{ data_json: string }>(
        "SELECT data_json FROM pi_commands WHERE host_id=? AND status IN ('waiting','starting','working','saving') ORDER BY created_at,id",
        hostId,
      )
    ).map(decode<PiCommandRecord>);
  }
  private async person(sql: Sql, key: string): Promise<PiPersonRecord> {
    const row = await sql.get<{ data_json: string }>(
      'SELECT data_json FROM pi_people WHERE key=?',
      key,
    );
    return row
      ? decode(row)
      : { key, preferred: this.config.machines[0].key, sticky: null, choseAt: null, moves: [] };
  }
  private async savePerson(tx: Transaction, person: PiPersonRecord): Promise<void> {
    const since = new Date(this.clock() - 86_400_000).toISOString();
    person.moves = person.moves.filter((move) => move.at > since);
    await tx.run(
      'INSERT INTO pi_people(key,data_json) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data_json=excluded.data_json',
      person.key,
      JSON.stringify(person),
    );
  }
  /** A move, stamped at its outcome, joins the person's last day of moves; an agent's cut-over
   * also makes its machine where a new host starts (`sticky`). */
  private async record(tx: Transaction, key: string, move: Omit<PiMove, 'at'>): Promise<void> {
    const person = await this.person(tx, key);
    person.moves.push({ at: this.time(), ...move });
    if (move.by === 'agent' && move.outcome === 'moved') person.sticky = move.to;
    await this.savePerson(tx, person);
  }
  private async user(caller: Caller, tx: Transaction): Promise<string> {
    check(
      !caller.session && !caller.managed && !caller.conversation,
      'pi_forbidden',
      'Workers cannot control conversations',
      403,
    );
    check(
      caller.projectId !== this.config.host?.projectId,
      'pi_forbidden',
      'Agent conversations are not available in the Pi host project',
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
  private workerToken(hostId: string, slot: PiSlot): string {
    return `piw_${slot.allocationId}.${this.signature('worker', [hostId, slot.allocationId, slot.epoch])}`;
  }
  private probe(hostId: string, slot: PiSlot, workerId: string): string {
    return this.signature('probe', [hostId, slot.allocationId, workerId]);
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
      const conversation: PiConversationRecord = {
        id: newId('pic'),
        projectId: caller.projectId,
        userId,
        title: value.title,
        revision: 1,
        activeCommandId: null,
        checkpoint: null,
        previousCheckpoint: null,
        source: await this.scope.delegationSource(caller, tx),
        createdAt: this.time(),
        updatedAt: this.time(),
      };
      await tx.run(
        'INSERT INTO pi_conversations(id,project_id,user_id,request_id,input_hash,data_json) VALUES(?,?,?,?,?,?)',
        conversation.id,
        conversation.projectId,
        userId,
        value.requestId,
        digest(value),
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
    // Read together, in one tick: the tail and the answer streamed up to its last event.
    const { tail, ...transient } = this.streams.snapshot(id);
    const streamed = this.live.get(id)?.streamed;
    const { conversation, commands, host, allocation, view } = await this.read(async (tx) => {
      const conversation = await this.owned(caller, id, tx);
      const rows = await tx.all<{ data_json: string }>(
        'SELECT data_json FROM pi_commands WHERE conversation_id=? ORDER BY created_at,id',
        id,
      );
      const { host, allocation } = await this.machineOf(tx, conversation);
      const source = await this.scope.delegationSource(caller, tx);
      const view = await this.hostView(tx, host, conversation, source);
      return { conversation, commands: rows.map(decode<PiCommandRecord>), host, allocation, view };
    });
    await this.scope.require(caller, 'read');
    const turn = commands.find((command) => command.id === conversation.activeCommandId);
    // The tail keeps only recent events: the turn's answer so far comes whole, as one event.
    const whole = streamed?.commandId === turn?.id ? streamed : undefined;
    const text = (event: PiEvent) => event.type === 'text' && event.commandId === whole?.commandId;
    return {
      stage: this.stage(conversation, turn ?? null, host, allocation),
      now: this.time(),
      available: this.fleet.connected(this.hostProject),
      conversation: publicConversation(conversation),
      commands: commands.map(publicCommand),
      host: view,
      ...transient,
      tail: whole
        ? [
            ...tail.filter((event) => !text(event)),
            { ...whole, type: 'text', sequence: tail.findLast(text)?.sequence ?? 0 },
          ]
        : tail,
    };
  }
  /** The conversation's live host and the allocation of the slot serving its new turns. */
  private async machineOf(tx: Transaction, conversation: PiConversationRecord) {
    const host = await this.liveHost(tx, this.key(conversation.userId, conversation.projectId));
    const allocation = host?.current && (await this.allocation(host.current.allocationId, tx));
    return { host, allocation: allocation || null };
  }
  /** Founder ruling 2026-09-24: the agent assumes the person's permissions. The default machine
   * is always allowed; any other only where the person could rent sandboxes themselves: their
   * project (source.projectId, never the host project) has its own Sandboxes connection and
   * `source` holds at least write there now. Otherwise the picker shows the reason, a new host
   * starts on the default, and switch_machine is not offered. Checked again at each claim: a
   * machine its person may no longer choose takes none of their turns and is left for the
   * default (take, settle). With runtimeKey 'person' one host serves several projects, and a turn
   * from one where the machine is not allowed waits for that move. */
  async machineChoice(
    source: DelegationSource,
    machine: string,
    tx: Transaction,
  ): Promise<PiMachineChoice> {
    if (machine === this.config.machines[0].key) return { allowed: true };
    if (!this.config.machines.some(({ key }) => key === machine))
      return { allowed: false, reason: 'not offered' };
    if (!this.fleet.connected(source.projectId))
      return { allowed: false, reason: 'needs Sandboxes in this project' };
    try {
      await this.scope.requireDelegation(source, 'write', tx);
    } catch (error) {
      if (error instanceof MervError && [401, 403].includes(error.status))
        return { allowed: false, reason: 'needs write access in this project' };
      throw error;
    }
    return { allowed: true };
  }
  /** A configured machine as Sandboxes describes its offer; null hides it. */
  private async machine(key: string): Promise<PiMachine | null> {
    const configured = this.config.machines.find((machine) => machine.key === key);
    const offer = configured && (await this.fleet.describe(this.hostProject, key));
    return offer
      ? {
          key,
          label: configured.label,
          vcpu: offer.vcpu,
          memoryGiB: offer.memoryGiB,
          diskGB: offer.diskGB,
          maxHourlyUsd: offer.maxHourlyUsd,
        }
      : null;
  }
  private async catalog(source: DelegationSource, tx: Transaction): Promise<PiMachineOption[]> {
    const options: PiMachineOption[] = [];
    for (const { key } of this.config.machines) {
      const machine = await this.machine(key);
      const choice = machine && (await this.machineChoice(source, key, tx));
      if (choice)
        options.push(
          choice.allowed
            ? { ...machine, available: true }
            : { ...machine, available: false, reason: choice.reason },
        );
    }
    return options;
  }
  /** Where a new host starts: the agent's last move, else the person's pick, while allowed. */
  private async starting(
    person: PiPersonRecord,
    source: DelegationSource,
    tx: Transaction,
  ): Promise<string> {
    const wanted = person.sticky ?? person.preferred;
    return (await this.machine(wanted)) && (await this.machineChoice(source, wanted, tx)).allowed
      ? wanted
      : this.config.machines[0].key;
  }
  private async hostView(
    tx: Transaction,
    host: PiHostRecord | null,
    { userId, projectId }: { userId: string; projectId: string },
    source: DelegationSource,
  ): Promise<PiHostView> {
    const person = await this.person(tx, this.key(userId, projectId));
    const catalog = await this.catalog(source, tx);
    const live = host && !this.idleOver(host) ? host : null;
    const shown = live?.current && catalog.find(({ key }) => key === live.current!.machine);
    return {
      machine: shown ? (({ available: _a, reason: _r, ...machine }) => machine)(shown) : null,
      preferred: await this.starting(person, source, tx),
      catalog,
      state: !live?.current ? 'none' : live.current.workerId ? 'ready' : 'starting',
      idleEndsAt: live?.idleSince
        ? new Date(Date.parse(live.idleSince) + this.config.idleTimeoutSeconds * 1000).toISOString()
        : null,
      idleSeconds: this.config.idleTimeoutSeconds,
      moving: live?.next
        ? { to: live.next.machine, by: live.next.by, since: this.movingSince(live.next) }
        : null,
      lastMove: person.moves.at(-1) ?? null,
    };
  }
  private movingSince(next: PiNextSlot): string {
    return new Date(Date.parse(next.readyBy) - readyMs).toISOString();
  }
  /** What the person waits on now, from the turn, its machine and what the worker last reported. */
  private stage(
    conversation: PiConversationRecord,
    command: PiCommandRecord | null,
    host: PiHostRecord | null,
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
    // With no turn of its own, a conversation waits on its host's move; a rollover is unseen.
    if (!command && host?.next && host.next.by !== 'deadline')
      return this.show(id, { name: 'moving', since: this.movingSince(host.next) });
    const slot = host?.current;
    if (!slot || gone(allocation, this.time()) || (!command && this.idleOver(host!)))
      return this.show(id, { name: 'idle', since: conversation.updatedAt });
    if (allocation!.runtime?.launch?.deliveryState !== 'launched') {
      const waited = Date.parse(allocation!.createdAt) + queuedMs < this.clock();
      return this.show(id, {
        name: allocation!.phase === 'queued' && waited ? 'queued' : 'machine',
      });
    }
    // An enrolled worker picks a new turn up at once, so the turn reads as thinking, not loading.
    return this.show(id, { name: !slot.workerId ? 'agent' : command ? 'thinking' : 'ready' });
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
  /** Open pages re-read what a committed transaction changed: the turns it ended or moved, and
   * `ids`; and, keeping any text streaming there, every conversation of a host it saved. Fleet
   * reconciles now, not at its tick. */
  private announce(...ids: string[]): void {
    for (const id of [...this.unsent, ...ids]) this.streams.changed(id);
    for (const id of this.sharers) this.streams.nudge(id);
    this.unsent.clear();
    this.sharers.clear();
    this.fleet.kick();
  }
  async authorizeStream(caller: Caller, id: string): Promise<void> {
    this.ready();
    await this.read((tx) => this.owned(caller, id, tx));
  }

  async send(caller: Caller, id: string, input: unknown): Promise<PiCommand> {
    this.ready();
    const value = parse(sendInput, input);
    const renter = await this.hostCaller();
    const { command, hostId } = await this.state.transaction(async (tx) => {
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
        return { command: publicCommand(command), hostId: command.hostId };
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
      // Every read of the turn runs as the person, with their authority as of this message.
      conversation.source = await this.scope.delegationSource(caller, tx);
      const { host, queued } = await this.ensure(renter, conversation, conversation.source, tx);
      const slot = host.current!;
      const expiry = this.turnEnd(slot, conversation.source, this.startMs(queued));
      check(expiry > this.clock(), 'pi_expired', 'Conversation source has expired', 403);
      const command: PiCommandRecord = {
        id: value.commandId,
        conversationId: id,
        epoch: slot.epoch,
        runtimeId: slot.allocationId,
        hostId: host.id,
        machine: slot.machine,
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
        'INSERT INTO pi_commands(id,conversation_id,status,relay_hash,created_at,host_id,data_json) VALUES(?,?,?,?,?,?,?)',
        command.id,
        id,
        command.status,
        hash(this.modelToken(command)),
        command.createdAt,
        host.id,
        JSON.stringify(command),
      );
      if (host.idleSince) {
        host.idleSince = null;
        await this.saveHost(tx, host);
      }
      conversation.activeCommandId = command.id;
      await this.saveConversation(tx, conversation);
      return { command: publicCommand(command), hostId: host.id };
    });
    this.streams.changed(id, command.id);
    this.announce();
    if (hostId) this.streams.wake(hostId);
    return command;
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
    if (!this.fleet.connected(this.hostProject)) return this.snapshot(caller, id);
    const renter = await this.hostCaller();
    await this.state.transaction(async (tx) => {
      const conversation = await this.owned(caller, id, tx);
      const source = await this.scope.delegationSource(caller, tx);
      await this.ensure(renter, conversation, source, tx, true);
    });
    this.announce();
    return this.snapshot(caller, id);
  }
  /** T1: the person's live host here, with a current slot for new turns: one is rented when it
   * has none. A host that has idled out is ended, not raced; the next send starts a fresh one. */
  private async ensure(
    renter: Caller,
    { userId, projectId }: PiConversationRecord,
    source: DelegationSource,
    tx: Transaction,
    warm = false,
  ): Promise<{ host: PiHostRecord; queued: boolean }> {
    const key = this.key(userId, projectId);
    let host = await this.liveHost(tx, key);
    if (host) await this.settle(tx, host, renter);
    if (host?.status === 'live' && host.current) {
      const allocation = await this.allocation(host.current.allocationId, tx);
      return { host, queued: allocation?.phase === 'queued' };
    }
    const machine = await this.starting(await this.person(tx, key), source, tx);
    if (host?.status !== 'live')
      host = {
        id: newId('pih'),
        key,
        userId,
        status: 'live',
        epoch: 0,
        revision: 0,
        current: null,
        next: null,
        draining: null,
        idleSince: null,
        createdAt: this.time(),
        ended: null,
      };
    host.current = await this.rent(renter, host, machine, tx);
    // Unused, a warmed host ends after the idle timeout like any other.
    if (warm && !(await this.turns(tx, host.id)).length) host.idleSince = this.time();
    await this.saveHost(tx, host);
    return { host, queued: true };
  }
  /** The Pi host identity (config.host.credentialEnv) rents every slot in the host project, so a
   * person's project needs no Sandboxes of its own. It only rents: turns read as the person. With
   * the host project unconnected, Fleet refuses a rental as sandbox_not_connected. A key it does
   * not accept is the server's fault, never the person's 401, which would sign them out. */
  private async hostCaller(): Promise<Caller> {
    if (this.renter) return this.renter;
    const token = process.env[this.config.host!.credentialEnv];
    check(token, 'pi_configuration', 'The Pi host credential is unavailable', 503);
    const actor = await this.scope.authenticate(token).catch((error: unknown) => {
      if (error instanceof MervError && error.status === 401) return null;
      throw error;
    });
    check(actor, 'pi_configuration', 'The Pi host credential is not accepted', 503);
    check(
      actor.projectId === this.hostProject,
      'pi_configuration',
      'The Pi host credential is outside its project',
      503,
    );
    return (this.renter = {
      actorId: actor.id,
      projectId: actor.projectId,
      credentialId: actor.credential.id,
    });
  }
  /** A new slot on `machine` for the host, requested by the host identity under a new epoch. */
  private async rent(
    renter: Caller,
    host: PiHostRecord,
    machine: string,
    tx: Transaction,
  ): Promise<PiSlot> {
    const epoch = ++host.epoch;
    const id = `${host.id}:${epoch}`;
    this.renting.add(id);
    try {
      const allocation = await this.fleet.request(
        renter,
        { requestId: id, owner: { kind: 'pi-host', id }, profile: machine },
        tx,
      );
      return {
        allocationId: allocation.id,
        allocationEpoch: allocation.epoch,
        epoch,
        machine,
        expiresAt: allocation.deadlineAt,
        workerId: null,
        enrolledAt: null,
        readyAt: null,
      };
    } finally {
      this.renting.delete(id);
    }
  }
  /** Reads `key`'s authority with `read`, unless that was done within the last second. */
  private async trust(key: string, read: () => Promise<unknown>): Promise<void> {
    const now = this.clock();
    if ((this.trusted.get(key) ?? -Infinity) + 1000 > now) return;
    await read();
    for (const [other, at] of this.trusted) if (at + 1000 <= now) this.trusted.delete(other);
    this.trusted.set(key, now);
  }
  /** A turn that ended: no progress is trusted or awaited any more. */
  private forget({ conversationId, id }: PiCommandRecord): void {
    const turn = `${conversationId}:${id}`;
    this.progressAt.delete(turn);
    for (const key of this.trusted.keys()) if (key.startsWith(`${turn} `)) this.trusted.delete(key);
  }
  /** The earliest of the slot's deadline, the source's expiry and `span` from now: none while
   * queued, turnTimeoutSeconds to reach the machine, and the ceiling once claimed. */
  private turnEnd(slot: PiSlot, source: DelegationSource, span: number): number {
    return Math.min(
      this.clock() + span,
      Date.parse(slot.expiresAt),
      source.kind === 'human' || !source.expiresAt ? Infinity : Date.parse(source.expiresAt),
    );
  }
  /** A turn's time to reach its machine; a queued one waits for capacity without a limit. */
  private startMs(queued: boolean): number {
    return queued ? Infinity : this.config.turnTimeoutSeconds * 1000;
  }
  /** A claimed turn that showed no progress for turnTimeoutSeconds. One claimed before this
   * process started counts from its first check here. */
  private stalled(turn: PiCommandRecord): boolean {
    if (!turn.workerId) return false;
    const key = `${turn.conversationId}:${turn.id}`;
    if (!this.progressAt.has(key)) this.progressAt.set(key, this.clock());
    return this.progressAt.get(key)! + this.config.turnTimeoutSeconds * 1000 <= this.clock();
  }
  private idleOver(host: PiHostRecord): boolean {
    return (
      !!host.idleSince &&
      Date.parse(host.idleSince) + this.config.idleTimeoutSeconds * 1000 <= this.clock()
    );
  }
  /** The host's idle clock starts when the last turn in any of its conversations has ended. */
  private async quiet(tx: Transaction, hostId: string | undefined): Promise<void> {
    const host = hostId ? await this.host(tx, hostId) : null;
    if (host?.status !== 'live' || host.idleSince || (await this.turns(tx, host.id)).length) return;
    host.idleSince = this.time();
    await this.saveHost(tx, host);
  }
  /** An operator may delete a stuck allocation row; Pi then treats the machine as lost. */
  private allocation(id: string, tx?: Transaction): Promise<FleetAllocation | null> {
    return this.fleet.inspectOwned(this, id, tx).catch((error: unknown) => {
      if (
        error instanceof MervError &&
        ['fleet_not_found', 'fleet_owner_denied'].includes(error.code)
      )
        return null;
      throw error;
    });
  }

  /** The live host slot an allocation serves; only Pi records a slot's allocation on a host. */
  private async owning(allocation: FleetAllocation, tx: Transaction) {
    if (this.closed || !this.config.enabled || allocation.owner.kind !== 'pi-host') return null;
    const [hostId, epoch] = allocation.owner.id.split(':');
    const host = await this.host(tx, hostId);
    const role = host?.status === 'live' ? roleOf(host, allocation.id) : undefined;
    const slot = role && host![role];
    return slot && slot.epoch === Number(epoch) ? { host: host!, role: role!, slot } : null;
  }
  /** C runs until the host idles out, N until its time to prove ready, D while it has turns. */
  async valid(allocation: FleetAllocation, tx: Transaction): Promise<boolean> {
    if (allocation.owner.kind === 'pi-host' && this.renting.has(allocation.owner.id)) return true;
    const owned = await this.owning(allocation, tx);
    if (!owned) return false;
    if (owned.role === 'current') return !this.idleOver(owned.host);
    if (owned.role === 'next') return owned.host.next!.readyBy > this.time();
    return (await this.turns(tx, owned.host.id)).some(
      (turn) => turn.runtimeId === allocation.id && turn.workerId,
    );
  }

  async bootstrap(allocation: FleetAllocation): Promise<string> {
    this.ready();
    return this.read(async (tx) => {
      const owned = await this.owning(allocation, tx);
      check(
        owned && (await this.valid(allocation, tx)),
        'pi_runtime_stale',
        'Conversation runtime is stale',
        403,
      );
      const { host, slot } = owned;
      const bootstrap: PiBootstrap = {
        kind: 'pi',
        version: 2,
        baseUrl: new URL(this.config.baseUrl!).origin,
        hostId: host.id,
        runtimeId: allocation.id,
        epoch: slot.epoch,
        machine: slot.machine,
        slots: this.slots(slot.machine),
        workerToken: this.workerToken(host.id, slot),
        expiresAt: allocation.deadlineAt,
      };
      return JSON.stringify(bootstrap);
    });
  }

  /** Running once a worker has enrolled, which acknowledges the launch; finished once invalid. */
  async observe(allocation: FleetAllocation): Promise<'starting' | 'running' | 'finished'> {
    return this.read(async (tx) => {
      const owned = await this.owning(allocation, tx);
      if (!owned || !(await this.valid(allocation, tx))) return 'finished';
      return owned.role === 'draining' || owned.slot.workerId ? 'running' : 'starting';
    });
  }

  /** The live host slot a worker credential names, while Fleet admits its machine. */
  private async worker(token: string, tx: Transaction) {
    this.ready();
    const match = /^piw_(flt_[A-Za-z0-9]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
    check(match, 'pi_unauthorized', 'Invalid conversation worker credential', 401);
    const allocation = await this.allocation(match[1], tx);
    const owned = allocation && (await this.owning(allocation, tx));
    check(owned, 'pi_unauthorized', 'Conversation runtime is unavailable', 401);
    check(
      equal(token, this.workerToken(owned.host.id, owned.slot)),
      'pi_unauthorized',
      'Invalid conversation worker credential',
      401,
    );
    check(
      await this.fleet.admits(owned.slot.allocationId, owned.slot.allocationEpoch, tx),
      'pi_runtime_stale',
      'Conversation runtime no longer admits work',
      401,
    );
    return owned;
  }
  /** The check before a worker's request is read. Every route reads its authority again in its
   * own transaction but /progress, which trusts a read for a second too. */
  async authenticateWorker(token: string): Promise<void> {
    await this.trust(token, () => this.read((tx) => this.worker(token, tx)));
  }

  /** The worker's turn on its own slot. Unless ending it, the person must still read here: losing
   * that fails only this turn. */
  private async bound(
    token: string,
    input: { conversationId: string; commandId: string; workerId: string },
    tx: Transaction,
    person = true,
  ) {
    const { host, slot } = await this.worker(token, tx);
    const conversation = await this.conversation(tx, input.conversationId);
    const command = await this.command(tx, conversation.id, input.commandId);
    check(
      conversation.activeCommandId === command.id &&
        command.hostId === host.id &&
        command.runtimeId === slot.allocationId &&
        command.epoch === slot.epoch &&
        command.workerId === input.workerId &&
        command.expiresAt > this.time(),
      'pi_command_stale',
      'Conversation command is no longer active',
      409,
    );
    const actor = person
      ? await this.scope.requireDelegation(conversation.source, 'read', tx).catch((error) => {
          if (error instanceof MervError && [401, 403].includes(error.status))
            throw new MervError(
              'pi_authority_stale',
              'Conversation authority is no longer active',
              403,
            );
          throw error;
        })
      : undefined;
    return { conversation, command, actor };
  }

  async next(token: string, input: unknown, holdMs = 0): Promise<PiNextReply> {
    const value = parse(nextInput, input);
    const { host } = await this.read((tx) => this.worker(token, tx));
    // Held until a send commits work for this host (it wakes this) or the hold ends.
    for (const end = Date.now() + holdMs; ;) {
      this.ready();
      const woken = this.streams.wait(host.id, Math.max(0, end - Date.now()));
      let taken = await this.read((tx) => this.take(token, value, tx, true));
      if (taken === 'due') {
        taken = await this.state.transaction((tx) => this.take(token, value, tx));
        this.streams.wake(host.id);
        this.announce();
      }
      const { retire, probe, claim } = taken as Taken;
      if (retire || probe)
        return { work: null, ...(retire && { retire }), ...(probe && { probe }) };
      if (claim) {
        const work = await this.work(token, value.workerId, claim);
        if (work) return { work };
      } else if (Date.now() >= end) return { work: null };
      else await woken;
    }
  }
  /** A claimed turn's work. /next serves every conversation on the machine, so a turn that cannot
   * start here (its person lost access, it was stopped, its checkpoint is unreadable) ends alone,
   * and /next looks for the next one. */
  private async work(
    token: string,
    workerId: string,
    { conversation, command, offered, notes }: NonNullable<Taken['claim']>,
  ): Promise<PiWork | null> {
    try {
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
      const turn = { conversationId: conversation.id, commandId: command.id, workerId };
      const { actor } = await this.read((tx) => this.bound(token, turn, tx));
      const caller = this.conversationCaller(conversation, command);
      // Every tool the person may use here, read-only for a reader, whose every other call a
      // handler would refuse.
      const described = (await this.tools.list(caller)).flatMap((definition) => {
        const tool = !('kind' in definition) && piTool(definition);
        return tool && (actor!.role !== 'reader' || tool.readOnly) ? [tool] : [];
      });
      // The offered list is fixed for the turn: a claim served again keeps it, and the model
      // grant names exactly it. switch_machine comes first, so no native tool's model name takes
      // its place.
      const tools = await this.state.transaction(async (tx) => {
        const current = (await this.bound(token, turn, tx)).command;
        if (!current.tools) {
          const names = new Set<string>();
          current.tools = [...(offered ? [offered] : []), ...described]
            .filter(
              ({ name }) => !names.has(piModelToolName(name)) && names.add(piModelToolName(name)),
            )
            .map(({ name }) => name);
          await this.saveCommand(tx, current);
        }
        return current.tools;
      });
      this.streams.changed(conversation.id, command.id);
      return {
        command: publicCommand(command),
        checkpoint,
        model: this.config.model,
        modelBaseUrl: `${new URL(this.config.baseUrl!).origin}/pi-model`,
        modelToken: this.modelToken(command),
        tools: [...described, ...(offered ? [offered] : [])].filter(({ name }) =>
          tools.includes(name),
        ),
        notes,
      };
    } catch {
      // A turn already ended (stopped) stays as it ended; a machine that no longer admits work is
      // what the next take reports.
      await this.state.transaction(async (tx) => {
        await this.interrupt(
          tx,
          await this.command(tx, conversation.id, command.id),
          'worker_interrupted',
        );
        await this.quiet(tx, command.hostId);
      });
      this.announce();
      return null;
    }
  }
  /** What /next gives this worker now: first a turn it claimed and has not begun, whose reply it
   * lost (a worker begins each turn before it asks again); else a draining slot retires (T5); a
   * next slot enrolls its first worker with a probe (T3) and cuts over when that worker echoes it
   * (T4); a current slot enrolls and claims its oldest waiting turn whose person may choose its
   * machine now, while it runs fewer than its machine's slots. With `dry`, in a read, it answers
   * 'due' instead of writing. */
  private async take(
    token: string,
    value: z.output<typeof nextInput>,
    tx: Transaction,
    dry = false,
  ): Promise<Taken | 'due'> {
    const { host, slot, role } = await this.worker(token, tx);
    const now = this.time();
    const turns = await this.turns(tx, host.id);
    const lost = turns.find(
      (turn) =>
        turn.runtimeId === slot.allocationId &&
        turn.workerId === value.workerId &&
        turn.status === 'starting' &&
        turn.expiresAt > now,
    );
    if (lost) return { claim: await this.claim(tx, host, lost, slot.machine) };
    if (role === 'draining') return { retire: true };
    let changed = false;
    if (role === 'next') {
      const probe = this.probe(host.id, slot, value.workerId);
      if (slot.workerId) {
        check(
          slot.workerId === value.workerId,
          'pi_worker_conflict',
          'This machine enrolled another worker',
          409,
        );
        if (!value.probe || !equal(value.probe, probe)) return { probe };
      }
      if (dry) return 'due';
      if (!slot.workerId) {
        Object.assign(slot, { workerId: value.workerId, enrolledAt: now });
        await this.saveHost(tx, host);
        return { probe };
      }
      await this.promote(tx, host);
      changed = true;
    } else if (!slot.workerId) {
      if (dry) return 'due';
      Object.assign(slot, { workerId: value.workerId, enrolledAt: now, readyAt: now });
      changed = true;
    }
    const serving = host.current!;
    // A next slot gets here only by the cut-over, which moved C's waiting turns to it.
    const mine = (role === 'next' ? await this.turns(tx, host.id) : turns).filter(
      (turn) => turn.runtimeId === serving.allocationId,
    );
    // A turn its person may no longer run here waits for settle's move to the default.
    let command: PiCommandRecord | undefined;
    if (mine.filter((turn) => turn.workerId).length < this.slots(serving.machine))
      for (const turn of mine) {
        if (turn.workerId || turn.expiresAt <= now) continue;
        const { source } = await this.conversation(tx, turn.conversationId);
        if (!(await this.machineChoice(source, serving.machine, tx)).allowed) continue;
        command = turn;
        break;
      }
    if (command && dry) return 'due';
    if (changed) await this.saveHost(tx, host);
    if (!command) return {};
    const claim = await this.claim(tx, host, command, serving.machine);
    command.status = 'starting';
    command.workerId = value.workerId;
    // Queueing and cold start spent the send-time budget; from here only a stall ends the turn
    // before its ceiling.
    command.expiresAt = new Date(
      this.turnEnd(serving, claim.conversation.source, turnCeilingMs),
    ).toISOString();
    this.progressAt.set(`${command.conversationId}:${command.id}`, this.clock());
    if (claim.offered) command.canMove = true;
    await this.saveCommand(tx, command);
    return { claim };
  }
  /** What a turn is told on `machine`: switch_machine while the move rules allow it (a claim
   * served again keeps what it was first given), and the notes. */
  private async claim(
    tx: Transaction,
    host: PiHostRecord,
    command: PiCommandRecord,
    machine: string,
  ) {
    const conversation = await this.conversation(tx, command.conversationId);
    const context = await this.moveContext(tx, host, conversation, machine);
    const offered = context && (!command.workerId || command.canMove) ? moveTool(context) : null;
    return { conversation, command, offered, notes: context ? moveNotes(context) : [] };
  }
  /** What the agent-move rules read for this turn on `machine`; targets are only machines its
   * person may pick here, so without write access or a Sandboxes connection switch_machine is
   * never offered. */
  private async moveContext(
    tx: Transaction,
    host: PiHostRecord,
    conversation: PiConversationRecord,
    machine: string,
  ): Promise<PiMoveContext | null> {
    const current = await this.machine(machine);
    if (!current) return null;
    const targets: PiMachine[] = [];
    for (const { key, agent } of this.config.machines) {
      const machine = agent && key !== current.key ? await this.machine(key) : null;
      if (machine && (await this.machineChoice(conversation.source, key, tx)).allowed)
        targets.push(machine);
    }
    return {
      now: this.clock(),
      enabled: this.config.agentMoves,
      host,
      person: await this.person(tx, host.key),
      conversationId: conversation.id,
      current,
      targets,
    };
  }

  async begin(token: string, input: unknown): Promise<{ apply: boolean }> {
    const value = parse(commandInput, input);
    const apply = await this.state.transaction(async (tx) => {
      const { command } = await this.bound(token, value, tx);
      if (command.status !== 'starting') {
        if (command.status === 'working') {
          await this.interrupt(tx, command, 'ambiguous_prompt');
          await this.quiet(tx, command.hostId);
        }
        return false;
      }
      command.status = 'working';
      command.startedAt = this.time();
      await this.saveCommand(tx, command);
      this.progressAt.set(`${command.conversationId}:${command.id}`, this.clock());
      return true;
    });
    if (!apply) this.announce();
    this.streams.changed(value.conversationId, value.commandId);
    return { apply };
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
    const host = command.hostId ? await this.host(tx, command.hostId) : null;
    const role = host?.status === 'live' ? roleOf(host, command.runtimeId) : undefined;
    const slot = role && host![role];
    check(
      slot &&
        slot.epoch === command.epoch &&
        conversation.activeCommandId === command.id &&
        conversation.source.actorId === caller.actorId &&
        conversation.projectId === caller.projectId &&
        command.runtimeId === caller.conversation.runtimeId &&
        command.epoch === caller.conversation.epoch &&
        ['starting', 'working'].includes(command.status) &&
        command.expiresAt > this.time(),
      'pi_authority_stale',
      'Conversation authority is no longer active',
      403,
    );
    check(
      await this.fleet.admits(slot.allocationId, slot.allocationEpoch, tx),
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
    check(
      command.tools?.includes(value.name),
      'pi_tool_forbidden',
      'This tool was not offered in this turn',
      403,
    );
    // What only the person may run (ToolDefinition.conversation) is proposed to them instead.
    const definition = (await this.tools.list()).find(({ name }) => name === value.name);
    let use: 'propose' | 'secret' | undefined;
    if (definition && !isRemoteTool(definition) && definition.conversation) {
      const parsed = await definition.inputSchema.safeParseAsync(value.input);
      if (!parsed.success)
        return {
          error: {
            code: 'invalid_input',
            message: 'Tool input failed validation',
            details: parsed.error.issues.map(({ path, message }) => ({ path, message })),
          },
        };
      const found = conversationUse(definition, parsed.data);
      if (found === 'propose' || found === 'secret') [use, value.input] = [found, parsed.data];
    }
    const key = `${conversation.id}:${command.id}`;
    this.progressAt.set(key, this.clock());
    this.report(
      conversation.id,
      command.id,
      'tool',
      use
        ? `Proposing ${value.name}`
        : value.name === 'machine.switch'
          ? 'Moving to a bigger machine'
          : `Using ${value.name}`,
    );
    const result = await (
      use
        ? this.propose(token, value, use)
        : value.name === 'machine.switch'
          ? this.switchMachine(conversation, command, value.input)
          : this.tools.call(value.name, this.conversationCaller(conversation, command), value.input)
    )
      .catch(async (error: unknown) => {
        // A turn that ended, or whose person lost access here, ends with its call; any other
        // refusal, the person's role included, is the model's to explain.
        await this.read((tx) => this.bound(token, value, tx));
        return error instanceof MervError
          ? {
              error: {
                code: error.code,
                message: error.message,
                ...(error.details === undefined ? {} : { details: error.details }),
              },
            }
          : { error: { code: 'tool_failed', message: 'The tool failed unexpectedly' } };
      })
      .finally(() => {
        this.progressAt.set(key, this.clock());
        this.report(conversation.id, command.id, 'thinking');
      });
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
  /** A call only its person may run: kept on the turn for their page, where Run runs it as them
   * (run). At most 16 an answer. */
  private async propose(
    token: string,
    turn: PiTurnInput & { name: string; input: Record<string, unknown> },
    use: 'propose' | 'secret',
  ): Promise<unknown> {
    const proposal = await this.state.transaction(async (tx) => {
      const { command } = await this.bound(token, turn, tx);
      if ((command.proposals?.length ?? 0) >= 16) return null;
      const proposal: PiProposal = {
        id: newId('pip'),
        name: turn.name,
        input: turn.input as Data,
        ...(use === 'secret' && { secret: true as const }),
        at: this.time(),
      };
      (command.proposals ??= []).push(proposal);
      await this.saveCommand(tx, command);
      return proposal;
    });
    if (!proposal)
      return {
        error: {
          code: 'too_many_proposals',
          message: 'This answer has proposed 16 calls: say what is left',
        },
      };
    this.streams.changed(turn.conversationId, turn.commandId);
    return {
      proposed: { id: proposal.id, name: proposal.name },
      note: 'The person sees this exact call with a Run button; it runs as them only if they press it.',
    };
  }

  /** pi.run: the person presses Run on a call their agent proposed, which runs once, as them, with
   * every check their own call meets. A secret result reaches only them: nothing keeps it. */
  async run(caller: Caller, input: unknown): Promise<{ result: unknown }> {
    this.ready();
    const value = parse(runInput, input);
    const find = (command: PiCommandRecord) =>
      command.proposals?.find(({ id }) => id === value.proposalId);
    const proposal = await this.state.transaction(async (tx) => {
      const conversation = await this.owned(caller, value.id, tx);
      check(
        !conversation.activeCommandId,
        'pi_turn_busy',
        'This conversation already has an active turn',
        409,
      );
      const command = await this.command(tx, value.id, value.commandId);
      const proposal = find(command);
      check(proposal, 'pi_not_found', 'Proposal not found', 404);
      check(!proposal.ran, 'pi_proposal_ran', 'This call has already run', 409);
      proposal.ran = { at: this.time() };
      await this.saveCommand(tx, command);
      return proposal;
    });
    const settle = (ok: boolean, code?: string) =>
      this.state.transaction(async (tx) => {
        const command = await this.command(tx, value.id, value.commandId);
        Object.assign(find(command)!.ran!, { ok, ...(code && { code }) });
        await this.saveCommand(tx, command);
      });
    try {
      const result = await this.tools.call(proposal.name, caller, proposal.input);
      await settle(true);
      return { result };
    } catch (error) {
      await settle(false, error instanceof MervError ? error.code : 'tool_failed');
      throw error;
    } finally {
      this.streams.changed(value.id, value.commandId);
    }
  }

  /** switch_machine: the agent starts a move without asking (T2), within the move rules and only
   * to a machine its person may pick here. The new machine serves later turns once ready. */
  private async switchMachine(
    conversation: PiConversationRecord,
    command: PiCommandRecord,
    input: unknown,
  ): Promise<PiSwitchMachineResult> {
    // The agent's reason stays in the turn's outcome; nothing it wrote reaches a record.
    const value = switchMachineInput.safeParse(input);
    check(value.success, 'invalid_input', 'Name a machine and say why in 10 to 300 characters');
    const { machine } = value.data;
    const renter = await this.hostCaller();
    const result = await this.state.transaction(async (tx): Promise<PiSwitchMachineResult> => {
      const host = await this.host(tx, command.hostId!);
      check(host?.status === 'live' && host.current, 'pi_command_stale', 'The machine ended', 409);
      if (host.current.machine === machine) return { status: 'already' };
      const context = await this.moveContext(tx, host, conversation, host.current.machine);
      const refusal = context?.targets.some(({ key }) => key === machine)
        ? moveRefusal(context, machine)
        : { code: 'machine_unavailable' as const };
      if (refusal) return { error: refusal };
      if (!(await this.move(tx, renter, host, machine, 'agent', conversation.id)))
        return { error: { code: 'machine_unavailable' } };
      await this.saveHost(tx, host);
      return { status: 'starting' };
    });
    this.announce();
    return result;
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
    const id = value.conversationId;
    const turn = `${id}:${value.commandId}`;
    // Words arrive several times a second: the turn's authority is read at most once a second.
    await this.trust(`${turn} ${value.workerId} ${token}`, async () => {
      const { command } = await this.read((tx) => this.bound(token, value, tx));
      check(
        command.status === 'working',
        'pi_command_stale',
        'Conversation turn is not working',
        409,
      );
    });
    if (value.events.length) this.progressAt.set(turn, this.clock());
    const text = value.events.some((event) => event.type === 'text');
    // When the answer began to show: one write per turn, never one per token.
    if (text && this.live.get(id)?.streamed?.commandId !== value.commandId)
      await this.state.transaction(async (tx) => {
        const current = (await this.bound(token, value, tx)).command;
        current.firstTextAt ??= this.time();
        await this.saveCommand(tx, current);
      });
    for (const event of value.events)
      this.streams.publish(id, { ...event, commandId: value.commandId });
    if (text) {
      // The answer so far, as the page shows it: a turn that ends early keeps it (interrupt).
      const live = this.live.get(id);
      const kept = live?.streamed?.commandId === value.commandId ? live.streamed.text : '';
      const added = value.events.map((event) => (event.type === 'text' ? event.text : '')).join('');
      const joined = kept + added;
      // A cut inside a character would leave half of it, which Postgres refuses as JSON.
      const text =
        joined.length < messageChars
          ? joined
          : joined.slice(0, messageChars).replace(/[\uD800-\uDBFF]$/, '\uFFFD');
      this.live.set(id, { ...live, streamed: { commandId: value.commandId, text } });
      this.report(id, value.commandId, 'writing');
    }
    return { accepted: true };
  }

  async complete(token: string, input: unknown): Promise<{ saved: boolean }> {
    const value = parse(completionInput, input) as PiCompletion & PiTurnInput;
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
    // Tool outputs are also in the checkpoint; keeping them must not fail a finished turn. The
    // answer is bounded only by messageChars.
    const outcomes =
      Buffer.byteLength(JSON.stringify(value.outcomes)) <= 256_000
        ? value.outcomes
        : value.outcomes.map((outcome) => ({ ...outcome, output: { omitted: true } }));
    // A replay after completion only has to match what was saved.
    const replayed = async (tx: Transaction) => {
      await this.worker(token, tx);
      const command = await this.command(tx, value.conversationId, value.commandId);
      if (command.status !== 'completed') return false;
      check(
        command.resultHash === resultHash && command.workerId === value.workerId,
        'pi_result_conflict',
        'Turn result changed on replay',
        409,
      );
      return true;
    };
    const retained = await this.state.transaction(async (tx) => {
      if (await replayed(tx)) return null;
      const { conversation, command } = await this.bound(token, value, tx);
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
      // An outcome names a tool this turn was offered; switch_machine keeps its own input.
      check(
        value.outcomes.every(
          (outcome) =>
            command.tools?.includes(outcome.name) &&
            (outcome.name !== 'machine.switch' ||
              switchMachineInput.safeParse(outcome.input).success),
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
      return { conversation, command };
    });
    if (!retained) return { saved: true };
    this.streams.changed(value.conversationId, value.commandId);
    const { projectId } = retained.conversation;
    let stored: { hash: string; size: number };
    try {
      stored = await this.blobs.put(projectId, bytes);
      check(
        stored.hash === value.checkpointHash && stored.size === bytes.length,
        'pi_checkpoint_invalid',
        'Checkpoint storage receipt mismatch',
      );
      const verified = await this.blobs.get(projectId, stored.hash);
      check(
        hash(verified) === stored.hash && verified.length === stored.size,
        'pi_checkpoint_invalid',
        'Stored checkpoint failed verification',
      );
    } catch {
      await this.state.transaction(async (tx) => {
        const command = await this.command(tx, value.conversationId, value.commandId);
        if (command.status === 'saving' && command.error !== 'checkpoint_unavailable') {
          command.error = 'checkpoint_unavailable';
          await this.saveCommand(tx, command);
        }
      });
      this.streams.changed(value.conversationId, value.commandId);
      return { saved: false };
    }
    const first = await this.state.transaction(async (tx) => {
      if (await replayed(tx)) return false;
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
      command.status = 'completed';
      command.error = null;
      command.completedAt = this.time();
      await this.saveCommand(tx, command);
      await this.saveConversation(tx, conversation);
      await this.quiet(tx, command.hostId);
      return first;
    });
    this.forget(retained.command);
    this.announce(value.conversationId);
    if (first) void this.name(value.conversationId, retained.command.messages).catch(() => {});
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
    command: PiCommandRecord,
    reason: PiInterruption,
  ): Promise<void> {
    if (!active.has(command.status)) return;
    this.forget(command);
    const conversation = await this.conversation(tx, command.conversationId);
    // Words the person saw stream stay as the answer, unless the turn's own result is in.
    const streamed = this.live.get(conversation.id)?.streamed;
    if (streamed?.commandId === command.id && streamed.text && !command.resultHash)
      command.messages.push({ role: 'assistant', text: streamed.text });
    command.status = 'interrupted';
    command.error = reason;
    command.completedAt = this.time();
    if (conversation.activeCommandId === command.id) conversation.activeCommandId = null;
    await this.saveCommand(tx, command);
    await this.saveConversation(tx, conversation);
    this.unsent.add(conversation.id);
  }
  /** The host ends with any turn still on it, every slot is released, and a move it was starting
   * is recorded as cancelled. */
  private async end(
    tx: Transaction,
    host: PiHostRecord,
    reason: string,
    turnsEnd: PiInterruption = 'cancelled',
  ): Promise<void> {
    for (const turn of await this.turns(tx, host.id)) await this.interrupt(tx, turn, turnsEnd);
    if (host.next) await this.abandon(tx, host, 'cancelled');
    for (const role of roles) {
      const slot = host[role];
      if (slot && (await this.allocation(slot.allocationId, tx)))
        await this.fleet.cancelOwned(this, slot.allocationId, tx);
    }
    host.status = 'ended';
    host.ended = { at: this.time(), reason };
    await this.saveHost(tx, host);
  }

  async fail(token: string, input: unknown): Promise<{ interrupted: true }> {
    const value = parse(commandInput, input);
    await this.state.transaction(async (tx) => {
      const { command } = await this.bound(token, value, tx, false);
      await this.interrupt(tx, command, 'worker_interrupted');
      await this.quiet(tx, command.hostId);
    });
    this.announce();
    return { interrupted: true };
  }

  /** Interrupts this conversation's turn only; the host serves the person's others. */
  async stop(caller: Caller, id: string): Promise<PiSnapshot> {
    this.ready();
    await this.state.transaction(async (tx) => {
      const conversation = await this.owned(caller, id, tx);
      if (!conversation.activeCommandId) return;
      const command = await this.command(tx, id, conversation.activeCommandId);
      await this.interrupt(tx, command, 'cancelled');
      await this.quiet(tx, command.hostId);
    });
    this.announce();
    return this.snapshot(caller, id);
  }

  /** pi.machine.set: the person's pick, for new hosts and now (T2), or back to C while N starts
   * (T11). Only a machine they may choose here; it replaces where the agent last moved them. */
  async setMachine(caller: Caller, input: unknown): Promise<PiHostView> {
    this.ready();
    const { machine } = parse(machineInput, input);
    const renter = await this.hostCaller();
    const view = await this.state.transaction(async (tx) => {
      const userId = await this.user(caller, tx);
      const source = await this.scope.delegationSource(caller, tx);
      const option = (await this.catalog(source, tx)).find(({ key }) => key === machine);
      check(
        option?.available,
        'pi_machine_unavailable',
        option ? `${option.label} ${option.reason}` : 'That machine is not offered',
        403,
      );
      const key = this.key(userId, caller.projectId);
      const found = await this.liveHost(tx, key);
      if (found) await this.settle(tx, found, renter);
      const person = await this.person(tx, key);
      Object.assign(person, { preferred: machine, sticky: null, choseAt: this.time() });
      await this.savePerson(tx, person);
      const host = found?.status === 'live' ? found : null;
      const { current, next } = host ?? {};
      if (host && current && next && current.machine === machine && next.machine !== machine) {
        await this.abandon(tx, host, 'cancelled');
        await this.saveHost(tx, host);
      } else if (host && current && current.machine !== machine && next?.machine !== machine) {
        if (await this.move(tx, renter, host, machine, 'person')) await this.saveHost(tx, host);
      }
      return this.hostView(tx, host, { userId, projectId: caller.projectId }, source);
    });
    this.announce();
    return view;
  }

  /** pi.machine.stop (T9): every turn of the host ends, every slot is released, and the next
   * host starts on the person's own pick. */
  async stopMachine(caller: Caller): Promise<PiHostView> {
    this.ready();
    const view = await this.state.transaction(async (tx) => {
      const userId = await this.user(caller, tx);
      const key = this.key(userId, caller.projectId);
      const person = await this.person(tx, key);
      person.sticky = null;
      await this.savePerson(tx, person);
      const host = await this.liveHost(tx, key);
      if (host) await this.end(tx, host, 'stopped');
      const source = await this.scope.delegationSource(caller, tx);
      return this.hostView(tx, null, { userId, projectId: caller.projectId }, source);
    });
    this.announce();
    return view;
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
        // Only the tools this turn was offered, the same for every call of the turn.
        toolNames: (command.tools ?? []).map(piModelToolName),
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
    const renter = await this.hostCaller().catch(() => undefined);
    const hosts = await this.state.read((sql) =>
      sql.all<{ data_json: string }>("SELECT data_json FROM pi_hosts WHERE status='live'"),
    );
    for (const row of hosts) {
      const seen = decode<PiHostRecord>(row);
      try {
        // Most passes find nothing to do: look first, and take the writer lock only to act.
        if (!(await this.read((tx) => this.settle(tx, seen, renter, true)))) continue;
        await this.state.transaction(async (tx) => {
          const host = await this.host(tx, seen.id);
          if (host?.status === 'live') await this.settle(tx, host, renter);
        });
        this.streams.wake(seen.id);
        this.announce();
      } catch {
        // One host's failure leaves the others' passes alone; the next pass retries it.
      }
    }
    // Fleet's progress is what open pages are waiting on.
    for (const id of [...this.live.keys()]) {
      const seen = await this.read(async (tx) => {
        const conversation = await this.conversation(tx, id);
        const command = conversation.activeCommandId
          ? await this.command(tx, id, conversation.activeCommandId)
          : null;
        return { conversation, command, ...(await this.machineOf(tx, conversation)) };
      }).catch(() => null);
      if (seen) this.stage(seen.conversation, seen.command, seen.host, seen.allocation);
    }
  }
  /** Applies Fleet's facts to a host: N not ready (T6), C lost (T7), D released once drained
   * (T5), turns expired or out of the queue, the idle end (T8) and a deadline's rollover (T10).
   * With `dry`, in a read, only whether any of that is due. */
  private async settle(
    tx: Transaction,
    host: PiHostRecord,
    renter?: Caller,
    dry = false,
  ): Promise<boolean> {
    const now = this.time();
    if (this.idleOver(host)) {
      if (dry) return true;
      const person = await this.person(tx, host.key);
      person.sticky = null;
      await this.savePerson(tx, person);
      await this.end(tx, host, 'idle');
      return true;
    }
    const facts = new Map<string, FleetAllocation | null>();
    for (const role of roles) {
      const slot = host[role];
      if (slot) facts.set(slot.allocationId, await this.allocation(slot.allocationId, tx));
    }
    const fact = (slot: PiSlot | null) => (slot && facts.get(slot.allocationId)) || null;
    let turns = await this.turns(tx, host.id);
    let changed = false;
    const { next } = host;
    if (next && (gone(fact(next), now) || next.readyBy <= now)) {
      if (dry) return true;
      await this.abandon(
        tx,
        host,
        'failed',
        fact(next)?.error === 'runtime_refused'
          ? 'no free machine'
          : next.readyBy <= now
            ? 'not ready in time'
            : 'the machine stopped',
      );
      changed = true;
    }
    if (host.current && gone(fact(host.current), now)) {
      if (dry) return true;
      const reason = lost(fact(host.current));
      if (host.next) await this.promote(tx, host, reason, fact(host.next)?.phase === 'queued');
      else {
        const { allocationId } = host.current;
        for (const turn of turns.filter(({ runtimeId }) => runtimeId === allocationId))
          await this.interrupt(tx, turn, reason);
        host.current = null;
      }
      changed = true;
    }
    if (host.draining && gone(fact(host.draining), now)) {
      if (dry) return true;
      const reason = lost(fact(host.draining));
      for (const turn of turns.filter(({ runtimeId }) => runtimeId === host.draining!.allocationId))
        await this.interrupt(tx, turn, reason);
      host.draining = null;
      changed = true;
    }
    // Slot deadlines follow Fleet's, which restarts one as it leaves the queue.
    for (const role of roles) {
      const slot = host[role];
      const allocation = fact(slot);
      if (slot && allocation && slot.expiresAt !== allocation.deadlineAt) {
        if (dry) return true;
        slot.expiresAt = allocation.deadlineAt;
        changed = true;
      }
    }
    if (changed) turns = await this.turns(tx, host.id);
    for (const turn of turns) {
      const role = roleOf(host, turn.runtimeId);
      if (turn.expiresAt <= now || this.stalled(turn)) {
        if (dry) return true;
        await this.interrupt(tx, turn, 'turn_expired');
        changed = true;
      } else if (turn.status === 'waiting' && role && fact(host[role])?.phase !== 'queued') {
        // Out of the queue: cold start gets a turn's time, within the deadline Fleet now keeps.
        if (dry) return true;
        await this.reassign(tx, turn, host[role]!, false);
        changed = true;
      }
    }
    const { current } = host;
    const newest = turns.at(-1);
    if (current?.workerId && newest && !host.next && !host.draining && renter) {
      // Only a machine in use is renewed near its deadline: of its kind while the newest turn's
      // person may still choose it, else the default. One they may no longer choose (take holds
      // their turns) is left for the default at once, unannounced like a rollover.
      const { source } = await this.conversation(tx, newest.conversationId);
      const allowed = (await this.machineChoice(source, current.machine, tx)).allowed;
      if (
        (!allowed || Date.parse(current.expiresAt) - this.clock() < rolloverMs) &&
        (await this.fleet.free(this.hostProject, tx)) >= moveRoom
      ) {
        if (dry) return true;
        const to = allowed ? current.machine : this.config.machines[0].key;
        const moved = await this.move(tx, renter, host, to, 'deadline');
        changed ||= moved;
      }
    }
    if (!host.current && !host.next && !host.draining) {
      if (dry) return true;
      await this.end(tx, host, 'lost');
      return true;
    }
    if (!changed || dry) return false;
    if (!(await this.turns(tx, host.id)).length) host.idleSince ??= now;
    await this.saveHost(tx, host);
    return true;
  }
  /** N becomes C: at cut-over once proven ready (T4), or first when C is lost (T7, with the
   * reason C's claimed turns end). C's unclaimed turns follow N; at cut-over its claimed turns
   * finish on D while C drains, or C stops at once. */
  private async promote(
    tx: Transaction,
    host: PiHostRecord,
    lostWith?: PiInterruption,
    queued = false,
  ): Promise<void> {
    const old = host.current!;
    const { by, conversationId, readyBy: _, ...slot } = host.next!;
    host.current = lostWith ? slot : { ...slot, readyAt: this.time() };
    host.next = null;
    const turns = (await this.turns(tx, host.id)).filter(
      ({ runtimeId }) => runtimeId === old.allocationId,
    );
    for (const turn of turns)
      if (!turn.workerId) await this.reassign(tx, turn, host.current, queued);
      else if (lostWith) await this.interrupt(tx, turn, lostWith);
    if (!lostWith) {
      if (turns.some(({ workerId }) => workerId)) host.draining = old;
      else await this.fleet.cancelOwned(this, old.allocationId, tx);
    }
    await this.record(tx, host.key, {
      by,
      from: old.machine,
      to: slot.machine,
      outcome: 'moved',
      ...(conversationId && { conversationId }),
    });
  }
  /** N's move ends without a cut-over: its machine is released, and the move is recorded, as the
   * agent's rules count every move whatever its outcome. */
  private async abandon(
    tx: Transaction,
    host: PiHostRecord,
    outcome: 'failed' | 'cancelled',
    reason?: PiMoveFailure,
  ): Promise<void> {
    const next = host.next!;
    if (await this.allocation(next.allocationId, tx))
      await this.fleet.cancelOwned(this, next.allocationId, tx);
    await this.record(tx, host.key, {
      by: next.by,
      from: host.current?.machine ?? next.machine,
      to: next.machine,
      outcome,
      ...(reason && { reason }),
      ...(next.conversationId && { conversationId: next.conversationId }),
    });
    host.next = null;
  }
  /** An unclaimed turn moves to another slot: a new model credential, and a turn's time there. */
  private async reassign(
    tx: Transaction,
    turn: PiCommandRecord,
    slot: PiSlot,
    queued: boolean,
  ): Promise<void> {
    const { source } = await this.conversation(tx, turn.conversationId);
    turn.runtimeId = slot.allocationId;
    turn.epoch = slot.epoch;
    turn.machine = slot.machine;
    turn.status = queued ? 'waiting' : 'starting';
    turn.expiresAt = new Date(this.turnEnd(slot, source, this.startMs(queued))).toISOString();
    await this.saveCommand(tx, turn);
    this.unsent.add(turn.conversationId);
  }
  /** T2: starts `to` as the next slot while C keeps serving. False, recorded as a failed move,
   * when Fleet has no room for a second machine. */
  private async move(
    tx: Transaction,
    renter: Caller,
    host: PiHostRecord,
    to: string,
    by: PiMoveBy,
    conversationId?: string,
  ): Promise<boolean> {
    check(
      host.current && !host.next && !host.draining,
      'pi_move_in_progress',
      'A move is already under way; try again shortly',
      409,
    );
    if ((await this.fleet.free(this.hostProject, tx)) < moveRoom) {
      await this.record(tx, host.key, {
        by,
        from: host.current.machine,
        to,
        outcome: 'failed',
        reason: 'no free machine',
        ...(conversationId && { conversationId }),
      });
      return false;
    }
    host.next = {
      ...(await this.rent(renter, host, to, tx)),
      by,
      conversationId: conversationId ?? null,
      readyBy: new Date(this.clock() + readyMs).toISOString(),
    };
    return true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    await this.pending?.catch(() => undefined);
    // A restart releases every machine; the next send starts one where the person left off.
    if (this.config.enabled) {
      await this.state.transaction(async (tx) => {
        const hosts = await tx.all<{ data_json: string }>(
          "SELECT data_json FROM pi_hosts WHERE status='live'",
        );
        for (const row of hosts)
          await this.end(tx, decode<PiHostRecord>(row), 'restart', 'service_unavailable');
      });
    }
    for (const dispose of this.disposers.reverse()) dispose();
    this.streams.close();
  }
}

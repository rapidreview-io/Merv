import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  check,
  plain,
  MervError,
  type Blobs,
  type Caller,
  type DelegationSource,
  type Scope,
  type Sql,
  type State,
  type Transaction,
} from '@merv/contracts';
import type { ListedTool, Tools } from '@merv/api/types';
import type { Fleet, FleetAllocation } from '@merv/fleet/types';
import { CredentialStore, tokenDigest } from '@merv/identity/credentials';
import { piConfig, type PiConfig } from './schema.js';
import { PiStreams } from './stream.js';
import { piTokens } from './relay.js';
import type {
  PiCommand,
  PiCommandRecord,
  PiConversationRecord,
  PiHostRecord,
  PiInterruption,
  PiMachine,
  PiMachineChoice,
  PiMachineOption,
  PiNextSlot,
  PiPersonRecord,
  PiProposal,
  PiSlot,
  PiStage,
  PiStageName,
} from './types.js';

export const active = new Set(['waiting', 'starting', 'working', 'saving']);
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const equal = (left: string, right: string) =>
  left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
/** Fleet reserves within a second of a send, so a request queued this long waits for capacity. */
const queuedMs = 3000;
/** A next slot proves ready within this, or the move fails and the current one serves on (T6). */
export const readyMs = 180_000;
/** The host's slots: C serves new turns, N starts to replace it, D finishes C's claimed turns. */
export const roles = ['current', 'next', 'draining'] as const;
type Role = (typeof roles)[number];
export const roleOf = (host: PiHostRecord, allocationId: string) =>
  roles.find((role) => host[role]?.allocationId === allocationId);
/** Fleet no longer runs this allocation for the host. */
export const gone = (a: FleetAllocation | null | undefined, now: string) =>
  !a ||
  a.intent !== 'run' ||
  ['releasing', 'released'].includes(a.phase) ||
  a.runtime?.state === 'failed' ||
  a.deadlineAt <= now;
/** Why a turn on a gone slot ended. Fleet stops a failed machine too, but no one chose that. */
export const lost = (a: FleetAllocation | null | undefined): PiInterruption =>
  a?.error === 'wallet_refused' || a?.error === 'person_capped'
    ? 'wallet_refused'
    : a?.error === 'runtime_refused'
      ? 'runtime_refused'
      : a && a.intent !== 'run' && a.runtime?.state !== 'failed'
        ? 'runtime_stopped'
        : 'runtime_lost';
export const decode = <T>(row: { data_json: string }): T => JSON.parse(row.data_json) as T;
export const publicCommand = (record: PiCommandRecord): PiCommand => {
  const {
    inputHash: _input,
    workerId: _worker,
    resultHash: _result,
    canMove: _move,
    tools: _tools,
    notes: _notes,
    context: _context,
    projectPaper: _paper,
    calledAt: _called,
    retried: _retried,
    ...value
  } = record;
  return value;
};
/** What a proposed call does, in the words its tool's owner declares (`act`), read from its input. */
export function actOf(
  tool: ListedTool | undefined,
  input: Record<string, unknown>,
): PiProposal['act'] {
  const act = tool && !('kind' in tool) ? tool.act : undefined;
  return (
    act && {
      title: typeof act.title === 'string' ? act.title : act.title(input),
      ...(act.says && { says: act.says }),
    }
  );
}
export function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(plain(value));
  check(parsed.success, 'invalid_pi_input', 'Invalid conversation request');
  return parsed.data;
}

export function conversationCaller(
  conversation: PiConversationRecord,
  command: PiCommandRecord,
): Caller {
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

/** Pi's records, credentials and what a page is shown of them: the context the host lifecycle,
 * the worker protocol and the person's service share. */
export class PiCore {
  readonly streams = new PiStreams();
  readonly config: z.output<typeof piConfig>;
  readonly secret: string;
  readonly credentials: CredentialStore;
  /** Each person's Agent tokens today, which every model call of theirs is charged to. */
  readonly tokens: ReturnType<typeof piTokens>;
  /** Memory only, never State: the stage each open conversation last showed, what its worker
   * last reported within a turn, and the answer it has streamed so far, which a turn ended early
   * keeps (interrupt). */
  readonly live = new Map<
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
  readonly progressAt = new Map<string, number>();
  readonly trusted = new Map<string, number>();
  /** Memory only, keyed like progressAt: each claimed turn's refused calls, by the digest of name
   * and input, with the code each was refused with. */
  readonly refusals = new Map<string, Map<string, string>>();
  /** Conversations whose turns a transaction ended or moved, announced after it commits; a spare
   * announcement only makes an open page read again. */
  readonly unsent = new Set<string>();
  /** Conversations sharing a host a transaction saved: they read it from their own snapshots. */
  readonly sharers = new Set<string>();
  closed = false;

  constructor(
    readonly state: State,
    readonly scope: Scope,
    readonly fleet: Fleet,
    readonly tools: Tools,
    readonly blobs: Blobs,
    config: PiConfig = {},
    readonly clock: () => number = Date.now,
  ) {
    const parsed = piConfig.safeParse(config);
    if (!parsed.success)
      throw new MervError(
        'pi_configuration',
        `Invalid Pi configuration at ${parsed.error.issues[0]?.path.join('.')}`,
        503,
      );
    this.config = parsed.data;
    this.credentials = new CredentialStore(state, clock);
    this.tokens = piTokens(state, () => this.time(), this.config.dailyTokensPerPerson);
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

  ready(): void {
    check(
      this.config.enabled && !this.closed,
      'pi_unavailable',
      'Agent conversations are unavailable',
      503,
    );
  }
  time(): string {
    return new Date(this.clock()).toISOString();
  }
  read<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.state.snapshot(() => this.state.transaction(fn));
  }
  get hostProject(): string {
    return this.config.host!.projectId;
  }
  /** One host per person per project (the ruling). */
  key(userId: string, projectId: string): string {
    return `${userId}:${projectId}`;
  }
  /** A catalog model; a missing or withdrawn id means the default, models[0]. */
  model(id?: string) {
    return this.config.models.find((model) => model.id === id) ?? this.config.models[0];
  }
  slots(machine: string): number {
    return this.config.machines.find(({ key }) => key === machine)?.slots ?? 1;
  }
  async conversation(sql: Sql, id: string): Promise<PiConversationRecord> {
    const row = await sql.get<{ data_json: string }>(
      'SELECT data_json FROM pi_conversations WHERE id=?',
      id,
    );
    check(row, 'pi_not_found', 'Conversation not found', 404);
    return decode(row);
  }
  async command(sql: Sql, conversationId: string, id: string): Promise<PiCommandRecord> {
    const row = await sql.get<{ data_json: string }>(
      'SELECT data_json FROM pi_commands WHERE conversation_id=? AND id=?',
      conversationId,
      id,
    );
    check(row, 'pi_command_not_found', 'Conversation command not found', 404);
    return decode(row);
  }
  /** Only a question, an answer or a name moves a conversation up the list (`touch`). */
  async saveConversation(tx: Transaction, conversation: PiConversationRecord, touch = true) {
    conversation.revision++;
    if (touch) conversation.updatedAt = this.time();
    await tx.run(
      'UPDATE pi_conversations SET data_json=? WHERE id=?',
      JSON.stringify(conversation),
      conversation.id,
    );
  }
  /** The relay hash follows the turn's slot, which a cut-over may change before it is claimed. */
  async saveCommand(tx: Transaction, command: PiCommandRecord): Promise<void> {
    const previous = await tx.get<{ data_json: string }>(
      'SELECT data_json FROM pi_commands WHERE conversation_id=? AND id=?',
      command.conversationId,
      command.id,
    );
    const old = previous ? decode<PiCommandRecord>(previous) : null;
    if (old) {
      if (
        old.status === 'working' &&
        (command.status !== 'working' || this.modelToken(old) !== this.modelToken(command))
      )
        await this.revokeModelCredential(tx, old);
    }
    if (
      command.status === 'working' &&
      (!old ||
        old.status !== 'working' ||
        this.modelToken(old) !== this.modelToken(command) ||
        old.expiresAt !== command.expiresAt)
    )
      await this.syncModelCredential(tx, command);
    await tx.run(
      'UPDATE pi_commands SET status=?,relay_hash=?,data_json=? WHERE conversation_id=? AND id=?',
      command.status,
      hash(this.modelToken(command)),
      JSON.stringify(command),
      command.conversationId,
      command.id,
    );
  }
  async host(sql: Sql, id: string): Promise<PiHostRecord | null> {
    const row = await sql.get<{ data_json: string }>(
      'SELECT data_json FROM pi_hosts WHERE id=?',
      id,
    );
    return row ? decode(row) : null;
  }
  async liveHost(sql: Sql, key: string): Promise<PiHostRecord | null> {
    const row = await sql.get<{ data_json: string }>(
      "SELECT data_json FROM pi_hosts WHERE key=? AND status='live'",
      key,
    );
    return row ? decode(row) : null;
  }
  /** The host's turns that have not ended, oldest first. */
  async turns(sql: Sql, hostId: string): Promise<PiCommandRecord[]> {
    return (
      await sql.all<{ data_json: string }>(
        "SELECT data_json FROM pi_commands WHERE host_id=? AND status IN ('waiting','starting','working','saving') ORDER BY created_at,id",
        hostId,
      )
    ).map(decode<PiCommandRecord>);
  }
  async person(sql: Sql, key: string): Promise<PiPersonRecord> {
    const row = await sql.get<{ data_json: string }>(
      'SELECT data_json FROM pi_people WHERE key=?',
      key,
    );
    return row
      ? decode(row)
      : { key, preferred: this.config.machines[0].key, sticky: null, choseAt: null, moves: [] };
  }
  async savePerson(tx: Transaction, person: PiPersonRecord): Promise<void> {
    const since = new Date(this.clock() - 86_400_000).toISOString();
    person.moves = person.moves.filter((move) => move.at > since);
    await tx.run(
      'INSERT INTO pi_people(key,data_json) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data_json=excluded.data_json',
      person.key,
      JSON.stringify(person),
    );
  }
  signature(kind: string, value: unknown): string {
    return createHmac('sha256', this.secret)
      .update(JSON.stringify([kind, value]))
      .digest('base64url');
  }
  workerToken(hostId: string, slot: PiSlot): string {
    return `piw_${slot.allocationId}.${this.signature('worker', [hostId, slot.allocationId, slot.epoch])}`;
  }
  probe(hostId: string, slot: PiSlot, workerId: string): string {
    return this.signature('probe', [hostId, slot.allocationId, workerId]);
  }
  modelToken(command: PiCommandRecord): string {
    return `pir_${this.signature('model', [command.conversationId, command.id, command.epoch, command.runtimeId])}`;
  }
  workerSubject(host: PiHostRecord, slot: PiSlot): string {
    return `${host.id}:${slot.allocationId}:${slot.epoch}`;
  }
  modelSubject(command: PiCommandRecord): string {
    return `${command.conversationId}:${command.id}:${command.epoch}:${command.runtimeId}`;
  }
  async syncModelCredential(tx: Transaction, command: PiCommandRecord): Promise<void> {
    const tokenHash = tokenDigest(this.modelToken(command));
    await this.credentials.adopt(
      {
        owner: 'pi',
        subject: this.modelSubject(command),
        kind: 'pi-model',
        tokenHash,
        expiresAt: command.expiresAt,
        hardDeadline: command.expiresAt,
      },
      tx,
    );
  }
  async revokeCredential(tx: Transaction, token: string): Promise<void> {
    // An unknown hash is a no-op; revoking an already expired row is harmless.
    await this.credentials.revoke(tokenDigest(token), 'pi', tx);
  }
  revokeModelCredential(tx: Transaction, command: PiCommandRecord) {
    return this.revokeCredential(tx, this.modelToken(command));
  }
  /** The agent assumes the person's permissions. The default machine is always allowed;
   * another requires write permission in this project. Otherwise the picker shows the reason,
   * a new host starts on the default, and switch_machine is not offered. Checked again at each claim: a
   * machine its person may no longer choose takes none of their turns and is left for the
   * default (take, settle). */
  async machineChoice(
    source: DelegationSource,
    machine: string,
    tx: Transaction,
  ): Promise<PiMachineChoice> {
    if (machine === this.config.machines[0].key) return { allowed: true };
    if (!this.config.machines.some(({ key }) => key === machine))
      return { allowed: false, reason: 'not offered' };
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
  async machine(key: string): Promise<PiMachine | null> {
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
  async catalog(source: DelegationSource, tx: Transaction): Promise<PiMachineOption[]> {
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
  async starting(
    person: PiPersonRecord,
    source: DelegationSource,
    tx: Transaction,
  ): Promise<string> {
    const wanted = person.sticky ?? person.preferred;
    return (await this.machine(wanted)) && (await this.machineChoice(source, wanted, tx)).allowed
      ? wanted
      : this.config.machines[0].key;
  }
  movingSince(next: PiNextSlot): string {
    return new Date(Date.parse(next.readyBy) - readyMs).toISOString();
  }
  /** What the person waits on now, from the turn, its machine and what the worker last reported. */
  stage(
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
  show(id: string, next: Omit<PiStage, 'since'> & { since?: string }): PiStage {
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
  report(id: string, commandId: string, name: PiStageName, detail?: string): void {
    const turn = { name, since: this.time(), commandId, detail };
    this.live.set(id, { ...this.live.get(id), turn });
    this.show(id, turn);
  }
  /** Open pages re-read what a committed transaction changed: the turns it ended or moved, and
   * `ids`; and, keeping any text streaming there, every conversation of a host it saved. Fleet
   * reconciles now, not at its tick. */
  announce(...ids: string[]): void {
    for (const id of [...this.unsent, ...ids]) this.streams.changed(id);
    for (const id of this.sharers) this.streams.nudge(id);
    this.unsent.clear();
    this.sharers.clear();
    this.fleet.kick();
  }
  /** A turn that ended: no progress is trusted or awaited any more. */
  forget({ conversationId, id }: PiCommandRecord): void {
    const turn = `${conversationId}:${id}`;
    this.progressAt.delete(turn);
    this.refusals.delete(turn);
    for (const key of this.trusted.keys()) if (key.startsWith(`${turn} `)) this.trusted.delete(key);
  }
  idleOver(host: PiHostRecord): boolean {
    return (
      !!host.idleSince &&
      Date.parse(host.idleSince) + this.config.idleTimeoutSeconds * 1000 <= this.clock()
    );
  }
}

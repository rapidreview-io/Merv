import { z } from 'zod';
import {
  check,
  digest,
  newId,
  MervError,
  type Caller,
  type Data,
  type Role as MemberRole,
  type Transaction,
} from '@merv/contracts';
import {
  commandInput,
  completionInput,
  defaultTitle,
  nextInput,
  switchMachineInput,
} from './schema.js';
import { decodeCheckpoint } from './checkpoint.js';
import { messageChars, turnCeilingMs } from './limits.js';
import { moveNotes, moveRefusal, moveTool, type PiMoveContext } from './moves.js';
import { piTitle, titleRequest } from './relay.js';
import { conversationUse } from './conversation-rules.js';
import { fit } from './fit.js';
import { piTool } from './relay-schema.js';
import { piInstructions, turnNotes } from './prompt.js';
import { piModelToolName } from './tool-names.js';
import type {
  PiCommandRecord,
  PiCompletion,
  PiConversationRecord,
  PiHostRecord,
  PiMachine,
  PiMessage,
  PiNextReply,
  PiProposal,
  PiSwitchMachineResult,
  PiTurnInput,
  PiWork,
} from './types.js';
import { decode, equal, hash, parse, publicCommand } from './core.js';
import { PiHosts } from './hosts.js';

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

/** The routes a host's worker calls: /next, /begin, /tool, /progress, /complete and /fail. */
export abstract class PiWorkerProtocol extends PiHosts {
  /** Reads `key`'s authority with `read`, unless that was done within the last second. */
  protected async trust(key: string, read: () => Promise<unknown>): Promise<void> {
    const now = this.clock();
    if ((this.trusted.get(key) ?? -Infinity) + 1000 > now) return;
    await read();
    for (const [other, at] of this.trusted) if (at + 1000 <= now) this.trusted.delete(other);
    this.trusted.set(key, now);
  }
  /** Progress on a turn still tracked: one that ended meanwhile (forget) is not added back. */
  protected touch(turn: string): void {
    if (this.progressAt.has(turn)) this.progressAt.set(turn, this.clock());
  }

  /** The live host slot a worker credential names, while Fleet admits its machine. */
  protected async worker(token: string, tx: Transaction) {
    this.ready();
    const match = /^piw_(flt_[A-Za-z0-9]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
    check(match, 'pi_unauthorized', 'Invalid conversation worker credential', 401);
    const credential = await this.credentials
      .authenticate(token, 'pi-worker', tx)
      .catch((error: unknown) => {
        if (error instanceof MervError && error.status === 401)
          throw new MervError('pi_unauthorized', 'Invalid conversation worker credential', 401);
        throw error;
      });
    const allocation = await this.allocation(match[1], tx);
    const owned = allocation && (await this.owning(allocation, tx));
    check(owned, 'pi_unauthorized', 'Conversation runtime is unavailable', 401);
    check(
      credential.subject === this.workerSubject(owned.host, owned.slot) &&
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
   * own transaction but /progress, which trusts a read for a second too. A worker acts for no
   * person: its caller names only the slot it holds, in the host project. */
  async authenticateWorker(token: string): Promise<Caller> {
    await this.trust(token, () => this.read((tx) => this.worker(token, tx)));
    return {
      projectId: this.hostProject,
      actorId: `pi-worker:${token.slice(4, token.indexOf('.'))}`,
    };
  }

  /** The worker's turn on its own slot. Unless ending it, the person must still read here: losing
   * that fails only this turn. */
  protected async bound(
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
  protected async work(
    token: string,
    workerId: string,
    { conversation, command, offered, notes }: NonNullable<Taken['claim']>,
  ): Promise<PiWork | null> {
    try {
      let checkpoint: PiWork['checkpoint'] = null;
      if (conversation.checkpoint) {
        // blobs verifies the bytes against their hash before returning them.
        const bytes = await this.blobs.get(conversation.projectId, conversation.checkpoint.hash);
        checkpoint = { content: bytes.toString('utf8'), hash: conversation.checkpoint.hash };
      }
      const turn = { conversationId: conversation.id, commandId: command.id, workerId };
      const { actor } = await this.read((tx) => this.bound(token, turn, tx));
      const caller = this.conversationCaller(conversation, command);
      // Every tool the person may use here, read-only for a reader, whose every other call a
      // handler would refuse.
      const uses = new Map(
        (await this.tools.list()).map((tool) => [
          tool.name,
          'kind' in tool ? undefined : tool.conversation,
        ]),
      );
      // Every native tool but Pi's own, run as the person: Scope applies their live role, and
      // each tool's own registration says what only the person may run.
      const described = (await this.tools.describe(caller))
        .filter(({ name }) => !name.startsWith('pi.'))
        .flatMap((description) => {
          const tool = piTool(description, uses.get(description.name));
          return tool && (actor!.role !== 'reader' || tool.readOnly) ? [tool] : [];
        });
      // At most 6 of the turn's and 3 of its machine's, under the worker's 10.
      const told = [...(await this.told(conversation, command, actor!.role)), ...notes];
      // What the installed plugins tell the turn about the project now, under the worker's cap.
      const context = (await this.tools.context(caller)).slice(0, 32_000) || undefined;
      // The offered list is fixed for the turn: a claim served again keeps it, and the model
      // grant names exactly it. switch_machine comes first, so no native tool's model name takes
      // its place. Its notes are kept the same way, so pi.prompt shows what the turn was given.
      const {
        tools,
        sent,
        context: sentContext,
      } = await this.state.transaction(async (tx) => {
        const current = (await this.bound(token, turn, tx)).command;
        if (!current.tools || !current.notes) {
          const names = new Set<string>();
          current.tools ??= [...(offered ? [offered] : []), ...described]
            .filter(
              ({ name }) => !names.has(piModelToolName(name)) && names.add(piModelToolName(name)),
            )
            .map(({ name }) => name);
          current.notes ??= told;
          current.context ??= context;
          await this.saveCommand(tx, current);
        }
        return { tools: current.tools, sent: current.notes, context: current.context };
      });
      this.streams.changed(conversation.id, command.id);
      const model = this.model(command.model);
      return {
        command: publicCommand(command),
        checkpoint,
        model: model.id,
        modelBaseUrl: `${new URL(this.config.baseUrl!).origin}/pi-model`,
        modelToken: this.modelToken(command),
        tools: [...described, ...(offered ? [offered] : [])].filter(({ name }) =>
          tools.includes(name),
        ),
        instructions: piInstructions(this.tools.instructions()),
        notes: sent,
        context: sentContext,
      };
    } catch {
      // A turn already ended (stopped) stays as it ended, and one moved to a fresh machine or kept
      // at a restart (again) is no longer this claim's to end; a machine that no longer admits
      // work is what the next take reports.
      await this.state.transaction(async (tx) => {
        const current = await this.command(tx, conversation.id, command.id);
        if (current.workerId === workerId && current.runtimeId === command.runtimeId)
          await this.interrupt(tx, current, 'worker_interrupted');
        await this.quiet(tx, command.hostId);
      });
      this.announce();
      return null;
    }
  }
  /** This turn's notes (turnNotes). */
  protected async told(
    conversation: PiConversationRecord,
    command: PiCommandRecord,
    role: MemberRole,
  ): Promise<string[]> {
    // What an answer that stopped early had already changed, as its events recorded them.
    const interrupted = await this.read(async (tx) => {
      const row = await tx.get<{ data_json: string }>(
        'SELECT data_json FROM pi_commands WHERE conversation_id=? AND id<>? ORDER BY created_at DESC,id DESC LIMIT 1',
        conversation.id,
        command.id,
      );
      const before = row && decode<PiCommandRecord>(row);
      if (before?.status !== 'interrupted') return [];
      const events = await tx.all<{ type: string; subject_id: string }>(
        `SELECT type,subject_id FROM events WHERE project_id=? AND actor_id=? AND created_at>=?
          AND data_json::jsonb #>> '{source,conversationId}'=? AND data_json::jsonb #>> '{source,commandId}'=?
          ORDER BY id LIMIT 6`,
        conversation.projectId,
        conversation.source.actorId,
        before.startedAt ?? before.createdAt,
        conversation.id,
        before.id,
      );
      return events.map(({ type, subject_id }) => `${type} ${subject_id}`);
    });
    return turnNotes({
      role,
      actorId: conversation.source.actorId,
      projectId: conversation.projectId,
      model: this.model(command.model),
      today: this.time().slice(0, 10),
      interrupted,
    });
  }
  /** What /next gives this worker now: first a turn it claimed and has not begun, whose reply it
   * lost (a worker begins each turn before it asks again); else a draining slot retires (T5); a
   * next slot enrolls its first worker with a probe (T3) and cuts over when that worker echoes it
   * (T4); a current slot enrolls and claims its oldest waiting turn whose person may choose its
   * machine now, while it runs fewer than its machine's slots. With `dry`, in a read, it answers
   * 'due' instead of writing. */
  protected async take(
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
    // The model is the conversation's as the turn is claimed: a pick while it waited applies.
    command.model = this.model(claim.conversation.model).id;
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
  protected async claim(
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
  protected async moveContext(
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

  protected conversationCaller(
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
    const key = `${conversation.id}:${command.id}`;
    const call = digest([value.name, value.input]);
    const refused = this.refusals.get(key)?.get(call);
    const refuse = (code: string) =>
      this.refusals.set(key, (this.refusals.get(key) ?? new Map()).set(call, code));
    if (refused)
      return {
        error: {
          code: 'already_refused',
          message: `This exact call was already refused with ${refused}: change the input or answer the person`,
        },
      };
    // Before its first call runs, so a turn that called a tool never starts again (again).
    if (!command.calledAt)
      await this.state.transaction(async (tx) => {
        const current = (await this.bound(token, value, tx)).command;
        current.calledAt ??= this.time();
        await this.saveCommand(tx, current);
      });
    // What only the person may run (ToolDefinition.conversation) is proposed to them instead.
    const definition = (await this.tools.list()).find(({ name }) => name === value.name);
    let use: 'propose' | 'secret' | undefined;
    if (definition && !('kind' in definition) && definition.conversation) {
      const parsed = await definition.inputSchema.safeParseAsync(value.input);
      if (!parsed.success && refuse('invalid_input'))
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
    this.touch(key);
    // What the call is, for the person's page while it runs: never the tool's name.
    this.report(
      conversation.id,
      command.id,
      'tool',
      use
        ? 'Proposing an action'
        : value.name === 'machine.switch'
          ? 'Moving to a bigger machine'
          : definition && !('kind' in definition) && definition.readOnly
            ? 'Reading'
            : 'Making a change',
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
        // refusal, the person's role included, is the model's to explain. A refusal the same
        // input always meets again (invalid, forbidden, unprocessable) is kept: the call is not
        // run again in this turn. What is missing may be made, and a conflict reread, meanwhile.
        await this.read((tx) => this.bound(token, value, tx));
        if (error instanceof MervError && [400, 403, 422].includes(error.status))
          refuse(error.code);
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
        this.touch(key);
        this.report(conversation.id, command.id, 'thinking');
      });
    return fit(value.name, result);
  }
  /** A call only its person may run: kept on the turn for their page, where Run runs it as them
   * (run). At most 16 an answer. */
  protected async propose(
    token: string,
    turn: PiTurnInput & { name: string; input: Record<string, unknown> },
    use: 'propose' | 'secret',
  ): Promise<unknown> {
    const result = await this.state.transaction(async (tx) => {
      const { command } = await this.bound(token, turn, tx);
      const identity = digest([turn.name, turn.input, use]);
      const existing = command.proposals?.find(
        (item) => digest([item.name, item.input, item.secret ? 'secret' : 'propose']) === identity,
      );
      if (existing) return { proposal: existing, created: false };
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
      return { proposal, created: true };
    });
    if (!result)
      return {
        error: {
          code: 'too_many_proposals',
          message: 'This answer has proposed 16 calls: say what is left',
        },
      };
    if (result.created) this.streams.changed(turn.conversationId, turn.commandId);
    return {
      proposed: { id: result.proposal.id, name: result.proposal.name },
      note: 'The person sees this call as a card in plain words with a Run button; it runs as them only if they press it.',
    };
  }

  /** switch_machine: the agent starts a move without asking (T2), within the move rules and only
   * to a machine its person may pick here. The new machine serves later turns once ready. */
  protected async switchMachine(
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
    if (value.events.length) this.touch(turn);
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
  protected async name(id: string, [asked, ...answer]: PiMessage[]): Promise<void> {
    const key = process.env[this.config.modelApiKeyEnv];
    // A small call without reasoning, on the first model that answers at effort none.
    const titler = this.config.models.find((model) => model.effort === 'none');
    if (!key || !titler) return;
    const body = titleRequest(
      titler.id,
      asked.text,
      answer.map((message) => message.text).join('\n\n'),
    );
    // Charged to the person's Agent tokens as the relay charges a turn's calls: a day already
    // used up names nothing.
    const person = { userId: (await this.read((tx) => this.conversation(tx, id))).userId };
    const reserved = await this.tokens.reserve(person, body);
    const { title, usage } = await piTitle(key, body);
    if (usage) await this.tokens.settle(usage, person, reserved);
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
}

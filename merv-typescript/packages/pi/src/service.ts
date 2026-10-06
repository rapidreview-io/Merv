import {
  check,
  digest,
  newId,
  personKey,
  MervError,
  type Caller,
  type DelegationSource,
  type Sql,
  type Transaction,
} from '@merv/contracts';
import type { FleetOwner, ModelRelayHandle } from '@merv/fleet/types';
import { tokenDigest } from '@merv/identity/credentials';
import {
  createInput,
  hostMigration,
  machineInput,
  migration,
  modelInput,
  runInput,
  sendInput,
  usageMigration,
  warmInput,
} from './schema.js';
import { piModelRelay } from './relay.js';
import { conversationRules } from './conversation-rules.js';
import { piInstructions } from './prompt.js';
import { piModelToolName } from './tool-names.js';
import type {
  Pi,
  PiCommand,
  PiCommandRecord,
  PiPrompt,
  PiConversation,
  PiConversationRecord,
  PiEvent,
  PiHostRecord,
  PiHostView,
  PiProposal,
  PiRan,
  PiSnapshot,
} from './types.js';
import { decode, equal, hash, parse, publicCommand, roleOf } from './core.js';
import { PiWorkerProtocol } from './worker-protocol.js';

const publicConversation = ({ source: _source, ...value }: PiConversationRecord): PiConversation =>
  value;

export class PiService extends PiWorkerProtocol implements Pi, FleetOwner {
  async initialize(): Promise<void> {
    await this.credentials.initialize();
    await this.state.migrate('pi', [migration, hostMigration, usageMigration]);
    if (!this.config.enabled) return;
    this.disposers.push(this.fleet.registerOwner('pi-host', this));
    // Pi issues conversation callers: Scope asks it whether one is current, and the tool registry
    // refuses every one until its rules are registered.
    this.disposers.push(
      this.scope.registerConversationAuthority({
        require: (caller, tx) => this.requireConversation(caller, tx),
      }),
      this.tools.registerCallerRules('conversation', conversationRules),
    );
    await this.tick();
    this.timer = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, this.config.pollIntervalMs);
    this.timer.unref();
  }
  /** The person's last model pick here, a pi_people row of its own: never the machine record, and
   * per project whatever runtimeKey says. */
  private pickKey(userId: string, projectId: string): string {
    return `model:${userId}:${projectId}`;
  }
  private async picked(sql: Sql, userId: string, projectId: string): Promise<string | undefined> {
    const row = await sql.get<{ data_json: string }>(
      'SELECT data_json FROM pi_people WHERE key=?',
      this.pickKey(userId, projectId),
    );
    return row ? decode<{ model: string }>(row).model : undefined;
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
    return personKey(actor.user, caller);
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
        model: this.model(await this.picked(tx, userId, caller.projectId)).id,
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
    const turn = commands.find((command) => command.id === conversation.activeCommandId);
    // The tail keeps only recent events: the turn's answer so far comes whole, as one event.
    const whole = streamed?.commandId === turn?.id ? streamed : undefined;
    const text = (event: PiEvent) => event.type === 'text' && event.commandId === whole?.commandId;
    return {
      stage: this.stage(conversation, turn ?? null, host, allocation),
      now: this.time(),
      available: this.fleet.connected(this.hostProject),
      conversation: {
        ...publicConversation(conversation),
        model: this.model(conversation.model).id,
      },
      commands: commands.map(publicCommand),
      host: view,
      models: this.config.models.map(({ effort: _effort, ...model }) => model),
      ...transient,
      tail: whole
        ? [
            ...tail.filter((event) => !text(event)),
            { ...whole, type: 'text', sequence: tail.findLast(text)?.sequence ?? 0 },
          ]
        : tail,
    };
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
  async prompt(caller: Caller, id: string): Promise<PiPrompt> {
    this.ready();
    const { conversation, commands } = await this.read(async (tx) => ({
      conversation: await this.owned(caller, id, tx),
      commands: (
        await tx.all<{ data_json: string }>(
          'SELECT data_json FROM pi_commands WHERE conversation_id=? ORDER BY created_at,id',
          id,
        )
      ).map(decode<PiCommandRecord>),
    }));
    // The turn under way, else the newest one that was served.
    const active = commands.find(({ id }) => id === conversation.activeCommandId);
    const served = active?.notes ? active : commands.findLast((command) => command.notes);
    return {
      instructions: piInstructions(this.tools.instructions()),
      turn: served
        ? {
            commandId: served.id,
            notes: served.notes!,
            tools: served.tools ?? [],
            context: served.context,
          }
        : null,
    };
  }

  async authorizeStream(caller: Caller, id: string): Promise<void> {
    this.ready();
    await this.read((tx) => this.owned(caller, id, tx));
  }

  async send(caller: Caller, id: string, input: unknown): Promise<PiCommand> {
    this.ready();
    // The model only guards the send: a retry is the same message whatever the page showed.
    const { model, ...value } = parse(sendInput, input);
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
      // A page showing another model than the conversation's sends nothing on it.
      const current = this.model(conversation.model);
      check(
        !model || model === current.id,
        'pi_model_changed',
        `This conversation now answers on ${current.label}. Send again to use it.`,
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

  /** pi.run: the person presses Run on a call their agent proposed, which runs once, as them, with
   * every check their own call meets. A secret result reaches only them: nothing keeps it. */
  async run(caller: Caller, input: unknown): Promise<PiRan> {
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
      return { result, ...(await this.ran(proposal, result)) };
    } catch (error) {
      await settle(false, error instanceof MervError ? error.code : 'tool_failed');
      throw error;
    } finally {
      this.streams.changed(value.id, value.commandId);
    }
  }

  /** What Run tells the agent in the person's name: the sentence that stands for a result only the
   *  person sees, the tool's own receipt, or as much of the result's JSON as Run sends. */
  private async ran(proposal: PiProposal, result: unknown): Promise<Omit<PiRan, 'result'>> {
    if (proposal.secret)
      return { told: `Ran ${proposal.name}; its result is shown only to me.`, whole: false };
    const tool = (await this.tools.list()).find(({ name }) => name === proposal.name);
    const receipt = tool && 'receipt' in tool ? tool.receipt?.(result, proposal.input) : undefined;
    if (receipt)
      return {
        told: `Ran ${proposal.name}: ${JSON.stringify(receipt.summary)}. Re-read ${receipt.reread.join(' and ')} for current details.`,
        whole: false,
      };
    return {
      told: `Ran ${proposal.name}: ${(JSON.stringify(result) ?? 'null').slice(0, 4000)}`,
      whole: true,
    };
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

  /** pi.model.set: the conversation's model from its next unclaimed turn, and the person's default
   * for new conversations here. Only the person: conversation, session and managed callers are
   * refused (user), and no agent tool reaches it. An answer under way keeps its model. */
  async setModel(caller: Caller, input: unknown): Promise<PiSnapshot> {
    this.ready();
    const { id, model } = parse(modelInput, input);
    await this.state.transaction(async (tx) => {
      const conversation = await this.owned(caller, id, tx);
      check(
        this.config.models.some((offered) => offered.id === model),
        'pi_model_unavailable',
        'That model is not offered',
        403,
      );
      conversation.model = model;
      await this.saveConversation(tx, conversation, false);
      await tx.run(
        'INSERT INTO pi_people(key,data_json) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data_json=excluded.data_json',
        this.pickKey(conversation.userId, conversation.projectId),
        JSON.stringify({ model }),
      );
    });
    this.streams.nudge(id);
    return this.snapshot(caller, id);
  }

  /** The relay for this Pi's workers' model calls, which Fleet builds: its owner mounts it and
   *  closes it with the mount. Its failure and usage records go to stderr. */
  modelRelay(): ModelRelayHandle {
    const log = (record: object) => void process.stderr.write(`${JSON.stringify(record)}\n`);
    return this.fleet.modelRelay(
      piModelRelay({
        enabled: this.config.enabled,
        models: this.config.models,
        providerKey: () => process.env[this.config.modelApiKeyEnv] ?? '',
        authority: {
          authorize: (token) => this.authorizeModel(token),
          validate: (grant) => this.validateModel(grant),
        },
        onFailure: log,
        reserve: (grant, body) => this.tokens.reserve(grant, body),
        onUsage: async (record, grant, reserved) => {
          log(record);
          await this.tokens.settle(record, grant, reserved);
        },
      }),
    );
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
      const credential = await this.credentials
        .authenticate(token, 'pi-model', tx)
        .catch((error: unknown) => {
          if (error instanceof MervError && error.status === 401)
            throw new MervError('pi_unauthorized', 'Invalid model credential', 401);
          throw error;
        });
      const row = await tx.get<{ data_json: string }>(
        'SELECT data_json FROM pi_commands WHERE relay_hash=?',
        hash(token),
      );
      check(row, 'pi_unauthorized', 'Invalid model credential', 401);
      const command = decode<PiCommandRecord>(row);
      const conversation = await this.conversation(tx, command.conversationId);
      check(
        credential.subject === this.modelSubject(command) &&
          equal(token, this.modelToken(command)) &&
          command.status === 'working',
        'pi_unauthorized',
        'Model credential is no longer active',
        401,
      );
      await this.requireConversation(this.conversationCaller(conversation, command), tx);
      await this.scope.requireDelegation(conversation.source, 'read', tx);
      return {
        // Per slot: a turn that starts again elsewhere is a new grant.
        id: `${conversation.id}:${command.id}:${command.epoch}`,
        userId: conversation.userId,
        projectId: conversation.projectId,
        conversationId: conversation.id,
        commandId: command.id,
        runtimeId: command.runtimeId,
        epoch: command.epoch,
        expiresAt: command.expiresAt,
        model: this.model(command.model).id,
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
      await this.credentials
        .authenticateHash(tokenDigest(this.modelToken(command)), 'pi-model', tx)
        .catch((error: unknown) => {
          if (error instanceof MervError && error.status === 401)
            throw new MervError('pi_authority_stale', 'Model authority is no longer active', 403);
          throw error;
        });
      check(
        grant.userId === conversation.userId &&
          grant.projectId === conversation.projectId &&
          grant.runtimeId === command.runtimeId &&
          grant.epoch === command.epoch &&
          grant.expiresAt === command.expiresAt &&
          grant.model === this.model(command.model).id &&
          command.status === 'working',
        'pi_authority_stale',
        'Model authority is no longer active',
        403,
      );
      await this.requireConversation(this.conversationCaller(conversation, command), tx);
      await this.scope.requireDelegation(conversation.source, 'read', tx);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    await this.pending?.catch(() => undefined);
    // A restart releases every machine; the next send starts one where the person left off. A
    // turn that has shown nothing waits: the next process starts it on a fresh machine.
    if (this.config.enabled) {
      await this.state.transaction(async (tx) => {
        const hosts = await tx.all<{ data_json: string }>(
          "SELECT data_json FROM pi_hosts WHERE status='live'",
        );
        for (const row of hosts)
          await this.end(tx, decode<PiHostRecord>(row), 'restart', 'service_unavailable', (turn) =>
            this.again(turn, false),
          );
      });
    }
    for (const dispose of this.disposers.reverse()) dispose();
    this.streams.close();
  }
}

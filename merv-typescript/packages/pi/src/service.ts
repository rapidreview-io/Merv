import {
  check,
  digest,
  newId,
  MervError,
  type Caller,
  type DelegationSource,
  type Sql,
  type Transaction,
} from '@merv/contracts';
import { randomBytes } from 'node:crypto';
import { personKey } from '@merv/fleet/model-ledger';
import type { ModelRelayHandle } from '@merv/fleet/types';
import { tokenDigest } from '@merv/identity/credentials';
import {
  createInput,
  machineInput,
  modelInput,
  piMigrations,
  runInput,
  lookInput,
  showInput,
  screenInput,
  sendInput,
  voiceInput,
  warmInput,
} from './schema.js';
import { piModelRelay } from './relay.js';
import { conversationRules } from './conversation-rules.js';
import { piInstructions } from './prompt.js';
import { piModelToolName } from './tool-names.js';
import { openVoice, voiceHistory } from './voice.js';
import { describeScreen, renderScreen, type ScreenAnswer } from './screen.js';
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
  PiShow,
  PiSnapshot,
} from './types.js';
import {
  actOf,
  conversationCaller,
  decode,
  storedTurn,
  equal,
  hash,
  parse,
  PiCore,
  publicCommand,
  roleOf,
} from './core.js';
import { PiHosts } from './hosts.js';
import { PiWorkerProtocol } from './worker-protocol.js';

/** What Run tells the agent, and the part of it that says how the call came out. */
type Told = Omit<PiRan, 'result'> & { said?: string };
/** How a call Run made came out, as Pi keeps it on its proposal. */
type Outcome = Omit<NonNullable<PiProposal['ran']>, 'at'>;
/** A call Run began: its turn, its tool, when it began, and how it came out once it returned. */
type Run = { id: string; commandId: string; name: string; at: number; outcome?: Outcome };

/** How often Run tries to keep a call's outcome, waiting twice as long each time from 200 ms. */
const SAVE_ATTEMPTS = 5;
/** Why the person's page gave no answer to the agent's ask. */
const UNANSWERED =
  'no page of theirs answered (Merv is not open in a browser, or the tab is in the background).';
/** A call that has not returned this long after Run began it may never return. */
const RUN_MS = 600_000;
/** What Pi keeps, and the agent is told, of a call whose outcome it cannot know: one a restart
 *  cut off, or one that never returned. */
const interrupted = (name: string): Outcome => {
  const said = 'it may have run, but how it came out is unknown';
  return { ok: false, code: 'interrupted', told: `${name} was interrupted: ${said}.`, said };
};
const publicConversation = ({ source: _source, ...value }: PiConversationRecord): PiConversation =>
  value;

/** The person's conversations. It composes Pi's shared records (core), each person's host and its
 * Fleet machines (hosts), and the routes the host's worker calls (protocol). */
export class PiService implements Pi {
  private readonly core: PiCore;
  private readonly hosts: PiHosts;
  private readonly protocol: PiWorkerProtocol;
  readonly config: PiCore['config'];
  readonly streams: PiCore['streams'];
  /** Each person's Agent tokens today, which every model call of theirs is charged to. */
  readonly tokens: PiCore['tokens'];
  private readonly disposers: (() => void)[] = [];
  private timer?: ReturnType<typeof setInterval>;
  /** The calls Run began in this process whose outcome is not kept yet, keyed by proposal: when
   *  each began, and its outcome once it returned. A ran proposal with no outcome that is not
   *  here was cut off by a restart. */
  private readonly runs = new Map<string, Run>();
  constructor(...args: ConstructorParameters<typeof PiCore>) {
    this.core = new PiCore(...args);
    this.hosts = new PiHosts(this.core);
    this.protocol = new PiWorkerProtocol(this.core, this.hosts);
    ({ config: this.config, streams: this.streams, tokens: this.tokens } = this.core);
  }
  readonly authenticateWorker: PiWorkerProtocol['authenticateWorker'] = (token) =>
    this.protocol.authenticateWorker(token);
  readonly next: PiWorkerProtocol['next'] = (...args) => this.protocol.next(...args);
  readonly begin: PiWorkerProtocol['begin'] = (...args) => this.protocol.begin(...args);
  readonly tool: PiWorkerProtocol['tool'] = (...args) => this.protocol.tool(...args);
  readonly progress: PiWorkerProtocol['progress'] = (...args) => this.protocol.progress(...args);
  readonly complete: PiWorkerProtocol['complete'] = (...args) => this.protocol.complete(...args);
  readonly fail: PiWorkerProtocol['fail'] = (...args) => this.protocol.fail(...args);
  /** One reconciling pass over every live host (see PiHosts.settle), and over Run's calls: an
   *  outcome a write could not keep is kept, and a call that never returned is interrupted. */
  readonly tick = async (): Promise<void> => {
    await this.hosts.tick();
    for (const [proposalId, run] of this.runs)
      if (run.outcome || this.core.clock() - run.at >= RUN_MS)
        await this.keep(run.id, run.commandId, (p) =>
          p.id === proposalId ? (run.outcome ?? interrupted(run.name)) : undefined,
        ).then(
          () => this.runs.delete(proposalId),
          () => undefined,
        );
  };
  readonly bootstrap: PiHosts['bootstrap'] = (allocation) => this.hosts.bootstrap(allocation);
  async initialize(): Promise<void> {
    await this.core.credentials.initialize();
    await this.core.state.migrate('pi', piMigrations);
    this.disposers.push(this.core.fleet.registerOwner('pi-host', this.hosts));
    // Pi issues conversation callers: Scope asks it whether one is current, and the tool registry
    // refuses every one until its rules are registered.
    this.disposers.push(
      this.core.scope.registerConversationAuthority({
        require: (caller, tx) => this.requireConversation(caller, tx),
      }),
      this.core.tools.registerCallerRules('conversation', conversationRules),
    );
    await this.hosts.tick();
    // Every call Run began before this process started is cut off. Only turns with a call that ran
    // are read, as text: jsonb refuses some JSON an older turn may hold.
    const ran = await this.core.read((tx) =>
      tx.all<{ conversation_id: string; id: string; data_json: string }>(
        `SELECT conversation_id,id,data_json FROM pi_commands WHERE strpos(data_json,'"ran"') > 0`,
      ),
    );
    for (const row of ran)
      if (decode<PiCommandRecord>(row).proposals?.some((p) => p.ran && p.ran.ok === undefined))
        await this.keep(row.conversation_id, row.id, (proposal) => interrupted(proposal.name));
    this.timer = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, this.core.config.pollIntervalMs);
    this.timer.unref();
  }
  /** The person's last model pick here, a pi_people row of its own: never the machine record. */
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
      caller.projectId !== this.core.config.host.projectId,
      'pi_forbidden',
      'Agent conversations are not available in the Pi host project',
      403,
    );
    const actor = await this.core.scope.require(caller, 'read', tx);
    return personKey(actor.user, caller);
  }
  private async owned(caller: Caller, id: string, tx: Transaction): Promise<PiConversationRecord> {
    const userId = await this.user(caller, tx);
    const conversation = await this.core.conversation(tx, id);
    check(
      conversation.projectId === caller.projectId && conversation.userId === userId,
      'pi_not_found',
      'Conversation not found',
      404,
    );
    return conversation;
  }

  async create(caller: Caller, input: unknown): Promise<PiConversation> {
    this.core.ready();
    const value = parse(createInput, input);
    return this.core.state.transaction(async (tx) => {
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
        model: this.core.model(await this.picked(tx, userId, caller.projectId)).id,
        source: await this.core.scope.delegationSource(caller, tx),
        createdAt: this.core.time(),
        updatedAt: this.core.time(),
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
    this.core.ready();
    return this.core.read(async (tx) => {
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
    this.core.ready();
    await this.authorizeStream(caller, id);
    // Read together, in one tick: the tail and the answer streamed up to its last event.
    const { tail, ...transient } = this.core.streams.snapshot(id);
    const streamed = this.core.live.get(id)?.streamed;
    const { conversation, commands, host, allocation, view } = await this.core.read(async (tx) => {
      const conversation = await this.owned(caller, id, tx);
      const rows = await tx.all<{ data_json: string }>(
        'SELECT data_json FROM pi_commands WHERE conversation_id=? ORDER BY created_at,id',
        id,
      );
      const { host, allocation } = await this.hosts.machineOf(tx, conversation);
      const source = await this.core.scope.delegationSource(caller, tx);
      const view = await this.hostView(tx, host, conversation, source);
      return { conversation, commands: rows.map(decode<PiCommandRecord>), host, allocation, view };
    });
    // A call proposed before its tool declared an act reads with the act its tool declares now.
    const untitled = commands.flatMap((command) => command.proposals?.filter((p) => !p.act) ?? []);
    if (untitled.length) {
      const tools = new Map((await this.core.tools.list()).map((tool) => [tool.name, tool]));
      for (const proposal of untitled) {
        // An act its tool cannot word for this input leaves the card's generic wording.
        try {
          const act = actOf(tools.get(proposal.name), proposal.input as Record<string, unknown>);
          if (act) proposal.act = act;
        } catch {}
      }
    }
    const turn = commands.find((command) => command.id === conversation.activeCommandId);
    // The tail keeps only recent events: the turn's answer so far comes whole, as one event.
    const whole = streamed?.commandId === turn?.id ? streamed : undefined;
    const text = (event: PiEvent) => event.type === 'text' && event.commandId === whole?.commandId;
    return {
      stage: this.core.stage(conversation, turn ?? null, host, allocation),
      now: this.core.time(),
      available: this.core.fleet.connected(this.core.hostProject),
      conversation: {
        ...publicConversation(conversation),
        model: this.core.model(conversation.model).id,
      },
      commands: commands.map(publicCommand),
      host: view,
      models: this.core.config.models.map(({ effort: _effort, ...model }) => model),
      ...(this.asks.has(id) ? { screen: this.asks.get(id)!.asked } : {}),
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
    const person = await this.core.person(tx, this.core.key(userId, projectId));
    const catalog = await this.core.catalog(source, tx);
    const live = host && !this.core.idleOver(host) ? host : null;
    const shown = live?.current && catalog.find(({ key }) => key === live.current!.machine);
    return {
      machine: shown ? (({ available: _a, reason: _r, ...machine }) => machine)(shown) : null,
      preferred: await this.core.starting(person, source, tx),
      catalog,
      state: !live?.current ? 'none' : live.current.workerId ? 'ready' : 'starting',
      idleEndsAt: live?.idleSince
        ? new Date(
            Date.parse(live.idleSince) + this.core.config.idleTimeoutSeconds * 1000,
          ).toISOString()
        : null,
      idleSeconds: this.core.config.idleTimeoutSeconds,
      moving: live?.next
        ? { to: live.next.machine, by: live.next.by, since: this.core.movingSince(live.next) }
        : null,
      lastMove: person.moves.at(-1) ?? null,
    };
  }
  async prompt(caller: Caller, id: string): Promise<PiPrompt> {
    this.core.ready();
    const { conversation, commands } = await this.core.read(async (tx) => ({
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
      instructions: piInstructions(this.core.tools.instructions()),
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
    this.core.ready();
    await this.core.read((tx) => this.owned(caller, id, tx));
  }

  async send(caller: Caller, id: string, input: unknown): Promise<PiCommand> {
    this.core.ready();
    // The model only guards the send: a retry is the same message whatever the page showed.
    const { model, ...value } = parse(sendInput, input);
    const renter = await this.hosts.hostCaller();
    const { command, hostId } = await this.core.state.transaction(async (tx) => {
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
      const current = this.core.model(conversation.model);
      check(
        !model || model === current.id,
        'pi_model_changed',
        `This conversation now answers on ${current.label}. Send again to use it.`,
        409,
      );
      // Every read of the turn runs as the person, with their authority as of this message.
      conversation.source = await this.core.scope.delegationSource(caller, tx);
      const { host, queued } = await this.hosts.ensure(
        renter,
        conversation,
        conversation.source,
        tx,
      );
      const slot = host.current!;
      const expiry = this.hosts.turnEnd(slot, conversation.source, this.hosts.startMs(queued));
      check(expiry > this.core.clock(), 'pi_expired', 'Conversation source has expired', 403);
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
        createdAt: this.core.time(),
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
        hash(this.core.modelToken(command)),
        command.createdAt,
        host.id,
        storedTurn(command),
      );
      if (host.idleSince) {
        host.idleSince = null;
        await this.hosts.saveHost(tx, host);
      }
      conversation.activeCommandId = command.id;
      await this.core.saveConversation(tx, conversation);
      return { command: publicCommand(command), hostId: host.id };
    });
    this.core.streams.changed(id, command.id);
    this.core.announce();
    if (hostId) this.core.streams.wake(hostId);
    return command;
  }

  /** What the agent asked of the person's page, by conversation: one at a time, answered by any
   *  of its tabs, or by none before the wait is over. */
  private readonly asks = new Map<
    string,
    { asked: { id: string; show?: PiShow; at?: PiShow }; settle(answer: ScreenAnswer | null): void }
  >();

  /** Asks the page the person has open, only for the agent in a turn, and waits for its answer. */
  private ask(
    caller: Caller,
    asked: { show?: PiShow; at?: PiShow } = {},
  ): Promise<ScreenAnswer | null> {
    const at = caller.conversation;
    check(at, 'pi_forbidden', "Only the person's own agent can use their screen", 403);
    this.asks.get(at.id)?.settle(null);
    const id = `ask_${randomBytes(12).toString('hex')}`;
    return new Promise<ScreenAnswer | null>((resolve) => {
      const timer = setTimeout(() => settle(null), this.config.screen.waitMs);
      const settle = (answer: ScreenAnswer | null) => {
        clearTimeout(timer);
        if (this.asks.get(at.id)?.asked.id === id) this.asks.delete(at.id);
        this.core.streams.changed(at.id, at.commandId);
        resolve(answer);
      };
      this.asks.set(at.id, { asked: { id, ...asked }, settle });
      this.core.streams.changed(at.id, at.commandId);
    });
  }

  /** screen.look {question}: the person's open page answers with its snapshot, Cloudflare draws
   *  it, and the conversation's model says what it shows. */
  async look(caller: Caller, input: unknown): Promise<{ page?: string; seen: string }> {
    this.core.ready();
    const { question, at } = parse(lookInput, input);
    check(
      !at || !at.record !== !at.page,
      'invalid_input',
      'Name one record or one page to look at',
      400,
    );
    const answer = await this.ask(caller, at ? { at } : {});
    if (answer?.missing) return { seen: answer.missing };
    const shot = answer?.shot;
    if (!shot) return { seen: `The person's screen could not be seen: ${UNANSWERED}` };
    const conversation = await this.core.read((tx) =>
      this.core.conversation(tx, caller.conversation!.id),
    );
    const key = process.env[this.config.modelApiKeyEnv];
    check(key, 'pi_screen_unavailable', 'The screen could not be read', 503);
    const picture = await renderScreen(this.config.screen, shot);
    const model = this.core.model(conversation.model).id;
    const { text } = await describeScreen(key, model, question, picture, shot.path);
    return { page: shot.path, seen: text };
  }

  /** screen.show {record | page}: the person's open page goes there, as a link would take it, and
   *  says where it went; the person's own back returns them. */
  async show(
    caller: Caller,
    input: unknown,
  ): Promise<{ opened?: string; title?: string; said?: string }> {
    this.core.ready();
    const { record, page } = parse(showInput, input);
    check(!record !== !page, 'invalid_input', 'Name one record or one page', 400);
    const answer = await this.ask(caller, { show: record ? { record } : { page: page! } });
    if (answer?.opened) return { opened: answer.opened.path, title: answer.opened.title };
    return { said: answer?.missing ?? `Nothing was shown: ${UNANSWERED}` };
  }

  /** pi.screen: the page answers what it was asked, once; an ask already over is refused. */
  async screen(caller: Caller, input: unknown): Promise<{ received: true }> {
    this.core.ready();
    const { id, askId, ...answer } = parse(screenInput, input);
    await this.core.read((tx) => this.owned(caller, id, tx));
    const waiting = this.asks.get(id);
    check(waiting?.asked.id === askId, 'pi_look_over', 'That ask is no longer waiting', 409);
    waiting.settle(answer);
    return { received: true };
  }

  /** pi.voice {id, sdp}: a GPT-Live session for this conversation, opened here with the model
   *  key and seeded with its last turns; the browser gets back only the WebRTC answer. */
  async voice(caller: Caller, input: unknown): Promise<{ sessionId: string; sdp: string }> {
    this.core.ready();
    const { id, sdp } = parse(voiceInput, input);
    const { commands, userId } = await this.core.read(async (tx) => {
      const conversation = await this.owned(caller, id, tx);
      const rows = await tx.all<{ data_json: string }>(
        'SELECT data_json FROM pi_commands WHERE conversation_id=? ORDER BY created_at,id',
        id,
      );
      return { commands: rows.map(decode<PiCommandRecord>), userId: conversation.userId };
    });
    const key = process.env[this.config.modelApiKeyEnv];
    check(key, 'pi_voice_unavailable', 'Voice is unavailable', 503);
    return openVoice(this.config.voice, key, sdp, voiceHistory(commands), hash(userId));
  }

  async warm(caller: Caller, input: unknown): Promise<PiSnapshot> {
    this.core.ready();
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
      (await this.core.read(empty))?.id ??
      (await this.create(caller, { requestId: value.requestId })).id;
    if (!this.core.fleet.connected(this.core.hostProject)) return this.snapshot(caller, id);
    const renter = await this.hosts.hostCaller();
    await this.core.state.transaction(async (tx) => {
      const conversation = await this.owned(caller, id, tx);
      const source = await this.core.scope.delegationSource(caller, tx);
      await this.hosts.ensure(renter, conversation, source, tx, true);
    });
    this.core.announce();
    return this.snapshot(caller, id);
  }
  private async requireConversation(caller: Caller, tx: Transaction): Promise<DelegationSource> {
    this.core.ready();
    check(caller.conversation, 'pi_forbidden', 'Conversation authority is required', 403);
    const conversation = await this.core.conversation(tx, caller.conversation.id);
    const command = await this.core.command(tx, conversation.id, caller.conversation.commandId);
    const host = command.hostId ? await this.core.host(tx, command.hostId) : null;
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
        command.expiresAt > this.core.time(),
      'pi_authority_stale',
      'Conversation authority is no longer active',
      403,
    );
    check(
      await this.core.fleet.admits(slot.allocationId, slot.allocationEpoch, tx),
      'pi_runtime_stale',
      'Conversation runtime no longer admits work',
      403,
    );
    return structuredClone(conversation.source);
  }

  /** pi.run: the person presses Run on a call their agent proposed, which runs once, as them, with
   * every check their own call meets. A secret result reaches only them: nothing keeps it. */
  async run(caller: Caller, input: unknown): Promise<PiRan> {
    this.core.ready();
    const value = parse(runInput, input);
    const find = (command: PiCommandRecord) =>
      command.proposals?.find(({ id }) => id === value.proposalId);
    const proposal = await this.core.state.transaction(async (tx) => {
      const conversation = await this.owned(caller, value.id, tx);
      check(
        !conversation.activeCommandId,
        'pi_turn_busy',
        'This conversation already has an active turn',
        409,
      );
      const command = await this.core.command(tx, value.id, value.commandId);
      const proposal = find(command);
      check(proposal, 'pi_not_found', 'Proposal not found', 404);
      check(!proposal.ran, 'pi_proposal_ran', 'This call has already run', 409);
      proposal.ran = { at: this.core.time() };
      await this.core.saveCommand(tx, command);
      return proposal;
    });
    this.core.streams.changed(value.id, value.commandId);
    const run: Run = { ...value, name: proposal.name, at: this.core.clock() };
    this.runs.set(proposal.id, run);
    let result: unknown = null;
    let code: string | undefined;
    let said = '';
    try {
      result = await this.core.tools.call(proposal.name, caller, proposal.input);
    } catch (error) {
      // A refusal is an answer too, in the tool's own words; a failure the server did not word
      // for a person says only that it failed.
      const refused = error instanceof MervError;
      code = refused ? error.code : 'tool_failed';
      said = refused && error.status < 500 ? error.message : 'it failed';
    }
    const told: Told = code
      ? { told: `${proposal.name} was refused: ${said}`, said, whole: true }
      : await this.ran(proposal, result);
    run.outcome = {
      ok: !code,
      ...(code && { code }),
      told: told.told,
      ...(told.said !== undefined && { said: told.said }),
    };
    // The call ran, so how it came out is kept even past a failed write: the next tick keeps it,
    // and a page that lost this answer reads it there and tells the agent from it.
    for (let attempt = 1; ; attempt++)
      try {
        const kept = await this.keep(value.id, value.commandId, (p) =>
          p.id === proposal.id ? run.outcome : undefined,
        );
        this.runs.delete(proposal.id);
        return { result, told: find(kept)!.ran!.told!, whole: told.whole };
      } catch (error) {
        if (attempt === SAVE_ATTEMPTS) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
      }
  }
  /** Keeps how a turn's ran calls came out, each `outcome` names whose outcome is not kept yet:
   *  one kept first, an interruption the agent may already have been told, stands. */
  private async keep(
    id: string,
    commandId: string,
    outcome: (proposal: PiProposal) => Outcome | undefined,
  ): Promise<PiCommandRecord> {
    const { command, kept } = await this.core.state.transaction(async (tx) => {
      const command = await this.core.command(tx, id, commandId);
      const open = command.proposals?.filter((p) => p.ran && p.ran.ok === undefined) ?? [];
      const kept = open.filter((p) => Object.assign(p.ran!, outcome(p)).ok !== undefined);
      if (kept.length) await this.core.saveCommand(tx, command);
      return { command, kept: kept.length };
    });
    if (kept) this.core.streams.changed(id, commandId);
    return command;
  }

  /** What Run tells the agent in the person's name: the sentence that stands for a result only the
   *  person sees, the tool's own receipt, or as much of the result's JSON as Run sends; `said` is
   *  the part of it that is the outcome. */
  private async ran(proposal: PiProposal, result: unknown): Promise<Told> {
    if (proposal.secret)
      return { told: `Ran ${proposal.name}; its result is shown only to me.`, whole: false };
    try {
      const tool = (await this.core.tools.list()).find(({ name }) => name === proposal.name);
      const receipt =
        tool && 'receipt' in tool ? tool.receipt?.(result, proposal.input) : undefined;
      if (receipt) {
        const said = JSON.stringify(receipt.summary);
        return {
          told: `Ran ${proposal.name}: ${said}. Re-read ${receipt.reread.join(' and ')} for current details.`,
          said,
          whole: false,
        };
      }
    } catch {
      // The call ran; a receipt that fails says nothing, and the result stands for it.
    }
    // A cut inside a character would leave half of it, which pi.send refuses.
    const json = (JSON.stringify(result) ?? 'null').slice(0, 4000).replace(/[\uD800-\uDBFF]$/, '');
    return { told: `Ran ${proposal.name}: ${json}`, said: json, whole: true };
  }

  /** Interrupts this conversation's turn only; the host serves the person's others. */
  async stop(caller: Caller, id: string): Promise<PiSnapshot> {
    this.core.ready();
    await this.core.state.transaction(async (tx) => {
      const conversation = await this.owned(caller, id, tx);
      if (!conversation.activeCommandId) return;
      const command = await this.core.command(tx, id, conversation.activeCommandId);
      await this.hosts.interrupt(tx, command, 'cancelled');
      await this.hosts.quiet(tx, command.hostId);
    });
    this.core.announce();
    return this.snapshot(caller, id);
  }

  /** pi.machine.set: the person's pick, for new hosts and now (T2), or back to C while N starts
   * (T11). Only a machine they may choose here; it replaces where the agent last moved them. */
  async setMachine(caller: Caller, input: unknown): Promise<PiHostView> {
    this.core.ready();
    const { machine } = parse(machineInput, input);
    const renter = await this.hosts.hostCaller();
    const view = await this.core.state.transaction(async (tx) => {
      const userId = await this.user(caller, tx);
      const source = await this.core.scope.delegationSource(caller, tx);
      const option = (await this.core.catalog(source, tx)).find(({ key }) => key === machine);
      check(
        option?.available,
        'pi_machine_unavailable',
        option ? `${option.label} ${option.reason}` : 'That machine is not offered',
        403,
      );
      const key = this.core.key(userId, caller.projectId);
      const found = await this.core.liveHost(tx, key);
      if (found) await this.hosts.settle(tx, found, renter);
      const person = await this.core.person(tx, key);
      Object.assign(person, { preferred: machine, sticky: null, choseAt: this.core.time() });
      await this.core.savePerson(tx, person);
      const host = found?.status === 'live' ? found : null;
      const { current, next } = host ?? {};
      if (host && current && next && current.machine === machine && next.machine !== machine) {
        await this.hosts.abandon(tx, host, 'cancelled');
        await this.hosts.saveHost(tx, host);
      } else if (host && current && current.machine !== machine && next?.machine !== machine) {
        if (await this.hosts.move(tx, renter, host, machine, 'person'))
          await this.hosts.saveHost(tx, host);
      }
      return this.hostView(tx, host, { userId, projectId: caller.projectId }, source);
    });
    this.core.announce();
    return view;
  }

  /** pi.machine.stop (T9): every turn of the host ends, every slot is released, and the next
   * host starts on the person's own pick. */
  async stopMachine(caller: Caller): Promise<PiHostView> {
    this.core.ready();
    const view = await this.core.state.transaction(async (tx) => {
      const userId = await this.user(caller, tx);
      const key = this.core.key(userId, caller.projectId);
      const person = await this.core.person(tx, key);
      person.sticky = null;
      await this.core.savePerson(tx, person);
      const host = await this.core.liveHost(tx, key);
      if (host) await this.hosts.end(tx, host, 'stopped');
      const source = await this.core.scope.delegationSource(caller, tx);
      return this.hostView(tx, null, { userId, projectId: caller.projectId }, source);
    });
    this.core.announce();
    return view;
  }

  /** pi.model.set: the conversation's model from its next unclaimed turn, and the person's default
   * for new conversations here. Only the person: conversation, session and managed callers are
   * refused (user), and no agent tool reaches it. An answer under way keeps its model. */
  async setModel(caller: Caller, input: unknown): Promise<PiSnapshot> {
    this.core.ready();
    const { id, model } = parse(modelInput, input);
    await this.core.state.transaction(async (tx) => {
      const conversation = await this.owned(caller, id, tx);
      check(
        this.core.config.models.some((offered) => offered.id === model),
        'pi_model_unavailable',
        'That model is not offered',
        403,
      );
      conversation.model = model;
      await this.core.saveConversation(tx, conversation, false);
      await tx.run(
        'INSERT INTO pi_people(key,data_json) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data_json=excluded.data_json',
        this.pickKey(conversation.userId, conversation.projectId),
        JSON.stringify({ model }),
      );
    });
    this.core.streams.nudge(id);
    return this.snapshot(caller, id);
  }

  /** The relay for this Pi's workers' model calls, which Fleet builds: its owner mounts it and
   *  closes it with the mount. Its failure and usage records go to stderr. */
  modelRelay(): ModelRelayHandle {
    const log = (record: object) => void process.stderr.write(`${JSON.stringify(record)}\n`);
    return this.core.fleet.modelRelay(
      piModelRelay({
        models: this.core.config.models,
        providerKey: () => process.env[this.core.config.modelApiKeyEnv] ?? '',
        authority: {
          authorize: (token) => this.authorizeModel(token),
          validate: (grant) => this.validateModel(grant),
        },
        onFailure: log,
        reserve: (grant, body) => this.core.tokens.reserve(grant, body),
        onUsage: async (record, grant, reserved) => {
          log(record);
          await this.core.tokens.settle(record, grant, reserved);
        },
      }),
    );
  }

  async authorizeModel(token: string) {
    this.core.ready();
    check(
      /^pir_[A-Za-z0-9_-]{43}$/.test(token),
      'pi_unauthorized',
      'Invalid model credential',
      401,
    );
    return this.core.read(async (tx) => {
      const credential = await this.core.credentials
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
      const conversation = await this.core.conversation(tx, command.conversationId);
      check(
        credential.subject === this.core.modelSubject(command) &&
          equal(token, this.core.modelToken(command)) &&
          command.status === 'working',
        'pi_unauthorized',
        'Model credential is no longer active',
        401,
      );
      await this.requireConversation(conversationCaller(conversation, command), tx);
      await this.core.scope.requireDelegation(conversation.source, 'read', tx);
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
        model: this.core.model(command.model).id,
        // Only the tools this turn was offered, the same for every call of the turn.
        toolNames: (command.tools ?? []).map(piModelToolName),
      };
    });
  }

  async validateModel(grant: Awaited<ReturnType<PiService['authorizeModel']>>): Promise<void> {
    this.core.ready();
    await this.core.read(async (tx) => {
      const conversation = await this.core.conversation(tx, grant.conversationId);
      const command = await this.core.command(tx, conversation.id, grant.commandId);
      await this.core.credentials
        .authenticateHash(tokenDigest(this.core.modelToken(command)), 'pi-model', tx)
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
          grant.model === this.core.model(command.model).id &&
          command.status === 'working',
        'pi_authority_stale',
        'Model authority is no longer active',
        403,
      );
      await this.requireConversation(conversationCaller(conversation, command), tx);
      await this.core.scope.requireDelegation(conversation.source, 'read', tx);
    });
  }

  async close(): Promise<void> {
    if (this.core.closed) return;
    this.core.closed = true;
    clearInterval(this.timer);
    await this.hosts.pending?.catch(() => undefined);
    // A restart releases every machine; the next send starts one where the person left off. A
    // turn that has shown nothing waits: the next process starts it on a fresh machine.
    await this.core.state.transaction(async (tx) => {
      const hosts = await tx.all<{ data_json: string }>(
        "SELECT data_json FROM pi_hosts WHERE status='live'",
      );
      for (const row of hosts)
        await this.hosts.end(
          tx,
          decode<PiHostRecord>(row),
          'restart',
          'service_unavailable',
          (turn) => this.hosts.again(turn, false),
        );
    });
    for (const dispose of this.disposers.reverse()) dispose();
    this.core.streams.close();
  }
}

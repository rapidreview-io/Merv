import type { Caller, Data, DelegationSource } from '@merv/contracts';
import type { PiModelConfig } from './schema.js';

export type PiStatus = 'waiting' | 'starting' | 'working' | 'saving' | 'completed' | 'interrupted';
/** Why a command was interrupted; the UI turns each into a sentence. */
export type PiInterruption =
  | 'worker_interrupted'
  | 'runtime_lost'
  | 'runtime_refused'
  | 'runtime_stopped'
  | 'turn_expired'
  | 'service_unavailable'
  | 'ambiguous_prompt'
  | 'checkpoint_unavailable'
  | 'cancelled';
export interface PiMessage {
  role: 'user' | 'assistant';
  text: string;
}
export interface PiToolOutcome {
  callId: string;
  name: string;
  input: Data;
  output: Data;
}
export interface PiCheckpoint {
  hash: string;
  size: number;
  commandId: string;
}
export interface PiConversation {
  id: string;
  projectId: string;
  userId: string;
  title: string;
  revision: number;
  activeCommandId: string | null;
  checkpoint: PiCheckpoint | null;
  previousCheckpoint: PiCheckpoint | null;
  /** Set at create from the person's last pick here; changed only by pi.model.set. Absent before
   * 2026-09-25, meaning config.models[0]. */
  model?: string;
  createdAt: string;
  updatedAt: string;
}
export interface PiConversationRecord extends PiConversation {
  /** The person's own authority, refreshed on every send: every data read of a turn runs as it. */
  source: DelegationSource;
}
export interface PiCommand {
  id: string;
  conversationId: string;
  /** The epoch of the host slot that serves this turn (PiSlot.epoch). */
  epoch: number;
  /** The Fleet allocation of the host slot that serves this turn (PiSlot.allocationId). */
  runtimeId: string;
  /** The person's host, and the machine key of the slot serving the turn; a cut-over moves an
   * unclaimed turn, so both can change until a worker claims it. Absent on turns before pi@2. */
  hostId?: string;
  machine?: string;
  /** The model it answers on, fixed when a worker claims it. */
  model?: string;
  status: PiStatus;
  messages: PiMessage[];
  outcomes: PiToolOutcome[];
  error: PiInterruption | null;
  createdAt: string;
  /** When the worker began the turn, and when its first text streamed; absent until then. */
  startedAt?: string;
  firstTextAt?: string;
  expiresAt: string;
  completedAt: string | null;
  /** Calls the agent proposed in this turn, which the person's page shows with Run. */
  proposals?: PiProposal[];
}
/** A call only the person may run (ToolDefinition.conversation), as the agent proposed it: Main's
 * parsed copy of its exact input. */
export interface PiProposal {
  /** 'pip_…' */
  id: string;
  /** The native tool name. */
  name: string;
  input: Data;
  /** Its result is shown only to the person and never kept. */
  secret?: true;
  at: string;
  /** Claimed when the person pressed Run, so it runs once; ok and code once it returned. */
  ran?: { at: string; ok?: boolean; code?: string };
}
export interface PiCommandRecord extends PiCommand {
  inputHash: string;
  workerId: string | null;
  resultHash: string | null;
  /** switch_machine was offered with this turn's claim: a claim served again offers it again. */
  canMove?: true;
  /** The native names this turn offers, fixed at its first serve: its relay grant names exactly
   * these, and its tool calls and outcomes only these. Absent until then. */
  tools?: string[];
  /** The lines this turn appended to the agent's instructions (turnNotes, then its machine's),
   * fixed at its first serve like tools. Absent for a turn served before they were kept. */
  notes?: string[];
  /** Its first tool call, recorded before the call runs: from then it never starts again. */
  calledAt?: string;
  /** It started again once, on a fresh machine, after its own was lost. */
  retried?: true;
}
export interface PiEvent {
  sequence: number;
  commandId: string;
  type: 'text' | 'progress' | 'changed';
  text: string;
}
/** What the person is waiting on right now, in the order a cold turn passes through. `moving`: the
 * host is starting another machine to move to (PiHostView.moving says which); turns keep running
 * on the current one meanwhile. */
export type PiStageName =
  | 'idle'
  | 'queued'
  | 'machine'
  | 'agent'
  | 'ready'
  | 'thinking'
  | 'tool'
  | 'writing'
  | 'saving'
  | 'moving';
export interface PiStage {
  name: PiStageName;
  /** When this stage began, so the UI can count seconds. */
  since: string;
  /** A short human phrase, e.g. the tool being used. */
  detail?: string;
}
/** A model a person may pick for a conversation (MERV_PI_MODELS), without the relay's effort. */
export type PiModel = Omit<PiModelConfig, 'effort'>;
export interface PiSnapshot {
  stage: PiStage;
  /** The server's clock when this was read, which a stage's `since` is counted against. */
  now: string;
  /** False when the agent cannot run at all: the Pi host project cannot rent machines. A project
   * needs no Sandboxes connection of its own for the agent. */
  available: boolean;
  conversation: PiConversation;
  commands: PiCommand[];
  /** The machine this person's turns run on in this project, shared by all their conversations. */
  host: PiHostView;
  /** What the person may pick; `conversation.model` is always one of them. */
  models: PiModel[];
  streamId: string;
  sequence: number;
  tail: PiEvent[];
}

/** Who began a move: the person (picker), their agent (switch_machine) or a slot's deadline. */
export type PiMoveBy = 'person' | 'agent' | 'deadline';
/** One machine the operator offers, as the Sandboxes service describes its offer. */
export interface PiMachine {
  /** 'standard' (the default, config.machines[0]) or 'large'. */
  key: string;
  label: string;
  vcpu: number;
  memoryGiB: number;
  diskGB: number;
  /** The offer's upper bound per hour; the provider meters less while idle. */
  maxHourlyUsd: number;
}
/** A catalog entry as one person sees it in one project. */
export interface PiMachineOption extends PiMachine {
  /** False where this person may not choose it here (see PiService.machineChoice). */
  available: boolean;
  /** Why not, in a short phrase the picker shows; set only when unavailable. */
  reason?: string;
}
/** PiService.machineChoice: whether a person, and so their agent, may run on a machine here. */
export type PiMachineChoice = { allowed: true } | { allowed: false; reason: string };
/** Why a move failed, in the service's own words: it reaches later turns' system prompts and the
 * person's page, so it is never text a model or a person wrote. */
export type PiMoveFailure = 'no free machine' | 'not ready in time' | 'the machine stopped';
/** One move, kept in PiPersonRecord.moves for 24 hours, stamped at its outcome. The agent's own
 * reason stays in its turn's switch_machine outcome. */
export interface PiMove {
  at: string;
  by: PiMoveBy;
  /** Machine keys. */
  from: string;
  to: string;
  outcome: 'moved' | 'failed' | 'cancelled';
  /** Only on a failed move. */
  reason?: PiMoveFailure;
  /** The conversation whose agent asked; absent for the person and deadlines. */
  conversationId?: string;
}
/** One Fleet allocation of a host. The Fleet owner is `pi-host`, id `${hostId}:${epoch}`. */
export interface PiSlot {
  allocationId: string;
  /** The allocation's own epoch, which Fleet.admits checks. */
  allocationEpoch: number;
  /** The host epoch this slot was requested at; the worker token signs [hostId, allocationId, epoch]. */
  epoch: number;
  /** PiMachine key. */
  machine: string;
  /** The allocation's deadline; T10 rolls over 15 minutes before it. */
  expiresAt: string;
  /** The worker that enrolled with the slot's first /next, and when; null until then. */
  workerId: string | null;
  enrolledAt: string | null;
  /** When the slot proved ready (enrolled, and for a next slot its probe round-trip). */
  readyAt: string | null;
}
/** A slot being started to move to; it serves nothing until cut-over (T4). */
export interface PiNextSlot extends PiSlot {
  by: PiMoveBy;
  conversationId: string | null;
  /** T6 gives up on the slot at this time (requested + 180 s). */
  readyBy: string;
}
/** State row pi_hosts: the one live machine set of a host key. Every transition is one transaction
 * that compares and sets `revision`, then kicks Fleet. */
export interface PiHostRecord {
  /** 'pih_…' */
  id: string;
  /** `${userId}:${projectId}` (config.runtimeKey 'project', the default), or userId ('person'). */
  key: string;
  userId: string;
  status: 'live' | 'ended';
  /** Raised for every slot requested. */
  epoch: number;
  revision: number;
  /** C: serves new turns. */
  current: PiSlot | null;
  /** N: being started to replace C (make-before-break). */
  next: PiNextSlot | null;
  /** D: a replaced C finishing its claimed turns; its /next answers retire. */
  draining: PiSlot | null;
  /** When the last turn in any of this key's conversations ended (or a warm began); null while
   * one runs. The host ends idleTimeoutSeconds (600) later. */
  idleSince: string | null;
  createdAt: string;
  ended: { at: string; reason: string } | null;
}
/** State row pi_people, keyed like the host (per person per project by default). Survives a host
 * ending and a Main restart. */
export interface PiPersonRecord {
  key: string;
  /** The machine the person picked; config.machines[0] until they pick. */
  preferred: string;
  /** Where an agent's move went; a new host starts there. Cleared when the host idles or is stopped. */
  sticky: string | null;
  /** When the person last picked a machine. */
  choseAt: string | null;
  /** The last 24 hours of moves, oldest first. */
  moves: PiMove[];
}
/** What the Agent page shows of the host. */
export interface PiHostView {
  /** The machine serving new turns (C); null with no live host. */
  machine: PiMachine | null;
  /** What a new host would start on: sticky ?? preferred, or the default where that is not allowed. */
  preferred: string;
  catalog: PiMachineOption[];
  /** none: no live host; starting: C has not enrolled a worker; ready: it has. */
  state: 'none' | 'starting' | 'ready';
  /** When an idle host stops; null while a turn runs or with no host. */
  idleEndsAt: string | null;
  /** How long a host stays up after the last turn in any of its conversations
   * (config.idleTimeoutSeconds). */
  idleSeconds: number;
  moving: { to: string; by: PiMoveBy; since: string } | null;
  /** The latest move in PiPersonRecord.moves, for the failure line. */
  lastMove: PiMove | null;
}

/** Bootstrap v2: one worker per host slot, running up to `slots` turns of any of the key's
 * conversations at once. Worker and start-runtime refuse any other version. */
export interface PiBootstrap {
  kind: 'pi';
  version: 2;
  baseUrl: string;
  hostId: string;
  /** The slot's Fleet allocation. */
  runtimeId: string;
  /** The slot's host epoch (PiSlot.epoch). */
  epoch: number;
  /** PiMachine key. */
  machine: string;
  /** Turns this worker runs at once: config.machines[].slots. */
  slots: number;
  /** `piw_${allocationId}.${HMAC([hostId, allocationId, epoch])}` */
  workerToken: string;
  expiresAt: string;
}
/** POST /pi-worker/next. */
export interface PiNextInput {
  workerId: string;
  /** The probe the previous reply carried, echoed once to prove this worker is ready (T4). */
  probe?: string;
}
/** The /next reply, sent as is. */
export interface PiNextReply {
  work: PiWork | null;
  /** On a next slot's enrollment: echo it on the following /next (HMAC(hostId, slot, workerId)). */
  probe?: string;
  /** This slot is draining: take no more work, finish running turns, exit. */
  retire?: true;
}
/** begin, tool, progress, complete and fail name the turn by its conversation too, since one
 * worker serves many conversations. */
export interface PiTurnInput {
  workerId: string;
  conversationId: string;
  commandId: string;
}
export interface PiWork {
  command: PiCommand;
  checkpoint: { content: string; hash: string } | null;
  model: string;
  modelBaseUrl: string;
  modelToken: string;
  /** Native names, which the worker calls by piModelToolName (machine.switch, only when offered
   * this turn, is switch_machine). readOnly false marks a write: tried once, run in order, its
   * result always shown whole. Absent (an older Main) is a read. */
  tools: { name: string; description: string; inputSchema: Data; readOnly?: boolean }[];
  /** At most 8 lines of at most 300 characters the worker appends to this turn's system prompt:
   * who the agent serves, today and its model, what the project lacks, its machine. */
  notes: string[];
  /** The agent's instructions (at most 32,000 characters), the same on every turn; an older Main
   * sends none and the worker keeps its own. */
  instructions?: string;
}
/** Agent tool machine.switch, seen by the model as switch_machine. Input: switchMachineInput. */
export type PiSwitchMachineResult =
  | { status: 'starting' | 'already' }
  | {
      error: {
        code: 'move_in_progress' | 'move_limit' | 'machine_unavailable';
        retryAfterSeconds?: number;
      };
    };
export type PiSwitchMachineError = Extract<PiSwitchMachineResult, { error: unknown }>['error'];
export interface PiRelayGrant {
  id: string;
  userId: string;
  projectId: string;
  conversationId: string;
  commandId: string;
  runtimeId: string;
  epoch: number;
  expiresAt: string;
  model: string;
  toolNames: string[];
}
export interface PiCompletion {
  commandId: string;
  workerId: string;
  messages: PiMessage[];
  outcomes: PiToolOutcome[];
  checkpoint: string;
  checkpointHash: string;
}
/** What the agent is given, as its person may see it: the instructions every turn shares, and
 * the latest turn's appended notes and offered tools exactly as that turn was served. */
export interface PiPrompt {
  instructions: string;
  turn: { commandId: string; notes: string[]; tools: string[] } | null;
}
export interface Pi {
  create(caller: Caller, input: unknown): Promise<PiConversation>;
  list(caller: Caller): Promise<PiConversation[]>;
  snapshot(caller: Caller, id: string): Promise<PiSnapshot>;
  /** See pi.prompt. */
  prompt(caller: Caller, id: string): Promise<PiPrompt>;
  send(caller: Caller, id: string, input: unknown): Promise<PiCommand>;
  /** Make sure the person's host exists before their first message; see pi.warm. */
  warm(caller: Caller, input: unknown): Promise<PiSnapshot>;
  /** Interrupt this conversation's turn only; the host keeps serving the others. */
  stop(caller: Caller, id: string): Promise<PiSnapshot>;
  /** pi.machine.set {machine}: the person picks their machine here (T2, or T11 to cancel a move). */
  setMachine(caller: Caller, input: unknown): Promise<PiHostView>;
  /** pi.machine.stop {}: interrupt every turn of the host, release every slot, clear sticky (T9). */
  stopMachine(caller: Caller): Promise<PiHostView>;
  /** pi.run {id, commandId, proposalId}: run a call the agent proposed, once, as the person. */
  run(caller: Caller, input: unknown): Promise<{ result: unknown }>;
  /** pi.model.set {id, model}: the person picks the conversation's model, and their default here. */
  setModel(caller: Caller, input: unknown): Promise<PiSnapshot>;
}
/** Server-facing contract: transport and UI do not need the service implementation. */
export interface PiRuntime extends Pi {
  readonly config: {
    enabled: boolean;
    models: readonly PiModelConfig[];
    modelApiKeyEnv: string;
    turnTimeoutSeconds: number;
  };
  readonly streams: {
    snapshot(id: string): { streamId: string; sequence: number; tail: PiEvent[] };
    subscribe(id: string, listener: () => void): () => void;
  };
  authorizeStream(caller: Caller, id: string): Promise<void>;
  authenticateWorker(token: string): Promise<void>;
  /** Holds up to `holdMs` for work before answering `work: null`. */
  next(token: string, input: unknown, holdMs?: number): Promise<PiNextReply>;
  tool(token: string, input: unknown): Promise<unknown>;
  begin(token: string, input: unknown): Promise<{ apply: boolean }>;
  progress(token: string, input: unknown): Promise<{ accepted: true }>;
  complete(token: string, input: unknown): Promise<{ saved: boolean }>;
  fail(token: string, input: unknown): Promise<{ interrupted: true }>;
  authorizeModel(token: string): Promise<PiRelayGrant>;
  validateModel(grant: PiRelayGrant): Promise<void>;
  /** Charges a call to its person's Agent tokens today and returns the charge; refuses at the ceiling. */
  reserveModel(grant: PiRelayGrant, body: Record<string, unknown>): Promise<number>;
  settleModel(
    usage: { inputTokens: number; outputTokens: number },
    grant: PiRelayGrant,
    reserved: number,
  ): Promise<void>;
}
declare module 'cordis' {
  interface Context {
    pi: PiRuntime;
  }
}

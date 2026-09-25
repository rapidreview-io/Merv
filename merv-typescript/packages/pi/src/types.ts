import type { Caller, Data, DelegationSource } from '@merv/contracts';

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
  /** @deprecated Per-conversation runtime binding; hosts replace it (G2 deletes). */
  epoch: number;
  /** @deprecated Per-conversation runtime binding; hosts replace it (G2 deletes). */
  runtimeId: string | null;
  activeCommandId: string | null;
  checkpoint: PiCheckpoint | null;
  previousCheckpoint: PiCheckpoint | null;
  createdAt: string;
  updatedAt: string;
}
export interface PiConversationRecord extends PiConversation {
  /** The person's own authority, refreshed on every send: every data read of a turn runs as it. */
  source: DelegationSource;
  /** @deprecated Per-conversation runtime binding; hosts replace it (G2 deletes). */
  runtimeEpoch: number | null;
  /** @deprecated Per-conversation runtime binding; hosts replace it (G2 deletes). */
  runtimeExpiresAt: string | null;
  /** @deprecated The idle clock is the host's (PiHostRecord.idleSince). */
  idleSince: string | null;
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
}
export interface PiCommandRecord extends PiCommand {
  inputHash: string;
  workerId: string | null;
  resultHash: string | null;
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
/** One move, kept in PiPersonRecord.moves for 24 hours. */
export interface PiMove {
  at: string;
  by: PiMoveBy;
  /** Machine keys. */
  from: string;
  to: string;
  outcome: 'moved' | 'failed' | 'cancelled';
  /** The agent's stated reason, or why the move failed. */
  reason?: string;
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
  reason: string;
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
  /** The Pi host service identity that rents every slot in the host project; never the person. */
  source: DelegationSource;
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
  /** How many of this person's conversations, in how many projects, share the machine. */
  shared: { conversations: number; projects: number };
  moving: { to: string; by: PiMoveBy; since: string } | null;
  /** The latest move in PiPersonRecord.moves, for Undo and the failure line. */
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
/** @deprecated The per-conversation bootstrap; G2 and G4 delete it with the v1 paths. */
export interface PiBootstrapV1 {
  kind: 'pi';
  baseUrl: string;
  projectId: string;
  conversationId: string;
  runtimeId: string;
  epoch: number;
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
  /** Native names; machine.switch (model name switch_machine) only when offered this turn. */
  tools: { name: string; description: string; inputSchema: Data }[];
  /** At most 4 lines of at most 300 characters the worker appends to this turn's system prompt,
   * e.g. the machine it runs on and a move that failed. */
  notes: string[];
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
export interface Pi {
  create(caller: Caller, input: unknown): Promise<PiConversation>;
  list(caller: Caller): Promise<PiConversation[]>;
  snapshot(caller: Caller, id: string): Promise<PiSnapshot>;
  send(caller: Caller, id: string, input: unknown): Promise<PiCommand>;
  /** Make sure the person's host exists before their first message; see pi.warm. */
  warm(caller: Caller, input: unknown): Promise<PiSnapshot>;
  /** Interrupt this conversation's turn only; the host keeps serving the others. */
  stop(caller: Caller, id: string): Promise<PiSnapshot>;
  /** pi.machine.set {machine}: the person picks their machine here (T2, or T11 to cancel a move). */
  setMachine(caller: Caller, input: unknown): Promise<PiHostView>;
  /** pi.machine.stop {}: interrupt every turn of the host, release every slot, clear sticky (T9). */
  stopMachine(caller: Caller): Promise<PiHostView>;
}
/** Server-facing contract: transport and UI do not need the service implementation. */
export interface PiRuntime extends Pi {
  readonly config: {
    enabled: boolean;
    model: string;
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
}
declare module 'cordis' {
  interface Context {
    pi: PiRuntime;
  }
}

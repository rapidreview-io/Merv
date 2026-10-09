import type { Caller, Data, DelegationSource } from '@merv/contracts';
import type { ModelRelayHandle } from '@merv/fleet/types';
import type { PiModelConfig } from './schema.js';
import type {
  PiCommand,
  PiConversation,
  PiEvent,
  PiHostView,
  PiMessage,
  PiMove,
  PiMoveBy,
  PiPrompt,
  PiRan,
  PiSnapshot,
  PiToolOutcome,
} from './models.js';

export type * from './models.js';

export interface PiConversationRecord extends PiConversation {
  /** The person's own authority, refreshed on every send: every data read of a turn runs as it. */
  source: DelegationSource;
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
  /** The project context (Tools.context) fixed when this turn was first served. Source material,
   * not instructions. */
  context?: string;
  /** What a turn served before context was generic kept as its paper; never served again. */
  projectPaper?: string;
  /** Its first tool call, recorded before the call runs: from then it never starts again. */
  calledAt?: string;
  /** It started again once, on a fresh machine, after its own was lost. */
  retried?: true;
}
/** PiCore.machineChoice: whether a person, and so their agent, may run on a machine here. */
export type PiMachineChoice = { allowed: true } | { allowed: false; reason: string };
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
  /** T6 gives up on the slot at this time: requested + Fleet's readyWindowMs. */
  readyBy: string;
}
/** State row pi_hosts: the one live machine set of a host key. Every transition is one transaction
 * that compares and sets `revision`, then kicks Fleet. */
export interface PiHostRecord {
  /** 'pih_…' */
  id: string;
  /** `${userId}:${projectId}`: one host per person per project. */
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
   * who the agent serves, today and its model, its machine. */
  notes: string[];
  /** At most 32,000 characters the installed plugins tell this turn about the project, which the
   * worker sends beside the person's message as source material, never instructions. */
  context?: string;
  /** The agent's instructions (at most 32,000 characters), the same on every turn. */
  instructions: string;
  /** The conversation's previous turn was interrupted, so this checkpoint is the one that turn
   * began from: the worker compacts nothing this turn, and sends what it would have compacted
   * within the window, so a summary that cannot finish is not tried (and charged) every turn. */
  previousInterrupted?: true;
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
/** A model call's charge: the day it was charged to and its tokens at their most. */
export type PiModelCharge = { day: string; tokens: number };
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
  /** See pi.prompt. */
  prompt(caller: Caller, id: string): Promise<PiPrompt>;
  send(caller: Caller, id: string, input: unknown): Promise<PiCommand>;
  /** pi.voice {id, sdp}: open a GPT-Live voice session for this conversation; see voice.ts. */
  voice(caller: Caller, input: unknown): Promise<{ sessionId: string; sdp: string }>;
  /** screen.look {question}: the agent sees the person's screen, answered in words (screen.ts). */
  look(caller: Caller, input: unknown): Promise<{ page?: string; seen: string }>;
  /** screen.show {record | page}: the agent puts a record or a page on the person's screen. */
  show(caller: Caller, input: unknown): Promise<{ opened?: string; title?: string; said?: string }>;
  /** pi.screen: the person's page answers a look with a snapshot of itself, a show with where
   *  it went. */
  screen(caller: Caller, input: unknown): Promise<{ received: true }>;
  /** Make sure the person's host exists before their first message; see pi.warm. */
  warm(caller: Caller, input: unknown): Promise<PiSnapshot>;
  /** Interrupt this conversation's turn only; the host keeps serving the others. */
  stop(caller: Caller, id: string): Promise<PiSnapshot>;
  /** pi.machine.set {machine}: the person picks their machine here (T2, or T11 to cancel a move). */
  setMachine(caller: Caller, input: unknown): Promise<PiHostView>;
  /** pi.machine.stop {}: interrupt every turn of the host, release every slot, clear sticky (T9). */
  stopMachine(caller: Caller): Promise<PiHostView>;
  /** pi.run {id, commandId, proposalId}: run a call the agent proposed, once, as the person. */
  run(caller: Caller, input: unknown): Promise<PiRan>;
  /** pi.model.set {id, model}: the person picks the conversation's model, and their default here. */
  setModel(caller: Caller, input: unknown): Promise<PiSnapshot>;
}
/** Server-facing contract: transport and UI do not need the service implementation. */
export interface PiRuntime extends Pi {
  readonly config: {
    models: readonly PiModelConfig[];
    modelApiKeyEnv: string;
    turnTimeoutSeconds: number;
  };
  readonly streams: {
    snapshot(id: string): { streamId: string; sequence: number; tail: PiEvent[] };
    subscribe(id: string, listener: () => void): () => void;
  };
  authorizeStream(caller: Caller, id: string): Promise<void>;
  /** A `piw_` bearer's caller, once its slot is live. */
  authenticateWorker(token: string): Promise<Caller>;
  /** Holds up to `holdMs` for work before answering `work: null`. */
  next(token: string, input: unknown, holdMs?: number): Promise<PiNextReply>;
  tool(token: string, input: unknown): Promise<unknown>;
  begin(token: string, input: unknown): Promise<{ apply: boolean }>;
  progress(token: string, input: unknown): Promise<{ accepted: true }>;
  complete(token: string, input: unknown): Promise<{ saved: boolean }>;
  fail(token: string, input: unknown): Promise<{ interrupted: true }>;
  /** The relay for this Pi's workers' model calls, which Fleet builds: its owner mounts it
   *  public and closes it with the mount. */
  modelRelay(): ModelRelayHandle;
}
declare module 'cordis' {
  interface Context {
    pi: PiRuntime;
  }
}

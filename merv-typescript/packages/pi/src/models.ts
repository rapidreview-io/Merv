/** Portable conversation read models, shared by the server and the browser. */
import type { Data } from '@merv/contracts/data';
import type { PiModelConfig } from './schema.js';

type PiStatus = 'waiting' | 'starting' | 'working' | 'saving' | 'completed' | 'interrupted';
/** Why a command was interrupted; the UI turns each into a sentence. */
export type PiInterruption =
  | 'worker_interrupted'
  | 'runtime_lost'
  | 'runtime_refused'
  | 'wallet_refused'
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
interface PiCheckpoint {
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
  /** What the tool's owner calls the act (its `act`), and the input field that title said. */
  act?: { title: string; says?: string };
  /** Its result is shown only to the person and never kept. */
  secret?: true;
  at: string;
  /** Claimed when the person pressed Run, so it runs once; ok and code once it returned, with what
   *  Run told the agent (PiRan.told) and the part of that which says how it came out: the result
   *  as told, the receipt's summary, or why it was refused. A secret result says nothing. */
  ran?: { at: string; ok?: boolean; code?: string; told?: string; said?: string };
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
  /** A short human phrase for a tool call: what it is (`Reading`), never the tool's name. */
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
  /** The agent asked to see the screen: the person's page answers with pi.screen. */
  look?: { id: string };
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
  /** False where this person may not choose it here (see PiCore.machineChoice). */
  available: boolean;
  /** Why not, in a short phrase the picker shows; set only when unavailable. */
  reason?: string;
}
/** Why a move failed, in the service's own words: it reaches later turns' system prompts and the
 * person's page, so it is never text a model or a person wrote. */
export type PiMoveFailure =
  'no free machine' | 'spending limit' | 'not ready in time' | 'the machine stopped';
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

/** What the agent is given, as its person may see it: the instructions every turn shares, and
 * the latest turn's appended notes and offered tools exactly as that turn was served. */
export interface PiPrompt {
  instructions: string;
  turn: { commandId: string; notes: string[]; tools: string[]; context?: string } | null;
}
/** A proposed call the person ran, and what Run tells the agent of it in their name: `whole` when
 *  that is the result itself (as much of its JSON as fits), else the person alone sees it all. */
export interface PiRan {
  result: unknown;
  told: string;
  whole: boolean;
}

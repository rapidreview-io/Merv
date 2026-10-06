import { readEventStream } from './event-stream';

export interface PiConversation {
  id: string;
  title: string;
  activeCommandId: string | null;
  updatedAt: string;
  /** The model its next answer uses; a conversation listed from before models were kept has none. */
  model?: string;
}
export interface PiCommand {
  id: string;
  status: 'waiting' | 'starting' | 'working' | 'saving' | 'completed' | 'interrupted';
  messages: { role: 'user' | 'assistant'; text: string }[];
  error: string | null;
  /** The machine key the turn ran (or will run) on; absent on turns from before machines. */
  machine?: string;
  /** Calls the agent proposed, which run as the person only when they press Run. */
  proposals?: PiProposal[];
  /** The model that answered it, fixed when a worker claimed it. */
  model?: string;
  /** When it ended, by the server's clock; null while it runs. */
  completedAt?: string | null;
}
/** Mirrors the server's PiProposal. */
export interface PiProposal {
  id: string;
  name: string;
  input: unknown;
  /** The act as the tool's owner titles it, and the input field that title says. */
  act?: { title: string; says?: string };
  secret?: true;
  ran?: { at: string; ok?: boolean; code?: string };
}
/** A model the person may pick for a conversation. */
export interface PiModel {
  id: string;
  label: string;
}
/** Mirrors the server's PiMachine, PiMachineOption, PiMove and PiHostView. */
export interface PiMachine {
  key: string;
  label: string;
  vcpu: number;
  memoryGiB: number;
  diskGB: number;
}
interface PiMachineOption extends PiMachine {
  available: boolean;
  reason?: string;
}
type PiMoveBy = 'person' | 'agent' | 'deadline';
interface PiMove {
  at: string;
  by: PiMoveBy;
  from: string;
  to: string;
  outcome: 'moved' | 'failed' | 'cancelled';
  reason?: string;
  conversationId?: string;
}
export interface PiHostView {
  machine: PiMachine | null;
  preferred: string;
  catalog: PiMachineOption[];
  state: 'none' | 'starting' | 'ready';
  idleEndsAt: string | null;
  idleSeconds: number;
  moving: { to: string; by: PiMoveBy; since: string } | null;
  lastMove: PiMove | null;
}
export interface PiEvent {
  sequence: number;
  commandId: string;
  type: 'text' | 'progress' | 'changed';
  text: string;
}
/** What the person is waiting on, and since when. */
interface PiStage {
  name: string;
  since: string;
  detail?: string;
}
export interface PiSnapshot {
  stage: PiStage;
  /** The server's clock when this was read, which the stage's `since` is counted against. */
  now: string;
  /** False when this project cannot run the agent at all. */
  available: boolean;
  conversation: PiConversation;
  commands: PiCommand[];
  /** The person's machine in this project. */
  host: PiHostView;
  /** The models the person may pick; `conversation.model` is one of them. */
  models: PiModel[];
  streamId: string;
  sequence: number;
  tail: PiEvent[];
}
/** pi.prompt: what the agent is given. The latest turn's notes and tools are as it was served. */
export interface PiPrompt {
  instructions: string;
  turn: { commandId: string; notes: string[]; tools: string[] } | null;
}
export type PiDelta = PiEvent & { streamId: string };
/** Pi's stream: its snapshots and its deltas. Resolves as `readEventStream` does. */
export const readPiEvents = (
  id: string,
  signal: AbortSignal,
  onSnapshot: (snapshot: PiSnapshot) => void,
  onDelta: (delta: PiDelta) => void,
): Promise<boolean> =>
  readEventStream(`/pi/${encodeURIComponent(id)}/events`, signal, (event, value) => {
    if (event === 'snapshot' && 'conversation' in value && 'streamId' in value)
      onSnapshot(value as PiSnapshot);
    if (
      event === 'delta' &&
      'streamId' in value &&
      'sequence' in value &&
      'commandId' in value &&
      'type' in value &&
      'text' in value
    )
      onDelta(value as PiDelta);
  });

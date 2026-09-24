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
  epoch: number;
  runtimeId: string | null;
  activeCommandId: string | null;
  checkpoint: PiCheckpoint | null;
  previousCheckpoint: PiCheckpoint | null;
  createdAt: string;
  updatedAt: string;
}
export interface PiConversationRecord extends PiConversation {
  source: DelegationSource;
  runtimeEpoch: number | null;
  runtimeExpiresAt: string | null;
  idleSince: string | null;
}
export interface PiCommand {
  id: string;
  conversationId: string;
  epoch: number;
  runtimeId: string;
  status: PiStatus;
  messages: PiMessage[];
  outcomes: PiToolOutcome[];
  error: PiInterruption | null;
  createdAt: string;
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
/** What the person is waiting on right now, in the order a cold turn passes through. */
export type PiStageName =
  'idle' | 'queued' | 'machine' | 'agent' | 'ready' | 'thinking' | 'tool' | 'writing' | 'saving';
export interface PiStage {
  name: PiStageName;
  /** When this stage began, so the UI can count seconds. */
  since: string;
  /** A short human phrase, e.g. the tool being used. */
  detail?: string;
}
export interface PiSnapshot {
  stage?: PiStage;
  /** False when this project cannot run the agent at all (no sandbox connection). */
  available: boolean;
  conversation: PiConversation;
  commands: PiCommand[];
  streamId: string;
  sequence: number;
  tail: PiEvent[];
}
export interface PiBootstrap {
  kind: 'pi';
  baseUrl: string;
  projectId: string;
  conversationId: string;
  runtimeId: string;
  epoch: number;
  workerToken: string;
  expiresAt: string;
}
export interface PiWork {
  command: PiCommand;
  checkpoint: { content: string; hash: string } | null;
  model: string;
  modelBaseUrl: string;
  modelToken: string;
  tools: { name: string; description: string; inputSchema: Data }[];
}
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
  stop(caller: Caller, id: string): Promise<PiSnapshot>;
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
  next(token: string, input: unknown): Promise<PiWork | null>;
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

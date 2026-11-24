/**
 * What every agent runtime on the Mac says and takes, whatever drives it underneath: Claude
 * Code through the Agent SDK, Codex through `codex app-server`. Threads carry the provider's
 * own id, so a thread here is the provider's session and resumes as one.
 */
import { browserTools } from './browser.js';
import { computerTools } from './computer.js';
import { boardHere, boardShow, boardTools } from './board.js';

export type Provider = 'claude' | 'codex';
export const authFailure = (text = '') =>
  /\b401\b|\bunauthorized\b|\bmissing bearer\b|\b(?:log|sign)(?:ged|ed|ging|ing)?[ -]?(?:in|out)\b|\b(?:access|refresh) token\b|\b(?:session|credentials?|token) (?:has |have )?expired\b|\b(?:login|token)_(?:required|expired)\b|\blogin ?required\b|\boauth\b|\b(?:un|re)?authenticat\w*/i.test(
    text,
  );
export const providerName = (provider: Provider) =>
  provider === 'claude' ? 'Claude Code' : 'Codex';

export const contextWindow = (provider: Provider, model?: string) =>
  model?.includes('[1m]') ? 1_000_000 : provider === 'claude' ? 200_000 : 272_000;
/** Older stored items use the same visibility rule as live runtime output. */
export const hiddenItem = (item: { kind?: string; title?: string }) =>
  ['TodoWrite', 'plan', 'mcp__merv_plan__plan_update'].includes(item.kind ?? '') ||
  item.title === 'merv_plan.plan_update' ||
  /^(?:Read|Write|Edit|MultiEdit) (?:~|\/[^\n]*)\/\.claude\/plans\//.test(item.title ?? '');

/** Evidence relayed by Merv; the identity and positions are references, never local paths. */
export interface SessionSource {
  thread: string;
  from?: string;
  through?: string;
  items?: string[];
  label?: string;
  context?: boolean;
}
export interface SideOf {
  thread: string;
  at: number;
}

/** What Merv lends a session runs as Merv's own tools do, with no yes: its browser, its board and
 *  its project tools, all but a Git credential. Named from the tools themselves, so a new one is
 *  never left asking. */
const freely: Record<string, ReadonlySet<string>> = {
  merv_browser: new Set(browserTools.map((tool) => tool.name)),
  merv_board: new Set([boardHere, boardShow, ...boardTools].map((tool) => tool.name)),
  merv_plan: new Set(['plan_update', 'voice_back']),
  // A main thread's own coordination; what a worker then does still asks the person as any session does.
  merv_project: new Set([
    'agent_start',
    'agent_review',
    'agent_message',
    'agent_read',
    'agent_list',
    'project_note',
    'project_switch',
    'todo_read',
    'todo_write',
    'job_start',
    'job_direction',
    'job_continue',
    'job_stop',
  ]),
  // The desk asks the person itself, once for each app a session reaches for.
  merv_computer: new Set(computerTools.map((tool) => tool.name)),
};
export const lentFreely = (server: string, tool: string) =>
  server === 'merv'
    ? /^\w+$/.test(tool) && tool !== 'code_git_credential'
    : Object.hasOwn(freely, server) && freely[server]!.has(tool);

/** Keep every question's choices together until the person sends the whole answer. */
export interface Question {
  id: string;
  question: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
  isSecret?: boolean;
}

/** Native secret questions and plain-language credential requests use the same private handoff. */
export const secretQuestion = (
  question: Pick<Question, 'question' | 'isSecret'> & Partial<Pick<Question, 'options'>>,
) =>
  question.isSecret === true ||
  (!question.options?.length &&
    /\b(api[ -]?key|token|access token|auth(?:entication)? token|password|secret|credential)\b/i.test(
      question.question,
    ));

/** Something the agent is waiting on a person for. Nothing in Merv answers one itself. */
export interface AgentRequest {
  /** Ours, unique across runtimes. */
  id: string;
  thread: string;
  /** The runtime that asked; a request dies with it and is never replayed into another. */
  generation: number;
  /** The native turn that asked, when the runtime can identify it. */
  turn?: string;
  /** `folder` is Merv asking, through the board, to use the person's agents in a folder. */
  kind:
    | 'command'
    | 'file_change'
    | 'permissions'
    | 'tool'
    | 'question'
    | 'elicitation'
    | 'folder'
    | 'plan';
  /** What the person reads: the command, the files, the question. */
  title: string;
  detail?: string;
  /** For questions: the choices offered, if any. */
  options?: string[];
  questions?: Question[];
}

export type Decision =
  | { kind: 'allow'; forSession?: boolean }
  | { kind: 'deny'; reason?: string }
  | { kind: 'answer'; text?: string; answers?: Record<string, string[]> }
  | { kind: 'board' }
  | { kind: 'cancel' };

/** A partial answer must leave the agent waiting for the remaining questions. */
export function answerQuestions(
  questions: Question[],
  decision: Extract<Decision, { kind: 'answer' }>,
): Record<string, string[]> {
  return Object.fromEntries(
    questions.map((question) => {
      const values =
        decision.answers?.[question.id] ??
        (questions.length === 1 && decision.text ? [decision.text] : []);
      if (
        !Array.isArray(values) ||
        !values.length ||
        values.some((value) => typeof value !== 'string' || !value.trim())
      )
        throw new Error('incomplete_answer');
      return [question.id, values];
    }),
  );
}

/** Generation comes from the emitting runtime, never from a later thread snapshot. */
export type RuntimeEvent = { generation?: number } &
  /** Native command feedback, without starting or ending an agent turn. */
  (
    | { type: 'command_output'; thread: string; item: string; text: string }
    | {
        type: 'thread';
        thread: string;
        provider: Provider;
        cwd: string;
        generation: number;
        side_of?: SideOf;
      }
    /** `anchor`: where the conversation stood when a turn ended, for going back to just after it. `background`: the turn
     *  ended idle while work it started in the background still runs, so the session will likely take itself up again when
     *  that work ends: the turn is a pause in its piece of work, not the end of it. `settled`: the agent itself is idle with
     *  nothing the desk sent still waiting, so every message sent so far has had its answer, even one sent into a running
     *  turn whose own turn could not be named. */
    | {
        type: 'status';
        thread: string;
        status: 'idle' | 'running' | 'stopped' | 'failed';
        turn?: string;
        error?: string;
        auth?: boolean;
        anchor?: string;
        background?: true;
        settled?: true;
      }
    /** A child's words stay under the Task or Agent that started it. */
    | {
        type: 'text';
        thread: string;
        turn?: string;
        item: string;
        delta: string;
        parent_tool_use_id?: string;
      }
    /** Command output belongs to its step, never the chat. */
    | { type: 'output'; thread: string; item: string; delta: string }
    | {
        type: 'item';
        thread: string;
        turn?: string;
        item: string;
        phase: 'started' | 'completed';
        kind: string;
        title: string;
        hidden?: boolean;
        detail?: string;
        /** Read back from history at attach, not heard live. */ recovered?: boolean;
        exitCode?: number;
        parent_tool_use_id?: string;
      }
    | { type: 'request'; request: AgentRequest }
    | { type: 'plan'; thread: string; turn: string; text: string }
    | { type: 'request_closed'; id: string; outcome: 'answered' | 'expired' }
    | {
        type: 'usage';
        thread: string;
        input: number;
        output: number;
        contextUsed?: number;
        contextWindow?: number;
        model?: string;
      }
    | { type: 'todos'; thread: string; tasks: AgentTask[] }
    | {
        type: 'rate_limit';
        thread: string;
        window: 'primary' | 'secondary' | string;
        used: number;
        resetsAt?: number;
        status: 'ok' | 'near' | 'exceeded';
        detail: string;
      }
    /** Words typed into a joined thread by its other client, the terminal. */
    | { type: 'said'; thread: string; text: string; turn?: string; item?: string }
    /** The runtime let go of the thread: it can be resumed elsewhere now. */
    | { type: 'ended'; thread: string }
  );

export const generationEvents = new Set<RuntimeEvent['type']>([
  'status',
  'text',
  'item',
  'ended',
  'said',
]);

export function rateLimit(
  thread: string,
  window: string,
  used: number,
  resetsAt: number | undefined,
  status: 'exceeded' | 'near' | 'ok',
  detail: string,
): RuntimeEvent {
  return {
    type: 'rate_limit',
    thread,
    window,
    used: Math.max(0, Math.min(1, used)),
    resetsAt,
    status,
    detail,
  };
}

/** The agent's own checklist stays beside its working state. */
export interface AgentTask {
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/** The plan tool the desk lends sessions without one of their own (desk-server plan.ts). */
export const planTool = {
  name: 'plan_update',
  description:
    'Show your plan for this request to the person as a checklist under your messages. For any request with three or more steps, call it first with every step pending, then again each time a step starts (in_progress) or ends (completed), always with the whole list. Steps are short imperative phrases.',
  inputSchema: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        maxItems: 30,
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', maxLength: 300 },
            status: { enum: ['pending', 'in_progress', 'completed'] },
          },
          required: ['text', 'status'],
          additionalProperties: false,
        },
      },
    },
    required: ['tasks'],
    additionalProperties: false,
  },
};

/** The person may be talking to this session by voice, through Merv. This hands their voice back to
 *  Merv's own conversation: it only ever gives the voice back, never takes it, and stops no work. */
export const voiceBackTool = {
  name: 'voice_back',
  description:
    "The person may be talking to you out loud, through Merv's voice. When they ask to go back to Merv, to talk to Merv (the main agent), or say they are done talking with you, in any words, call this tool: it is the only way their voice moves back to Merv. Saying goodbye or telling them to switch does not move it. Their voice returns to Merv's conversation once this reply ends, so finish with one short goodbye and do no more work in this turn. Nothing else about this session changes.",
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

/** Choices belong to a session; a running turn keeps the choices it began with. */
export interface SessionOptions {
  model?: string;
  mode?: 'plan' | 'act';
  /** Ask before edits; edit files without asking; or full access, running anything without asking. */
  access?: 'ask' | 'edit' | 'full';
  /** How hard the model thinks; empty is the model's own default. */
  effort?: string;
  /** How fast the model answers: one of its speeds; empty is the agent's own setting. */
  speed?: string;
}

/** Images stay on the Mac, in the desk's attachments folder. */
export interface Attachment {
  path: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
}

export interface TurnOptions extends SessionOptions {
  /** Side questions cannot gain file or command access on later turns. */
  readOnly?: boolean;
  /** A reviewer of another agent's work, in that agent's folder: it reads and runs commands there and is kept from
   *  writing into it. What keeps it is the provider's own: Claude Code runs every command in its sandbox with the
   *  folder denied for writing and has no edit tools; Codex runs commands with only its private scratch root
   *  writable. Neither provider permits sandbox escalation. Said with every turn, so it cannot be lost. */
  review?: boolean;
  /** Private writable scratch root; kept with the review across turns and resumes. */
  reviewScratch?: string;
  /** Recheck queued work or a plan after preparation, just before the runtime accepts its words. */
  beforeSend?: () => void;
  /** Commit durable send intent once preparation and readiness checks pass, at transport entry. */
  onSend?: () => void;
  /** The prompt UUID lets Claude resume at the message the person chose. */
  messageId?: `${string}-${string}-${string}-${string}-${string}`;
  attachments?: Attachment[];
}

export interface RuntimeModel {
  resolved?: string;
  id: string;
  name: string;
  /** Kept for clients that predate the per-model capability object. */
  plan?: boolean;
  capabilities: {
    efforts: string[];
    plan?: boolean;
    vision?: boolean;
    contextWindow?: number;
    /** The speeds this model offers, slowest first, when it offers more than one. */
    speeds?: { id: string; name: string; description?: string }[];
    /** The speed in use when the person has chosen none. */
    speed?: string;
  };
}

/** What the person can type to call a command or skill, as the agent itself lists it. */
export interface RuntimeCommand {
  name: string;
  description?: string;
}

export interface StartOptions extends TurnOptions {
  /** Identify this start before publishing its thread, even if its first send fails. */
  onThread?: (thread: string) => void;
  /** Require the native runtime to confirm the reviewed model/effort before sending work. */
  configurationLocked?: boolean;
  cwd: string;
  prompt: string;
  /** Here, an automatic new branch, or a reusable worktree's folder. */
  place?: 'here' | 'new' | string;
  /** The provider's own session or thread id, to continue it. */
  resume?: string;
  resumeSessionAt?: string;
  side_of?: SideOf;
  /** Fork native history when possible; context is the bounded fallback. */
  fork?: { thread: string; anchor?: string; nativeTurn?: string; context: string };
  /** Tools lent to this session, each at its own URL with a session token. */
  mcp?: { name: string; url: string; token: string }[];
}

/** A proposed plan continues through the desk, with its current session choices. */
export type PlanContinuation = (
  text: string,
  mode: 'act' | 'plan',
  beforeSend: () => void,
) => Promise<unknown>;

export interface RuntimeAccount {
  state: 'in' | 'out' | 'unknown';
  email?: string;
  plan?: string;
  method?: string;
}
export interface AccountChange {
  login?: { id?: string; ok: boolean };
}
export interface UsageLimit {
  name?: string;
  windowMins?: number;
  usedPercent: number;
  resetsAt?: number;
}
export type Usage =
  | { state: 'ok'; limits: UsageLimit[]; at: number; blocked?: boolean }
  | { state: 'unavailable'; reason: 'not_reported' | 'signed_out' | 'not_installed' }
  | { state: 'error' };

export interface Runtime {
  readonly provider: Provider;
  usage?(cwd: string): Promise<Usage>;
  account?(): Promise<RuntimeAccount | undefined>;
  onAccount?(listener: (change: AccountChange) => void): () => void;
  /** Starts or resumes a thread and sends its first message; answers with the thread's id. */
  start(options: StartOptions): Promise<{ thread: string; turn?: string; generation?: number }>;
  /** A message to a thread: it steers a running turn, or begins the next one. */
  message(
    thread: string,
    text: string,
    options?: TurnOptions,
  ): Promise<{ turn?: string; generation?: number }>;
  /** Ask the runtime itself, so the picker matches the person's installed agent. */
  models?(cwd: string): Promise<RuntimeModel[]>;
  configuration?(
    cwd: string,
    requested: { model?: string; effort?: string },
  ): Promise<{ model: string; effort: string }>;
  commands?(cwd?: string): Promise<RuntimeCommand[]>;
  /** Stops the running turn; `turn`, when given, must still be the running one. */
  interrupt(thread: string, turn?: string): Promise<void>;
  /** Make room in this session without starting another one. */
  compact?(
    thread: string,
    send?: (text: string) => Promise<unknown>,
    takeUp?: { cwd: string; mcp(): StartOptions['mcp'] },
  ): Promise<unknown>;
  /** Let an idle session continue in the person's CLI. */
  detach?(thread: string): Promise<void>;
  resumeCommand?(thread: string): string;
  /** Release a side runtime after interrupt, even before its final status arrives. */
  release?(thread: string): Promise<void>;
  /** Restore conversation history while the session is idle. */
  rewind?(
    thread: string,
    options: StartOptions & { anchor?: string; nativeTurn?: string },
  ): Promise<{ resumeAt?: string } | void>;
  answer(request: string, decision: Decision, continuePlan?: PlanContinuation): Promise<void>;
  /** Sessions live in another client that this runtime could join: a terminal's, on a shared server. */
  shared?(): Promise<{ thread: string; cwd: string; running: boolean }[]>;
  /** Joins one of those as it runs: its words, its turn and its approvals, beside the other client. */
  /** `leftRunning`: the desk last saw this thread mid-turn, so its ending and missed answer are read back. */
  join?(
    thread: string,
    mcp?: StartOptions['mcp'],
    leftRunning?: boolean,
  ): Promise<{ thread: string; turn?: string }>;
  /** The completed answer of a native turn, including one finished while the desk was closed. */
  completed?(thread: string, turn: string): Promise<string | undefined>;
  onEvent(listener: (event: RuntimeEvent) => void): () => void;
  close(): Promise<void>;
}

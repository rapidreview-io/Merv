import { readdirSync } from 'node:fs';
import {
  readLine as read,
  type AgentEvent,
  type HarnessLine as Line,
} from '@merv/sessions/agent-stream';
import type { SessionUsageReport } from '@merv/sessions/types';
import type { LaunchRequest, RunnerProfile } from '../profiles.js';

export const sessionTokenVariable = 'MERV_AGENT_SESSION_TOKEN';
/** Claude's session ids and Codex's thread ids. */
export const conversationIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const maximumSkillEntries = 4096;
/**
 * Merv's internet reads (@merv/web). Each call sends its query, or the address of a page to read,
 * to an outside provider, and that is a way out of the machine: a worker whose shell has no
 * network, or a sealed review, is not given them. Codex's own hosted web search stays disabled.
 */
export const INTERNET_READS = ['web.search', 'web.extract'] as const;

/** A private MCP connection as one spawn names it: its bearer is read from `bearerEnv`. */
export interface LaunchServer {
  name: string;
  url: string;
  bearerEnv: string;
}
/** What the runner has decided of a launch, which its profile's launcher turns into a command. */
export interface LaunchFacts {
  request: LaunchRequest;
  /** The checked MCP endpoint. */
  url: string;
  /** The runner's runtime variables: the launch's environment unless its launcher fixes one. */
  runtime: Record<string, string>;
  /** The machine's environment, where a further server's bearer is read by name. */
  environment: Readonly<NodeJS.ProcessEnv>;
  /** Read-only, offline and keeping nothing (`sealed`). */
  sealed: boolean;
  /** An inquiry visit (`inquiring`). */
  inquiry: boolean;
  /** Whether it is given Merv's internet reads. */
  internet: boolean;
  /** Its private MCP connections. */
  servers: LaunchServer[];
}
/** A launcher's part of a launch: what runs, and with what before bearers and Merv's variables. */
export interface LaunchParts {
  executable: string;
  args: string[];
  env: Record<string, string>;
  /** Further bearers, by the variable that holds each. */
  bearers?: Record<string, string>;
  /** Where the harness's shell sources the launch's `shellEnv` before each command. */
  shellEnvFile?: string;
  /** What its worker is told of how its harness ends a visit. */
  note?: string;
}
/**
 * How the runner launches one kind of profile: the runner core asks its profile's launcher and
 * never names a harness.
 */
export interface Launcher<P extends RunnerProfile = RunnerProfile> {
  /** Its agent's output and conversations. A plain command has none, and so no filesystem
   *  sandbox, MCP connections or conversation to resume. */
  readonly agent?: Harness;
  /** Whether remote settings tune its model and effort. */
  readonly tuned: boolean;
  /** Whether it reads repository skills, which each launch then disables by path. */
  readonly skills: boolean;
  /** How long a launch whose own handoff closed its session may take to end by itself. */
  readonly handoffGraceMs: number;
  /** What its profile must also satisfy beyond the schema. */
  valid(profile: P): boolean;
  /** Whether it runs as the assignment user through an image-owned launcher, as a work host's. */
  isolated(profile: P): boolean;
  /** Whether its shell has the network, so it may be given Merv's internet reads. */
  networked(profile: P): boolean;
  /** Whether a hosted machine brokers it Hugging Face access. */
  huggingface(profile: P): boolean;
  /** Before a launch: what it keeps in the run directory, as overrides of the environment. */
  prepare(
    profile: P,
    runDirectory: string,
    environment?: NodeJS.ProcessEnv,
  ): Record<string, string> | undefined;
  /** Its command line and environment; refuses what the request asks that it cannot give. */
  launch(profile: P, facts: LaunchFacts): LaunchParts;
}

/**
 * What the runner knows of one agent harness: how it prints and where it keeps its
 * conversations. Each harness's module answers for it; the rest of the runner only asks.
 */
export interface Harness {
  /** The profile's `harness` that names it, which a kept conversation records. */
  name: 'claude' | 'codex';
  /** A reader of its output a line at a time (`at` is the line's place in the log), keeping
   *  what a block spread over lines needs. */
  lines(): (text: string, at: number) => AgentEvent[];
  /** What the run spent, from the last report the output holds, for the profile's model. */
  usage(output: string, model?: string): SessionUsageReport | undefined;
  /** The conversation id it printed first. */
  conversationId(output: string): string | undefined;
  /** What it prints when it finds no conversation to resume. */
  resumeRefused: RegExp;
  /** A log line, by its first 32 bytes, as a transcript sees it: a partial-message piece, a
   *  whole message that repeats such pieces, or neither. */
  line(head: string): 'delta' | 'whole' | undefined;
  /** Where a launch keeps its conversations. */
  home(profile: RunnerProfile, runDirectory: string, environment: NodeJS.ProcessEnv): string;
  /** A conversation's file in that home: the one the launch run in `cwd` wrote, where a home
   *  keeps conversations by directory and that one exists. */
  locate(root: string, id: string, cwd?: string): string | undefined;
  /** Where a conversation is put to be resumed: its directory and file name. */
  restorePath(root: string, cwd: string, id: string): [string, string];
  /** Takes these conversations out of a home the runner shares; with `cwd`, only the copies the
   *  launch run there kept, where another launch may hold the same conversation elsewhere. */
  forget(root: string, ids: string[], cwd?: string): void;
}

export const entries = (directory: string) => {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
};

/** The JSON lines of `output` that hold `marker`. */
function* events(output: string, marker: string) {
  for (const line of output.split('\n')) if (line.includes(marker)) yield read(line) ?? {};
}
/** The first id `pick` finds on a line holding `marker`, if it is a conversation id. */
export function firstId(output: string, marker: string, pick: (event: Line) => unknown) {
  for (const event of events(output, marker)) {
    const id = pick(event);
    if (typeof id === 'string' && conversationIdPattern.test(id)) return id;
  }
  return undefined;
}

/** A usage's counts (and `cache` counts, absent as 0) when all are whole. */
function counted(usage: Line | undefined, cache: string[], model?: string) {
  const [input, outputTokens, ...cached] = ['input_tokens', 'output_tokens', ...cache].map(
    (key, index) => usage?.[key] ?? (index < 2 ? undefined : 0),
  );
  if (![input, outputTokens, ...cached].every((count) => Number.isSafeInteger(count) && count >= 0))
    return undefined;
  return {
    inputTokens: input + cached.reduce((sum, count) => sum + count, 0),
    outputTokens,
    ...(model && { model }),
  } as SessionUsageReport;
}
/** The last `type` event's usage whose counts (and `cache` counts, absent as 0) are all whole. */
export function spent(output: string, type: string, model?: string, cache: string[] = []) {
  let usage: SessionUsageReport | undefined;
  for (const event of events(output, `"${type}"`))
    if (event.type === type) usage = counted(event.usage, cache, model) ?? usage;
  return usage;
}
/**
 * What a run spent so far by each model call's own `type` event (`message.usage`, the last one
 * printed under each message id), summed: for a harness whose total is printed only at its end.
 */
export function calls(output: string, type: string, model?: string, cache: string[] = []) {
  const each = new Map<string, SessionUsageReport>();
  for (const event of events(output, `"${type}"`)) {
    const usage = event.type === type ? counted(event.message?.usage, cache) : undefined;
    if (usage && typeof event.message?.id === 'string') each.set(event.message.id, usage);
  }
  if (!each.size) return undefined;
  const sum = (key: 'inputTokens' | 'outputTokens') =>
    [...each.values()].reduce((total, usage) => total + usage[key], 0);
  return {
    inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'),
    ...(model && { model }),
  } as SessionUsageReport;
}

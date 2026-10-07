import { readdirSync } from 'node:fs';
import {
  readLine as read,
  type AgentEvent,
  type HarnessLine as Line,
} from '@merv/sessions/agent-stream';
import type { SessionUsageReport } from '@merv/sessions/types';
import { conversationIdPattern, type RunnerProfile } from '../profiles.js';

/**
 * What the runner knows of one agent harness: how it prints and where it keeps its
 * conversations. Each harness's module answers for it; the rest of the runner only asks.
 */
export interface Harness {
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

/** The last `type` event's usage whose counts (and `cache` counts, absent as 0) are all whole. */
export function spent(output: string, type: string, model?: string, cache: string[] = []) {
  let usage: SessionUsageReport | undefined;
  for (const event of events(output, `"${type}"`)) {
    const [input, outputTokens, ...cached] = ['input_tokens', 'output_tokens', ...cache].map(
      (key, index) => event.usage?.[key] ?? (index < 2 ? undefined : 0),
    );
    if (
      event.type === type &&
      [input, outputTokens, ...cached].every((count) => Number.isSafeInteger(count) && count >= 0)
    )
      usage = {
        inputTokens: input + cached.reduce((sum, count) => sum + count, 0),
        outputTokens,
        ...(model && { model }),
      };
  }
  return usage;
}

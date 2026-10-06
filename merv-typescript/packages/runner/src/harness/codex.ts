import { lstatSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@merv/contracts';
import { assignmentCodexHome, type RunnerProfile } from '../profiles.js';
import { answer, entries, firstId, type Harness, type Line, read, spent, str } from './shared.js';

/** A Codex tool item: its call, and on completion its answer. */
function call(item: Line): { name: string; input: string; output: string; error: boolean } {
  const failed = item.status === 'failed';
  if (item.type === 'command_execution')
    return {
      name: 'shell',
      input: str(item.command),
      output: str(item.aggregated_output),
      error: failed || (typeof item.exit_code === 'number' && item.exit_code !== 0),
    };
  if (item.type === 'mcp_tool_call')
    return {
      name: item.server === 'merv' ? str(item.tool) : `${str(item.server)}.${str(item.tool)}`,
      input: JSON.stringify(item.arguments ?? {}),
      output: item.error ? str(item.error.message) : answer(item.result?.content),
      error: failed || !!item.error,
    };
  if (item.type === 'file_change')
    return {
      name: 'edit',
      input: (Array.isArray(item.changes) ? item.changes : [])
        .map((change: Line) => `${str(change?.kind)} ${str(change?.path)}`)
        .join('\n'),
      output: str(item.status),
      error: failed,
    };
  return { name: 'web_search', input: str(item.query), output: '', error: failed };
}
const TOOLS = new Set(['command_execution', 'mcp_tool_call', 'file_change', 'web_search']);

/** Reads `codex exec --json`. */
function lines() {
  const started = new Set<string>();
  return (text: string, at: number): AgentEvent[] => {
    const status = (said: string): AgentEvent[] => [
      { kind: 'status', id: `status-${at}`, text: said },
    ];
    const line = read(text);
    if (!line) return [];
    if (line.type === 'thread.started') return status('Started');
    if (line.type === 'turn.completed') {
      const usage = line.usage ?? {};
      return status(
        `Turn completed · ${Number(usage.input_tokens) || 0} tokens in · ${Number(usage.output_tokens) || 0} out`,
      );
    }
    if (line.type === 'turn.failed') return status(`Turn failed · ${str(line.error?.message)}`);
    if (line.type === 'error') return status(`Error · ${str(line.message)}`);
    if (line.type !== 'item.started' && line.type !== 'item.completed') return [];
    const item: Line = line.item ?? {};
    const id = str(item.id),
      done = line.type === 'item.completed';
    if (item.type === 'reasoning' || item.type === 'agent_message')
      return done && str(item.text)
        ? [
            {
              kind: item.type === 'reasoning' ? 'thinking' : 'text',
              id,
              delta: str(item.text),
              done: true,
            },
          ]
        : [];
    // Codex reports its non-fatal warnings as error items; a fatal error is the top-level line.
    if (item.type === 'error') return done ? status(`Warning · ${str(item.message)}`) : [];
    if (!TOOLS.has(item.type)) return [];
    const { name, input, output, error } = call(item);
    const event: AgentEvent = { kind: 'tool_call', id, name, input };
    if (!done) {
      started.add(id);
      return [event];
    }
    return [
      ...(started.delete(id) ? [] : [event]),
      { kind: 'tool_result', id, output, ...(error ? { error: true } : {}) },
    ];
  };
}

/** The isolated assignment's own home; a local launch has one in its run directory. */
const home = (profile: RunnerProfile, runDirectory: string) =>
  profile.harness === 'codex' && profile.isolatedLauncher
    ? assignmentCodexHome
    : join(runDirectory, 'codex-home');

/**
 * Codex. `codex exec --json` runs one thread and ends each turn with `turn.completed`, whose
 * usage is the thread's running total (`input_tokens` includes cached input), so the last one
 * counts; a stream cut off before any turn completed reports nothing. It keeps each thread in its
 * home's databases too and resumes a thread only where it was recorded, so a local launch has a
 * home of its own, taken away whole when it ends; a conversation is a dated
 * `sessions/YYYY/MM/DD/rollout-…-<id>.jsonl` there.
 */
export const codex: Harness = {
  lines,
  usage: (output, model) => spent(output, 'turn.completed', model),
  conversationId: (output) =>
    firstId(
      output,
      '"thread.started"',
      (event) => event.type === 'thread.started' && event.thread_id,
    ),
  resumeRefused: /no rollout found/i,
  line: () => undefined,
  home,
  locate(root, id) {
    const walk = (directory: string, depth: number): string | undefined => {
      for (const entry of entries(directory)) {
        const path = join(directory, entry.name);
        if (depth < 3 && entry.isDirectory()) {
          const found = walk(path, depth + 1);
          if (found) return found;
        } else if (
          depth === 3 &&
          entry.name.startsWith('rollout-') &&
          entry.name.endsWith(`-${id}.jsonl`)
        )
          return path;
      }
      return undefined;
    };
    return walk(join(root, 'sessions'), 0);
  },
  restorePath(root, _cwd, id) {
    const now = new Date().toISOString();
    return [
      join(root, 'sessions', now.slice(0, 4), now.slice(5, 7), now.slice(8, 10)),
      `rollout-${now.slice(0, 19).replaceAll(':', '-')}-${id}.jsonl`,
    ];
  },
  forget: (root) => rmSync(root, { recursive: true, force: true }),
};

/** Before a local Codex launch: its own `CODEX_HOME`, holding a link to the machine's login. */
export function launchCodexHome(
  profile: RunnerProfile,
  runDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (profile.harness !== 'codex' || profile.isolatedLauncher) return undefined;
  const path = home(profile, runDirectory);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const login = join(path, 'auth.json');
  if (!lstatSync(login, { throwIfNoEntry: false }))
    symlinkSync(
      join(environment.CODEX_HOME ?? join(environment.HOME ?? homedir(), '.codex'), 'auth.json'),
      login,
    );
  return path;
}

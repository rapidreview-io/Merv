import { lstatSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { claudeEvents } from '@merv/sessions/agent-stream';
import { calls, entries, firstId, type Harness, spent } from './shared.js';

const cache = ['cache_creation_input_tokens', 'cache_read_input_tokens'];

/**
 * Claude Code. Its `stream-json` ends with one `result` event: its `input_tokens` excludes the
 * cache, so cache writes and reads are added. Its home is the machine's own, which holds its
 * login; a conversation is `projects/<cwd>/<id>.jsonl`, found in any project directory.
 */
/** The project directory Claude Code keeps a launch's conversations in: its cwd, spelled out. */
const project = (cwd: string) => realpathSync(cwd).replace(/[^A-Za-z0-9]/g, '-');
export const claude: Harness = {
  lines: claudeEvents,
  // A run stopped before its `result` spent what each of its model calls printed.
  usage: (output, model) =>
    spent(output, 'result', model, cache) ?? calls(output, 'assistant', model, cache),
  conversationId: (output) =>
    firstId(
      output,
      '"init"',
      (event) => event.type === 'system' && event.subtype === 'init' && event.session_id,
    ),
  resumeRefused: /no conversation found/i,
  line: (head) =>
    head.startsWith('{"type":"stream_event"')
      ? 'delta'
      : /^\{"type":"(?:assistant|result)"/.test(head)
        ? 'whole'
        : undefined,
  home: (_profile, _runDirectory, environment) =>
    environment.CLAUDE_CONFIG_DIR ?? join(environment.HOME ?? homedir(), '.claude'),
  locate(root, id, cwd) {
    // The launch's own copy first: an inquiry visit elsewhere may hold the same conversation.
    const own = cwd && join(root, 'projects', project(cwd), `${id}.jsonl`);
    if (own && lstatSync(own, { throwIfNoEntry: false })?.isFile()) return own;
    for (const project of entries(join(root, 'projects'))) {
      const path = join(root, 'projects', project.name, `${id}.jsonl`);
      if (project.isDirectory() && lstatSync(path, { throwIfNoEntry: false })?.isFile())
        return path;
    }
    return undefined;
  },
  restorePath: (root, cwd, id) => [join(root, 'projects', project(cwd)), `${id}.jsonl`],
  forget(root, ids, cwd) {
    if (cwd) {
      for (const id of ids)
        for (const name of [`${id}.jsonl`, id])
          rmSync(join(root, 'projects', project(cwd), name), { recursive: true, force: true });
      return;
    }
    for (const id of ids)
      for (const path of [
        ...entries(join(root, 'projects')).flatMap((project) =>
          project.isDirectory()
            ? [`${id}.jsonl`, id].map((name) => join(root, 'projects', project.name, name))
            : [],
        ),
        join(root, 'file-history', id),
        join(root, 'session-env', id),
      ])
        rmSync(path, { recursive: true, force: true });
  },
};

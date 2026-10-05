import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fchownSync,
  fstatSync,
  lchownSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { MAX_TRANSCRIPT_BYTES, MervError } from '@merv/contracts';
import type { SessionConversationDeclaration } from '@merv/sessions/types';
import { assignmentCodexHome, conversationIdPattern, type RunnerProfile } from './profiles.js';
import { bearer } from './transcript.js';
import { assignmentUser } from './workspaces.js';

/** What Sessions is told of a kept conversation. */
export type ConversationFacts = Omit<SessionConversationDeclaration, 'hostRef' | 'deliver'>;
/** The redacted copy a launch keeps in its run directory until it is delivered. */
export const conversationFile = (runDirectory: string) => join(runDirectory, 'conversation.jsonl');

/**
 * Where a launch's harness keeps its conversations: the home profiles.ts gives it, which holds its
 * login too, so it is the machine's own and never a per-launch one. The runner takes each
 * conversation out of it when the launch ends, and puts one back only to resume it.
 */
function home(profile: RunnerProfile, environment: NodeJS.ProcessEnv) {
  const user = environment.HOME ?? homedir();
  if (profile.harness === 'claude') return environment.CLAUDE_CONFIG_DIR ?? join(user, '.claude');
  if (profile.harness === 'codex')
    return profile.isolatedLauncher
      ? assignmentCodexHome
      : (environment.CODEX_HOME ?? join(user, '.codex'));
  return undefined;
}
/** The isolated assignment owns its home; everywhere else the runner does. */
const owner = (profile: RunnerProfile) =>
  profile.harness === 'codex' && profile.isolatedLauncher ? assignmentUser : undefined;

/** The conversation id the harness printed first: Claude's init `session_id`, Codex's `thread_id`. */
export function conversationId(harness: 'claude' | 'codex', output: string): string | undefined {
  const marker = harness === 'claude' ? '"init"' : '"thread.started"';
  for (const line of output.split('\n')) {
    if (!line.includes(marker)) continue;
    try {
      const event = JSON.parse(line);
      const id =
        harness === 'claude'
          ? event.type === 'system' && event.subtype === 'init' && event.session_id
          : event.type === 'thread.started' && event.thread_id;
      if (typeof id === 'string' && conversationIdPattern.test(id)) return id;
    } catch {
      // Not an event this reads.
    }
  }
  return undefined;
}

const entries = (directory: string) => {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
};
/** Claude's `projects/<cwd>/<id>.jsonl`; Codex's `sessions/YYYY/MM/DD/rollout-…-<id>.jsonl`. */
function locate(harness: 'claude' | 'codex', root: string, id: string): string | undefined {
  if (harness === 'claude') {
    for (const project of entries(join(root, 'projects'))) {
      const path = join(root, 'projects', project.name, `${id}.jsonl`);
      if (project.isDirectory() && lstatSync(path, { throwIfNoEntry: false })?.isFile())
        return path;
    }
    return undefined;
  }
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
}

/**
 * The conversation as kept: each JSON line parsed, every string in it blanked of bearers and of
 * each exact secret (≥ 16 characters), as a transcript is, and written back as JSON, so a
 * redaction never breaks a record. A line that is not JSON is dropped.
 */
export function redactConversation(bytes: Buffer, secrets: string[]): Buffer {
  const blank = new RegExp(
    [
      bearer.source,
      ...secrets
        .filter((secret) => secret.length >= 16)
        .map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    ].join('|'),
    'g',
  );
  const scrub = (value: unknown): unknown =>
    typeof value === 'string'
      ? value.replace(blank, '[REDACTED]')
      : Array.isArray(value)
        ? value.map(scrub)
        : value !== null && typeof value === 'object'
          ? Object.fromEntries(Object.entries(value).map(([k, v]) => [scrub(k), scrub(v)]))
          : value;
  const lines: string[] = [];
  for (const line of bytes.toString('utf8').split('\n'))
    if (line.trim())
      try {
        lines.push(JSON.stringify(scrub(JSON.parse(line))));
      } catch {
        // Not a record.
      }
  return Buffer.from(lines.length ? `${lines.join('\n')}\n` : '');
}

/** A regular file `uid` owns, read without following a link: whole up to `cap`, else its head. */
function readOwned(path: string, uid: number | undefined, cap: number, head = false): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (uid !== undefined && stat.uid !== uid) || (!head && stat.size > cap))
      throw new MervError('conversation_unreadable', 'Not a conversation this runner keeps');
    const bytes = Buffer.alloc(Math.min(stat.size, cap));
    let read = 0;
    for (let n = 1; n > 0 && read < bytes.length; read += n)
      n = readSync(fd, bytes, read, bytes.length - read, read);
    return bytes.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/**
 * After a launch ends: the conversation its harness wrote, found by the id it printed, redacted
 * into the run directory and, on the runner's own machine, taken out of the harness's home.
 * Undefined when the launch kept none.
 */
export function keepConversation(
  runDirectory: string,
  profile: RunnerProfile,
  secrets: string[],
  environment: NodeJS.ProcessEnv = process.env,
): ConversationFacts | undefined {
  const root = home(profile, environment);
  if (!root || profile.harness === 'command') return undefined;
  let output: Buffer;
  try {
    output = readOwned(join(runDirectory, 'stdout.log'), undefined, 1 << 20, true);
  } catch {
    return undefined;
  }
  const id = conversationId(profile.harness, output.toString('utf8'));
  const path = id && locate(profile.harness, root, id);
  if (!id || !path) return undefined;
  let raw: Buffer;
  try {
    raw = readOwned(path, owner(profile)?.uid ?? process.getuid?.(), MAX_TRANSCRIPT_BYTES);
  } finally {
    // The isolated home is wiped before anything else runs there; the runner's own is shared.
    if (!owner(profile)) rmSync(path, { force: true });
  }
  const bytes = redactConversation(raw, secrets);
  if (bytes.length === 0 || bytes.length > MAX_TRANSCRIPT_BYTES) return undefined;
  const fd = openSync(
    conversationFile(runDirectory),
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
  return {
    harness: profile.harness,
    conversationId: id,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
  };
}

/**
 * Before a resumed launch: the kept conversation, put where its harness looks it up by id. Claude
 * finds `<id>.jsonl` in any project directory, so it goes under the new cwd's; Codex finds a dated
 * rollout. In the isolated home, which was just wiped, every directory made and the file are the
 * assignment's.
 */
export function restoreConversation(
  profile: RunnerProfile,
  cwd: string,
  id: string,
  bytes: Uint8Array,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const root = home(profile, environment);
  if (!root || profile.harness === 'command' || !conversationIdPattern.test(id))
    throw new MervError('resume_unsupported', 'This launch cannot resume a conversation');
  const now = new Date().toISOString();
  const [directory, name] =
    profile.harness === 'claude'
      ? [join(root, 'projects', realpathSync(cwd).replace(/[^A-Za-z0-9]/g, '-')), `${id}.jsonl`]
      : [
          join(root, 'sessions', now.slice(0, 4), now.slice(5, 7), now.slice(8, 10)),
          `rollout-${now.slice(0, 19).replaceAll(':', '-')}-${id}.jsonl`,
        ];
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const user = owner(profile);
  if (user) {
    let path = root;
    lchownSync(path, user.uid, user.gid);
    for (const part of relative(root, directory).split(sep))
      lchownSync((path = join(path, part)), user.uid, user.gid);
  }
  const path = join(directory, name);
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    if (user) fchownSync(fd, user.uid, user.gid);
    writeSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
  return path;
}

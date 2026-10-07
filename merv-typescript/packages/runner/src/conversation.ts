import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fchownSync,
  fstatSync,
  lchownSync,
  mkdirSync,
  openSync,
  readSync,
  writeSync,
} from 'node:fs';
import { join, relative, sep } from 'node:path';
import { MAX_TRANSCRIPT_BYTES, MervError } from '@merv/contracts';
import type { SessionConversationDeclaration } from '@merv/sessions/types';
import { type Harness, harnessOf, launcherOf } from './harness/index.js';
import { conversationIdPattern } from './harness/shared.js';
import type { RunnerProfile } from './profiles.js';
import { blankPattern } from './transcript.js';
import { assignmentUser } from './workspaces.js';

/** What Sessions is told of a kept conversation. */
export type ConversationFacts = Omit<SessionConversationDeclaration, 'hostRef' | 'deliver'>;
/** The redacted copy a launch keeps in its run directory until it is delivered. */
export const conversationFile = (runDirectory: string) => join(runDirectory, 'conversation.jsonl');

/**
 * Where a launch's harness keeps its conversations (each harness says where). The isolated
 * assignment's is wiped before each launch. The runner takes each conversation out when the
 * launch ends, and puts one back only to resume it.
 */
function home(profile: RunnerProfile, runDirectory: string, environment: NodeJS.ProcessEnv) {
  const harness = harnessOf(profile);
  return harness && { harness, root: harness.home(profile, runDirectory, environment) };
}
/** The isolated assignment owns its home; everywhere else the runner does. */
const owner = (profile: RunnerProfile) =>
  launcherOf(profile).isolated(profile) ? assignmentUser : undefined;

/**
 * The conversation as kept: each JSON line that holds a bearer or an exact secret (≥ 16
 * characters) parsed, every string in it blanked of them, as a transcript is, and written back as
 * JSON, so a redaction never breaks a record; such a line that is not JSON is dropped. Every other
 * line keeps its own bytes.
 */
export function redactConversation(bytes: Buffer, secrets: string[]): Buffer {
  const blank = blankPattern(secrets);
  // A secret that JSON escapes (a quote, a backslash) is written escaped in the line.
  const held = blankPattern([
    ...secrets,
    ...secrets.map((secret) => JSON.stringify(secret).slice(1, -1)),
  ]);
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
    if (line.search(held) < 0) {
      if (line.trim()) lines.push(line);
    } else
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
  cwd?: string,
): ConversationFacts | undefined {
  const found = home(profile, runDirectory, environment);
  const id = found && printed(found.harness, runDirectory);
  const path = id && found.harness.locate(found.root, id, cwd);
  if (!id || !path) return undefined;
  const raw = readOwned(path, owner(profile)?.uid ?? process.getuid?.(), MAX_TRANSCRIPT_BYTES);
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
    harness: found.harness.name,
    conversationId: id,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
  };
}

const printed = (harness: Harness, runDirectory: string) => {
  try {
    const output = readOwned(join(runDirectory, 'stdout.log'), undefined, 1 << 20, true);
    return harness.conversationId(output.toString('utf8'));
  } catch {
    return undefined;
  }
};

/**
 * A launch whose harness would not take up the conversation restored for it: it started none
 * and said it found none to resume.
 */
export function refusedResume(profile: RunnerProfile, runDirectory: string): boolean {
  const harness = harnessOf(profile);
  return (
    !!harness &&
    !printed(harness, runDirectory) &&
    ['stdout.log', 'stderr.log'].some((name) => {
      try {
        const head = readOwned(join(runDirectory, name), undefined, 64 << 10, true);
        return harness.resumeRefused.test(head.toString('utf8'));
      } catch {
        return false;
      }
    })
  );
}

/**
 * After a launch ends, kept or not: nothing of its conversations is left in a home the runner
 * shares: those of the conversation it printed and of the one restored for it (which a launch
 * that failed early never took up). An inquiry visit (`forked`, run in `cwd`) forked the one
 * restored for it, which a work visit of its thread may be running meanwhile in the same home:
 * of that one, only its own copy goes.
 */
export function forgetConversations(
  runDirectory: string,
  profile: RunnerProfile,
  restored: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
  forked?: { cwd?: string },
): void {
  const found = home(profile, runDirectory, environment);
  if (!found || owner(profile)) return;
  const valid = (id: string | undefined): id is string => !!id && conversationIdPattern.test(id);
  const ids = [...new Set([printed(found.harness, runDirectory), restored])].filter(valid);
  if (!forked) return found.harness.forget(found.root, ids);
  found.harness.forget(
    found.root,
    ids.filter((id) => id !== restored),
  );
  if (valid(restored) && forked.cwd) found.harness.forget(found.root, [restored], forked.cwd);
}

/**
 * Before a resumed launch: the kept conversation, put where its harness looks it up by id. In the
 * isolated home, which was just wiped, every directory made and the file are the assignment's.
 */
export function restoreConversation(
  profile: RunnerProfile,
  runDirectory: string,
  cwd: string,
  id: string,
  bytes: Uint8Array,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const found = home(profile, runDirectory, environment);
  if (!found || !conversationIdPattern.test(id))
    throw new MervError('resume_unsupported', 'This launch cannot resume a conversation');
  const { root } = found;
  const [directory, name] = found.harness.restorePath(root, cwd, id);
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

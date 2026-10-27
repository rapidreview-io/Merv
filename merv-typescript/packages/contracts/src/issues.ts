/**
 * Issues: what went wrong, said once by its owner at the place it went wrong. An owner holds
 * `reporter(ctx)`, which looks the `issues` service up at each call, so no owner depends on
 * @merv/issues and Issues may be absent, reloading or failing. That plugin fingerprints, counts,
 * detects loops, keeps the cases and alerts. Every field is a code or an id except `note`:
 * owner-bounded words, redacted, read by platform admins only and never sent to Slack.
 */
import type { Context } from 'cordis';
import { MervError } from './index.js';

export type IssueClass = 'tool' | 'question' | 'platform';
export type IssueLevel = 'notice' | 'warn' | 'severe';
export type IssueState = 'open' | 'resolved';

/** Ids only: what joins a case to its project, visit, conversation, machine and code. */
export interface IssueRefs {
  projectId?: string;
  actorId?: string;
  /** An outside agent's client string. */
  client?: string;
  sessionId?: string;
  threadId?: string;
  /** A leased call's session_tool_calls row. */
  invocationId?: string;
  instanceId?: string;
  revision?: number;
  questionId?: string;
  conversationId?: string;
  commandId?: string;
  hostId?: string;
  allocationId?: string;
  sandboxId?: string;
  profileId?: string;
  /** A hosted machine's image, `rt1_…` (deploy/HOSTED_RELEASES.md maps it to its commit). */
  runtimeRelease?: string;
  runnerId?: string;
  hostRef?: string;
  pushId?: string;
  eventType?: string;
  subjectId?: string;
  eventIds?: [first: number, last: number];
  /** The Main release a case ran under when it is not this process's: a crash found at restart. */
  release?: string;
}

/** One thing that went wrong, as its owner judges it where it went wrong. */
export interface IssueReport {
  class: IssueClass;
  /** The owner's site: `experiment.write:create`, `sessions.launch`, `fleet.retry`, `api_error`. */
  where: string;
  /** A finite code: a MervError code, an outcome, a PiInterruption. Never words. */
  code: string;
  /** What else tells one issue from another at this site: a question, a route, a close reason. */
  key?: string;
  /** The owner's judgement, `warn` when it gives none. Issues only ever raises it. */
  level?: IssueLevel;
  status?: number;
  /** Who repeats it (a visit, a conversation, a machine, a loop): loops are counted per subject. */
  subject?: string;
  /** A condition re-reported on every pass while it holds: counted once an episode, never a
   *  loop, and resolved ten minutes after its last report. */
  standing?: true;
  /** The owner already knows it repeats, as an event flood does. */
  loop?: true;
  /** How many times it happened, where the owner counted them; 1 otherwise. */
  n?: number;
  refs?: IssueRefs;
  /** Kept as errorFacts(error) only, never its message. */
  error?: unknown;
  /** Owner-bounded words (a worker's question, a worker's own failure reason): kept redacted, at
   *  most 280 characters. */
  note?: string;
}
/** Which issue an owner resolves: the fields its fingerprint is made of. */
export type IssueTarget = Pick<IssueReport, 'class' | 'where' | 'code' | 'key'>;

/** What owners call. Neither verb throws or waits. Inside a write transaction both wait for its
 *  commit and are dropped if it rolls back: report after the transaction's first write, so a
 *  snapshot attempt that a writer then repeats does not schedule it twice. */
export interface Issues {
  report(issue: IssueReport): void;
  /** The condition is over; the next report of it opens a new episode. */
  resolve(target: IssueTarget): void;
}

/** What an error is kept as: never its message, which may carry request values or secrets. */
export interface ErrorFacts {
  name?: string;
  code?: string;
  status?: number;
  /** Up to three stack frames of a fault (status 500 or above, or no MervError): file:line
   *  within the release. */
  at?: string[];
  sqlstate?: string;
  table?: string;
  constraint?: string;
  /** Paths of the input fields a refusal names (invalid_input), at most ten. */
  fields?: string[];
}

/** What Sessions pins of one visit for a case (`sessions.running.platformTrace`). */
export interface SessionTrace {
  projectId: string;
  threadId: string;
  instanceId: string;
  revision: number;
  role: string;
  harness?: string;
  status: string;
  outcome?: string;
  closeReason?: string;
  createdAt: string;
  closedAt?: string;
  runnerId?: string;
  hostRef?: string;
  allocationId?: string;
  /** Its uploaded transcript: blob `transcripts-<projectId>/<sha256>`. */
  transcript?: { sha256: string; size: number };
  /** The resumable conversation it left: blob `conversations-<projectId>/<sha256>`. */
  conversation?: { sha256: string; size: number };
  workspace?: { branch?: string; baseOid?: string; headOid?: string; treeOid?: string };
}

/** An issue as the admin reads it. */
export interface IssueRow {
  id: string;
  class: IssueClass;
  where: string;
  code: string;
  key: string | null;
  level: IssueLevel;
  loop: boolean;
  state: IssueState;
  count: number;
  /** The most reports in any one hour. */
  peakHour: number;
  note: string | null;
  /** Up to five projects its kept cases name. */
  projects: string[];
  firstAt: string;
  openedAt: string;
  lastAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}
/** One kept case of an issue. */
export interface IssueCase {
  id: string;
  at: string;
  level: IssueLevel;
  status: number | null;
  /** Reports of its subject folded into this case within one flush. */
  repeats: number;
  projectId: string | null;
  subject: string | null;
  /** The Main release it ran under (`<stamp>-<sha8>-<content12>`), where known. */
  release: string | null;
  refs: IssueRefs;
  error: ErrorFacts | null;
  note: string | null;
  /** Pinned once its visit has ended; null before that and for a case without a visit. */
  trace: SessionTrace | null;
}
/** The `issues` service: owners' verbs and the admin's reads. */
export interface IssueStore extends Issues {
  /** Platform admin read, never exposed through a tool, a lease or a machine key: the open
   *  issues and those resolved in the last seven days, at most 500, newest report first. */
  platformIssues(): Promise<{ rows: IssueRow[]; open: number; severe: number }>;
  /** Platform admin read, never exposed through a tool, a lease or a machine key: one issue,
   *  its first kept case and its newest 50. */
  platformIssue(id: string): Promise<{ issue: IssueRow; cases: IssueCase[] } | undefined>;
  /** An admin resolves it, recorded under their label; its next report reopens it. */
  close(id: string, by: string): Promise<IssueRow>;
}

declare module 'cordis' {
  interface Context {
    issues: IssueStore;
  }
}

/** An owner's reporter where nothing collects: a unit test, a CLI command. */
export const silent: Issues = { report() {}, resolve() {} };

const bounded = (value: unknown, max: number) =>
  typeof value === 'string' && value ? value.slice(0, max) : undefined;

/** An error as an issue keeps it: its kind, code, status, frames and sanitized SQL cause. */
export function errorFacts(error: unknown): ErrorFacts | undefined {
  if (error === undefined || error === null) return undefined;
  if (typeof error !== 'object') return { name: typeof error };
  try {
    const failure = error as { name?: unknown; stack?: unknown; cause?: unknown };
    const cause = (
      failure.cause && typeof failure.cause === 'object' ? failure.cause : {}
    ) as Record<string, unknown>;
    const merv = error instanceof MervError ? error : undefined;
    const details = merv?.details as { issues?: unknown } | undefined;
    const issues: unknown = Array.isArray(details) ? details : details?.issues;
    const facts: ErrorFacts = {
      name: bounded(failure.name, 80),
      code: bounded(merv?.code, 120),
      status: merv?.status,
      // A refusal's frames are the refuser's, the same each time: only a fault's are kept.
      at:
        typeof failure.stack === 'string' && (!merv || merv.status >= 500)
          ? failure.stack
              .split('\n')
              .filter((line) => /^\s+at /.test(line))
              .slice(0, 3)
              .map((line) => line.trim().slice(0, 300))
          : undefined,
      sqlstate: bounded(cause.sqlstate, 10),
      table: bounded(cause.table, 120),
      constraint: bounded(cause.constraint, 120),
      fields: Array.isArray(issues)
        ? issues
            .slice(0, 10)
            .map((issue: { path?: unknown }) =>
              Array.isArray(issue?.path) ? issue.path.join('.').slice(0, 120) : '',
            )
            .filter(Boolean)
        : undefined,
    };
    return Object.fromEntries(
      Object.entries(facts).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length)),
    ) as ErrorFacts;
  } catch {
    return { name: 'unreadable' };
  }
}

/**
 * What an owner holds: `issues` looked up at each call. A warn or severe report also writes
 * one stderr line, at most one per issue every ten seconds, which is all there is while Issues
 * or its database is away.
 */
export function reporter(ctx: Context): Issues {
  const lines = new Map<string, number>();
  const line = (issue: IssueReport) => {
    const level = issue.level ?? 'warn';
    if (level === 'notice') return;
    const id = `${issue.class}\n${issue.where}\n${issue.code}\n${issue.key ?? ''}`;
    const now = Date.now();
    if ((lines.get(id) ?? 0) > now) return;
    if (lines.size >= 1000) lines.clear();
    lines.set(id, now + 10_000);
    const facts = errorFacts(issue.error);
    process.stderr.write(
      `${JSON.stringify({
        event: issue.where,
        code: issue.code,
        level,
        key: issue.key,
        subject: issue.subject,
        status: issue.status,
        ...issue.refs,
        name: facts?.name,
        at: facts?.at,
        sqlstate: facts?.sqlstate,
        table: facts?.table,
        constraint: facts?.constraint,
      })}\n`,
    );
  };
  return {
    report(issue) {
      try {
        line(issue);
        ctx.get('issues')?.report(issue);
      } catch {
        // Telemetry never decides a call.
      }
    },
    resolve(target) {
      try {
        ctx.get('issues')?.resolve(target);
      } catch {
        // Telemetry never decides a call.
      }
    },
  };
}

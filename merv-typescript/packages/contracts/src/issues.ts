/**
 * Issues: what went wrong, said once by its owner at the place it went wrong. An owner holds
 * `reporter(ctx)`, which looks the `issues` service up at each call, so no owner depends on
 * @merv/issues and Issues may be absent, reloading or failing. That plugin fingerprints, counts,
 * detects loops, keeps the cases and alerts. Every field is a code or an id except `note`:
 * owner-bounded words, redacted, read by platform admins only and never sent to Slack.
 */
import type { Context } from 'cordis';
import { MervError } from './index.js';

import type {
  ErrorFacts,
  IssueCase,
  IssueClass,
  IssueLevel,
  IssueRefs,
  IssueRow,
} from './issue-models.js';
export type * from './issue-models.js';

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

/** A failure's finite code: its MervError's, else `unexpected`. */
export const issueCode = (error: unknown): string =>
  error instanceof MervError ? error.code : 'unexpected';

/** The catch of a pass that swallows its failure for the next pass to retry: a platform issue
 *  at `where`, which is also its subject, so a pass that keeps failing is a loop. */
export const swallowed =
  (issues: Pick<Issues, 'report'>, where: string, level: IssueLevel = 'warn') =>
  (error: unknown): undefined =>
    void issues.report({
      class: 'platform',
      where,
      code: issueCode(error),
      subject: where,
      level,
      error,
    });

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

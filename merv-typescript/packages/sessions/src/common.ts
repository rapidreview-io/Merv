import {
  check,
  digest,
  MervError,
  type Caller,
  type DelegationSource,
  type Scope,
  type State,
  type Transaction,
  visible,
} from '@merv/contracts';
import type { Session } from './types.js';

/** The provider Sessions reports dispatch holds as, beside any other opinion of its own. */
export const HOLD_PROVIDER = 'session-dispatch';
/** The provider of the model budget's wait on work a rented machine would take. */
export const MODEL_BUDGET_PROVIDER = 'session-model-budget';
/** The provider of a worker's wait for its compute, on the work it withholds. */
export const COMPUTE_PROVIDER = 'session-compute';
import { live } from './rules.js';
export { live };
/** Refuses a call from a visit that has ended, or that is not the caller's own. */
export const ownLive = (session: { status: string; actorId: string }, caller: Caller) =>
  check(
    live(session) && session.actorId === caller.actorId,
    'session_ended',
    'This session has ended',
    409,
  );
/** Visible text of at most `max` characters and no NUL. */
export const text = (value: unknown, max = 200) =>
  typeof value === 'string' && visible(value) && value.length <= max && !value.includes('\0');
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
/** A stored visit's row, as far as it is read back whole. */
export type Stored = { thread_id: string; session_json: string };
/** A stored visit; a work visit stored before 2026-10-07 names no kind in its JSON. */
export const decoded = (row: Stored): Session => ({
  kind: 'work',
  ...JSON.parse(row.session_json),
  threadId: row.thread_id,
});
/** Managed runners use only their bound controls, never an ordinary Sessions entry point. */
export function ordinary(caller: Caller): void {
  check(
    !caller.managed,
    'forbidden',
    'Managed runners may only use their bound session controls',
    403,
  );
}
/** A worker_sessions row with its workspace capture. */
export interface Row extends Stored {
  id: string;
  project_id: string;
  owner_hash: string;
  token_hash: string;
  fingerprint: string;
  attachment_json: string | null;
  result_json: string | null;
}

/** A thread of the project, or `thread_not_found`. */
export async function threadIn(tx: Transaction, projectId: string, id: string) {
  const thread = await tx.get<{
    id: string;
    project_id: string;
    instance_id: string;
    status: string;
    size: number | string | null;
  }>('SELECT * FROM session_threads WHERE id=? AND project_id=?', id, projectId);
  check(thread, 'thread_not_found', 'Thread not found in this project', 404);
  return thread;
}
/** A runner's control names the host its session is attached to. */
export const attached = (session: { hostRef: string | null }, hostRef: string, what: string) =>
  check(
    session.hostRef !== null && session.hostRef === hostRef,
    'host_conflict',
    `${what} must name the attached host`,
    409,
  );

/** A refusal as it is, anything else as Sessions being unavailable. */
export const safeError = (error: unknown): MervError =>
  error instanceof MervError
    ? error
    : new MervError('session_unavailable', 'Session validation is unavailable', 503);

export const isoNow = (clock: () => number) => new Date(clock()).toISOString();

/** A snapshot refuses a write before any SQL runs: what it refused has something to record. */
export const refused = (error: unknown) =>
  error instanceof MervError && error.code === 'read_only_scope';
/** `fn` on a snapshot, again in a writer when it has something to record: it changes only `tx`. */
export async function readFirst<T>(state: State, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  if (state.ambient) return await fn(state.ambient);
  try {
    return await state.snapshotTransaction(fn);
  } catch (error) {
    if (!refused(error)) throw error;
    return await state.transaction(fn);
  }
}

/** The caller's delegation source and the hash that owns what it offers, registers or runs. */
export async function ownerOf(
  scope: Scope,
  caller: Caller,
  tx: Transaction,
): Promise<{ source: DelegationSource; hash: string }> {
  const source = await scope.delegationSource(caller, tx);
  return { source, hash: digest(source) };
}

/** PostgreSQL SUM(bigint) is numeric and arrives as text; a public total is normalised here. */
export const safeCount =
  (code: string, message: string) =>
  (value: number | string | null): number => {
    const number = Number(value ?? 0);
    check(Number.isSafeInteger(number) && number >= 0, code, message, 500);
    return number;
  };

/** What a lease label begins with for the agent: `Work: `, `Review: ` or a recipe's dotted name. */
const PURPOSE = String.raw`^(?:Work|Review|[a-z]+(?:\.\w+)+):\s+`;
/** The name a person reads for a session's work (an inquiry visit names the step it asks of):
 *  its record's own, or the label of a lease offered before owners gave one. In SQL it is the
 *  `work_name` column (sessions@23). */
export const workName = ({ name, label }: { name?: string; label: string }) =>
  name ?? label.replace(new RegExp(PURPOSE), '');
export const targetKey = (item: { instanceId: string; expectedRevision: number }) =>
  `${item.instanceId}:${item.expectedRevision}`;
/** The workflow steps of a project that a live session holds, as targetKey values. */
export async function liveTargets(tx: Transaction, projectId: string): Promise<Set<string>> {
  return new Set(
    (
      await tx.all<{ instance_id: string; revision: number }>(
        "SELECT instance_id,revision FROM worker_sessions WHERE project_id=? AND status IN ('offered','active') AND kind='work'",
        projectId,
      )
    ).map((row) => targetKey({ instanceId: row.instance_id, expectedRevision: row.revision })),
  );
}

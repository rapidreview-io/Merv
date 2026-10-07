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

/**
 * A visit its worker ended by its own hand: its handoff, or its question to its owner. Hosted
 * Codex may finish the model call it had started for a minute after either.
 */
export const ownEnd = (reason: string | null | undefined) =>
  reason === 'handoff' || reason === 'asked_owner';
/** The provider Sessions reports dispatch holds as, beside any other opinion of its own. */
export const HOLD_PROVIDER = 'session-dispatch';
/** Offered or active: a session that still holds its lease. */
export const live = (session: Pick<Session, 'status'>) =>
  session.status === 'offered' || session.status === 'active';
/** Visible text of at most `max` characters and no NUL. */
export const text = (value: unknown, max = 200) =>
  typeof value === 'string' && visible(value) && value.length <= max && !value.includes('\0');
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
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
export interface Row {
  id: string;
  project_id: string;
  thread_id: string;
  owner_hash: string;
  token_hash: string;
  fingerprint: string;
  session_json: string;
  attachment_json: string | null;
  result_json: string | null;
}

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
/** In SQL, the name a person reads for the work of session JSON `j`: its record's own, or the
 * label of a lease offered before owners gave one. */
export const workNameOf = (j: string) =>
  `COALESCE(${j} #>> '{assignment,name}',regexp_replace(${j} #>> '{assignment,label}','${PURPOSE}',''))`;
/** The same name, read from a session's assignment. */
export const workName = ({ name, label }: { name?: string; label: string }) =>
  name ?? label.replace(new RegExp(PURPOSE), '');
export const targetKey = (item: { instanceId: string; expectedRevision: number }) =>
  `${item.instanceId}:${item.expectedRevision}`;
/** The workflow steps of a project that a live session holds, as targetKey values. */
export async function liveTargets(tx: Transaction, projectId: string): Promise<Set<string>> {
  return new Set(
    (
      await tx.all<{ instance_id: string; revision: number }>(
        "SELECT instance_id,revision FROM worker_sessions WHERE project_id=? AND status IN ('offered','active')",
        projectId,
      )
    ).map((row) => targetKey({ instanceId: row.instance_id, expectedRevision: row.revision })),
  );
}

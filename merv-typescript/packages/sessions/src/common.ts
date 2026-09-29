import {
  check,
  digest,
  MervError,
  type Caller,
  type DelegationSource,
  type Scope,
  type State,
  type Transaction,
} from '@merv/contracts';

export const isoNow = (clock: () => number) => new Date(clock()).toISOString();

/** A snapshot refuses a write before any SQL runs: what it refused has something to record. */
export const refused = (error: unknown) =>
  error instanceof MervError && error.code === 'read_only_scope';
/** `fn` on a snapshot, again in a writer when it has something to record: it changes only `tx`. */
export async function readFirst<T>(state: State, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  if (state.ambient) return await fn(state.ambient);
  try {
    return await state.snapshot(() => state.transaction(fn));
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

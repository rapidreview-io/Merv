import {
  check,
  digest,
  type Caller,
  type DelegationSource,
  type Scope,
  type Transaction,
} from '@merv/contracts';

export const isoNow = (clock: () => number) => new Date(clock()).toISOString();

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

import type { Permission, Sql, State, Transaction } from '@merv/contracts';

/**
 * Where one Scope read or decision runs, chosen in one place.
 * - An explicit `tx` is used as it is, once asserted.
 * - Inside a transaction, a snapshot's open read transaction included, that one is reused.
 * - Without `place`, a plain read runs on `state.read`.
 * - With `place` the work needs a transaction. For 'read' it is a snapshot's read-only one, which
 *   takes no writer lock and refuses writes; for any other permission a write transaction. Inside
 *   a bare snapshot both are read-only transactions of that snapshot, and inside a plain read both
 *   are write transactions on the read's own connection.
 */
export async function within<T>(
  state: State,
  tx: Transaction | undefined,
  fn: (sql: Sql) => Promise<T>,
  place?: Permission,
): Promise<T> {
  if (tx) {
    state.assertTransaction(tx);
    return await fn(tx);
  }
  const ambient = state.ambient;
  if (ambient) return await fn(ambient);
  if (!place) return await state.read(fn);
  return place === 'read'
    ? await state.snapshot(() => state.transaction(fn))
    : await state.transaction(fn);
}

/** A pure read that needs a transaction: it runs wherever a read decision would run. */
export async function forRead<T>(state: State, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  // With a place, `within` always hands over a transaction.
  return await within(state, undefined, (sql) => fn(sql as Transaction), 'read');
}

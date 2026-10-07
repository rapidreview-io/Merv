/** Counting the SQL statements one call issues, for tests that hold a read's cost flat. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { State, Transaction } from '@merv/contracts';

/** How many statements `run` issues itself; background work the app does meanwhile is not counted. */
export function counter(state: State) {
  const mine = new AsyncLocalStorage<{ statements: number }>();
  const patched = new WeakSet<object>();
  const patch = (tx: Transaction) => {
    if (patched.has(tx)) return;
    patched.add(tx);
    for (const key of ['get', 'all', 'run'] as const) {
      const original = tx[key] as (...args: unknown[]) => unknown;
      Object.assign(tx, {
        [key]: (...args: unknown[]) => {
          const count = mine.getStore();
          if (count) count.statements++;
          return original.apply(tx, args);
        },
      });
    }
  };
  const target = state as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const name of ['transaction', 'read'] as const) {
    const original = target[name]!.bind(state);
    target[name] = (fn: unknown, ...rest: unknown[]) =>
      original(
        async (tx: Transaction) => {
          patch(tx);
          return await (fn as (tx: Transaction) => unknown)(tx);
        },
        ...rest,
      );
  }
  return async (run: () => Promise<unknown>) => {
    const count = { statements: 0 };
    await mine.run(count, run);
    return count.statements;
  };
}

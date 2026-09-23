/**
 * Two writers racing on one database, as two server processes would: each has its own State pool
 * on the same schema and its own services. The first is held inside its write transaction at a
 * point the test chooses; the second is started and seen queued on State's writer lock (the
 * transaction advisory lock on `merv-state:<schema>`) before the first may go on.
 */
import { createService, type Transaction } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import type { PostgresState } from '@merv/state';
import { deferred } from './deferred.js';
import { openState } from './state.js';

export type Settled<T> =
  { ok: true; value: T } | { ok: false; code: string | undefined; status: number | undefined };

/** What a writer's services call: the first is held at `hold`; the second reports `entered`. */
export interface Writer {
  hold(): Promise<void>;
  entered(): void;
}

const settle = <T>(pending: Promise<T>): Promise<Settled<T>> =>
  pending.then(
    (value) => ({ ok: true as const, value }),
    (error: { code?: string; status?: number }) => ({
      ok: false as const,
      code: error.code,
      status: error.status,
    }),
  );

/** Until another session waits for the writer lock of `schema`, which the first writer holds. */
async function queued(observer: PostgresState, schema: string) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const waiting = await observer.read((sql) =>
      sql.get<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_catalog.pg_locks
         WHERE locktype='advisory' AND NOT granted
           AND ((classid::bigint << 32) | objid::bigint) = pg_catalog.hashtextextended(?, 0)`,
        `merv-state:${schema}`,
      ),
    );
    if (waiting!.n > 0) return;
    if (Date.now() > deadline) throw new Error('The second writer never queued behind the first');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export async function raceWriters<S, T>(options: {
  /** The schema both writers share: the test's own database. */
  schema: string;
  /** One writer's services on its own State. */
  service: (state: PostgresState, writer: Writer) => Promise<S>;
  first: (service: S) => Promise<T>;
  second: (service: S) => Promise<T>;
}): Promise<{
  first: Settled<T>;
  second: Settled<T>;
  /** Whether the second had entered while the first was held, and by the end. */
  secondEnteredWhileHeld: boolean;
  secondEntered: boolean;
}> {
  const open = () =>
    openState(undefined, {
      schema: options.schema,
      maxConnections: 2,
      readConnections: 1,
      lockTimeoutMs: 30_000,
    });
  const holding = deferred(),
    release = deferred();
  let held = false,
    entered = false;
  const [firstState, secondState] = [await open(), await open()];
  const [firstService, secondService] = [
    await options.service(firstState, {
      hold: async () => {
        if (held) return;
        held = true;
        holding.resolve();
        await release.promise;
      },
      entered: () => undefined,
    }),
    await options.service(secondState, {
      hold: async () => undefined,
      entered: () => {
        entered = true;
      },
    }),
  ];
  try {
    const first = settle(options.first(firstService));
    await Promise.race([
      holding.promise,
      first.then((result) => {
        throw new Error(`The first writer finished without being held: ${JSON.stringify(result)}`);
      }),
    ]);
    const second = settle(options.second(secondService));
    await queued(firstState, options.schema);
    const secondEnteredWhileHeld = entered;
    release.resolve();
    const results = { first: await first, second: await second };
    return { ...results, secondEnteredWhileHeld, secondEntered: entered };
  } finally {
    release.resolve();
    await Promise.allSettled([firstState.close(), secondState.close()]);
  }
}

/**
 * A Scope writer: held just after it appends its first event (or its first event of type
 * `holdAfter`), and entered once a transaction callback of its own runs.
 */
export const scopeWriter =
  (clock: () => number, holdAfter?: string) =>
  async (state: PostgresState, writer: Writer): Promise<ProjectScope> => {
    // Scope's own migrations are writes too, so it is ready before the writer is watched.
    const scope = await createService(new ProjectScope(state, clock));
    const append = state.appendEvent.bind(state);
    state.appendEvent = async (tx, event) => {
      const written = await append(tx, event);
      if (holdAfter === undefined || event.type === holdAfter) await writer.hold();
      return written;
    };
    const transaction = state.transaction.bind(state);
    state.transaction = ((fn: (tx: Transaction) => unknown) =>
      transaction((tx) => {
        writer.entered();
        return fn(tx);
      })) as typeof state.transaction;
    return scope;
  };

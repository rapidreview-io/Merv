/**
 * Two writers racing on one database, as two server processes would: each has its own State pool
 * on the same schema and its own Scope. The first is held inside its write transaction just after
 * it appends an event; the second is started and seen queued on the database's writer lock
 * before the first may go on.
 */
import { createService } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import type { PostgresState } from '@merv/state';
import { deferred } from './deferred.js';
import { openState } from './state.js';

export type Settled<T> =
  { ok: true; value: T } | { ok: false; code: string | undefined; status: number | undefined };

const settle = <T>(pending: Promise<T>): Promise<Settled<T>> =>
  pending.then(
    (value) => ({ ok: true as const, value }),
    (error: { code?: string; status?: number }) => ({
      ok: false as const,
      code: error.code,
      status: error.status,
    }),
  );

/** Until a backend waits for an advisory lock that backend `holder` holds. */
async function queuedBehind(observer: PostgresState, holder: number) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const waiting = await observer.read((sql) =>
      sql.get<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_catalog.pg_locks w JOIN pg_catalog.pg_locks h
           ON h.locktype='advisory' AND h.classid=w.classid AND h.objid=w.objid AND h.objsubid=w.objsubid
         WHERE w.locktype='advisory' AND NOT w.granted AND h.granted AND h.pid=?`,
        holder,
      ),
    );
    if (waiting!.n > 0) return;
    if (Date.now() > deadline) throw new Error('The second writer never queued behind the first');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export async function raceWriters<T>(options: {
  /** The schema both writers share: the test's own database. */
  schema: string;
  /** Scope's clock for both writers. */
  clock: () => number;
  /** The event type after which the first writer is held; by default its first event. */
  holdAfter?: string;
  first: (scope: ProjectScope) => Promise<T>;
  second: (scope: ProjectScope) => Promise<T>;
}): Promise<{ first: Settled<T>; second: Settled<T>; secondEnteredWhileHeld: boolean }> {
  const open = () =>
    openState(undefined, {
      schema: options.schema,
      maxConnections: 2,
      readConnections: 1,
      lockTimeoutMs: 30_000,
    });
  const [held, waiting] = [await open(), await open()];
  // Both Scopes are ready (their migrations are writes too) before either writer is watched.
  const [heldScope, waitingScope] = [
    await createService(new ProjectScope(held, options.clock)),
    await createService(new ProjectScope(waiting, options.clock)),
  ];
  const holding = deferred<number>(),
    release = deferred();
  let holds = true;
  const append = held.appendEvent.bind(held);
  held.appendEvent = async (tx, event) => {
    const written = await append(tx, event);
    if (holds && (options.holdAfter === undefined || event.type === options.holdAfter)) {
      holds = false;
      holding.resolve((await tx.get<{ pid: number }>('SELECT pg_backend_pid() AS pid'))!.pid);
      await release.promise;
    }
    return written;
  };
  let entered = false;
  const transaction = waiting.transaction.bind(waiting);
  waiting.transaction = ((fn: Parameters<typeof transaction>[0]) =>
    transaction((tx) => {
      entered = true;
      return fn(tx);
    })) as typeof waiting.transaction;
  try {
    const first = settle(options.first(heldScope));
    const holder = await Promise.race([
      holding.promise,
      first.then((result) => {
        throw new Error(`The first writer finished without being held: ${JSON.stringify(result)}`);
      }),
    ]);
    const second = settle(options.second(waitingScope));
    await queuedBehind(held, holder);
    const secondEnteredWhileHeld = entered;
    release.resolve();
    return { first: await first, second: await second, secondEnteredWhileHeld };
  } finally {
    release.resolve();
    await Promise.allSettled([held.close(), waiting.close()]);
  }
}

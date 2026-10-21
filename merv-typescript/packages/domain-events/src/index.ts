import { bootMaintenance } from '@merv/contracts/maintenance';
import { AsyncLocalStorage } from 'node:async_hooks';
import { types as nodeTypes } from 'node:util';
import type { Context } from 'cordis';
import {
  createService,
  check,
  digest,
  type State,
  type Transaction,
  type DomainEvents,
  type EventConsumer,
  type ConsumerStatus,
} from '@merv/contracts';
import { postgresMigrations } from './index.postgres.js';

type Progress = {
  id: string;
  cursor: number;
  attempts: number;
  error: string | null;
  retry_at: number;
  definition_hash: string;
};

const NAME = /^[a-z][a-z0-9_.-]{0,127}$/;
const progressOf = (tx: Transaction, id: string) =>
  tx.get<Progress>('SELECT * FROM event_consumers WHERE id=?', id);
/** How many passes that reach their head answer a drain() while commits keep arriving. */
const DRAIN_PASSES = 16;

/** Local async handlers commit their effects and durable event cursor together. */
export class DurableEvents implements DomainEvents {
  private consumers = new Map<string, EventConsumer>();
  /** Registrations in flight, by consumer ID; close() joins them. */
  private registering = new Map<string, Promise<void>>();
  /** The one delivery transaction in flight; a disposer joins it. */
  private admitted?: { consumer: EventConsumer; transaction: Promise<number | false> };
  private handlerContext = new AsyncLocalStorage<{ consumer: EventConsumer; live: boolean }>();
  private running?: Promise<void>;
  /** Passes that reached the head they began with, and drain() callers in call order. */
  private covered = 0;
  private waiting: { until: number; resolve(): void }[] = [];
  private initialization?: Promise<void>;
  private closing?: Promise<void>;
  private closed = false;
  private wakeRequested = false;
  /** The earliest retry the last pass saw; commits in this process wake delivery directly. */
  private retryAt = Infinity;
  private timer?: ReturnType<typeof setTimeout>;
  private unlisten: () => void = () => {};

  constructor(private state: State) {}

  initialize(): Promise<void> {
    check(!this.closed, 'events_closed', 'Domain Events is closed', 503);
    return (this.initialization ??= this.prepare());
  }

  private async prepare(): Promise<void> {
    await this.state.migrate('domain_events', postgresMigrations);
    if (this.closed) return;
    this.unlisten = this.state.onEventsCommitted(() => this.wake());
    this.wake();
  }

  async subscribe(input: EventConsumer): Promise<() => void | Promise<void>> {
    check(!this.closed, 'events_closed', 'Domain Events is closed', 503);
    check(
      typeof input.id === 'string' &&
        NAME.test(input.id) &&
        Array.isArray(input.types) &&
        input.types.length > 0 &&
        input.types.every((type) => typeof type === 'string' && NAME.test(type)) &&
        new Set(input.types).size === input.types.length &&
        ['beginning', 'now'].includes(input.from) &&
        typeof input.handle === 'function',
      'invalid_consumer',
      'A stable consumer ID, distinct event types and explicit starting position are required',
    );
    check(
      !this.consumers.has(input.id) && !this.registering.has(input.id),
      'consumer_registered',
      'Consumer is already active',
      409,
    );
    const consumer = { ...input, types: [...input.types] };
    const hash = digest([...consumer.types].sort());
    const registration = this.state.transaction(async (tx) => {
      const previous = await progressOf(tx, consumer.id);
      if (previous)
        check(
          previous.definition_hash === hash,
          'consumer_changed',
          'Use a new consumer ID when changing subscribed types',
          409,
        );
      else
        await tx.run(
          'INSERT INTO event_consumers(id,definition_hash,cursor) VALUES(?,?,?)',
          consumer.id,
          hash,
          consumer.from === 'beginning' ? 0 : await this.state.eventHead(tx),
        );
    });
    this.registering.set(consumer.id, registration);
    try {
      await registration;
      check(!this.closed, 'events_closed', 'Domain Events is closed', 503);
      this.consumers.set(consumer.id, consumer);
      this.wake();
    } finally {
      this.registering.delete(consumer.id);
    }
    return () => {
      if (this.consumers.get(consumer.id) === consumer) this.consumers.delete(consumer.id);
      // A handler may withdraw itself. It cannot wait for its own transaction to finish.
      const handler = this.handlerContext.getStore();
      if (handler?.live && handler.consumer === consumer) return;
      if (this.admitted?.consumer === consumer)
        return this.admitted.transaction.then(
          () => {},
          () => {},
        );
    };
  }

  private wake(delay = 0): void {
    if (bootMaintenance.active) return;
    if (this.closed) return;
    if (this.running) {
      if (delay === 0) this.wakeRequested = true;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      // Explicit drain callers receive storage failures. Timer wakeups retry without
      // creating an unhandled rejection when the database is temporarily unavailable.
      void this.drain().catch(() => {});
    }, delay);
    this.timer.unref();
  }

  drain(): Promise<void> {
    if (bootMaintenance.active) return Promise.resolve();
    this.requireOutsideHandler();
    if (this.running) {
      this.wakeRequested = true;
      return this.bounded(this.running);
    }
    if (this.closed) return Promise.resolve();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.running = Promise.resolve().then(async () => {
      try {
        let backlog: boolean;
        do {
          this.wakeRequested = false;
          backlog = await this.deliver();
          if (!backlog) this.covered++;
          while ((this.waiting[0]?.until ?? Infinity) <= this.covered)
            this.waiting.shift()!.resolve();
        } while (!this.closed && (backlog || this.wakeRequested));
      } finally {
        // Cleared in the same step as the last check above: a drain() from here on starts a
        // new pass instead of joining one that will not look for its commit.
        this.running = undefined;
        this.waiting = [];
        // A slow poll also discovers commits made through another State connection.
        this.wake(Math.max(0, Math.min(this.retryAt - Date.now(), 1000)));
      }
    });
    return this.bounded(this.running);
  }

  /** Settles with `running`, the passes until no commit wakes another, or while commits keep
   * arriving once DRAIN_PASSES more reach their head (one more, for a pass begun before the call). */
  private bounded(running: Promise<void>): Promise<void> {
    const until = this.covered + DRAIN_PASSES + 1;
    return Promise.race([
      running,
      new Promise<void>((resolve) => this.waiting.push({ until, resolve })),
    ]);
  }

  private async advance(tx: Transaction, consumer: EventConsumer, cursor: number) {
    await tx.run(
      'UPDATE event_consumers SET cursor=?, attempts=0, error=NULL, retry_at=0 WHERE id=?',
      cursor,
      consumer.id,
    );
  }

  private async deliver(): Promise<boolean> {
    const consumers = [...this.consumers.values()];
    this.retryAt = Infinity;
    if (!consumers.length) return false;
    // Lock-free: skip a consumer when a read taken after this pass began shows it waiting on a
    // retry, already past every committed event, or (quiet) with nothing it subscribes to up to
    // the head. Every event up to the head had committed when it was read (see the README's
    // ordering invariant), so that answer holds; the locked transactions below decide the rest.
    const { head, progress, quiet } = await this.state.read(async (sql) => {
      // Inside this read scope, eventHead reuses the same connection.
      const head = await this.state.eventHead();
      const progress = new Map(
        (
          await sql.all<Pick<Progress, 'id' | 'cursor' | 'retry_at'>>(
            'SELECT id, cursor, retry_at FROM event_consumers',
          )
        ).map((row) => [row.id, row]),
      );
      // Quiet consumers' ids and cursors, in pairs.
      const quiet: (string | number)[] = [];
      for (const consumer of consumers) {
        const seen = progress.get(consumer.id);
        if (!seen || seen.retry_at > Date.now() || seen.cursor >= head) continue;
        const next = await this.state.nextEventId(seen.cursor, consumer.types);
        if (next === undefined || next > head) quiet.push(consumer.id, seen.cursor);
      }
      return { head, progress, quiet };
    });
    // They pass to the head together, in one statement, each only while its row still reads as
    // it did; one that changed meanwhile is left to its delivery transaction.
    const passed = new Set<string>();
    if (quiet.length)
      for (const { id } of await this.state.transaction((tx) =>
        tx.all<{ id: string }>(
          `UPDATE event_consumers SET cursor=?, attempts=0, error=NULL, retry_at=0 WHERE retry_at<=?
           AND (id,cursor) IN (${'(?,?),'.repeat(quiet.length / 2).slice(0, -1)}) RETURNING id`,
          head,
          Date.now(),
          ...quiet,
        ),
      ))
        passed.add(id);
    let backlog = false;
    for (const consumer of consumers) {
      const seen = progress.get(consumer.id);
      if (seen && seen.retry_at > Date.now()) this.retryAt = Math.min(this.retryAt, seen.retry_at);
      // A consumer without a progress row (removed outside the application) has nothing to do.
      if (!seen || seen.retry_at > Date.now() || seen.cursor >= head || passed.has(consumer.id))
        continue;
      for (let count = 0; count < 100; count++) {
        if (this.closed || this.consumers.get(consumer.id) !== consumer) break;
        let attemptedCursor: number | undefined;
        try {
          const transaction = this.state.transaction(async (tx) => {
            const progress = await progressOf(tx, consumer.id);
            // A progress row removed outside the application: deliver nothing, strand no one.
            if (!progress || progress.retry_at > Date.now()) return false;
            attemptedCursor = progress.cursor;
            // The unsubscribed events before the next subscribed one are passed with it, and
            // with none left the cursor moves to the head.
            const event = await this.state.nextEvent(progress.cursor, consumer.types, tx);
            if (!event) {
              const end = await this.state.eventHead(tx);
              if (end > progress.cursor) await this.advance(tx, consumer, end);
              return false;
            }
            // A handler owns its argument, not the dispatcher's durable progress.
            const cursor = event.id;
            const frame = { consumer, live: true };
            try {
              await this.handlerContext.run(frame, () => consumer.handle(event, tx));
            } finally {
              frame.live = false;
            }
            await this.advance(tx, consumer, cursor);
            return cursor;
          });
          this.admitted = { consumer, transaction };
          let delivered: number | false;
          try {
            delivered = await transaction;
          } finally {
            this.admitted = undefined;
          }
          if (delivered === false) break;
          // Past the head this pass began with, later commits wake the next pass themselves.
          if (count === 99 && delivered < head) backlog = true;
        } catch (error) {
          // Failed handler effects and cursor both rolled back. Record retry separately.
          await this.state.transaction(async (tx) => {
            const row = await progressOf(tx, consumer.id);
            if (!row || row.cursor !== attemptedCursor) return;
            const delay = 100 * 2 ** Math.min(row.attempts, 8);
            this.retryAt = Math.min(this.retryAt, Date.now() + delay);
            // Failure handling must not invoke getters or proxy traps on an
            // arbitrary thrown value and thereby strand every later consumer.
            const field =
              error && typeof error === 'object' && !nodeTypes.isProxy(error)
                ? Object.getOwnPropertyDescriptor(error, 'code')
                : undefined;
            const value = field && Object.hasOwn(field, 'value') ? field.value : undefined;
            const code =
              typeof value === 'string' && /^[a-z_]{1,80}$/.test(value) ? value : 'handler_failed';
            await tx.run(
              'UPDATE event_consumers SET attempts=attempts+1,error=?,retry_at=? WHERE id=?',
              code,
              Date.now() + delay,
              consumer.id,
            );
          });
          break;
        }
      }
    }
    return backlog;
  }

  async status(): Promise<ConsumerStatus[]> {
    return this.state.read(async (sql) =>
      (await sql.all<Progress>('SELECT * FROM event_consumers ORDER BY id')).map((row) => ({
        id: row.id,
        cursor: row.cursor,
        active: this.consumers.has(row.id),
        attempts: row.attempts,
        error: row.error,
        retryAt: row.retry_at,
      })),
    );
  }

  private requireOutsideHandler(): void {
    check(
      !this.handlerContext.getStore()?.live,
      'events_handler_active',
      'Cannot drain or close Domain Events from an active event handler',
      409,
    );
  }

  close(): Promise<void> {
    this.requireOutsideHandler();
    if (this.closing) return this.closing;
    this.closed = true;
    this.unlisten();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.consumers.clear();
    this.closing = Promise.allSettled([
      ...this.registering.values(),
      ...(this.initialization ? [this.initialization] : []),
      ...(this.running ? [this.running] : []),
    ]).then(() => {});
    return this.closing;
  }
}

export const domainEventsPlugin = {
  name: 'merv-domain-events',
  inject: ['state'],
  async apply(ctx: Context) {
    await ctx.effect(async function* () {
      const events = await createService(new DurableEvents(ctx.state));
      yield () => events.close();
      yield ctx.provide('domainEvents', events);
    });
  },
};
export default domainEventsPlugin;

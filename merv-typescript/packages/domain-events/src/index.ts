import { AsyncLocalStorage } from 'node:async_hooks';
import { types as nodeTypes } from 'node:util';
import type { Context } from 'cordis';
import {
  createService,
  check,
  digest,
  type State,
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

/** Local async handlers commit their effects and durable event cursor together. */
export class DurableEvents implements DomainEvents {
  private consumers = new Map<string, EventConsumer>();
  private pendingIds = new Set<string>();
  private subscriptions = new Set<Promise<void>>();
  private admitted = new Map<EventConsumer, Promise<boolean>>();
  private handlerContext = new AsyncLocalStorage<{ consumer: EventConsumer; live: boolean }>();
  private running?: Promise<void>;
  private initialization?: Promise<void>;
  private closing?: Promise<void>;
  private closed = false;
  private wakeRequested = false;
  private timer?: ReturnType<typeof setTimeout>;
  private unlisten: () => void = () => {};

  constructor(private state: State) {}

  initialize(): Promise<void> {
    check(!this.closed, 'events_closed', 'Domain Events is closed', 503);
    return (this.initialization ??= this.prepare());
  }

  private async prepare(): Promise<void> {
    await this.state.migrate('domain_events', [
      {
        version: 1,
        postgres: postgresMigrations[1],
        sql: `
      CREATE TABLE event_consumers (
        id TEXT PRIMARY KEY, definition_hash TEXT NOT NULL, cursor INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, error TEXT, retry_at INTEGER NOT NULL DEFAULT 0
      );
    `,
      },
    ]);
    if (this.closed) return;
    this.unlisten = this.state.onEventsCommitted(() => this.wake());
    this.wake();
  }

  async subscribe(input: EventConsumer): Promise<() => void | Promise<void>> {
    check(!this.closed, 'events_closed', 'Domain Events is closed', 503);
    check(
      /^[a-z][a-z0-9_.-]{0,127}$/.test(input.id) &&
        input.types.length > 0 &&
        input.types.every((type) => /^[a-z][a-z0-9_.-]{0,127}$/.test(type)) &&
        new Set(input.types).size === input.types.length &&
        ['beginning', 'now'].includes(input.from) &&
        typeof input.handle === 'function',
      'invalid_consumer',
      'A stable consumer ID, distinct event types and explicit starting position are required',
    );
    check(
      !this.consumers.has(input.id) && !this.pendingIds.has(input.id),
      'consumer_registered',
      'Consumer is already active',
      409,
    );
    const consumer = { ...input, types: [...input.types] };
    const hash = digest([...consumer.types].sort());
    this.pendingIds.add(consumer.id);
    const registration = this.state.transaction(async (tx) => {
      const previous = await tx.get<Progress>(
        'SELECT * FROM event_consumers WHERE id=?',
        consumer.id,
      );
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
    this.subscriptions.add(registration);
    try {
      await registration;
      check(!this.closed, 'events_closed', 'Domain Events is closed', 503);
      this.consumers.set(consumer.id, consumer);
      this.wake();
    } finally {
      this.pendingIds.delete(consumer.id);
      this.subscriptions.delete(registration);
    }
    return () => {
      if (this.consumers.get(consumer.id) === consumer) this.consumers.delete(consumer.id);
      // A handler may withdraw itself. It cannot wait for its own transaction to finish.
      const handler = this.handlerContext.getStore();
      if (handler?.live && handler.consumer === consumer) return;
      return this.admitted.get(consumer)?.then(
        () => {},
        () => {},
      );
    };
  }

  private wake(delay = 0): void {
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
    this.requireOutsideHandler();
    if (this.running) {
      this.wakeRequested = true;
      return this.running;
    }
    if (this.closed) return Promise.resolve();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.running = Promise.resolve()
      .then(async () => {
        let backlog: boolean;
        do {
          this.wakeRequested = false;
          backlog = await this.deliver();
        } while (!this.closed && (backlog || this.wakeRequested));
      })
      .finally(() => {
        this.running = undefined;
        // Also discovers commits made through another State connection.
        this.wake(100);
      });
    return this.running;
  }

  private async deliver(): Promise<boolean> {
    let backlog = false;
    for (const consumer of [...this.consumers.values()]) {
      for (let count = 0; count < 100; count++) {
        if (this.closed || this.consumers.get(consumer.id) !== consumer) break;
        let attemptedCursor: number | undefined;
        try {
          const transaction = this.state.transaction(async (tx) => {
            const progress = (await tx.get<Progress>(
              'SELECT * FROM event_consumers WHERE id=?',
              consumer.id,
            ))!;
            attemptedCursor = progress.cursor;
            if (progress.retry_at > Date.now()) return false;
            const event = (await this.state.eventBatch(progress.cursor, 1, tx))[0];
            if (!event) return false;
            // A handler owns its argument, not the dispatcher's durable progress.
            const cursor = event.id;
            if (consumer.types.includes(event.type)) {
              const frame = { consumer, live: true };
              try {
                await this.handlerContext.run(frame, () => consumer.handle(event, tx));
              } finally {
                frame.live = false;
              }
            }
            await tx.run(
              'UPDATE event_consumers SET cursor=?, attempts=0, error=NULL, retry_at=0 WHERE id=?',
              cursor,
              consumer.id,
            );
            return true;
          });
          this.admitted.set(consumer, transaction);
          let advanced: boolean;
          try {
            advanced = await transaction;
          } finally {
            this.admitted.delete(consumer);
          }
          if (!advanced) break;
          if (count === 99) backlog = true;
        } catch (error) {
          // Failed handler effects and cursor both rolled back. Record retry separately.
          await this.state.transaction(async (tx) => {
            const row = (await tx.get<Progress>(
              'SELECT * FROM event_consumers WHERE id=?',
              consumer.id,
            ))!;
            if (row.cursor !== attemptedCursor) return;
            const delay = Math.min(30_000, 100 * 2 ** Math.min(row.attempts, 8));
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
      ...this.subscriptions,
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

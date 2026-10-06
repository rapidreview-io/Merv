import { z } from 'zod';
import {
  AGENT_EVENT_TEXT,
  check,
  type AgentEvent,
  type AgentStreamEvent,
  type Caller,
  type Scope,
  type State,
  type Transaction,
} from '@merv/contracts';
import { isoNow, live, readFirst } from './common.js';
import { postgresMigrations } from './stream.postgres.js';
import type { Session, SessionStreamBatch, SessionStreamReads } from './types.js';

/** How long after its session closed a stream still takes the agent's last words. */
const STREAM_GRACE_MS = 10 * 60_000;
const RETAIN_MS = 30 * 86_400_000;
/** What a page is sent first: the newest events, at most this many or this many bytes. */
const SNAPSHOT_EVENTS = 500;
const SNAPSHOT_BYTES = 2_000_000;
const READERS_PER_SESSION = 8;
const READERS = 256;
const busy = 'Too many agent streams are open; retry shortly';

const offset = z.number().int().nonnegative().safe();
const id = z.string().max(200);
const words = z.string().max(AGENT_EVENT_TEXT);
const cut = z.number().int().positive().safe().optional();
const eventSchema: z.ZodType<AgentEvent> = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('thinking'), id, delta: words, done: z.boolean().optional(), cut })
    .strict(),
  z
    .object({ kind: z.literal('text'), id, delta: words, done: z.boolean().optional(), cut })
    .strict(),
  z
    .object({ kind: z.literal('tool_call'), id, name: z.string().max(200), input: words, cut })
    .strict(),
  z
    .object({
      kind: z.literal('tool_result'),
      id,
      output: words,
      error: z.boolean().optional(),
      cut,
    })
    .strict(),
  z.object({ kind: z.literal('status'), id, text: words }).strict(),
]);
const batchSchema = z
  .object({
    sessionId: z.string().min(1).max(200),
    runnerId: z.string().min(1).max(200),
    hostRef: z.string().min(1).max(512),
    from: offset,
    to: offset,
    events: z.array(eventSchema).max(20_000),
  })
  .strict()
  .refine((batch) => batch.to >= batch.from);

type Row = { seq: number | string; at: string; event: string };
const view = (row: Row): AgentStreamEvent => ({
  seq: Number(row.seq),
  at: row.at,
  event: JSON.parse(row.event),
});

/**
 * A worker agent's live stream: what its runner reads from the agent's output, numbered here
 * in the order it arrives, kept 30 days after the session ends, and pushed to operators' pages.
 * Pushes come from this process's own ingests; a page also re-reads every two seconds, so a
 * batch another app instance took arrives too.
 */
export class SessionStreams implements SessionStreamReads {
  private readonly readers = new Map<string, Set<() => void>>();
  private open = 0;
  constructor(
    private readonly state: State,
    private readonly scope: Scope,
    private readonly clock: () => number,
    private readonly controlled: (
      caller: Caller,
      id: string,
      runnerId: string,
      tx: Transaction,
    ) => Promise<Session>,
    /** Refuses once Sessions has closed. */
    private readonly available: () => void,
  ) {}
  async initialize() {
    await this.state.migrate('session_events', [{ version: 1, sql: postgresMigrations[1]! }]);
  }

  /**
   * One batch from the runner that holds the session, while it is live and for a while after it
   * closed. A batch starting before what is already held was taken before: it is answered, not
   * added, so a retry never doubles a line. The answer says how far into the log Sessions holds.
   * Authority and what is held are read on a snapshot; only a batch to add takes the writer.
   */
  async append(caller: Caller, input: unknown): Promise<{ until: number; seq: number }> {
    this.available();
    caller = structuredClone(caller);
    const parsed = batchSchema.safeParse(input);
    check(
      parsed.success,
      'invalid_stream',
      'A stream batch names its host, the log bytes it read and their events',
    );
    const batch = parsed.data;
    const head = async (tx: Transaction) => {
      const row = await tx.get<{ seq: number | string; until: number | string }>(
        'SELECT seq,until FROM session_events WHERE session_id=? ORDER BY seq DESC LIMIT 1',
        batch.sessionId,
      );
      return { seq: Number(row?.seq ?? 0), until: Number(row?.until ?? 0) };
    };
    const held = await readFirst(this.state, async (tx) => {
      const session = await this.controlled(caller, batch.sessionId, batch.runnerId, tx);
      check(
        session.hostRef !== null && session.hostRef === batch.hostRef,
        'host_conflict',
        'A stream must name the attached host',
        409,
      );
      check(
        live(session) || Date.parse(session.closedAt ?? '') + STREAM_GRACE_MS > this.clock(),
        'stream_closed',
        'The session has ended; its stream is closed',
        409,
      );
      return await head(tx);
    });
    if (batch.from < held.until || !batch.events.length) return held;
    const taken = await this.state.transaction(async (tx) => {
      // Read again under the writer lock: a retry that raced this one was added once.
      const { seq, until } = await head(tx);
      if (batch.from < until) return { until, seq };
      await tx.run(
        `INSERT INTO session_events(session_id,seq,at,until,event)
          SELECT ?,CAST(? AS BIGINT)+e.n,?,?,e.value FROM jsonb_array_elements(CAST(? AS JSONB)) WITH ORDINALITY AS e(value,n)`,
        batch.sessionId,
        seq,
        isoNow(this.clock),
        batch.to,
        JSON.stringify(batch.events),
      );
      return { until: batch.to, seq: seq + batch.events.length };
    });
    for (const wake of this.readers.get(batch.sessionId) ?? []) wake();
    return taken;
  }

  /**
   * An operator's read of one session of the caller's project: whether its stream may still
   * grow. A leased worker, a managed runner and anyone short of operator are refused.
   */
  async authorize(caller: Caller, sessionId: string): Promise<{ growing: boolean }> {
    caller = structuredClone(caller);
    check(
      !caller.session && !caller.managed,
      'forbidden',
      'Only a person reads an agent’s stream',
      403,
    );
    const actor = await this.state.snapshotTransaction((tx) =>
      this.scope.require(caller, 'read', tx),
    );
    check(actor.role === 'operator', 'forbidden', 'Only an operator reads an agent’s stream', 403);
    return { growing: await this.growing(sessionId, caller.projectId) };
  }

  /**
   * Whether an authorized session's stream may still grow. A session's close is recorded once,
   * with its usage, so its time is read there rather than from the session's JSON.
   */
  async growing(sessionId: string, projectId: string): Promise<boolean> {
    const row = await this.state.read((sql) =>
      sql.get<{ status: Session['status']; closed_at: string | null }>(
        `SELECT s.status,u.closed_at FROM worker_sessions s LEFT JOIN session_usage u ON u.session_id=s.id
          WHERE s.id=? AND s.project_id=?`,
        sessionId,
        projectId,
      ),
    );
    check(row, 'session_not_found', 'Session not found', 404);
    return live(row) || Date.parse(row.closed_at ?? '') + STREAM_GRACE_MS > this.clock();
  }

  /** The events after `after`, at most `limit`, oldest first. */
  async after(sessionId: string, after: number, limit: number): Promise<AgentStreamEvent[]> {
    return (
      await this.state.read((sql) =>
        sql.all<Row>(
          `SELECT seq,at,event::text AS event FROM session_events WHERE session_id=? AND seq>? ORDER BY seq LIMIT ${limit}`,
          sessionId,
          after,
        ),
      )
    ).map(view);
  }

  /** The newest events, oldest first, within SNAPSHOT_EVENTS and SNAPSHOT_BYTES. */
  async snapshot(sessionId: string): Promise<AgentStreamEvent[]> {
    return (
      await this.state.read((sql) =>
        sql.all<Row>(
          `SELECT seq,at,event FROM (SELECT seq,at,event,SUM(length(event)+64) OVER (ORDER BY seq DESC) AS bytes
            FROM (SELECT seq,at,event::text AS event FROM session_events WHERE session_id=? ORDER BY seq DESC LIMIT ${SNAPSHOT_EVENTS}) t) b
            WHERE bytes<=${SNAPSHOT_BYTES} ORDER BY seq`,
          sessionId,
        ),
      )
    ).map(view);
  }

  /** `wake` runs on each batch this process takes for the session; a reader slot is taken. */
  subscribe(sessionId: string, wake: () => void): () => void {
    const readers = this.readers.get(sessionId) ?? new Set();
    check(this.open < READERS && readers.size < READERS_PER_SESSION, 'stream_busy', busy, 429);
    readers.add(wake);
    this.readers.set(sessionId, readers);
    this.open++;
    return () => {
      if (!readers.delete(wake)) return;
      this.open--;
      if (!readers.size) this.readers.delete(sessionId);
    };
  }

  /**
   * The sweep's: the events of sessions that ended over 30 days ago, a hundred sessions at a
   * time. They are chosen among ended sessions, never among the oldest events, which a session
   * still live, or ended lately, could fill and so keep every other one's events.
   */
  async prune(): Promise<void> {
    const cutoff = isoNow(() => this.clock() - RETAIN_MS);
    await readFirst(this.state, async (tx) => {
      const ended = await tx.all<{ id: string }>(
        `SELECT s.id FROM worker_sessions s WHERE s.status IN ('released','expired')
          AND (s.session_json::jsonb #>> '{closedAt}')<?
          AND EXISTS (SELECT 1 FROM session_events e WHERE e.session_id=s.id) LIMIT 100`,
        cutoff,
      );
      if (ended.length)
        await tx.run(
          `DELETE FROM session_events WHERE session_id IN (${ended.map(() => '?').join(',')})`,
          ...ended.map((row) => row.id),
        );
    });
  }
}

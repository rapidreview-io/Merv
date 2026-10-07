import { z } from 'zod';
import { check, type Caller, type Scope, type State, type Transaction } from '@merv/contracts';
import { AGENT_EVENT_TEXT, type AgentEvent, type AgentStreamEvent } from './agent-stream.js';
import { isoNow, live, readFirst } from './common.js';
import { readsAgents } from './rules.js';
import { postgresMigrations } from './stream.postgres.js';
import type { LiveFeedFrame, Session, SessionStreamBatch, SessionStreamReads } from './types.js';

/** How long after its session closed a stream still takes the agent's last words. */
const STREAM_GRACE_MS = 10 * 60_000;
const RETAIN_MS = 30 * 86_400_000;
/** What a page is sent first: the newest events, at most this many or this many bytes. */
const SNAPSHOT_EVENTS = 500;
const SNAPSHOT_BYTES = 2_000_000;
const READERS_PER_SESSION = 8;
const READERS = 256;
/** Pages reading one project's live feed at once. */
const FEED_READERS = 16;
/** The live visits a feed follows, newest first. */
const FEED_VISITS = 48;
/** The newest events a frame reads of one visit; a visit further ahead than this starts over. */
const FEED_READ = 200;
/** The events, pieces of one block joined, a frame sends of one visit. */
const FEED_KEEP = 24;
/** What a feed event keeps: the end of a text, the start of a tool's input and answer. */
const FEED_TEXT = 1200;
const FEED_INPUT = 400;
const FEED_OUTPUT = 200;
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
  private readonly feeds = new Map<string, Set<() => void>>();
  private open = 0;
  /** The last session the sweep looked at: the next sweep goes on after it. */
  private pruned = '';
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
    let projectId = '';
    const held = await readFirst(this.state, async (tx) => {
      const session = await this.controlled(caller, batch.sessionId, batch.runnerId, tx);
      projectId = session.projectId;
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
    for (const wake of this.feeds.get(projectId) ?? []) wake();
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
    check(readsAgents(actor.role), 'forbidden', 'Only an operator reads an agent’s stream', 403);
    return { growing: await this.growing(sessionId, caller.projectId) };
  }

  /**
   * Whether an authorized session's stream may still grow. A session's close is recorded once,
   * with its usage, so its time is read there rather than from the session's JSON.
   */
  async growing(sessionId: string, projectId: string): Promise<boolean> {
    const row = await this.state.read((sql) =>
      sql.get<{ status: Session['status']; closed_at: string | null }>(
        // An inquiry visit records no usage row: its close is read from its own.
        `SELECT s.status,COALESCE(u.closed_at,s.session_json::jsonb->>'closedAt') AS closed_at
          FROM worker_sessions s LEFT JOIN session_usage u ON u.session_id=s.id
          WHERE s.id=? AND s.project_id=?`,
        sessionId,
        projectId,
      ),
    );
    check(row, 'session_not_found', 'Session not found', 404);
    return live(row) || Date.parse(row.closed_at ?? '') + STREAM_GRACE_MS > this.clock();
  }

  /** The project's live feed is an operator's, as each agent's stream is. */
  async authorizeFeed(caller: Caller): Promise<void> {
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
    check(readsAgents(actor.role), 'forbidden', 'Only an operator reads an agent’s stream', 403);
  }

  subscribeFeed(projectId: string, wake: () => void): () => void {
    const readers = this.feeds.get(projectId) ?? new Set();
    check(this.open < READERS && readers.size < FEED_READERS, 'stream_busy', busy, 429);
    readers.add(wake);
    this.feeds.set(projectId, readers);
    this.open++;
    return () => {
      if (!readers.delete(wake)) return;
      this.open--;
      if (!readers.size) this.feeds.delete(projectId);
    };
  }

  /**
   * One frame of the project's feed: the live visits, and each one's events past what `held`
   * says the page holds, read in one statement for them all. A visit new to the page, or one
   * that said more than FEED_READ since, is sent its newest events alone and starts over. A
   * thread's card shows its work: an inquiry visit's lines only while no work visit is live.
   */
  async feed(projectId: string, held: Map<string, number>): Promise<LiveFeedFrame | null> {
    const live = (
      await this.state.read((sql) =>
        sql.all<{ id: string; thread_id: string }>(
          `SELECT id,thread_id FROM worker_sessions s WHERE project_id=? AND status IN ('offered','active')
            AND thread_id IS NOT NULL AND (kind='work' OR NOT EXISTS (SELECT 1 FROM worker_sessions w
              WHERE w.thread_id=s.thread_id AND w.kind='work' AND w.status IN ('offered','active')))
            ORDER BY _merv_rowid DESC LIMIT ${FEED_VISITS}`,
          projectId,
        ),
      )
    ).map((row) => ({ sessionId: row.id, threadId: row.thread_id }));
    const ids = new Set(live.map((visit) => visit.sessionId));
    let changed = false;
    for (const id of [...held.keys()])
      if (!ids.has(id)) {
        held.delete(id);
        changed = true;
      }
    const rows = live.length
      ? await this.state.read((sql) =>
          sql.all<Row & { session_id: string }>(
            `SELECT c.id AS session_id,e.seq,e.at,e.event FROM (VALUES ${live.map(() => '(?,CAST(? AS BIGINT))').join(',')}) c(id,after)
              CROSS JOIN LATERAL (SELECT seq,at,jsonb_strip_nulls(jsonb_build_object('kind',x.event->>'kind','id',x.event->>'id',
                  'name',x.event->>'name','done',x.event->'done','error',x.event->'error',
                  'delta',right(x.event->>'delta',${FEED_TEXT}),'text',left(x.event->>'text',${FEED_INPUT}),
                  'input',left(x.event->>'input',${FEED_INPUT}),'output',left(x.event->>'output',${FEED_OUTPUT})))::text AS event
                FROM session_events x WHERE x.session_id=c.id AND x.seq>c.after ORDER BY x.seq DESC LIMIT ${FEED_READ + 1}) e`,
            ...live.flatMap((visit) => [visit.sessionId, held.get(visit.sessionId) ?? 0]),
          ),
        )
      : [];
    const visits: LiveFeedFrame['visits'] = [];
    for (const visit of live) {
      const own = rows
        .filter((row) => row.session_id === visit.sessionId)
        .map(view)
        .sort((a, b) => a.seq - b.seq);
      const fresh = !held.has(visit.sessionId);
      const reset = fresh || own.length > FEED_READ;
      if (own.length) held.set(visit.sessionId, own.at(-1)!.seq);
      else if (fresh) held.set(visit.sessionId, 0);
      if (!own.length && !fresh) continue;
      changed = true;
      visits.push({
        ...visit,
        ...(reset && { reset: true as const }),
        events: tail(reset ? own.slice(-FEED_READ) : own),
      });
    }
    return changed ? { live, visits } : null;
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
   * The sweep's: the events of sessions that ended over 30 days ago. Each sweep looks at the
   * next hundred sessions that still hold events, in id order from where the last one stopped
   * and from the start again after the last, a step along the events' own key each; so it
   * never reads the sessions whose events are gone, and a session still live, or ended
   * lately, is only one it passes over.
   */
  async prune(): Promise<void> {
    const cutoff = isoNow(() => this.clock() - RETAIN_MS);
    const after = this.pruned;
    this.pruned = await readFirst(this.state, async (tx) => {
      const held = await tx.all<{ id: string }>(
        `WITH RECURSIVE held(id) AS (
            (SELECT session_id FROM session_events WHERE session_id>? ORDER BY session_id LIMIT 1)
            UNION ALL
            SELECT (SELECT e.session_id FROM session_events e WHERE e.session_id>held.id
              ORDER BY e.session_id LIMIT 1) FROM held WHERE held.id IS NOT NULL)
          SELECT id FROM held WHERE id IS NOT NULL LIMIT 100`,
        after,
      );
      if (!held.length) return '';
      const ended = await tx.all<{ id: string }>(
        `SELECT id FROM worker_sessions WHERE id IN (${held.map(() => '?').join(',')})
          AND status IN ('released','expired') AND (session_json::jsonb #>> '{closedAt}')<?`,
        ...held.map((row) => row.id),
        cutoff,
      );
      if (ended.length)
        await tx.run(
          `DELETE FROM session_events WHERE session_id IN (${ended.map(() => '?').join(',')})`,
          ...ended.map((row) => row.id),
        );
      return held.length < 100 ? '' : held.at(-1)!.id;
    });
  }
}

/**
 * The newest FEED_KEEP events of a run, the pieces of one block that follow each other joined
 * into one event under the last piece's number, its text cut to its end again.
 */
function tail(events: AgentStreamEvent[]): AgentStreamEvent[] {
  const joined: AgentStreamEvent[] = [];
  for (const item of events) {
    const last = joined.at(-1);
    const { event } = item;
    if (
      last &&
      (event.kind === 'text' || event.kind === 'thinking') &&
      last.event.kind === event.kind &&
      last.event.id === event.id
    ) {
      const delta = (last.event.delta + event.delta).slice(-FEED_TEXT);
      joined[joined.length - 1] = {
        seq: item.seq,
        at: item.at,
        event: { ...last.event, delta, ...(event.done && { done: true }) },
      };
    } else joined.push(item);
  }
  return joined.slice(-FEED_KEEP);
}

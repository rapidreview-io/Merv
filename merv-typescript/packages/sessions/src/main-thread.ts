/**
 * A person's main thread in a project: the one conversation their own agent continues on their
 * Mac and Merv's agent (Pi) continues when the Mac is away. The thread is this log, not either
 * engine's transcript: each engine's native session is only a cache of it.
 *
 * One lease says who may append. The Mac takes and renews it with each `sync`, which appends its
 * finished turns; its number only goes up, and moves on whenever the holder changes, so a Mac
 * that names the number it held is refused once the thread has moved on. Once the Mac's lease has
 * run out, a message from the web or a phone (`say`) is answered here by the turn Pi registers,
 * on Merv's keys, and appended. Each native session has a delivery receipt: `sync` hands it only
 * the items after it that it has not been given or written itself, and never the same one twice.
 *
 * Nothing here starts work on a Mac, and no credential of the person's agent ever reaches it.
 */
import type { Context } from 'cordis';
import { z } from 'zod';
import {
  MervError,
  check,
  digest,
  inTransaction,
  type Caller,
  type Migration,
  type Scope,
  type State,
  type Transaction,
} from '@merv/contracts';
import type {} from '@merv/api/types';
import type {} from '@merv/ui/types';

/** The Mac renews every 20 seconds; a lease this old means it is away. */
export const MAC_LEASE_MS = 90_000;
/** Long enough for one answer. A Mac that returns meanwhile waits for it. */
const PI_LEASE_MS = 120_000;
const TEXT = 256_000;
/** Items one sync returns unless it asks for up to 200; `more` says there are others. */
const PAGE = 12;
/** The most words one sync returns, whatever its limit (always at least one item). */
const SYNC_BYTES = 1 << 20;

/**
 * Step A of the move from the Pi plugin's tables: the thread, its items and its lease are copied
 * (each item keeps its sequence number); `pi_main_*` stay, so the previous server still starts.
 * The Pi plugin's experiment cards are not copied: jobs replace them.
 */
export const mainThreadMigrations: Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE session_main_threads (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, person TEXT NOT NULL,
  holder TEXT CHECK (holder IN ('mac','pi')), device TEXT,
  number BIGINT NOT NULL DEFAULT 0, expires_at BIGINT NOT NULL DEFAULT 0,
  UNIQUE (project_id, person)
);
CREATE TABLE session_main_items (
  thread_id TEXT NOT NULL REFERENCES session_main_threads(id), seq BIGINT NOT NULL,
  local_id TEXT NOT NULL, engine TEXT NOT NULL, native_session TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('person','answer','ready')),
  words TEXT NOT NULL, request_id TEXT, lease BIGINT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (thread_id, seq), UNIQUE (thread_id, local_id)
);
CREATE TABLE session_main_deliveries (
  thread_id TEXT NOT NULL REFERENCES session_main_threads(id), engine TEXT NOT NULL,
  native_session TEXT NOT NULL, through_seq BIGINT NOT NULL,
  PRIMARY KEY (thread_id, engine, native_session)
);
DO $copy$
BEGIN
  IF to_regclass('pi_main_items') IS NOT NULL THEN
    INSERT INTO session_main_threads (id, project_id, person, holder, device, number, expires_at)
    SELECT 'mth_' || md5(k.project_id || '/' || k.person), k.project_id, k.person, l.holder, l.device,
      COALESCE(l.number, 0), COALESCE(l.expires_at, 0)
    FROM (SELECT project_id, person FROM pi_main_items UNION SELECT project_id, person FROM pi_main_leases) k
    LEFT JOIN pi_main_leases l ON l.project_id = k.project_id AND l.person = k.person;
    INSERT INTO session_main_items (thread_id, seq, local_id, engine, kind, words, request_id, lease, created_at)
    SELECT t.id, i.seq, i.local_id, i.engine, i.kind, i.words, i.request_id, i.lease, i.created_at
    FROM pi_main_items i JOIN session_main_threads t ON t.project_id = i.project_id AND t.person = i.person;
  END IF;
END $copy$;`,
  },
];

const words = z.string().min(1).max(TEXT);
const macItem = z
  .object({
    localId: z.string().min(1).max(300),
    requestId: z.string().max(200).optional(),
    kind: z.enum(['person', 'answer']),
    text: words,
    /** The native session that wrote it, which is never given it back (else `native.session`). */
    native: z.string().min(1).max(300).optional(),
  })
  .strict();
export const syncInput = z
  .object({
    /** This Mac, as it names itself: a second Mac takes the lease over. */
    device: z.string().min(1).max(100),
    engine: z.enum(['claude', 'codex']),
    items: z.array(macItem).max(12).default([]),
    /** Without `native`: the last cloud item this Mac has kept. */
    after: z.number().int().min(0).default(0),
    /** The lease number this Mac holds: its items are refused (lease_stale) once the thread has
     *  another. A Mac that sends none is not checked. */
    lease: z.number().int().min(0).optional(),
    /** The native session given the reply: its delta, the items after its receipt (or `through`,
     *  what it already has) that it neither wrote nor was given before; it also tags the items
     *  sent without their own `native`. A heartbeat that delivers nothing leaves it out. */
    native: z
      .object({
        session: z.string().min(1).max(300),
        through: z.number().int().min(0).default(0),
      })
      .strict()
      .optional(),
    /** Items the reply holds at most (default 12), within 1 MiB of words. */
    limit: z.number().int().min(1).max(200).default(PAGE),
    /** Ignored: an older Mac's experiment cards, which jobs replace. */
    cards: z.array(z.unknown()).max(20).optional(),
    /** The Mac is quitting or going to sleep: its hold ends now, so Merv cloud may answer at once. */
    release: z.boolean().optional(),
  })
  .strict();
export const sayInput = z
  .object({ text: words.max(20_000), requestId: z.string().min(1).max(200) })
  .strict();
export const pageInput = z
  .object({
    before: z.number().int().positive().optional(),
    /** The items after this sequence, oldest first, instead of the newest: a read that takes
     *  no lease. */
    after: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(200).default(60),
  })
  .strict();

export interface MainItem {
  seq: number;
  engine: string;
  kind: 'person' | 'answer' | 'ready';
  text: string;
  at: string;
  requestId?: string;
}
type Row = {
  seq: number | string;
  engine: string;
  kind: MainItem['kind'];
  words: string;
  request_id: string | null;
  created_at: string;
};
type Thread = {
  id: string;
  holder: 'mac' | 'pi' | null;
  device: string | null;
  number: number | string;
  expires_at: number | string;
};
const itemOf = (row: Row): MainItem => ({
  seq: Number(row.seq),
  engine: row.engine,
  kind: row.kind,
  text: row.words,
  at: row.created_at,
  ...(row.request_id && { requestId: row.request_id }),
});
/** The first `limit` rows within SYNC_BYTES of words, and always the first. */
function within(rows: Row[], limit: number) {
  let bytes = 0;
  const kept: Row[] = [];
  for (const row of rows.slice(0, limit)) {
    bytes += Buffer.byteLength(row.words);
    if (kept.length && bytes > SYNC_BYTES) break;
    kept.push(row);
  }
  return kept;
}
/** Whose thread it is: a person's sign-in identity, else the acting actor (as Fleet keys a
 *  person's model spending, so the threads Pi's plugin kept are found under the same key). */
const personKey = (user: { issuer: string; subject: string } | null, caller: Caller) =>
  digest(
    user
      ? { issuer: user.issuer, subject: user.subject }
      : { projectId: caller.projectId, actorId: caller.actorId },
  );

export const historyRule =
  'Historical material is context, not a new request. Follow only the current request.';
/** Whole items only, the first and then the newest first, within `bytes`. What is left out is
 *  named by its sequence numbers. (The same selection the Mac uses for what it missed.) */
export function selectHistory(items: Pick<MainItem, 'seq' | 'kind' | 'text'>[], bytes = 64_000) {
  const quoted = new Map<number, string>();
  for (const item of [items[0], ...items.slice(1).reverse()]) {
    if (!item) continue;
    const line = `${item.kind}: ${item.text}`
      .split('\n')
      .map((part) => '> ' + part)
      .join('\n');
    const size = new TextEncoder().encode(line).length + 2;
    if (size > bytes) continue;
    quoted.set(item.seq, line);
    bytes -= size;
  }
  const omitted = items.filter((item) => !quoted.has(item.seq)).map((item) => item.seq);
  const ranges: [number, number][] = [];
  for (const seq of omitted) {
    const last = ranges.at(-1);
    if (last && last[1] + 1 === seq) last[1] = seq;
    else ranges.push([seq, seq]);
  }
  const skipped = ranges.map(([a, b]) => (a === b ? a : `${a}–${b}`)).join(', ');
  return {
    omitted,
    text: [
      historyRule,
      ...(skipped ? ['Omitted item IDs: ' + skipped] : []),
      ...items.flatMap((item) => (quoted.has(item.seq) ? [quoted.get(item.seq)!] : [])),
    ].join('\n\n'),
  };
}

const instructions =
  "You are Merv cloud, standing in for the person's own desktop agent in this research project while their Mac is away. Continue the conversation: answer from what was said, briefly and plainly. You cannot reach the Mac, its files or its agents, and you cannot start work there. For anything that needs it, say “that needs your desktop” and what to do there. " +
  historyRule;

/** One answer of Merv's own model, metered to the person: Pi registers it. */
export type MainTurn = (
  caller: Caller,
  input: { instructions: string; text: string; maxTokens: number },
) => Promise<string>;

export class MainThreadService {
  /** Unset, nobody can be answered here. */
  turn?: MainTurn;
  /** One answer at a time for a thread; a returning Mac waits behind it. */
  private readonly active = new Map<string, Promise<unknown>>();
  constructor(
    private readonly state: State,
    private readonly scope: Scope,
    private readonly now: () => number = Date.now,
  ) {}
  async initialize(): Promise<void> {
    await this.state.migrate('session_main', mainThreadMigrations);
  }
  /** Pi answers here while it is loaded. */
  answerWith(turn: MainTurn) {
    this.turn = turn;
    return () => void (this.turn === turn && (this.turn = undefined));
  }

  /** The person this caller acts for: a signed-in person or their own key, never a worker. */
  private async person(caller: Caller, tx: Transaction): Promise<string> {
    check(
      !caller.session && !caller.managed && !caller.conversation,
      'forbidden',
      'Only a person or their own Mac reaches their main thread',
      403,
    );
    const actor = await this.scope.require(caller, 'read', tx);
    return personKey(actor.user ?? null, caller);
  }
  /** The person's thread; a writer creates it and holds it until it commits. */
  private async thread(tx: Transaction, projectId: string, person: string, write = false) {
    if (write)
      await tx.run(
        `INSERT INTO session_main_threads (id, project_id, person) VALUES ('mth_' || md5(? || '/' || ?), ?, ?)
         ON CONFLICT (project_id, person) DO NOTHING`,
        projectId,
        person,
        projectId,
        person,
      );
    return await tx.get<Thread>(
      `SELECT id, holder, device, number, expires_at FROM session_main_threads WHERE project_id=? AND person=?${write ? ' FOR UPDATE' : ''}`,
      projectId,
      person,
    );
  }
  private held(thread: Thread | undefined, holder: 'mac' | 'pi') {
    return thread?.holder === holder && Number(thread.expires_at) > this.now();
  }
  /** Takes or renews the lease: its number moves on only when another holder takes it. */
  private async take(tx: Transaction, thread: Thread, holder: 'mac' | 'pi', device: string) {
    const same = thread.holder === holder && thread.device === device;
    const number = Number(thread.number) + (same ? 0 : 1);
    await tx.run(
      'UPDATE session_main_threads SET holder=?, device=?, number=?, expires_at=? WHERE id=?',
      holder,
      device,
      number,
      this.now() + (holder === 'mac' ? MAC_LEASE_MS : PI_LEASE_MS),
      thread.id,
    );
    return { number, from: same ? null : thread.holder };
  }
  private async append(
    tx: Transaction,
    thread: string,
    lease: number,
    item: {
      localId: string;
      engine: string;
      native?: string;
      kind: MainItem['kind'];
      text: string;
      requestId?: string;
    },
  ) {
    await tx.run(
      `INSERT INTO session_main_items (thread_id, seq, local_id, engine, native_session, kind, words, request_id, lease, created_at)
       SELECT ?,COALESCE(MAX(seq),0)+1,?,?,?,?,?,?,?,? FROM session_main_items WHERE thread_id=?
       ON CONFLICT (thread_id, local_id) DO NOTHING`,
      thread,
      item.localId,
      item.engine,
      item.native ?? null,
      item.kind,
      item.text,
      item.requestId ?? null,
      lease,
      new Date(this.now()).toISOString(),
      thread,
    );
  }
  private async serial<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.active.get(key);
    const pending = previous ? previous.catch(() => {}).then(run) : run();
    this.active.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.active.get(key) === pending) this.active.delete(key);
    }
  }

  /** The Mac's heartbeat: it takes or renews the lease, appends its finished turns, and reads
   *  what it has not seen. A retry of the same items writes nothing twice. */
  async sync(caller: Caller, input: unknown) {
    const { device, engine, items, after, lease, native, limit, release } = syncInput.parse(input);
    caller = structuredClone(caller);
    const wait = await inTransaction(this.state, undefined, async (tx) =>
      JSON.stringify([caller.projectId, await this.person(caller, tx)]),
    );
    // An answer already being written finishes before the Mac takes the thread back.
    await this.active.get(wait)?.catch(() => {});
    return await inTransaction(this.state, undefined, async (tx) => {
      const person = await this.person(caller, tx);
      const thread = (await this.thread(tx, caller.projectId, person, true))!;
      // An old lease never appends: the thread moved on while this Mac was away.
      if (lease !== undefined && items.length && lease !== Number(thread.number))
        throw new MervError(
          'lease_stale',
          `The thread has moved on to lease ${thread.number}: read what you missed, then send these again.`,
          409,
          { lease: Number(thread.number) },
        );
      const taken = await this.take(tx, thread, 'mac', device);
      if (taken.from === 'pi') {
        const last = await tx.get<Row>(
          'SELECT * FROM session_main_items WHERE thread_id=? ORDER BY seq DESC LIMIT 1',
          thread.id,
        );
        if (last?.engine === 'pi' && last.kind === 'answer')
          await this.append(tx, thread.id, taken.number, {
            localId: 'ready:' + last.seq,
            engine,
            kind: 'ready',
            text: 'Your desktop is ready',
          });
      }
      for (const item of items)
        await this.append(tx, thread.id, taken.number, {
          ...item,
          localId: 'mac:' + item.localId,
          engine,
          native: item.native ?? native?.session,
        });
      let rows: Row[];
      let kept: Row[];
      let through: number | undefined;
      if (native) {
        // Its receipt only goes up: what was given once is never given again.
        const receipt = [thread.id, engine, native.session] as const;
        const seen = await tx.get<{ through_seq: number | string }>(
          'SELECT through_seq FROM session_main_deliveries WHERE thread_id=? AND engine=? AND native_session=?',
          ...receipt,
        );
        const from = Math.max(Number(seen?.through_seq ?? 0), native.through);
        rows = await tx.all<Row>(
          `SELECT * FROM session_main_items WHERE thread_id=? AND seq>? AND NOT (engine=? AND native_session IS NOT DISTINCT FROM ?)
           ORDER BY seq LIMIT ?`,
          thread.id,
          from,
          engine,
          native.session,
          limit + 1,
        );
        kept = within(rows, limit);
        through = Math.max(from, ...kept.map((row) => Number(row.seq)));
        await tx.run(
          `INSERT INTO session_main_deliveries (thread_id, engine, native_session, through_seq) VALUES (?,?,?,?)
           ON CONFLICT (thread_id, engine, native_session) DO UPDATE SET through_seq=excluded.through_seq`,
          ...receipt,
          through,
        );
      } else {
        rows = await tx.all<Row>(
          `SELECT * FROM session_main_items WHERE thread_id=? AND seq>? AND (engine='pi' OR kind='ready')
           ORDER BY seq LIMIT ?`,
          thread.id,
          after,
          limit + 1,
        );
        kept = within(rows, limit);
      }
      if (release)
        await tx.run(
          'UPDATE session_main_threads SET expires_at=? WHERE id=?',
          this.now(),
          thread.id,
        );
      return {
        thread: thread.id,
        lease: taken.number,
        renewMs: 20_000,
        items: kept.map(itemOf),
        more: rows.length > kept.length,
        ...(through !== undefined && { through }),
      };
    });
  }

  /** The thread as a page reads it, oldest first, and who has it now. */
  async page(caller: Caller, input: unknown) {
    const { before, after, limit } = pageInput.parse(input ?? {});
    return await inTransaction(this.state, undefined, async (tx) => {
      const thread = await this.thread(tx, caller.projectId, await this.person(caller, tx));
      const rows = thread
        ? await tx.all<Row>(
            `SELECT * FROM session_main_items WHERE thread_id=? AND seq<? AND seq>?
             ORDER BY seq ${after === undefined ? 'DESC' : 'ASC'} LIMIT ?`,
            thread.id,
            before ?? Number.MAX_SAFE_INTEGER,
            after ?? 0,
            limit + 1,
          )
        : [];
      const items = rows.slice(0, limit).map(itemOf);
      return {
        thread: thread?.id ?? null,
        items: after === undefined ? items.reverse() : items,
        more: rows.length > limit,
        /** `mac`: their own agent has the thread. `cloud`: Merv answers here. */
        engine: this.held(thread, 'mac') ? ('mac' as const) : ('cloud' as const),
        available: !!this.turn,
      };
    });
  }

  /** The person's words from the web or a phone. With the Mac away, Merv cloud answers from the
   *  thread and both are appended; with the Mac here, the Mac has the thread and this is refused. */
  async say(caller: Caller, input: unknown): Promise<{ person: MainItem; answer: MainItem }> {
    const { text, requestId } = sayInput.parse(input);
    caller = structuredClone(caller);
    const person = await inTransaction(this.state, undefined, (tx) => this.person(caller, tx));
    const local = 'person:' + requestId;
    const said = (tx: Transaction, thread: string) =>
      tx.all<Row>(
        'SELECT * FROM session_main_items WHERE thread_id=? AND local_id IN (?,?) ORDER BY seq',
        thread,
        local,
        'answer:' + requestId,
      );
    return await this.serial(JSON.stringify([caller.projectId, person]), async () => {
      const start = await inTransaction(this.state, undefined, async (tx) => {
        const thread = (await this.thread(tx, caller.projectId, person, true))!;
        const before = await said(tx, thread.id);
        if (before.length) {
          check(
            before[0]!.words === text,
            'request_conflict',
            'This message ID already belongs to another message',
            409,
          );
          check(before.length === 2, 'conflict', 'That message is still being answered', 409);
          return { done: before };
        }
        check(
          !this.held(thread, 'mac'),
          'desktop_here',
          'Your desktop has this conversation. Write to it there.',
          409,
        );
        check(this.turn, 'pi_unavailable', 'Merv cloud is unavailable', 503);
        const taken = await this.take(tx, thread, 'pi', 'cloud');
        const history = await tx.all<Row>(
          "SELECT * FROM session_main_items WHERE thread_id=? AND kind<>'ready' ORDER BY seq",
          thread.id,
        );
        return { thread: thread.id, lease: taken.number, history: history.map(itemOf) };
      });
      if ('done' in start)
        return { person: itemOf(start.done![0]!), answer: itemOf(start.done![1]!) };
      const answer = (
        await this.turn!(caller, {
          instructions,
          text: selectHistory(start.history).text + '\n\nCurrent request:\n' + text,
          maxTokens: 2400,
        })
      ).trim();
      check(answer, 'pi_unavailable', 'Merv cloud could not answer. Try again.', 503);
      return await inTransaction(this.state, undefined, async (tx) => {
        await this.person(caller, tx);
        const thread = (await this.thread(tx, caller.projectId, person, true))!;
        // The thread moved while this was being written: an old lease number never appends.
        check(
          thread.holder === 'pi' && Number(thread.number) === start.lease,
          'desktop_here',
          'Your desktop took this conversation back. Ask it there.',
          409,
        );
        const at = { localId: local, engine: 'pi', kind: 'person' as const, text, requestId };
        await this.append(tx, thread.id, start.lease, at);
        await this.append(tx, thread.id, start.lease, {
          localId: 'answer:' + requestId,
          engine: 'pi',
          kind: 'answer',
          text: answer.slice(0, TEXT),
        });
        // Answered: the Mac may have the thread back at once.
        await tx.run(
          'UPDATE session_main_threads SET expires_at=? WHERE id=?',
          this.now(),
          thread.id,
        );
        const rows = await said(tx, thread.id);
        return { person: itemOf(rows[0]!), answer: itemOf(rows[1]!) };
      });
    });
  }
}

declare module 'cordis' {
  interface Context {
    mainThread: MainThreadService;
  }
}

export const mainThreadPlugin = {
  name: 'merv-sessions-main-thread',
  inject: ['state', 'scope', 'tools'],
  async apply(ctx: Context) {
    const service = new MainThreadService(ctx.state, ctx.scope);
    await service.initialize();
    ctx.provide('mainThread', service);
    ctx.inject(['ui'], (part) => {
      part.effect(() =>
        part.ui.register({
          id: 'main',
          label: 'Main thread',
          group: 'operations',
          order: 1,
          path: '/main',
          view: { kind: 'main' },
        }),
      );
    });
    ctx.effect(() =>
      ctx.tools.noun('main.read', {
        // For Merv's own page and the person's Mac (POST /tools): never offered to an agent.
        tier: 'ui',
        readOnly: true,
        description:
          'Read your main thread in this project: the one conversation your own desktop agent and Merv cloud both continue. page (its items, oldest first, and who has it now).',
        actions: {
          page: {
            description:
              'Read the newest items of your main thread, or those before the sequence `before`, or with `after` those after that sequence, oldest first. It never takes the thread. `engine` says who answers now: your Mac, or Merv cloud while it is away.',
            input: pageInput,
            handler: async (caller, input) => await service.page(caller, input),
          },
        },
      }),
    );
    ctx.effect(() =>
      ctx.tools.noun('main.write', {
        tier: 'ui',
        description:
          'Continue your main thread: say (your words from the web or a phone, answered by Merv cloud while your Mac is away) and sync (your own Mac only: its finished turns, and what it missed).',
        actions: {
          say: {
            description:
              'Say something in your main thread from the web or a phone. While your Mac is away Merv cloud answers from the conversation so far; while it is here this is refused (desktop_here). An identical requestId retry returns the original answer.',
            input: sayInput,
            handler: async (caller, input) => await service.say(caller, input),
          },
          sync: {
            description:
              "Your own Mac's heartbeat: it renews the Mac's hold on the thread, appends its finished turns and returns what Merv cloud said after `after`; with `native`, what that native session has not seen, once (an item tagged with its own `native` is never given back to that session). `limit` up to 200 items within 1 MiB. With `lease`, its items are refused (lease_stale) once the thread has moved on. Not for agents.",
            input: syncInput,
            handler: async (caller, input) => await service.sync(caller, input),
          },
        },
      }),
    );
  },
};
export default mainThreadPlugin;

import {
  check,
  MervError,
  clip,
  freezeData,
  newId,
  type Blobs,
  type Caller,
  type DelegationSource,
  type Scope,
  type State,
  type Transaction,
} from '@merv/contracts';
import {
  AGENT_EVENT_TEXT,
  claudeEvents,
  codexEvents,
  readLine,
  type AgentEvent,
  type AgentStreamEvent,
} from './agent-stream.js';
import {
  attached,
  isoNow,
  live,
  ordinary,
  readFirst,
  safeError,
  text,
  threadIn,
} from './common.js';
import { messageInquiry, openInquiry } from './inquiries.js';
import { takesMessage, type Standing } from './messages.js';
import { leaseLiveness } from './liveness.js';
import { readsAgents } from './rules.js';
import { deliver, uploads } from './transcripts.js';
import type {
  ContinuityProvider,
  ContinuityUnit,
  InquiryStatus,
  ProjectThreads,
  Session,
  SessionContinuity,
  SessionControl,
  SessionConversationDeclaration,
  SessionResume,
  SessionStatus,
  SessionTranscript,
  ThreadConversation,
  ThreadCounts,
  ThreadView,
  VisitView,
  WorkerLineage,
} from './types.js';

type Row = {
  id: string;
  project_id: string;
  continuity_key: string | null;
  instance_id: string;
  state: string;
  role: string;
  actor_id: string;
  status: 'open' | 'dormant' | 'retired';
  harness: SessionResume['harness'] | null;
  conversation_id: string | null;
  sha256: string | null;
  size: number | string | null;
  uploaded_at: string | null;
  latest_session_id: string | null;
  /** The last delivered conversation (`SessionResume`), kept while a newer one is undelivered. */
  delivered_json: string | null;
};
/** One prefix per project, as transcripts have. */
const namespace = (projectId: string) => `conversations-${projectId}`;
/** How long a thread waits, dormant, for its work to come back to it. */
export const dormantMs = 14 * 86_400_000;
/** How many visits of one review round its step limit may cut before each further cut counts. */
const reviewVisits = 4;
/** What one conversation read sends: the newest events it has not sent, at most this many or
 *  bytes; and what it downloads of transcripts: as many bytes, in at most READ_GETS ranged GETs
 *  of at most CHUNK_BYTES each, or, while it holds no line it can send, to LINE_BYTES. */
const READ_EVENTS = 500;
const READ_BYTES = 2_000_000;
const READ_GETS = 8;
const CHUNK_BYTES = 1_000_000;
const LINE_BYTES = 16_000_000;
/** How long one ranged read of a transcript may take. */
const CHUNK_TIMEOUT_MS = 30_000;
/** What one read has left to send (`events`, `bytes`) and to download (`download`, `gets`). */
type Room = { events: number; bytes: number; download: number; gets: number };
const fullRoom = (): Room => ({
  events: READ_EVENTS,
  bytes: READ_BYTES,
  download: READ_BYTES,
  gets: READ_GETS,
});
/** The most work items one read of their threads names: a wave and every attempt's lenses. */
const LIST_INSTANCES = 100;
/** How many threads that want no attention a page of the project's threads holds. */
const PAGE = 50;
/** A thread one of whose work visits holds its lease (an inquiry visit holds none). */
const LIVE = `EXISTS (SELECT 1 FROM worker_sessions s WHERE s.thread_id=t.id AND s.status IN ('offered','active') AND s.kind='work')`;
/** A question to it (an inquiry) still waiting for a machine or being answered. */
const INQUIRING = `EXISTS (SELECT 1 FROM session_inquiries i WHERE i.thread_id=t.id AND ${openInquiry('i')})`;
/** A thread holding a person's message its agent has not read, where it is not retired. The
 *  context an answered inquiry left its work is not one: the person has read that answer. */
const UNREAD = `(t.status<>'retired' AND EXISTS (SELECT 1 FROM session_messages m WHERE m.thread_id=t.id
  AND m.acknowledged_at IS NULL AND m.inquiry_role IS NULL))`;

/**
 * Threads: continuing workers for one role, optionally spanning stages through a provider. A session is one visit
 * by its thread, with its own lease and credential; the thread holds the attribution actor every
 * visit acts as, the conversation they kept and whether it is open, dormant or retired.
 *
 * A session's continuity key is its workflow's provider's, else its instance, state and role, so
 * a reviewer never continues a producer. A reviewer's is its round's (instance, state, role and
 * revision): a visit cut before its verdict is continued, a verdict handed in retires it, and the
 * next round's reviewer starts fresh and retires the earlier rounds'. A key has at most one
 * thread that is not retired. An offer resumes it, with its actor and conversation, when it is
 * dormant, belongs to the same source and declared a conversation; otherwise the offer retires it
 * as superseded and opens a new one. A visit without a key retires its thread at close; a thread
 * that waited longer than `dormantMs`, or whose resume its harness could not take up, is retired.
 */
export class SessionThreads {
  /** Bound once, as Sessions is provided. */
  blobs!: Blobs;
  /** How many threads waiting for an answer one sweep pass reads, and where the last stopped. */
  askingPage = 100;
  private askingAfter = 0;
  private readonly conversationGrace = new Map<string, number>();
  private readonly providers = new Map<string, ContinuityProvider>();
  constructor(
    private state: State,
    private scope: Scope,
    private clock: () => number,
    private host: {
      controlled(caller: Caller, id: string, runnerId: string, tx: Transaction): Promise<Session>;
      /** Refuses a caller who may not read the work item. */
      readable(caller: Caller, instanceId: string, tx: Transaction): Promise<unknown>;
      /** A visit's kept stream as a page is first sent it, only its events before `before`
       *  where that is given. */
      stream(sessionId: string, before?: number): Promise<AgentStreamEvent[]>;
      /** Where these threads' questions stand (Messages.standing, the one rule). */
      standing(
        tx: Transaction,
        projectId: string,
        read?: { threads?: readonly string[]; instances?: readonly string[] },
      ): Promise<Standing>;
      /** Which of these threads' agents may not be asked now (Inquiries.refusals). */
      unaskable(
        projectId: string,
        threadIds: string[],
        tx: Transaction,
      ): Promise<Map<string, unknown>>;
      /** Refuses once Sessions has closed. */
      available(): void;
    },
  ) {}
  register(
    workflow: string,
    provider: ContinuityProvider,
    options?: { conversationGraceMs: number },
  ): () => void {
    this.host.available();
    check(
      !this.providers.has(workflow),
      'continuity_registered',
      'This workflow already has a continuity provider',
      409,
    );
    const grace = options?.conversationGraceMs ?? 0;
    check(
      Number.isSafeInteger(grace) && grace >= 0 && grace <= 300_000,
      'invalid_conversation_grace',
      'Conversation handoff grace must be 0–300000 milliseconds',
    );
    this.providers.set(workflow, provider);
    this.conversationGrace.set(workflow, grace);
    return () => {
      if (this.providers.get(workflow) === provider) {
        this.providers.delete(workflow);
        this.conversationGrace.delete(workflow);
      }
    };
  }
  key(unit: ContinuityUnit): string | null {
    // A review is read with fresh eyes each round: a reviewer never carries its earlier verdict,
    // but one cut before giving it (its step limit, a lost host, a release) goes on with it.
    if (unit.role === 'reviewer')
      return JSON.stringify([unit.instanceId, unit.state, unit.role, unit.revision]);
    const provider = this.providers.get(unit.workflow);
    if (!provider) return JSON.stringify([unit.instanceId, unit.state, unit.role]);
    const key = provider(freezeData(structuredClone(unit)));
    check(
      key === null || (typeof key === 'string' && key.length > 0 && key.length <= 512),
      'invalid_continuity_key',
      'A continuity key is 1–512 characters or null',
      500,
    );
    return key;
  }
  /**
   * The thread an offer's session visits: the key's own, resumed with its conversation, or a new
   * one with an actor of its own. A declared conversation may still be on its way: a runner that
   * cannot fetch it yet launches the same thread fresh.
   */
  async open(
    projectId: string,
    owner: { source: DelegationSource; hash: string },
    unit: ContinuityUnit,
    runnerId: string,
    tx: Transaction,
  ): Promise<{ id: string; actorId: string; continuity?: SessionContinuity }> {
    const key = this.key(unit),
      at = isoNow(this.clock);
    const held =
      key === null
        ? undefined
        : await tx.get<Row>(
            "SELECT * FROM session_threads WHERE project_id=? AND continuity_key=? AND status<>'retired'",
            projectId,
            key,
          );
    if (held) {
      const visits = await tx.all<{ owner_hash: string; live: boolean }>(
        // Its work visits: an inquiry visit holds neither the work nor the conversation.
        "SELECT owner_hash,bool_or(status IN ('offered','active')) AS live FROM worker_sessions WHERE thread_id=? AND kind='work' GROUP BY owner_hash",
        held.id,
      );
      // Transitions close visits before their runner can save the harness conversation. Give
      // an attached visit a bounded opportunity to deliver it, rather than superseding it or
      // freezing an older snapshot into the next offer. A dead runner cannot block forever.
      const grace = this.conversationGrace.get(unit.workflow) ?? 0;
      if (
        grace &&
        unit.role !== 'reviewer' &&
        visits.length === 1 &&
        visits[0]!.owner_hash === owner.hash &&
        !visits[0]!.live
      ) {
        const last = await tx.get<{
          id: string;
          closed_at: string | null;
          host_ref: string | null;
        }>(
          "SELECT id,closed_at,host_ref FROM worker_sessions WHERE thread_id=? AND kind='work' ORDER BY _merv_rowid DESC LIMIT 1",
          held.id,
        );
        if (
          last?.host_ref &&
          last.closed_at &&
          this.clock() < Date.parse(last.closed_at) + grace &&
          (held.latest_session_id !== last.id || held.uploaded_at === null)
        ) {
          const waiting = new MervError(
            'conversation_pending',
            'The previous visit is saving its conversation; retry shortly',
            409,
          );
          waiting.wait = true;
          throw waiting;
        }
      }
      // Sessions' choice, not the runner's: the thread may have run anywhere.
      if (
        held.sha256 !== null &&
        visits.length === 1 &&
        visits[0]!.owner_hash === owner.hash &&
        !visits[0]!.live
      ) {
        await this.scope.setThreadRole(owner.source, held.actor_id, unit.role, tx);
        // A key may span work items: the thread is now on this one, and takes its messages.
        await tx.run(
          "UPDATE session_threads SET status='open',instance_id=?,state=?,updated_at=? WHERE id=?",
          unit.instanceId,
          unit.state,
          at,
          held.id,
        );
        return {
          id: held.id,
          actorId: held.actor_id,
          continuity: { key: key!, resume: resumeOf(held) },
        };
      }
      await this.retire(held, 'superseded', tx);
    }
    // A new round's reviewer: the earlier rounds' reviewers of this stage are done with.
    if (unit.role === 'reviewer')
      for (const earlier of await tx.all<Row>(
        "SELECT * FROM session_threads WHERE project_id=? AND instance_id=? AND state=? AND role='reviewer' AND status<>'retired' AND continuity_key<>?",
        projectId,
        unit.instanceId,
        unit.state,
        key,
      ))
        await this.retire(earlier, 'superseded', tx);
    const id = newId('thr');
    const actor = await this.scope.createSessionActor(
      owner.source,
      { threadId: id, name: clip(`Agent ${runnerId}`, 200), role: unit.role },
      tx,
    );
    await tx.run(
      "INSERT INTO session_threads(id,project_id,continuity_key,instance_id,state,role,actor_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'open',?,?)",
      id,
      projectId,
      key,
      unit.instanceId,
      unit.state,
      unit.role,
      actor.id,
      at,
      at,
    );
    await this.state.appendEvent(tx, {
      projectId,
      actorId: 'system:sessions',
      type: 'thread.opened',
      subjectId: id,
      data: { threadId: id, workerActorId: actor.id },
    });
    return { id, actorId: actor.id, ...(key !== null && { continuity: { key } }) };
  }
  /** Its actor goes with it, unless a visit still holds it: that visit's close retires it. */
  private async retire(thread: Row, reason: string, tx: Transaction): Promise<void> {
    await tx.run(
      "UPDATE session_threads SET status='retired',retired_reason=?,updated_at=? WHERE id=? AND status<>'retired'",
      reason,
      isoNow(this.clock),
      thread.id,
    );
    const held = await tx.get(
      `SELECT 1 FROM session_threads t WHERE t.id=? AND ${LIVE}`,
      thread.id,
    );
    if (!held) await this.scope.retireSessionActor(thread.actor_id, reason, tx);
    await this.state.appendEvent(tx, {
      projectId: thread.project_id,
      actorId: 'system:sessions',
      type: 'thread.retired',
      subjectId: thread.id,
      data: { threadId: thread.id, reason },
    });
  }
  private async row(id: string, tx: Transaction): Promise<Row> {
    const row = await tx.get<Row>('SELECT * FROM session_threads WHERE id=?', id);
    check(row, 'thread_not_found', 'Thread not found', 404);
    return row;
  }
  /**
   * A visit closed. Without a key its thread retires with it. With one the thread waits, dormant,
   * its conversation kept for the next offer; the first visit to close is its latest until one
   * declares. A visit whose harness could not take up the conversation it was offered retires the
   * thread, so the key's next offer, on whatever machine, starts afresh rather than failing again.
   */
  async closed(session: Session, reason: string, tx: Transaction): Promise<void> {
    const thread = await this.row(session.threadId, tx);
    if (thread.status === 'retired')
      return await this.scope.retireSessionActor(thread.actor_id, reason, tx);
    const failed = session.deferral?.cause === 'resume_failed' && session.continuity?.resume;
    // A reviewer's verdict ends its round: nothing continues it.
    if (!session.continuity || (session.role === 'reviewer' && session.outcome === 'completed'))
      return await this.retire(thread, reason, tx);
    if (failed && thread.sha256 !== null && resumeOf(thread).sha256 === failed.sha256)
      return await this.retire(thread, 'superseded', tx);
    await tx.run(
      "UPDATE session_threads SET status='dormant',updated_at=?,latest_session_id=COALESCE(latest_session_id,?) WHERE id=?",
      session.closedAt ?? isoNow(this.clock),
      session.id,
      thread.id,
    );
  }
  /**
   * Whether a reviewer's visit its step limit cut is past what one review round is given: the
   * round's reviewer is resumed through `reviewVisits` visits uncounted, and each further cut
   * counts against the work (`review_unfinished`), so a review that never finishes is held.
   */
  async overran(session: Session, tx: Transaction): Promise<boolean> {
    if (session.role !== 'reviewer' || !session.continuity) return false;
    const visits = await tx.get<{ n: number | string }>(
      "SELECT count(*) AS n FROM worker_sessions s JOIN session_threads t ON t.id=s.thread_id WHERE t.project_id=? AND t.continuity_key=? AND s.kind='work'",
      session.projectId,
      session.continuity.key,
    );
    return Number(visits?.n ?? 0) > reviewVisits;
  }
  /** Like a transcript: declared with no store I/O, delivered by one HEAD and a signed PUT. */
  async record(
    caller: Caller,
    input: SessionControl & SessionConversationDeclaration,
  ): Promise<SessionTranscript> {
    const blobs = uploads(this.blobs, 'conversation');
    const {
      hostRef: _host,
      deliver: _deliver,
      sessionId: _id,
      runnerId: _runner,
      ...facts
    } = input;
    const row = await readFirst(this.state, async (tx) => {
      const session = await this.host.controlled(caller, input.sessionId, input.runnerId, tx);
      attached(session, input.hostRef, 'A conversation');
      check(session.continuity, 'conversation_unkept', 'This session keeps no conversation', 409);
      // The fork: an inquiry visit's conversation is never saved back, so the thread's next work
      // visit resumes the conversation as it was (and reads the exchange as a message).
      check(
        session.kind === 'work',
        'conversation_unkept',
        'An inquiry visit keeps no conversation: its thread resumes the one it had',
        409,
      );
      const found = await this.row(session.threadId, tx);
      // A closed visit may still declare while it is the thread's latest, or newer than it,
      // though a later one closed since with nothing declared.
      check(
        found.status !== 'retired' &&
          (found.latest_session_id === session.id ||
            live(session) ||
            (found.latest_session_id !== null &&
              !!(await tx.get(
                'SELECT 1 FROM worker_sessions s, worker_sessions r WHERE s.id=? AND r.id=? AND s._merv_rowid>r._merv_rowid',
                session.id,
                found.latest_session_id,
              )))),
        'conversation_superseded',
        'A later session of this work holds its conversation',
        409,
      );
      if (found.latest_session_id === session.id && found.sha256 !== null) return found;
      // The conversation delivered last stays resumable until this one is delivered.
      await tx.run(
        'UPDATE session_threads SET latest_session_id=?,harness=?,conversation_id=?,sha256=?,size=?,uploaded_at=NULL,delivered_json=?,updated_at=? WHERE id=?',
        session.id,
        facts.harness,
        facts.conversationId,
        facts.sha256,
        facts.size,
        found.uploaded_at === null ? found.delivered_json : JSON.stringify(resumeOf(found)),
        isoNow(this.clock),
        found.id,
      );
      return await this.row(found.id, tx);
    });
    check(
      row.latest_session_id === input.sessionId &&
        row.sha256 === input.sha256 &&
        Number(row.size) === input.size &&
        row.harness === input.harness &&
        row.conversation_id === input.conversationId,
      'conversation_conflict',
      'This session declared another conversation',
      409,
    );
    const view = (row: Row): SessionTranscript => ({
      sessionId: row.latest_session_id!,
      sha256: row.sha256!,
      size: Number(row.size),
      uploadedAt: row.uploaded_at,
    });
    if (row.uploaded_at !== null || !input.deliver) return view(row);
    return await deliver(blobs, 'conversation', namespace(row.project_id), view(row), () =>
      this.state.transaction(async (tx) => {
        await tx.run(
          "UPDATE session_threads SET uploaded_at=?,delivered_json=NULL WHERE id=? AND latest_session_id=? AND sha256=? AND uploaded_at IS NULL AND status<>'retired'",
          isoNow(this.clock),
          row.id,
          row.latest_session_id,
          row.sha256,
        );
        const now = await this.row(row.id, tx);
        check(
          now.status !== 'retired' && now.latest_session_id === row.latest_session_id,
          'conversation_superseded',
          'A later session of this work holds its conversation',
          409,
        );
        return view(now);
      }),
    );
  }
  /** The signed GET of what a live session resumes, for the runner that attached it. */
  async download(caller: Caller, input: SessionControl & { hostRef: string }) {
    const blobs = this.blobs;
    check(
      blobs.download,
      'conversations_unsupported',
      'Conversation storage takes no downloads',
      409,
    );
    const session = await readFirst(this.state, (tx) =>
      this.host.controlled(caller, input.sessionId, input.runnerId, tx),
    );
    check(
      live(session) && session.hostRef !== null && session.hostRef === input.hostRef,
      'host_conflict',
      'A resume must name the attached host of a live session',
      409,
    );
    const resume = session.continuity?.resume;
    check(resume, 'resume_none', 'This session continues no conversation', 404);
    return await blobs.download(
      namespace(session.projectId),
      resume.sha256,
      resume.size,
      'conversation.jsonl',
    );
  }
  /**
   * The sweep: threads whose work has not come back for `dormantMs`, a bounded batch a pass. A
   * thread waiting for the answer to its question waits as long as that takes.
   */
  async expire(tx: Transaction): Promise<void> {
    const before = isoNow(() => this.clock() - dormantMs);
    const rows = await tx.all<Row>(
      `SELECT * FROM session_threads t WHERE status='dormant' AND updated_at<?
        AND NOT EXISTS (SELECT 1 FROM session_questions q WHERE q.thread_id=t.id AND q.answered_at IS NULL)
        ORDER BY updated_at LIMIT 100`,
      before,
    );
    for (const row of rows) await this.retire(row, 'dormant', tx);
    // A question keeps its thread only while its work can still come back to it. Work that
    // ended took its question's blocker with it; its thread is read once more here and retired.
    // Work that stays open is read again each pass, `askingPage` threads at a time from where
    // the last pass stopped, so every waiting one is reached in turn and no pass reads them all.
    const page = await tx.all<{ id: string; project_id: string; seq: number | string }>(
      `SELECT t.id,t.project_id,t._merv_rowid AS seq FROM session_threads t WHERE t.status='dormant' AND t.updated_at<?
        AND t._merv_rowid>? AND EXISTS (SELECT 1 FROM session_questions q WHERE q.thread_id=t.id AND q.answered_at IS NULL)
        ORDER BY t._merv_rowid LIMIT ?`,
      before,
      this.askingAfter,
      this.askingPage,
    );
    for (const projectId of new Set(page.map((row) => row.project_id))) {
      const ids = page.filter((row) => row.project_id === projectId).map((row) => row.id);
      const { questions } = await this.host.standing(tx, projectId, { threads: ids });
      for (const id of ids)
        if (!questions.some((question) => question.thread_id === id))
          await this.retire(await this.row(id, tx), 'dormant', tx);
    }
    // Only once the page is done: a snapshot refused at its first retire is run again in a
    // writer (readFirst), which must read this same page.
    this.askingAfter = page.length < this.askingPage ? 0 : Number(page.at(-1)!.seq);
  }
  /** The sweep: a thread whose live visit's source lost its delegation is retired. */
  async lapsed(id: string, tx: Transaction): Promise<void> {
    const thread = await this.row(id, tx);
    if (thread.status === 'retired') return;
    const visit = (await tx.get<{ source: string }>(
      "SELECT session_json::jsonb->>'source' AS source FROM worker_sessions WHERE thread_id=? AND kind='work' ORDER BY _merv_rowid DESC LIMIT 1",
      id,
    ))!;
    try {
      await this.scope.requireDelegation(JSON.parse(visit.source), 'read', tx);
    } catch (error) {
      const failure = safeError(error);
      if (failure.status < 500) await this.retire(thread, failure.code, tx);
    }
  }

  /** Every thread with a visit on the work item, oldest first, each with all of its visits. */
  async list(caller: Caller, instanceIds: string | readonly string[]): Promise<ThreadView[]> {
    const ids = [...new Set(typeof instanceIds === 'string' ? [instanceIds] : instanceIds)];
    check(
      ids.length >= 1 && ids.length <= LIST_INSTANCES && ids.every((id) => text(id)),
      'invalid_input',
      `instanceId names a work item, or up to ${LIST_INSTANCES} of them`,
    );
    return await this.reading(caller, async (tx) => {
      for (const id of ids) await this.host.readable(caller, id, tx);
      const threads = await tx.all<Row>(
        'SELECT * FROM session_threads WHERE project_id=? AND id IN (SELECT thread_id FROM worker_sessions WHERE project_id=? AND instance_id IN (SELECT jsonb_array_elements_text(?::jsonb))) ORDER BY _merv_rowid',
        caller.projectId,
        caller.projectId,
        JSON.stringify(ids),
      );
      const standing = await this.standingOf(tx, caller.projectId, threads);
      return (await this.viewed(tx, threads, standing)).map(
        ({ name: _name, workflow: _workflow, ...view }) => view,
      );
    });
  }
  /**
   * A leased worker's lineage: the threads of its own work item, its own included, with each
   * visit's status, times, outcome, harness and runner, as session.threads gives a person them;
   * never another item's. A reviewer cites it for which machine each stage ran on.
   */
  async lineage(caller: Caller): Promise<WorkerLineage> {
    ordinary(caller);
    this.host.available();
    check(caller.session, 'session_required', 'Only a leased worker reads its lineage', 403);
    caller = structuredClone(caller);
    return await this.state.snapshotTransaction(async (tx) => {
      await this.scope.require(caller, 'read', tx);
      const own = await tx.get<{ instance_id: string }>(
        'SELECT instance_id FROM worker_sessions WHERE id=? AND project_id=? AND actor_id=?',
        caller.session!.id,
        caller.projectId,
        caller.actorId,
      );
      check(own, 'session_not_found', 'Session not found', 404);
      const threads = await tx.all<Row>(
        'SELECT * FROM session_threads WHERE project_id=? AND id IN (SELECT thread_id FROM worker_sessions WHERE project_id=? AND instance_id=?) ORDER BY _merv_rowid',
        caller.projectId,
        caller.projectId,
        own.instance_id,
      );
      const standing = await this.standingOf(tx, caller.projectId, threads);
      // Whether a person may message or ask a thread is theirs to read, not its worker's.
      return {
        instanceId: own.instance_id,
        threads: (await this.viewed(tx, threads, standing)).map(
          ({ name: _name, workflow: _workflow, takesMessage: _takes, asks: _asks, ...view }) =>
            view,
        ),
      };
    });
  }
  /**
   * The project's threads, as its Agents page lists them: on the first page every one that wants
   * attention (live, asking its owner, or holding a message its agent has not read), then the
   * newest of the rest, `PAGE` at a time, each page older than the cursor `before`. A thread
   * whose work the reader may read carries its open question and its newest message.
   */
  async project(caller: Caller, before?: string): Promise<ProjectThreads> {
    const after = before === undefined ? null : Number(before);
    check(
      after === null || (Number.isSafeInteger(after) && after > 0),
      'invalid_input',
      'before is the cursor a page of threads returned',
    );
    return await this.reading(caller, async (tx) => {
      const attention = await this.attention(tx, caller.projectId);
      const first =
        after === null
          ? await tx.all<Row & { seq: number | string }>(
              `SELECT t.*,t._merv_rowid AS seq FROM session_threads t WHERE t.project_id=? AND ${attention.sql} ORDER BY t._merv_rowid DESC`,
              caller.projectId,
              ...attention.params,
            )
          : [];
      const rest = await tx.all<Row & { seq: number | string }>(
        `SELECT t.*,t._merv_rowid AS seq FROM session_threads t WHERE t.project_id=? AND NOT ${attention.sql}
          AND (CAST(? AS BIGINT) IS NULL OR t._merv_rowid<?) ORDER BY t._merv_rowid DESC LIMIT ?`,
        caller.projectId,
        ...attention.params,
        after,
        after,
        PAGE + 1,
      );
      const page = [...first, ...rest.slice(0, PAGE)];
      const ids = page.map((row) => row.id);
      const marks = ids.map(() => '?').join(',');
      const standing = await this.standingOf(tx, caller.projectId, page);
      // Each thread's newest question that stands (oldest first, so the newest wins).
      const asked = new Map(standing.questions.map((row) => [row.thread_id, row]));
      const said = new Map(
        (page.length
          ? await tx.all<{
              thread_id: string;
              id: string;
              sender_actor_id: string;
              body: string;
              created_at: string;
              acknowledged_at: string | null;
              reply_body: string | null;
              inquiry_id: string | null;
              inquiry_status: InquiryStatus | null;
            }>(
              // The context an answered inquiry left its work repeats the question and its reply.
              `SELECT DISTINCT ON (m.thread_id) m.thread_id,m.id,m.sender_actor_id,m.body,m.created_at,m.acknowledged_at,m.reply_body,
                  i.id AS inquiry_id,i.status AS inquiry_status
                FROM session_messages m LEFT JOIN session_inquiries i ON i.id=m.inquiry_id AND m.inquiry_role='question'
                WHERE m.project_id=? AND m.thread_id IN (${marks}) AND m.inquiry_role IS DISTINCT FROM 'context'
                ORDER BY m.thread_id,m._merv_rowid DESC`,
              caller.projectId,
              ...ids,
            )
          : []
        ).map((row) => [row.thread_id, row]),
      );
      // What its agent asked and what it was told are read as its work is: by a reader of it.
      const readable = new Set<string>();
      for (const instanceId of new Set(
        page.filter((row) => asked.has(row.id) || said.has(row.id)).map((row) => row.instance_id),
      ))
        try {
          await this.host.readable(caller, instanceId, tx);
          readable.add(instanceId);
        } catch (error) {
          if (safeError(error).status >= 500) throw error;
        }
      const views = await this.viewed(tx, page, standing);
      return {
        threads: views.map((view, index) => {
          const question = readable.has(view.instanceId) ? asked.get(view.id) : undefined;
          const message = readable.has(view.instanceId) ? said.get(view.id) : undefined;
          return {
            ...view,
            ...(index < first.length
              ? { attention: true as const }
              : { seq: String(page[index]!.seq) }),
            ...(question && {
              question: {
                id: question.id,
                question: question.question,
                askedAt: question.asked_at,
                ...(question.response_json ? { response: JSON.parse(question.response_json) } : {}),
              },
            }),
            ...(message && {
              message: {
                id: message.id,
                senderActorId: message.sender_actor_id,
                body: message.body,
                createdAt: message.created_at,
                acknowledgedAt: message.acknowledged_at,
                reply: message.reply_body,
                ...(message.inquiry_id &&
                  message.inquiry_status && {
                    inquiry: messageInquiry(message.inquiry_id, message.inquiry_status),
                  }),
              },
            }),
          };
        }),
        next: rest.length > PAGE ? String(rest[PAGE - 1]!.seq) : null,
      };
    });
  }
  /**
   * Which of the project's threads want attention: live, asked a question (an inquiry) that is
   * still open, asking its owner a question that still stands, or holding an unread message
   * while it takes one (`takesMessage`), so not on work that has ended, which no visit will read
   * it on. Whether a question stands, and whether work ended, is one `standing` read.
   */
  private async attention(tx: Transaction, projectId: string) {
    const unread = await tx.all<{ id: string; instance_id: string; status: string }>(
      `SELECT t.id,t.instance_id,t.status FROM session_threads t WHERE t.project_id=? AND ${UNREAD}`,
      projectId,
    );
    const standing = await this.host.standing(tx, projectId, {
      instances: unread.map((row) => row.instance_id),
    });
    const ids = [
      ...new Set([
        ...standing.questions.map((question) => question.thread_id),
        ...unread.filter((row) => takesMessage(row, standing)).map((row) => row.id),
      ]),
    ];
    return {
      sql: `(${LIVE} OR ${INQUIRING}${ids.length ? ` OR t.id IN (${ids.map(() => '?').join(',')})` : ''})`,
      params: ids,
    };
  }
  /** How many of the project's threads are live, and how many ask their owner a question. */
  async counts(caller: Caller): Promise<ThreadCounts> {
    return await this.reading(caller, async (tx) => {
      const row = await tx.get<{ live: number | string }>(
        `SELECT count(*) AS live FROM session_threads t WHERE t.project_id=? AND ${LIVE}`,
        caller.projectId,
      );
      const { questions } = await this.host.standing(tx, caller.projectId);
      return {
        live: Number(row?.live ?? 0),
        waiting: new Set(questions.map((question) => question.thread_id)).size,
      };
    });
  }
  /** Where these threads' questions stand, with whether each one's work item has ended. */
  private async standingOf(tx: Transaction, projectId: string, threads: Row[]) {
    return await this.host.standing(tx, projectId, {
      threads: threads.map((thread) => thread.id),
      instances: threads.map((thread) => thread.instance_id),
    });
  }
  /** A read of the project's threads by a person or their key, never a worker. */
  private async reading<T>(caller: Caller, read: (tx: Transaction) => Promise<T>): Promise<T> {
    ordinary(caller);
    this.host.available();
    caller = structuredClone(caller);
    return await this.state.snapshotTransaction(async (tx) => {
      await this.scope.require(caller, 'read', tx);
      check(!caller.session, 'session_forbidden', 'Workers cannot browse other agents', 403);
      return await read(tx);
    });
  }
  /**
   * Each thread with all of its visits, live while one of them holds its lease, and whether it
   * takes a message now, by Messages' one rule (`takesMessage`) over `standing`, which read these
   * threads. It may be asked as `session.ask_thread` takes a question: it kept a conversation,
   * dispatch is on, and no question to it is still waiting or being answered.
   */
  private async viewed(
    tx: Transaction,
    threads: Row[],
    standing: Standing,
  ): Promise<(ThreadView & { name: string; workflow: string })[]> {
    const ids = threads.map((thread) => thread.id);
    const visits = await this.visits(tx, ids);
    const unaskable = threads.length
      ? await this.host.unaskable(threads[0]!.project_id, ids, tx)
      : new Map<string, unknown>();
    return threads.map((thread) => {
      const mine = visits.filter((visit) => visit.threadId === thread.id);
      const own = mine.map((visit) => visit.view);
      // The work item it is on, as its newest work visit's assignment names it.
      const newest = mine.filter((visit) => !visit.view.inquiry).at(-1);
      return {
        name: newest?.name ?? '',
        workflow: newest?.workflow ?? '',
        id: thread.id,
        instanceId: thread.instance_id,
        state: thread.state,
        role: thread.role,
        status:
          thread.status === 'retired'
            ? 'retired'
            : own.some((visit) => live(visit) && !visit.inquiry)
              ? 'live'
              : 'dormant',
        takesMessage: takesMessage(thread, standing),
        ...(!unaskable.has(thread.id) && { asks: true as const }),
        visits: own,
      };
    });
  }
  private async visits(tx: Transaction, threadIds: string[]) {
    if (!threadIds.length) return [];
    const now = this.clock();
    const rows = await tx.all<{
      id: string;
      thread_id: string;
      status: SessionStatus;
      runner_id: string;
      created_at: string;
      activated_at: string | null;
      expires_at: string;
      hard_deadline: string;
      closed_at: string | null;
      close_reason: string | null;
      outcome: string | null;
      resumed: boolean;
      state: string | null;
      harness: string | null;
      streamed: boolean;
      transcript: boolean;
      name: string | null;
      workflow: string | null;
      kind: 'work' | 'inquiry';
    }>(
      // The columns kept beside each visit's JSON (sessions@23): the pages that list threads poll.
      `SELECT s.id,s.thread_id,s.status,s.runner_id,s.kind,s.created_at,s.activated_at,s.expires_at,s.hard_deadline,
          s.closed_at,s.close_reason,s.work_name AS name,s.workflow,s.outcome,s.execution_state AS state,s.resume_harness IS NOT NULL AS resumed,
          COALESCE(d.platform_json::jsonb->>'harness',u.harness,s.resume_harness) AS harness,
          EXISTS (SELECT 1 FROM session_events e WHERE e.session_id=s.id) AS streamed,
          EXISTS (SELECT 1 FROM session_transcripts t WHERE t.session_id=s.id AND t.uploaded_at IS NOT NULL) AS transcript
        FROM worker_sessions s LEFT JOIN session_dispatch_receipts d ON d.session_id=s.id LEFT JOIN session_usage u ON u.session_id=s.id
        WHERE s.thread_id IN (${threadIds.map(() => '?').join(',')}) ORDER BY s._merv_rowid`,
      ...threadIds,
    );
    return rows.map((row) => {
      const view: VisitView = {
        sessionId: row.id,
        ...(row.state && { state: row.state }),
        status: row.status,
        offeredAt: row.created_at,
        ...(row.activated_at && { startedAt: row.activated_at }),
        ...(row.closed_at && { endedAt: row.closed_at }),
        ...(row.outcome && { outcome: row.outcome }),
        ...(row.close_reason && { why: row.close_reason }),
        // A process that ran either called Merv, which activated the lease, or printed.
        launched: row.activated_at !== null || row.streamed,
        resumed: row.resumed,
        ...((row.harness === 'claude' || row.harness === 'codex') && { harness: row.harness }),
        runnerId: row.runner_id,
        ...(live(row) && {
          liveness: leaseLiveness(
            {
              status: row.status,
              createdAt: row.created_at,
              activatedAt: row.activated_at,
              expiresAt: row.expires_at,
              hardDeadline: row.hard_deadline,
            },
            now,
          ),
        }),
        hasConversation: row.streamed || row.transcript,
        ...(row.kind === 'inquiry' && { inquiry: true as const }),
      };
      return { threadId: row.thread_id, view, name: row.name, workflow: row.workflow };
    });
  }
  /**
   * What the thread's agent did, visit by visit: each visit's kept stream while it is kept,
   * otherwise its stored transcript read into the same events. An operator's alone, as the
   * stream is. One read sends the newest events it has room for, newest visit first, and says
   * where it stopped (`next`); passed back as `before`, the next read goes on from there, so a
   * page that reads on until `next` is null holds every event, each once.
   */
  async conversation(
    caller: Caller,
    threadId: string,
    before?: string,
  ): Promise<ThreadConversation> {
    caller = structuredClone(caller);
    check(
      !caller.session && !caller.managed,
      'forbidden',
      'Only a person reads an agent’s conversation',
      403,
    );
    this.host.available();
    check(text(threadId), 'invalid_input', 'A thread id of 1–200 characters is required');
    const cursor = /^([^:]{1,200})(?::(\d{1,15}))?$/.exec(before ?? '');
    const visits = await this.state.snapshotTransaction(async (tx) => {
      const actor = await this.scope.require(caller, 'read', tx);
      check(
        readsAgents(actor.role),
        'forbidden',
        'Only an operator reads an agent’s conversation',
        403,
      );
      await threadIn(tx, caller.projectId, threadId);
      return await tx.all<Said>(
        `SELECT s.id,s.project_id,s.status,t.sha256,t.size,t.declared_at,
            EXISTS (SELECT 1 FROM session_events e WHERE e.session_id=s.id) AS streamed
          FROM worker_sessions s LEFT JOIN session_transcripts t ON t.session_id=s.id AND t.uploaded_at IS NOT NULL
          WHERE s.thread_id=? ORDER BY s._merv_rowid`,
        threadId,
      );
    });
    const first =
      before === undefined
        ? visits.length - 1
        : visits.findIndex((visit) => visit.id === cursor?.[1]);
    check(
      before === undefined || first >= 0,
      'invalid_input',
      'before is where a read of this conversation stopped',
    );
    const out: ThreadConversation = {
      threadId,
      // A page reads a live visit from its own stream (`/events`), so it takes no room here.
      visits: visits.map((visit) => ({
        sessionId: visit.id,
        from: live(visit)
          ? 'live'
          : visit.streamed
            ? 'stream'
            : visit.sha256
              ? 'transcript'
              : 'none',
        events: [],
      })),
      next: null,
    };
    const left = fullRoom();
    for (let index = first; index >= 0 && out.next === null; index--) {
      const visit = visits[index]!,
        said = out.visits[index]!;
      if (said.from !== 'stream' && said.from !== 'transcript') continue;
      const end = index === first && cursor?.[2] !== undefined ? Number(cursor[2]) : undefined;
      try {
        const read =
          left.events > 0 && left.bytes > 0
            ? await this.said(visit, end, left, index === first)
            : { events: [], rest: end };
        said.events = read.events;
        if ('rest' in read) {
          said.truncated = true;
          out.next = read.rest === undefined ? visit.id : `${visit.id}:${read.rest}`;
        }
      } catch {
        said.from = 'unavailable';
      }
    }
    return out;
  }
  /**
   * What one read takes of a visit, before `end` (from its end when undefined): its newest events
   * that fit `room`, which they take up, and where it stopped (`rest`) unless it reached the
   * visit's start. The read's first visit (`must`) always moves on, so no read stands still.
   */
  private async said(
    visit: Said,
    end: number | undefined,
    room: Room,
    must: boolean,
  ): Promise<{ events: AgentStreamEvent[]; rest?: number }> {
    if (visit.streamed) {
      // A stream numbers its events from 1.
      const kept = await this.host.stream(visit.id, end);
      const events = newest(kept, room);
      const rest = events[0]?.seq ?? (kept.at(-1)?.seq ?? 0) + 1;
      return { events, ...(rest > 1 && { rest }) };
    }
    const blobs = this.blobs;
    check(blobs.download, 'transcripts_unsupported', 'Transcript storage takes no downloads', 409);
    const size = Number(visit.size);
    const { url } = await blobs.download(`transcripts-${visit.project_id}`, visit.sha256!, size);
    // A ranged GET of its signed download.
    const range = async (start: number, stop: number) => {
      const response = await fetch(url, {
        headers: { range: `bytes=${start}-${stop - 1}` },
        signal: AbortSignal.timeout(CHUNK_TIMEOUT_MS),
      });
      check(response.ok, 'blob_unavailable', 'The transcript could not be read', 503);
      const bytes = Buffer.from(await response.arrayBuffer());
      // A store that ignores the range sends the whole object.
      return response.status === 206 ? bytes : bytes.subarray(start, stop);
    };
    return await transcriptEvents(range, end ?? size, visit.declared_at!, room, must);
  }
}
type Said = {
  id: string;
  project_id: string;
  status: SessionStatus;
  sha256: string | null;
  size: string | number | null;
  declared_at: string | null;
  streamed: boolean;
};
/** What a thread resumes: its latest conversation once delivered, else the last delivered one
 *  where it kept one, else the latest declared (a runner that cannot fetch it starts fresh). */
const resumeOf = (row: Row): SessionResume =>
  row.uploaded_at === null && row.delivered_json !== null
    ? (JSON.parse(row.delivered_json) as SessionResume)
    : {
        sessionId: row.latest_session_id!,
        harness: row.harness!,
        conversationId: row.conversation_id!,
        sha256: row.sha256!,
        size: Number(row.size),
      };
/** A text an event holds, cut where it is longer, saying how much was dropped. */
const fit = (event: AgentEvent): AgentEvent => {
  const field =
    event.kind === 'tool_call'
      ? 'input'
      : event.kind === 'tool_result'
        ? 'output'
        : event.kind === 'status'
          ? 'text'
          : 'delta';
  const value = (event as Record<string, unknown>)[field] as string;
  if (value.length <= AGENT_EVENT_TEXT) return event;
  const kept = clip(value, AGENT_EVENT_TEXT);
  return {
    ...event,
    [field]: kept,
    ...(event.kind !== 'status' && { cut: value.length - kept.length }),
  } as AgentEvent;
};
/** The newest of `events` that fit `room`, which they then take up. Once one does not fit, no
 * older one is sent. */
function newest(events: AgentStreamEvent[], room: Room): AgentStreamEvent[] {
  let from = events.length;
  while (from > 0 && room.events > 0) {
    const size = JSON.stringify(events[from - 1]!.event).length + 64;
    if (size > room.bytes) {
      room.bytes = 0;
      break;
    }
    room.bytes -= size;
    room.events--;
    from--;
  }
  return events.slice(from);
}
/** A piece of a Claude message streamed in parts, but its start: a reader takes a piece only
 *  once it has read the start, so the piece waits for the chunk that holds it. */
const piece = (text: string) =>
  text.startsWith('{"type":"stream_event"') && readLine(text)?.event?.type !== 'message_start';
/**
 * A stored transcript read as its stream would have been, back from byte `end`: each line through
 * both harnesses' readers (their line types do not overlap), its newest lines whose events fit
 * `room`, which they take up, from disjoint chunks `range(start, stop)` downloads while `room`
 * allows. A line is read once its start is held, and Claude's streamed pieces once their
 * message's start is, and named by where it starts (the readers' `at`, its events' `seq`), so a
 * transcript read in parts draws as it does whole (a Codex call whose start and end two parts
 * hold is sent by both, one block by its id). Events carry the declaration's time (`at`); `rest`
 * is where the read stopped, unless it reached the start. A read that `must` move sends its
 * newest line whatever its size, downloading past its room until it holds one, each chunk as
 * large as all before it, to LINE_BYTES: only a longer line is passed over.
 */
export async function transcriptEvents(
  range: (start: number, stop: number) => Promise<Buffer>,
  end: number,
  at: string,
  room: Room = fullRoom(),
  must = true,
): Promise<{ events: AgentStreamEvent[]; rest?: number }> {
  const events: AgentStreamEvent[] = [];
  const top = end;
  const stuck = () => must && end === top;
  // Bytes [start, end) are held: downloaded, not yet sent.
  let start = end,
    held = Buffer.alloc(0);
  const left = () => (stuck() ? LINE_BYTES - (top - start) : room.gets > 0 ? room.download : 0);
  while (start > 0 && left() > 0 && room.events > 0 && room.bytes > 0) {
    const from = Math.max(0, start - Math.min(Math.max(CHUNK_BYTES, top - start), left()));
    held = Buffer.concat([await range(from, start), held]);
    room.download -= start - from;
    room.gets--;
    start = from;
    // Its whole lines: from the first that starts in what is held.
    const lines: { offset: number; text: string }[] = [];
    for (let line = start === 0 ? 0 : held.indexOf(10) + 1 || held.length; line < held.length;) {
      const stop = held.indexOf(10, line) + 1 || held.length + 1;
      lines.push({ offset: start + line, text: held.toString('utf8', line, stop - 1) });
      line = stop;
    }
    let first = 0;
    if (start > 0) while (first < lines.length && piece(lines[first]!.text)) first++;
    if (first === lines.length && stuck() && left() <= 0) {
      if (!lines.length) end = start;
      first = 0;
    }
    const readers = [claudeEvents(), codexEvents()];
    const said = lines
      .slice(first)
      .map(({ offset, text }) =>
        readers
          .flatMap((read) => read(text, offset))
          .map((event, index) => ({ seq: offset + index + 1, at, event: fit(event) })),
      );
    // Newest lines first, each whole, while the room holds them.
    let line = said.length;
    for (; line > 0; line--) {
      const kept = said[line - 1]!;
      const bytes = kept.reduce((sum, item) => sum + JSON.stringify(item.event).length + 64, 0);
      if ((kept.length > room.events || bytes > room.bytes) && !stuck()) break;
      room.events -= kept.length;
      room.bytes -= bytes;
      end = lines[first + line - 1]!.offset;
      events.unshift(...kept);
    }
    if (line > 0) break;
    held = held.subarray(0, end - start);
  }
  return { events, ...(end > 0 && { rest: end }) };
}

import {
  AGENT_EVENT_TEXT,
  check,
  claudeEvents,
  codexEvents,
  newId,
  type AgentEvent,
  type AgentStreamEvent,
  type Blobs,
  type Caller,
  type DelegationSource,
  type Scope,
  type State,
  type Transaction,
} from '@merv/contracts';
import { isoNow, live, ordinary, readFirst, safeError, text } from './common.js';
import { freezeLaunchSnapshot } from './launch-connections.js';
import { leaseLiveness } from './liveness.js';
import { deliver, uploads } from './transcripts.js';
import type {
  ContinuityProvider,
  ContinuityUnit,
  Session,
  SessionContinuity,
  SessionControl,
  SessionConversationDeclaration,
  SessionResume,
  SessionStatus,
  SessionTranscript,
  ThreadConversation,
  ThreadView,
  VisitView,
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
};
type Facts = Omit<SessionConversationDeclaration, 'hostRef' | 'deliver'>;
/** One prefix per project, as transcripts have. */
const namespace = (projectId: string) => `conversations-${projectId}`;
/** How long a thread waits, dormant, for its work to come back to it. */
export const dormantMs = 14 * 86_400_000;
/** What a conversation read sends of one visit: its newest events, at most this many or bytes. */
const VISIT_EVENTS = 500;
const VISIT_BYTES = 2_000_000;

/**
 * Threads: the worker that owns one stage of one work item for one role. A session is one visit
 * by its thread, with its own lease and credential; the thread holds the attribution actor every
 * visit acts as, the conversation they kept and whether it is open, dormant or retired.
 *
 * A session's continuity key is its workflow's provider's, else its instance, state and role, so
 * a reviewer never continues a producer, and no reviewer continues at all. A key has at most one
 * thread that is not retired. An offer resumes it, with its actor and conversation, when it is
 * dormant, belongs to the same source and declared a conversation; otherwise the offer retires it
 * as superseded and opens a new one. A visit without a key retires its thread at close; a thread
 * that waited longer than `dormantMs`, or whose resume its harness could not take up, is retired.
 */
export class SessionThreads {
  /** Late-bound like transcripts'. */
  blobs?: Blobs;
  private readonly providers = new Map<string, ContinuityProvider>();
  constructor(
    private state: State,
    private scope: Scope,
    private clock: () => number,
    private host: {
      controlled(caller: Caller, id: string, runnerId: string, tx: Transaction): Promise<Session>;
      /** Refuses a caller who may not read the work item. */
      readable(caller: Caller, instanceId: string, tx: Transaction): Promise<unknown>;
      /** A visit's live stream as a page is first sent it. */
      stream(sessionId: string): Promise<AgentStreamEvent[]>;
      /** Refuses once Sessions has closed. */
      available(): void;
    },
  ) {}
  register(workflow: string, provider: ContinuityProvider): () => void {
    this.host.available();
    check(
      !this.providers.has(workflow),
      'continuity_registered',
      'This workflow already has a continuity provider',
      409,
    );
    this.providers.set(workflow, provider);
    return () => {
      if (this.providers.get(workflow) === provider) this.providers.delete(workflow);
    };
  }
  key(unit: ContinuityUnit): string | null {
    // A review is read with fresh eyes each round: a reviewer never carries its earlier verdict.
    if (unit.role === 'reviewer') return null;
    const provider = this.providers.get(unit.workflow);
    if (!provider) return JSON.stringify([unit.instanceId, unit.state, unit.role]);
    const key = provider(freezeLaunchSnapshot(structuredClone(unit)));
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
        "SELECT owner_hash,bool_or(status IN ('offered','active')) AS live FROM worker_sessions WHERE thread_id=? GROUP BY owner_hash",
        held.id,
      );
      // Sessions' choice, not the runner's: the thread may have run anywhere.
      if (
        held.sha256 !== null &&
        visits.length === 1 &&
        visits[0]!.owner_hash === owner.hash &&
        !visits[0]!.live
      ) {
        await this.scope.setAgentRole(owner.source, held.actor_id, unit.role, tx);
        await tx.run(
          "UPDATE session_threads SET status='open',updated_at=? WHERE id=?",
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
    const id = newId('thr');
    const actor = await this.scope.createSessionActor(
      owner.source,
      { sessionId: id, threadId: id, name: `Agent ${runnerId}`.slice(0, 200), role: unit.role },
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
    if (!(await this.executing(thread.id, tx)))
      await this.scope.retireSessionActor(thread.actor_id, reason, tx);
    await this.state.appendEvent(tx, {
      projectId: thread.project_id,
      actorId: 'system:sessions',
      type: 'thread.retired',
      subjectId: thread.id,
      data: { threadId: thread.id, reason },
    });
  }
  private async executing(id: string, tx: Transaction): Promise<boolean> {
    return !!(await tx.get(
      "SELECT 1 FROM worker_sessions WHERE thread_id=? AND status IN ('offered','active')",
      id,
    ));
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
    if (!session.continuity) return await this.retire(thread, reason, tx);
    if (failed && thread.sha256 === failed.sha256)
      return await this.retire(thread, 'superseded', tx);
    await tx.run(
      "UPDATE session_threads SET status='dormant',updated_at=?,latest_session_id=COALESCE(latest_session_id,?) WHERE id=?",
      session.closedAt ?? isoNow(this.clock),
      session.id,
      thread.id,
    );
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
      check(
        session.hostRef !== null && session.hostRef === input.hostRef,
        'host_conflict',
        'A conversation must name the attached host',
        409,
      );
      check(session.continuity, 'conversation_unkept', 'This session keeps no conversation', 409);
      const found = await this.row(session.threadId, tx);
      const superseded = () =>
        check(
          false,
          'conversation_superseded',
          'A later session of this work holds its conversation',
          409,
        );
      if (found.status === 'retired') superseded();
      if (found.latest_session_id === session.id && found.sha256 !== null) return found;
      // A closed visit may still declare while it is the thread's latest, or newer than it,
      // though a later one closed since with nothing declared.
      if (
        found.latest_session_id !== session.id &&
        !live(session) &&
        !(
          found.latest_session_id !== null &&
          (await tx.get(
            'SELECT 1 FROM worker_sessions s, worker_sessions r WHERE s.id=? AND r.id=? AND s._merv_rowid>r._merv_rowid',
            session.id,
            found.latest_session_id,
          ))
        )
      )
        superseded();
      await tx.run(
        'UPDATE session_threads SET latest_session_id=?,harness=?,conversation_id=?,sha256=?,size=?,uploaded_at=NULL,updated_at=? WHERE id=?',
        session.id,
        facts.harness,
        facts.conversationId,
        facts.sha256,
        facts.size,
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
          "UPDATE session_threads SET uploaded_at=? WHERE id=? AND latest_session_id=? AND sha256=? AND uploaded_at IS NULL AND status<>'retired'",
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
    check(blobs?.download, 'blob_unavailable', 'Conversation storage is not loaded', 503);
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
  /** The sweep: threads whose work has not come back for `dormantMs`, a bounded batch a pass. */
  async expire(tx: Transaction): Promise<void> {
    const rows = await tx.all<Row>(
      "SELECT * FROM session_threads WHERE status='dormant' AND updated_at<? ORDER BY updated_at LIMIT 100",
      isoNow(() => this.clock() - dormantMs),
    );
    for (const row of rows) await this.retire(row, 'dormant', tx);
  }
  /** The sweep: a thread whose live visit's source lost its delegation is retired. */
  async lapsed(id: string, tx: Transaction): Promise<void> {
    const thread = await this.row(id, tx);
    if (thread.status === 'retired') return;
    const visit = (await tx.get<{ source: string }>(
      "SELECT session_json::jsonb->>'source' AS source FROM worker_sessions WHERE thread_id=? ORDER BY _merv_rowid DESC LIMIT 1",
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
  async list(caller: Caller, instanceId: string): Promise<ThreadView[]> {
    ordinary(caller);
    this.host.available();
    check(text(instanceId), 'invalid_input', 'instanceId names a work item');
    caller = structuredClone(caller);
    return await this.state.snapshotTransaction(async (tx) => {
      await this.scope.require(caller, 'read', tx);
      check(!caller.session, 'session_forbidden', 'Workers cannot browse other agents', 403);
      await this.host.readable(caller, instanceId, tx);
      const threads = await tx.all<Row & { _merv_rowid: number }>(
        'SELECT * FROM session_threads WHERE project_id=? AND id IN (SELECT thread_id FROM worker_sessions WHERE project_id=? AND instance_id=?) ORDER BY _merv_rowid',
        caller.projectId,
        caller.projectId,
        instanceId,
      );
      const visits = await this.visits(
        tx,
        threads.map((thread) => thread.id),
      );
      return threads.map((thread) => {
        const own = visits
          .filter((visit) => visit.threadId === thread.id)
          .map((visit) => visit.view);
        return {
          id: thread.id,
          instanceId: thread.instance_id,
          state: thread.state,
          role: thread.role,
          status:
            thread.status === 'retired'
              ? 'retired'
              : own.some((visit) => live(visit))
                ? 'live'
                : 'dormant',
          visits: own,
        };
      });
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
      harness: string | null;
      streamed: boolean;
      transcript: boolean;
    }>(
      `SELECT s.id,s.thread_id,s.status,s.runner_id,x.j->>'createdAt' AS created_at,x.j->>'activatedAt' AS activated_at,
          x.j->>'expiresAt' AS expires_at,x.j->>'hardDeadline' AS hard_deadline,x.j->>'closedAt' AS closed_at,
          x.j->>'closeReason' AS close_reason,x.j->>'outcome' AS outcome,(x.j#>'{continuity,resume}') IS NOT NULL AS resumed,
          COALESCE(d.platform_json::jsonb->>'harness',u.harness,x.j#>>'{continuity,resume,harness}') AS harness,
          EXISTS (SELECT 1 FROM session_events e WHERE e.session_id=s.id) AS streamed,
          EXISTS (SELECT 1 FROM session_transcripts t WHERE t.session_id=s.id AND t.uploaded_at IS NOT NULL) AS transcript
        FROM worker_sessions s CROSS JOIN LATERAL (SELECT s.session_json::jsonb AS j OFFSET 0) x
        LEFT JOIN session_dispatch_receipts d ON d.session_id=s.id LEFT JOIN session_usage u ON u.session_id=s.id
        WHERE s.thread_id IN (${threadIds.map(() => '?').join(',')}) ORDER BY s._merv_rowid`,
      ...threadIds,
    );
    return rows.map((row) => {
      const view: VisitView = {
        sessionId: row.id,
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
      };
      return { threadId: row.thread_id, view };
    });
  }
  /**
   * What the thread's agent did, visit by visit: each visit's live stream while it is kept,
   * otherwise its stored transcript read into the same events. An operator's alone, as the
   * stream is.
   */
  async conversation(caller: Caller, threadId: string): Promise<ThreadConversation> {
    caller = structuredClone(caller);
    check(
      !caller.session && !caller.managed,
      'forbidden',
      'Only a person reads an agent’s conversation',
      403,
    );
    this.host.available();
    check(text(threadId), 'invalid_input', 'A thread id of 1–200 characters is required');
    const visits = await this.state.snapshotTransaction(async (tx) => {
      const actor = await this.scope.require(caller, 'read', tx);
      check(
        actor.role === 'operator',
        'forbidden',
        'Only an operator reads an agent’s conversation',
        403,
      );
      check(
        await tx.get(
          'SELECT 1 FROM session_threads WHERE id=? AND project_id=?',
          threadId,
          caller.projectId,
        ),
        'thread_not_found',
        'Thread not found in this project',
        404,
      );
      return await tx.all<{
        id: string;
        project_id: string;
        sha256: string | null;
        declared_at: string | null;
      }>(
        'SELECT s.id,s.project_id,t.sha256,t.declared_at FROM worker_sessions s LEFT JOIN session_transcripts t ON t.session_id=s.id AND t.uploaded_at IS NOT NULL WHERE s.thread_id=? ORDER BY s._merv_rowid',
        threadId,
      );
    });
    const out: ThreadConversation = { threadId, visits: [] };
    for (const visit of visits) {
      const streamed = await this.host.stream(visit.id);
      if (streamed.length) {
        out.visits.push({ sessionId: visit.id, from: 'stream', events: streamed });
        continue;
      }
      if (visit.sha256 === null) {
        out.visits.push({ sessionId: visit.id, from: 'none', events: [] });
        continue;
      }
      check(this.blobs, 'blob_unavailable', 'Transcript storage is not loaded', 503);
      const bytes = await this.blobs.get(`transcripts-${visit.project_id}`, visit.sha256);
      out.visits.push({
        sessionId: visit.id,
        from: 'transcript',
        events: transcriptEvents(bytes.toString('utf8'), visit.declared_at!),
      });
    }
    return out;
  }
}
const resumeOf = (row: Row): SessionResume => ({
  sessionId: row.latest_session_id!,
  harness: row.harness!,
  conversationId: row.conversation_id!,
  sha256: row.sha256!,
  size: Number(row.size),
});
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
  return {
    ...event,
    [field]: value.slice(0, AGENT_EVENT_TEXT),
    ...(event.kind !== 'status' && { cut: value.length - AGENT_EVENT_TEXT }),
  } as AgentEvent;
};
/**
 * A stored transcript read as its stream would have been: each line through both harnesses'
 * readers (their line types do not overlap), its newest events within what a page is sent.
 * The runner kept whole messages only, so Claude's are read whole. Each event is stamped with
 * the transcript's declaration, as a line carries no time of its own.
 */
export function transcriptEvents(transcript: string, at: string): AgentStreamEvent[] {
  const readers = [claudeEvents(), codexEvents()];
  const events = transcript
    .split('\n')
    .flatMap((line, index) => readers.flatMap((read) => read(line, index)))
    .map((event, index) => ({ seq: index + 1, at, event: fit(event) }));
  let bytes = 0,
    from = events.length;
  while (from > 0 && events.length - from < VISIT_EVENTS) {
    bytes += JSON.stringify(events[from - 1]!.event).length + 64;
    if (bytes > VISIT_BYTES) break;
    from--;
  }
  return events.slice(from);
}

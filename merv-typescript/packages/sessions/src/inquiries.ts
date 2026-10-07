import {
  MervError,
  check,
  clip,
  digest,
  newId,
  type Caller,
  type DelegationSource,
  type Scope,
  type State,
  type Transaction,
} from '@merv/contracts';
import { isoNow, ordinary, text, workName } from './common.js';
import type {
  DispatchState,
  InquirySession,
  InquiryStatus,
  Session,
  SessionInquiries,
  SessionResume,
  ThreadInquiry,
  ThreadInquiryInput,
} from './types.js';

/** How long a question waits for a machine to take it before it expires. */
export const INQUIRY_WAIT_MS = 10 * 60_000;
/** An inquiry visit's hard deadline from its offer: a short answer, never work. */
export const INQUIRY_VISIT_SECONDS = 10 * 60;
/** The model tokens one inquiry visit may spend besides resending its conversation. */
export const INQUIRY_TOKENS = 300_000;
/** How many model calls' worth of its conversation an inquiry visit may resend: each call of a
 *  resumed conversation carries all of it, and an answer takes a call or a few. */
const INQUIRY_RESENDS = 4;
/**
 * The model tokens one person's questions may spend in a day, wherever they ran: each counts
 * what its runner reported, and one still waiting, running or unreported its whole budget.
 */
export const INQUIRY_DAILY_TOKENS = 2_000_000;
/** An inquiry's budget for a conversation of `size` bytes (about four to a token), within a day's. */
const inquiryBudget = (size: number) =>
  Math.min(INQUIRY_DAILY_TOKENS, INQUIRY_TOKENS + INQUIRY_RESENDS * Math.ceil(size / 4));

interface InquiryRow {
  id: string;
  project_id: string;
  thread_id: string;
  message_id: string;
  asker_actor_id: string;
  asker_source_json: string;
  request_id: string;
  fingerprint: string;
  status: InquiryStatus;
  asked_at: string;
  wait_until: string;
  session_id: string | null;
  ended_at: string | null;
  token_budget: number | string;
  /** Joined from its thread. */
  instance_id: string;
}
const INQUIRY =
  'SELECT i.*,t.instance_id FROM session_inquiries i JOIN session_threads t ON t.id=i.thread_id';
const view = (row: InquiryRow): ThreadInquiry => ({
  id: row.id,
  threadId: row.thread_id,
  instanceId: row.instance_id,
  messageId: row.message_id,
  askedBy: row.asker_actor_id,
  status: row.status,
  askedAt: row.asked_at,
  waitUntil: row.wait_until,
  sessionId: row.session_id,
  endedAt: row.ended_at,
  tokenBudget: Number(row.token_budget),
});

/** A queued question a machine may take now, with what its visit is built from. */
export interface InquiryCandidate {
  id: string;
  threadId: string;
  messageId: string;
  askedBy: string;
  instanceId: string;
  actorId: string;
  continuityKey: string;
  tokenBudget: number;
  resume: SessionResume;
  /** The question, which the visit's assignment carries. */
  body: string;
  /** The thread's newest work visit, whose step the conversation is of. */
  latest: Session;
}

/**
 * The visit an inquiry runs as: the thread's actor and conversation, a short deadline, and an
 * assignment and execution of its own that name the step the conversation is of. It holds no
 * lease and binds no registration. Its policy is read-only with no workspace and no tools: what
 * it may call is the project's reads and its one reply, which Sessions admits for inquiry visits
 * alone.
 */
export function inquirySession(input: {
  id: string;
  candidate: InquiryCandidate;
  projectId: string;
  source: DelegationSource;
  runnerId: string;
  createdAt: string;
  hardDeadline: string;
}): InquirySession {
  const { candidate, id, projectId } = input;
  const { latest } = candidate;
  const step = {
    instanceId: candidate.instanceId,
    projectId,
    actorId: candidate.actorId,
    workflow: latest.execution.workflow,
    version: latest.execution.version,
    state: latest.execution.state,
    revision: latest.expectedRevision,
  };
  const name = workName(latest.assignment);
  return {
    kind: 'inquiry',
    id,
    threadId: candidate.threadId,
    projectId,
    actorId: candidate.actorId,
    source: input.source,
    instanceId: candidate.instanceId,
    expectedRevision: latest.expectedRevision,
    role: 'reader',
    status: 'offered',
    runnerId: input.runnerId,
    hostRef: null,
    createdAt: input.createdAt,
    activatedAt: null,
    expiresAt: input.hardDeadline,
    hardDeadline: input.hardDeadline,
    closedAt: null,
    closeReason: null,
    outcome: null,
    assignment: {
      ...step,
      workStart: null,
      role: 'reader',
      label: `Inquiry: ${name}`,
      name,
      // What an inquiry is, and how it is answered, its worker prompt says (workerPrompt).
      brief: `The question: ${candidate.body}`,
      references: [],
      handoff: { instruction: '', tools: ['session.message.ack'] },
      execution: { readOnly: true, tools: [] },
      context: null,
    },
    execution: { ...step, policy: { readOnly: true, tools: [] } },
    continuity: { key: candidate.continuityKey, resume: candidate.resume },
    tokenBudget: candidate.tokenBudget,
    inquiry: { id: candidate.id, messageId: candidate.messageId, askedBy: candidate.askedBy },
  };
}

/** What the thread's next work visit reads of an inquiry it did not take part in. */
export const inquiryContext = (question: string, reply: string) =>
  clip(
    `While your work was away, a person asked an inquiry visit of yours (your conversation as you left it, read-only) a question, and it answered. Nothing in your work changed because of it; acknowledge this and carry on.\n\nThe question: ${question}\n\nYour answer: ${reply}`,
    16_000,
  );

/** What the inquiries module uses of Sessions. */
export interface InquiryHost {
  transaction<T>(fn: (tx: Transaction) => T | Promise<T>): Promise<T>;
  /** Refuses a caller who may not read the work item. */
  readable(caller: Caller, instanceId: string, tx: Transaction): Promise<unknown>;
  /** The project's automatic dispatch, which launches inquiry visits too. */
  dispatching(projectId: string, tx: Transaction): Promise<DispatchState>;
  decode(row: { thread_id: string; session_json: string }): Session;
}

/**
 * A person's questions to any thread's agent, live, dormant or retired. Each is a message to the
 * thread whose reply is the answer, and an inquiry that a machine takes as a short read-only
 * visit resuming the thread's saved conversation: one open per thread, a few minutes to be taken
 * and as long to answer, and a token budget charged to the person who asked.
 */
export class Inquiries implements SessionInquiries {
  constructor(
    private readonly state: State,
    private readonly scope: Scope,
    private readonly clock: () => number,
    private readonly host: InquiryHost,
  ) {}
  async ask(caller: Caller, input: ThreadInquiryInput): Promise<ThreadInquiry> {
    ordinary(caller);
    check(!caller.session && !caller.managed, 'forbidden', 'Workers cannot ask other agents', 403);
    check(
      input &&
        typeof input === 'object' &&
        Object.keys(input).every((key) => ['threadId', 'body', 'requestId'].includes(key)) &&
        text(input.threadId, 200) &&
        text(input.body, 8_000) &&
        text(input.requestId, 200),
      'invalid_inquiry',
      'A thread ID, a question of 1–8000 characters and a stable requestId are required',
    );
    caller = structuredClone(caller);
    input = structuredClone(input);
    return await this.host.transaction(async (tx) => {
      await this.scope.require(caller, 'write', tx);
      const fingerprint = digest({ threadId: input.threadId, body: input.body });
      const old = await tx.get<InquiryRow>(
        `${INQUIRY} WHERE i.project_id=? AND i.asker_actor_id=? AND i.request_id=?`,
        caller.projectId,
        caller.actorId,
        input.requestId,
      );
      if (old) {
        check(
          old.fingerprint === fingerprint,
          'request_conflict',
          'Inquiry requestId was used for different input',
          409,
        );
        return view(old);
      }
      const thread = await tx.get<{
        id: string;
        project_id: string;
        instance_id: string;
        size: number | string | null;
      }>('SELECT id,project_id,instance_id,size FROM session_threads WHERE id=?', input.threadId);
      check(
        thread && thread.project_id === caller.projectId,
        'thread_not_found',
        'Thread not found in this project',
        404,
      );
      await this.host.readable(caller, thread.instance_id, tx);
      const refused = (await this.refusals(tx, caller.projectId, [thread.id])).get(thread.id);
      if (refused) throw refused;
      const now = this.clock();
      const budget = inquiryBudget(Number(thread.size ?? 0));
      // What its visits spent is in Sessions' one usage ledger, as its runners reported it; one
      // still open, or that ran with no report, counts its whole budget.
      const day = await tx.get<{ spent: number | string }>(
        `SELECT COALESCE(SUM(CASE WHEN i.status IN ('queued','running') OR (u.started_at IS NOT NULL AND u.reported_at IS NULL)
            THEN i.token_budget ELSE COALESCE(u.input_tokens,0)+COALESCE(u.output_tokens,0) END),0) AS spent
          FROM session_inquiries i LEFT JOIN session_usage u ON u.session_id=i.session_id
          WHERE i.project_id=? AND i.asker_actor_id=? AND i.asked_at>?`,
        caller.projectId,
        caller.actorId,
        new Date(now - 86_400_000).toISOString(),
      );
      check(
        Number(day?.spent ?? 0) + budget <= INQUIRY_DAILY_TOKENS,
        'inquiry_tokens_spent',
        'Your questions to agents have spent their model tokens for the last day; ask again later',
        429,
      );
      const source = await this.scope.delegationSource(caller, tx);
      const id = newId('inquiry');
      const messageId = newId('session_message');
      const at = new Date(now).toISOString();
      await tx.run(
        "INSERT INTO session_messages(id,project_id,thread_id,sender_actor_id,request_id,fingerprint,body,created_at,inquiry_id,inquiry_role) VALUES(?,?,?,?,?,?,?,?,?,'question')",
        messageId,
        caller.projectId,
        thread.id,
        caller.actorId,
        `inquiry:${input.requestId}`,
        fingerprint,
        input.body,
        at,
        id,
      );
      await tx.run(
        "INSERT INTO session_inquiries(id,project_id,thread_id,message_id,asker_actor_id,asker_source_json,request_id,fingerprint,status,asked_at,wait_until,token_budget) VALUES(?,?,?,?,?,?,?,?,'queued',?,?,?)",
        id,
        caller.projectId,
        thread.id,
        messageId,
        caller.actorId,
        JSON.stringify(source),
        input.requestId,
        fingerprint,
        at,
        new Date(now + INQUIRY_WAIT_MS).toISOString(),
        budget,
      );
      await this.state.appendEvent(tx, {
        projectId: caller.projectId,
        actorId: caller.actorId,
        type: 'session.inquiry_asked',
        subjectId: thread.id,
        data: { inquiryId: id, threadId: thread.id, messageId, instanceId: thread.instance_id },
      });
      return view((await tx.get<InquiryRow>(`${INQUIRY} WHERE i.id=?`, id))!);
    });
  }
  /**
   * Why each of these threads' agents may not be asked now, where it may not: the one rule `ask`
   * refuses by and a thread's `asks` says. It kept a conversation to resume, nothing asked of it
   * is still open, the project's dispatch is on, and a machine could take the question: a Claude
   * conversation is resumed by a machine of its owner's, and a Codex one only by a hosted
   * machine, whose model relay holds the visit to its budget (Codex reports its spend only as
   * its turn ends), so only where its work last ran on one and the project is not on its own
   * machines, which Fleet rents none for.
   */
  async refusals(
    tx: Transaction,
    projectId: string,
    threadIds: readonly string[],
  ): Promise<Map<string, MervError>> {
    if (!threadIds.length) return new Map();
    const dispatch = await this.host.dispatching(projectId, tx);
    const rows = await tx.all<{
      id: string;
      kept: boolean;
      busy: boolean;
      codex: boolean;
      hosted: boolean;
    }>(
      `SELECT t.id,t.sha256 IS NOT NULL AND t.uploaded_at IS NOT NULL AS kept,
          EXISTS (SELECT 1 FROM session_inquiries i WHERE i.thread_id=t.id AND i.status IN ('queued','running')) AS busy,
          t.harness='codex' AS codex,
          EXISTS (SELECT 1 FROM (SELECT s.id FROM worker_sessions s WHERE s.thread_id=t.id AND s.kind='work'
              ORDER BY s._merv_rowid DESC LIMIT 1) w
            WHERE EXISTS (SELECT 1 FROM session_managed_assignments a WHERE a.session_id=w.id)
              OR EXISTS (SELECT 1 FROM session_managed_runners r WHERE r.bound_session_id=w.id)) AS hosted
        FROM session_threads t WHERE t.project_id=? AND t.id IN (${threadIds.map(() => '?').join(',')})`,
      projectId,
      ...threadIds,
    );
    const refusals = new Map<string, MervError>();
    for (const row of rows) {
      const refusal = !row.kept
        ? new MervError(
            'inquiry_unkept',
            'This agent kept no conversation to resume: a fresh agent would know nothing of its work, so there is nobody to ask',
            409,
          )
        : row.busy
          ? new MervError(
              'inquiry_busy',
              'This agent is still on an earlier question; ask again once it has answered',
              409,
            )
          : !dispatch.enabled
            ? new MervError(
                'dispatch_disabled',
                'Automatic dispatch is off in this project, so no machine would take the question',
                409,
              )
            : row.codex && !(row.hosted && !dispatch.ownMachines)
              ? new MervError(
                  'inquiry_unreachable',
                  'No machine would take this question: a Codex conversation is resumed only on a hosted machine, where its work ran on one and Fleet rents them for this project',
                  409,
                )
              : undefined;
      if (refusal) refusals.set(row.id, refusal);
    }
    return refusals;
  }
  /**
   * The oldest queued question of the project a machine of `ownerHash` may take: its thread's
   * conversation was kept by `harness` and its work visits ran under the same owner (whose
   * machines alone resume it, as continuity does), on `workInstanceId` alone for a work host.
   * Those `skip` names, which this lease was refused, are passed over.
   */
  async candidate(
    tx: Transaction,
    projectId: string,
    ownerHash: string,
    harness: string,
    workInstanceId: string | null,
    skip: readonly string[] = [],
  ): Promise<InquiryCandidate | undefined> {
    const row = await tx.get<{
      id: string;
      thread_id: string;
      message_id: string;
      asker_actor_id: string;
      token_budget: number | string;
      instance_id: string;
      actor_id: string;
      continuity_key: string;
      latest_session_id: string;
      harness: SessionResume['harness'];
      conversation_id: string;
      sha256: string;
      size: number | string;
      body: string;
      visit_id: string;
      visit_thread: string;
      visit_json: string;
    }>(
      `SELECT i.id,i.thread_id,i.message_id,i.asker_actor_id,i.token_budget,t.instance_id,t.actor_id,t.continuity_key,
          t.latest_session_id,t.harness,t.conversation_id,t.sha256,t.size,m.body,
          w.id AS visit_id,w.thread_id AS visit_thread,w.session_json AS visit_json
        FROM session_inquiries i JOIN session_threads t ON t.id=i.thread_id
        JOIN session_messages m ON m.id=i.message_id
        CROSS JOIN LATERAL (SELECT s.id,s.thread_id,s.owner_hash,s.session_json FROM worker_sessions s
          WHERE s.thread_id=t.id AND s.kind='work' ORDER BY s._merv_rowid DESC LIMIT 1) w
        WHERE i.project_id=? AND i.status='queued' AND i.wait_until>? AND t.harness=?
          AND t.sha256 IS NOT NULL AND t.uploaded_at IS NOT NULL AND t.continuity_key IS NOT NULL
          AND w.owner_hash=? AND (CAST(? AS TEXT) IS NULL OR t.instance_id=?)
          ${skip.length ? `AND i.id NOT IN (${skip.map(() => '?').join(',')})` : ''}
        ORDER BY i._merv_rowid LIMIT 1`,
      projectId,
      isoNow(this.clock),
      harness,
      ownerHash,
      workInstanceId,
      workInstanceId,
      ...skip,
    );
    if (!row) return undefined;
    return {
      id: row.id,
      threadId: row.thread_id,
      messageId: row.message_id,
      askedBy: row.asker_actor_id,
      tokenBudget: Number(row.token_budget),
      instanceId: row.instance_id,
      actorId: row.actor_id,
      continuityKey: row.continuity_key,
      resume: {
        sessionId: row.latest_session_id,
        harness: row.harness,
        conversationId: row.conversation_id,
        sha256: row.sha256,
        size: Number(row.size),
      },
      body: row.body,
      latest: this.host.decode({ thread_id: row.visit_thread, session_json: row.visit_json }),
    };
  }
  /** The work items with a question a machine of `ownerHash` running `harness` could take now,
   *  each at its current revision: what Fleet rents a work host for. */
  async demand(
    tx: Transaction,
    projectId: string,
    ownerHash: string,
    harness: string,
  ): Promise<string[]> {
    return (
      await tx.all<{ instance_id: string }>(
        `SELECT DISTINCT t.instance_id FROM session_inquiries i JOIN session_threads t ON t.id=i.thread_id
          CROSS JOIN LATERAL (SELECT s.owner_hash FROM worker_sessions s
            WHERE s.thread_id=t.id AND s.kind='work' ORDER BY s._merv_rowid DESC LIMIT 1) w
          WHERE i.project_id=? AND i.status='queued' AND i.wait_until>? AND t.harness=?
            AND t.sha256 IS NOT NULL AND t.uploaded_at IS NOT NULL AND w.owner_hash=?`,
        projectId,
        isoNow(this.clock),
        harness,
        ownerHash,
      )
    ).map((row) => row.instance_id);
  }
  /** Its visit took the question: the inquiry runs, or another lease took it first. */
  async started(tx: Transaction, inquiryId: string, sessionId: string): Promise<void> {
    const result = await tx.run(
      "UPDATE session_inquiries SET status='running',session_id=? WHERE id=? AND status='queued'",
      sessionId,
      inquiryId,
    );
    check(result.changes === 1, 'inquiry_taken', 'The question was taken by another machine', 409);
  }
  /** Its visit closed: answered when the question's message carries the reply, else not. */
  async closed(tx: Transaction, session: InquirySession): Promise<void> {
    const ref = session.inquiry!;
    const replied = await tx.get<{ reply_body: string | null }>(
      'SELECT reply_body FROM session_messages WHERE id=?',
      ref.messageId,
    );
    const status: InquiryStatus = replied?.reply_body
      ? 'answered'
      : session.closeReason === 'session_expired'
        ? 'expired'
        : 'unanswered';
    await tx.run(
      "UPDATE session_inquiries SET status=?,ended_at=? WHERE id=? AND status='running'",
      status,
      session.closedAt ?? isoNow(this.clock),
      ref.id,
    );
    await this.state.appendEvent(tx, {
      projectId: session.projectId,
      actorId: 'system:sessions',
      type: 'session.inquiry_closed',
      subjectId: session.id,
      data: {
        sessionId: session.id,
        inquiryId: ref.id,
        threadId: session.threadId,
        instanceId: session.instanceId,
        status,
        reason: session.closeReason ?? 'released',
        source: session.source,
      },
    });
  }
  /** The sweep: questions no machine took in time. */
  async expire(tx: Transaction): Promise<void> {
    const at = isoNow(this.clock);
    // Read first, so a pass with nothing to expire takes no writer.
    if (
      !(await tx.get(
        "SELECT 1 FROM session_inquiries WHERE status='queued' AND wait_until<=? LIMIT 1",
        at,
      ))
    )
      return;
    await tx.run(
      "UPDATE session_inquiries SET status='expired',ended_at=? WHERE status='queued' AND wait_until<=?",
      at,
      at,
    );
  }
  /** An inquiry visit's question and asker, for its message reads and its relay grant. */
  async asker(tx: Transaction, sessionId: string): Promise<DelegationSource | undefined> {
    const row = await tx.get<{ asker_source_json: string }>(
      'SELECT asker_source_json FROM session_inquiries WHERE session_id=?',
      sessionId,
    );
    return row ? JSON.parse(row.asker_source_json) : undefined;
  }
  /** The statuses of these inquiries, for the thread's messages read. */
  async statuses(tx: Transaction, ids: string[]): Promise<Map<string, InquiryStatus>> {
    if (!ids.length) return new Map();
    return new Map(
      (
        await tx.all<{ id: string; status: InquiryStatus }>(
          `SELECT id,status FROM session_inquiries WHERE id IN (${ids.map(() => '?').join(',')})`,
          ...ids,
        )
      ).map((row) => [row.id, row.status]),
    );
  }
}

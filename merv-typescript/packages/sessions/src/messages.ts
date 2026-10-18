import {
  check,
  clip,
  digest,
  MervError,
  newId,
  type Caller,
  type Scope,
  type State,
  type Transaction,
} from '@merv/contracts';
import type { WorkflowProvidedBlockerInput } from '@merv/workflows/models';
import { isoNow, live, ordinary, text, threadIn, type Row } from './common.js';
import { QuestionResponders } from './question-responder.js';
import type { QuestionResponse } from './models.js';
import { messageInquiry } from './inquiries.js';
import type {
  QuestionResponder,
  QuestionResolution,
  InquirySession,
  InquiryStatus,
  OwnerAnswer,
  Session,
  SessionMessage,
  SessionMessageInput,
  ThreadMessages,
  ThreadQuestion,
  WorkerQueue,
} from './types.js';

interface MessageRow {
  id: string;
  project_id: string;
  thread_id: string;
  sender_actor_id: string;
  request_id: string;
  fingerprint: string;
  body: string;
  created_at: string;
  acknowledged_at: string | null;
  ack_request_id: string | null;
  reply_body: string | null;
  /** An inquiry's question (whose reply is its answer), or the context its thread's work reads. */
  inquiry_id: string | null;
  inquiry_role: 'question' | 'context' | null;
}
/** A question a worker asked its owner, as `session_questions` holds it. */
export interface QuestionRow {
  response_json?: string | null;
  id: string;
  project_id: string;
  thread_id: string;
  session_id: string;
  instance_id: string;
  revision: number | string;
  question: string;
  asked_at: string;
  answered_at: string | null;
  answer_message_id: string | null;
}
/**
 * The threads whose messages a visit of a thread reads: its own, and each other one of its
 * continuity key, so a message to a thread its key has since replaced (a conversation that
 * never reached the store) still reaches the key's worker. A union of the id and a lookup by
 * (project, key), each of which reads an index; its parameters are `keyThreads`'.
 */
const KEY_THREADS = `SELECT CAST(? AS TEXT) UNION SELECT o.id FROM session_threads o
  WHERE o.project_id=? AND o.continuity_key=(SELECT t.continuity_key FROM session_threads t WHERE t.id=?)`;
const keyThreads = (session: Pick<Session, 'projectId' | 'threadId'>) => [
  session.threadId,
  session.projectId,
  session.threadId,
];
/** What a work visit reads of a thread's messages: all but inquiries' questions, which their
 *  inquiry visits answer; it reads the context of each answer instead. */
const FOR_WORK = "inquiry_role IS DISTINCT FROM 'question'";
/** How long a message shown to a visit is not shown again by a refusal: one batch of calls. */
const SHOWN_MS = 60_000;
/** What a worker's queue tells it to do with a message that waits, by its visit's kind. */
const QUEUE_NEXT = {
  work: 'Acknowledge each message here not yet acknowledged (acknowledgedAt null) with session.message.ack (messageId, a stable requestId, and a reply saying what you will do) before any other Merv call: until you do, every other call is refused with session_message_pending.',
  inquiry:
    'Answer the question with session.message.ack (messageId, reply, requestId): that reply is your answer, and it ends this visit.',
};
/** The provider Sessions publishes an unanswered question as, on the work it withholds. */
export const QUESTION_PROVIDER = 'session-question';
/**
 * Where a set of threads' open questions stand, read once (`SessionMessages.standing`): those
 * that still stand, and which of the work items read have ended.
 */
export interface Standing {
  /** The open questions that stand, oldest first: none is about work that has ended. */
  questions: QuestionRow[];
  /** Which of the work items read (each open question's, and those asked about) have ended. */
  ended: Set<string>;
}
/**
 * Whether a thread takes a message now, by the one rule: it answers a question the thread asked
 * that still stands, or the thread is not retired and its work has not ended, so a visit will
 * read it. `standing` must have read the thread and its work item.
 */
export const takesMessage = (
  thread: { id: string; instance_id: string; status: string },
  standing: Standing,
) =>
  standing.questions.some((question) => question.thread_id === thread.id) ||
  (thread.status !== 'retired' && !standing.ended.has(thread.instance_id));
const question = (row: QuestionRow, open: boolean): ThreadQuestion => ({
  ...(row.response_json ? { response: JSON.parse(row.response_json) as QuestionResponse } : {}),
  id: row.id,
  threadId: row.thread_id,
  sessionId: row.session_id,
  instanceId: row.instance_id,
  revision: Number(row.revision),
  question: row.question,
  askedAt: row.asked_at,
  answeredAt: row.answered_at,
  answerMessageId: row.answer_message_id,
  open,
});

/** A row of `session_messages`, as its one writer (`SessionMessages.insert`) takes it. */
export interface MessageInsert {
  projectId: string;
  threadId: string;
  senderActorId: string;
  requestId: string;
  fingerprint: string;
  body: string;
  /** An inquiry's question (whose reply is its answer), or the context its answer left. */
  inquiry?: { id: string; role: 'question' | 'context' };
}
/** What messaging uses of Sessions: its transactions, session rows and a visit's close. */
export interface MessageHost {
  transaction<T>(fn: (tx: Transaction) => T | Promise<T>): Promise<T>;
  reading<T>(fn: (tx: Transaction) => T | Promise<T>): Promise<T>;
  row(tx: Transaction, id: string): Promise<Row>;
  decode(row: Row): Session;
  /** Closes a visit that asked its owner: released, not counted against the work. */
  asked(session: Session, tx: Transaction): Promise<void>;
  /** An inquiry visit replied to its question: it ends, and its thread's work is told. */
  answered(
    session: InquirySession,
    question: string,
    reply: string,
    tx: Transaction,
  ): Promise<void>;
  /** Where these inquiries stand. */
  inquiryStatuses(tx: Transaction, ids: string[]): Promise<Map<string, InquiryStatus>>;
  /** Refuses a caller who may not read the work item. */
  readable(caller: Caller, instanceId: string, tx: Transaction): Promise<unknown>;
  /** Sessions' whole opinion of one instance, as Workflows keeps it for the work's gate. */
  publish(
    input: { projectId: string; instanceId: string; blockers: WorkflowProvidedBlockerInput[] },
    tx: Transaction,
  ): Promise<void>;
  /** Where these work items of the project stand: each one's revision, and whether it ended. */
  work(
    projectId: string,
    instanceIds: string[],
    tx: Transaction,
  ): Promise<Map<string, { revision: number; ended: boolean }>>;
}

/**
 * Messages between the people over a project and its workers: a person's to a thread, which
 * the visit that reads it acknowledges, and a worker's question to its owner,
 * which ends its visit and withholds its work from dispatch until a message to its thread
 * answers it.
 */
export class SessionMessages {
  readonly responders: QuestionResponders;
  constructor(
    private readonly state: State,
    private readonly scope: Scope,
    private readonly clock: () => number,
    private readonly host: MessageHost,
  ) {
    this.responders = new QuestionResponders(
      host,
      clock,
      (tx, row) => this.stands(tx, row),
      (project, instance, tx) => this.report(project, instance, tx),
      question,
    );
  }
  /** Whether this question still stands (`standing`, the one rule). */
  private async stands(tx: Transaction, row: QuestionRow): Promise<boolean> {
    const { questions } = await this.standing(tx, row.project_id, { instance: row.instance_id });
    return questions.some((q) => q.id === row.id);
  }
  registerResponder(responder: QuestionResponder): () => Promise<void> {
    return this.responders.register(responder);
  }
  /** Only the bound investigation can resolve this exact question. Human messages remain available. */
  async resolve(caller: Caller, input: QuestionResolution): Promise<ThreadQuestion> {
    check(
      caller.conversation && !caller.session && !caller.managed,
      'conversation_required',
      'Only the bound responder conversation resolves a question',
      403,
    );
    check(
      text(input.questionId, 200) &&
        Number.isSafeInteger(input.expectedRevision) &&
        input.expectedRevision >= 0 &&
        ['answered', 'needs_you'].includes(input.outcome) &&
        text(input.body, 8000) &&
        text(input.requestId, 200),
      'invalid_question_resolution',
      'An exact question, revision, outcome, explanation and stable requestId are required',
    );
    caller = structuredClone(caller);
    input = structuredClone(input);
    return await this.host.transaction(async (tx) => {
      await this.scope.require(caller, 'write', tx);
      const row = await tx.get<QuestionRow>(
        'SELECT * FROM session_questions WHERE id=? AND project_id=?',
        input.questionId,
        caller.projectId,
      );
      check(row, 'question_not_found', 'Question not found', 404);
      const response = await this.responders.read(tx, row.id);
      check(
        response && JSON.parse(response.data_json).reference?.id === caller.conversation!.id,
        'question_responder_forbidden',
        'This conversation is not the question’s responder',
        403,
      );
      const fingerprint = digest(input);
      const receipt = response.receipt_json && JSON.parse(response.receipt_json);
      if (receipt?.requestId === input.requestId) {
        check(
          receipt.fingerprint === fingerprint,
          'request_conflict',
          'Resolution requestId was reused',
          409,
        );
        return question(
          { ...row, response_json: response.data_json },
          !row.answered_at && (await this.stands(tx, row)),
        );
      }
      check(
        Number(row.revision) === input.expectedRevision && (await this.stands(tx, row)),
        'question_obsolete',
        'This question has already been answered or its work has moved on',
        409,
      );
      await this.host.readable(caller, row.instance_id, tx);
      if (input.outcome === 'answered') {
        await this.toThread(
          caller,
          row.thread_id,
          {
            threadId: row.thread_id,
            requestId: `question:${row.id}`,
            body: `${JSON.parse(response.data_json).label} acting on your behalf:\n\n${input.body}`,
          },
          fingerprint,
          tx,
          row.id,
        );
      }
      if (input.outcome === 'needs_you')
        await this.responders.finish(tx, row, 'needs_you', input.body);
      await tx.run(
        'UPDATE session_question_responses SET receipt_json=? WHERE question_id=?',
        JSON.stringify({ requestId: input.requestId, fingerprint }),
        row.id,
      );
      await this.state.appendEvent(tx, {
        projectId: caller.projectId,
        actorId: caller.actorId,
        type: 'session.question_resolved',
        subjectId: row.thread_id,
        data: {
          questionId: row.id,
          revision: input.expectedRevision,
          outcome: input.outcome,
          conversationId: caller.conversation!.id,
        },
      });
      return question(
        {
          ...(await tx.get<QuestionRow>('SELECT * FROM session_questions WHERE id=?', row.id))!,
          response_json: (await this.responders.read(tx, row.id))!.data_json,
        },
        input.outcome !== 'answered',
      );
    });
  }
  private async messageRow(tx: Transaction, id: string): Promise<MessageRow> {
    const row = await tx.get<MessageRow>('SELECT * FROM session_messages WHERE id=?', id);
    check(row, 'session_message_not_found', 'Session message not found', 404);
    return row;
  }
  private publicMessage(
    row: MessageRow,
    instanceId: string,
    inquiries?: Map<string, InquiryStatus>,
  ): SessionMessage {
    const status = row.inquiry_role === 'question' && inquiries?.get(row.inquiry_id!);
    const inquiry = status ? { inquiry: messageInquiry(row.inquiry_id!, status) } : {};
    return {
      id: row.id,
      threadId: row.thread_id,
      instanceId,
      senderActorId: row.sender_actor_id,
      body: row.body,
      createdAt: row.created_at,
      acknowledgedAt: row.acknowledged_at,
      reply: row.reply_body,
      ...inquiry,
    };
  }
  /** A visit reads the messages to its thread's (`KEY_THREADS`). */
  private async addressed(tx: Transaction, session: Session): Promise<MessageRow[]> {
    // An inquiry visit reads its one question, and nothing meant for its thread's work.
    if (session.kind === 'inquiry')
      return await tx.all<MessageRow>(
        'SELECT * FROM session_messages WHERE id=?',
        session.inquiry.messageId,
      );
    return await tx.all<MessageRow>(
      `SELECT * FROM session_messages WHERE project_id=? AND thread_id IN (${KEY_THREADS}) AND ${FOR_WORK} ORDER BY _merv_rowid`,
      session.projectId,
      ...keyThreads(session),
    );
  }
  /**
   * When a visit was last shown each message it has yet to acknowledge, in this process: a
   * refusal carries a message's text once, not once per call of a parallel batch. Only how much
   * a refusal says depends on it, so a restart that forgets it costs a repeated text, no more.
   */
  private readonly shown = new Map<string, number>();
  private show(sessionId: string, messageId: string): boolean {
    const key = `${sessionId} ${messageId}`;
    const at = this.shown.get(key);
    if (at !== undefined && this.clock() - at < SHOWN_MS) return false;
    if (this.shown.size >= 1000) this.shown.clear();
    this.shown.set(key, this.clock());
    return true;
  }
  /**
   * Refuses a visit's call while a message to it waits for its acknowledgement: `unstarted`
   * before its handler runs, else the write it is about to commit. The refusal carries the
   * oldest such message, so the worker can acknowledge it at once and send its call again,
   * without first reading its queue.
   */
  async requireMessagesAcknowledged(
    sessionId: string,
    tx: Transaction,
    unstarted = false,
  ): Promise<void> {
    const session = await tx.get<{ project_id: string; thread_id: string; kind: string }>(
      'SELECT project_id,thread_id,kind FROM worker_sessions WHERE id=?',
      sessionId,
    );
    // An inquiry visit writes nothing a message could fence, and answers only its question.
    if (!session || session.kind === 'inquiry') return;
    const row = await tx.get<MessageRow & { pending: number | string }>(
      `SELECT *,COUNT(*) OVER () AS pending FROM session_messages WHERE project_id=? AND acknowledged_at IS NULL
        AND thread_id IN (${KEY_THREADS}) AND ${FOR_WORK} ORDER BY _merv_rowid LIMIT 1`,
      session.project_id,
      ...keyThreads({ projectId: session.project_id, threadId: session.thread_id }),
    );
    if (!row) return;
    const pending = Number(row.pending);
    const shown = this.show(sessionId, row.id);
    const one = pending === 1;
    throw new MervError(
      'session_message_pending',
      [
        `${one ? 'A message to your thread awaits' : `${pending} messages to your thread await`} your acknowledgement, so ${unstarted ? 'this call was refused and nothing of it was applied' : 'the write this call was about to commit was refused'}.`,
        shown
          ? `${one ? 'It is' : 'The oldest is'} in details.message${one ? '' : '; session.messages lists them all'}.`
          : 'You were shown its text moments ago; session.messages reads it again.',
        `Acknowledge ${one ? 'it' : 'each'} with session.message.ack (messageId, a stable requestId, and a reply saying what you will do), then send this call again, as it was unless the message changes what it should do.`,
      ].join(' '),
      409,
      {
        messageId: row.id,
        pending,
        ...(shown && {
          message: {
            id: row.id,
            senderActorId: row.sender_actor_id,
            createdAt: row.created_at,
            body: row.body,
          },
        }),
      },
    );
  }
  /** A person's message to a thread, which its live visit or its next one reads. */
  async message(caller: Caller, input: SessionMessageInput): Promise<SessionMessage> {
    ordinary(caller);
    check(
      !caller.session && !caller.managed,
      'forbidden',
      'Workers cannot send operator messages',
      403,
    );
    check(
      text(input?.threadId, 200) && text(input.body, 8_000) && text(input.requestId, 200),
      'invalid_session_message',
      'A thread ID, a message of 1–8000 characters and a stable requestId are required',
    );
    caller = structuredClone(caller);
    input = structuredClone(input);
    return await this.host.transaction(async (tx) => {
      await this.scope.require(caller, 'write', tx);
      const fingerprint = digest({ threadId: input.threadId, body: input.body });
      const old = await tx.get<MessageRow>(
        'SELECT * FROM session_messages WHERE project_id=? AND sender_actor_id=? AND request_id=?',
        caller.projectId,
        caller.actorId,
        input.requestId,
      );
      if (old) {
        check(
          old.fingerprint === fingerprint,
          'request_conflict',
          'Message requestId was used for different input',
          409,
        );
        const { instance_id } = await threadIn(tx, caller.projectId, old.thread_id);
        return this.publicMessage(old, instance_id);
      }
      return await this.toThread(caller, input.threadId, input, fingerprint, tx);
    });
  }
  /** The one writer of `session_messages`: a person's message, or an inquiry's question or the
   *  context its answer leaves the thread's work. */
  async insert(tx: Transaction, row: MessageInsert): Promise<string> {
    const id = newId('session_message');
    await tx.run(
      'INSERT INTO session_messages(id,project_id,thread_id,sender_actor_id,request_id,fingerprint,body,created_at,inquiry_id,inquiry_role) VALUES(?,?,?,?,?,?,?,?,?,?)',
      id,
      row.projectId,
      row.threadId,
      row.senderActorId,
      row.requestId,
      row.fingerprint,
      row.body,
      isoNow(this.clock),
      row.inquiry?.id ?? null,
      row.inquiry?.role ?? null,
    );
    return id;
  }
  /**
   * The one read of whether a question stands, which threads, counts, attention, the Agents
   * page's cards and the thread's box all ask: a question still unanswered stands while the work
   * it asked about has neither ended nor moved past the revision it asked at (either took its
   * blocker with it, whichever work item its thread is on now). Read for the project, or only `threads`' questions or `instance`'s;
   * `instances` are work items whose end the caller reads too, in the same one check.
   */
  async standing(
    tx: Transaction,
    projectId: string,
    read: { threads?: readonly string[]; instance?: string; instances?: readonly string[] } = {},
  ): Promise<Standing> {
    if (read.threads && !read.threads.length) return { questions: [], ended: new Set() };
    const open = await tx.all<QuestionRow>(
      `SELECT q.*,r.data_json AS response_json FROM session_questions q LEFT JOIN session_question_responses r ON r.question_id=q.id WHERE project_id=? AND answered_at IS NULL
        ${read.threads ? `AND thread_id IN (${read.threads.map(() => '?').join(',')})` : ''}
        ${read.instance === undefined ? '' : 'AND instance_id=?'} ORDER BY q._merv_rowid`,
      projectId,
      ...(read.threads ?? []),
      ...(read.instance === undefined ? [] : [read.instance]),
    );
    const items = [...new Set([...open.map((row) => row.instance_id), ...(read.instances ?? [])])];
    const work = items.length
      ? await this.host.work(projectId, items, tx)
      : new Map<string, { revision: number; ended: boolean }>();
    const ended = new Set([...work].filter(([, item]) => item.ended).map(([id]) => id));
    // A question is about the revision it asked at, as its blocker is: work that ended, or moved
    // on by any hand, no longer waits on it.
    const stands = (row: QuestionRow) => {
      const item = work.get(row.instance_id);
      return !!item && !item.ended && item.revision === Number(row.revision);
    };
    return { questions: open.filter(stands), ended };
  }
  /**
   * A message to a thread waits for its live or next visit. It answers every question the thread
   * asked that still stands, which lets dispatch offer that work again, and never one that no
   * longer stands; a thread that takes no message otherwise (`takesMessage`) is refused.
   */
  private async toThread(
    caller: Caller,
    threadId: string,
    input: SessionMessageInput,
    fingerprint: string,
    tx: Transaction,
    questionId?: string,
  ): Promise<SessionMessage> {
    const thread = await threadIn(tx, caller.projectId, threadId);
    await this.host.readable(caller, thread.instance_id, tx);
    const standing = await this.standing(tx, caller.projectId, {
      threads: [thread.id],
      instances: [thread.instance_id],
    });
    if (caller.conversation && !questionId) {
      const bound = await tx.get(
        `SELECT 1 FROM session_question_responses r JOIN session_questions q ON q.id=r.question_id WHERE q.thread_id=? AND r.data_json::jsonb#>>'{reference,id}'=?`,
        thread.id,
        caller.conversation.id,
      );
      check(
        !bound,
        'question_resolution_required',
        'Use session.question.resolve with the exact question and revision',
        409,
      );
    }
    const open = questionId
      ? standing.questions.filter((row) => row.id === questionId)
      : standing.questions;
    check(
      takesMessage(thread, standing),
      'thread_retired',
      'This thread has ended and no visit will read a message to it',
      409,
    );
    const id = await this.insert(tx, {
      projectId: caller.projectId,
      threadId: thread.id,
      senderActorId: caller.actorId,
      requestId: input.requestId,
      fingerprint,
      body: input.body,
    });
    await this.state.appendEvent(tx, {
      projectId: caller.projectId,
      actorId: caller.actorId,
      type: 'session.message_queued',
      subjectId: thread.id,
      data: { messageId: id, threadId: thread.id, instanceId: thread.instance_id },
    });
    if (open.length) {
      const at = isoNow(this.clock);
      await tx.run(
        `UPDATE session_questions SET answered_at=?,answer_message_id=? WHERE answered_at IS NULL AND id IN (${open.map(() => '?').join(',')})`,
        at,
        id,
        ...open.map((row) => row.id),
      );
      for (const row of open) {
        if (row.response_json)
          await tx.run(
            'UPDATE session_question_responses SET state=?,data_json=? WHERE question_id=?',
            'answered',
            JSON.stringify({
              ...JSON.parse(row.response_json),
              state: 'answered',
              reason: undefined,
            }),
            row.id,
          );
      }
      for (const instanceId of new Set(open.map((row) => row.instance_id)))
        await this.report(caller.projectId, instanceId, tx);
      await this.state.appendEvent(tx, {
        projectId: caller.projectId,
        actorId: caller.actorId,
        type: 'session.question_answered',
        subjectId: thread.id,
        data: {
          threadId: thread.id,
          messageId: id,
          questionIds: open.map((row) => row.id),
          instanceId: thread.instance_id,
        },
      });
    }
    return this.publicMessage(await this.messageRow(tx, id), thread.instance_id);
  }
  /**
   * Sessions' opinion of one work item: a blocker for each of its threads with a question still
   * open, so the work's gate and session.stuck say what it waits for, or none.
   */
  private async report(projectId: string, instanceId: string, tx: Transaction): Promise<void> {
    // Ended work waits on no answer: its question is cleared with the work's other blockers.
    const { questions } = await this.standing(tx, projectId, { instance: instanceId });
    const newest = new Map(questions.map((row) => [row.thread_id, row]));
    await this.host.publish(
      {
        projectId,
        instanceId,
        blockers: [...newest.values()].map((row) => {
          const response: QuestionResponse | undefined = row.response_json
            ? JSON.parse(row.response_json)
            : undefined;
          const investigating = response?.state === 'investigating';
          return {
            key: row.thread_id,
            code: investigating ? 'agent_question_investigating' : 'agent_question',
            status: 409,
            message: `${investigating ? `${response.label} is investigating` : 'Its agent asked its owner'}: ${clip(row.question, 3_900)}`,
            next: investigating
              ? 'The responder is investigating; you can still answer directly in the thread'
              : response?.reference
                ? 'Answer its agent’s question with a message to its thread, or continue the responder conversation linked there'
                : 'Answer its agent’s question with a message to its thread; dispatch then offers the work again',
            cause: 'agent_question',
            // Its owner's move, as Workflows tells that owner and a project admin; the question
            // reaches Needs you through this blocker alone.
            whose: investigating ? ('nobody' as const) : ('owner' as const),
            // About the revision it asked at: work moved on by any hand no longer waits on it.
            revision: Number(row.revision),
            related: [{ kind: 'thread', id: row.thread_id, label: 'Its agent’s thread' }],
          };
        }),
      },
      tx,
    );
  }
  /**
   * The worker ends its visit with a question for its owner. The visit closes as released
   * (`asked_owner`), counted against nothing; its thread waits, dormant, with its conversation;
   * and dispatch withholds the work until a message to the thread answers. A visit without a
   * continuity key cannot ask: no later visit would continue its conversation.
   */
  async ask(caller: Caller, input: { question: string }): Promise<ThreadQuestion> {
    ordinary(caller);
    check(caller.session, 'session_required', 'Only an assigned worker asks its owner', 403);
    check(
      text(input?.question, 4_000),
      'invalid_question',
      'A question of 1–4000 visible characters is required',
    );
    caller = structuredClone(caller);
    const asked = input.question;
    return await this.host.transaction(async (tx) => {
      await this.scope.require(caller, 'read', tx);
      const session = this.host.decode(await this.host.row(tx, caller.session!.id));
      check(
        live(session) && session.actorId === caller.actorId,
        'session_ended',
        'This session has ended',
        409,
      );
      check(
        session.continuity,
        'question_unkept',
        'This visit keeps no conversation for a later visit to continue, so it cannot wait for an answer: finish or hand off the work instead',
        409,
      );
      const id = newId('session_question');
      await tx.run(
        'INSERT INTO session_questions(id,project_id,thread_id,session_id,instance_id,revision,question,asked_at) VALUES(?,?,?,?,?,?,?,?)',
        id,
        session.projectId,
        session.threadId,
        session.id,
        session.instanceId,
        session.expectedRevision,
        asked,
        isoNow(this.clock),
      );
      await this.responders.reserve(tx, id);
      await this.report(session.projectId, session.instanceId, tx);
      await this.state.appendEvent(tx, {
        projectId: session.projectId,
        actorId: caller.actorId,
        type: 'session.question_asked',
        subjectId: session.threadId,
        data: {
          questionId: id,
          threadId: session.threadId,
          sessionId: session.id,
          instanceId: session.instanceId,
          revision: session.expectedRevision,
        },
      });
      await this.host.asked(session, tx);
      return question(
        (await tx.get<QuestionRow>('SELECT * FROM session_questions WHERE id=?', id))!,
        true,
      );
    });
  }
  /**
   * A leased worker's queue: the messages to its thread's that await its acknowledgement and,
   * in a visit that did not resume its thread's conversation, those earlier visits acknowledged,
   * or with `all` every one, its acknowledged ones with their replies. A person reads a thread.
   */
  async messages(
    caller: Caller,
    input: { sessionId?: string; all?: boolean } = {},
  ): Promise<WorkerQueue> {
    ordinary(caller);
    check(
      caller.session,
      'session_required',
      'Only a leased worker reads its queue; read a thread with session.thread_messages',
      403,
    );
    // A visit's queue is its thread's, so it already holds what was sent to earlier visits.
    check(
      input.sessionId === undefined || input.sessionId === caller.session.id,
      'forbidden',
      'Workers read only their own queue, which already holds every message to their thread, those sent to its earlier visits included: call session.messages without sessionId',
      403,
    );
    caller = structuredClone(caller);
    return await this.host.reading(async (tx) => {
      await this.scope.require(caller, 'read', tx);
      const session = this.host.decode(await this.host.row(tx, caller.session!.id));
      const rows = await this.addressed(tx, session);
      const waiting = rows.filter((row) => row.acknowledged_at === null);
      for (const row of waiting) this.show(session.id, row.id);
      // A visit that starts its conversation afresh has read nothing an earlier one acknowledged.
      const fresh = !session.continuity?.resume;
      const listed = rows.filter(
        (row) =>
          input.all ||
          row.acknowledged_at === null ||
          (fresh && row.acknowledged_at < session.createdAt),
      );
      return {
        messages: listed.map((item) => this.publicMessage(item, session.instanceId)),
        acknowledged: rows.length - waiting.length,
        ...(waiting.length && { next: QUEUE_NEXT[session.kind] }),
      };
    });
  }
  /** A thread's messages and its questions, oldest first. */
  async thread(caller: Caller, threadId: string): Promise<ThreadMessages> {
    ordinary(caller);
    check(!caller.session, 'session_forbidden', 'A leased worker reads its own messages', 403);
    check(text(threadId, 200), 'invalid_input', 'A thread id of 1–200 characters is required');
    caller = structuredClone(caller);
    return await this.host.reading(async (tx) => {
      await this.scope.require(caller, 'read', tx);
      const thread = await threadIn(tx, caller.projectId, threadId);
      await this.host.readable(caller, thread.instance_id, tx);
      // The context an answered inquiry left its work repeats the question and its reply.
      const rows = await tx.all<MessageRow>(
        `SELECT * FROM session_messages WHERE project_id=? AND thread_id=?
          AND inquiry_role IS DISTINCT FROM 'context' ORDER BY _merv_rowid`,
        caller.projectId,
        thread.id,
      );
      const questions = await tx.all<QuestionRow>(
        'SELECT q.*,r.data_json AS response_json FROM session_questions q LEFT JOIN session_question_responses r ON r.question_id=q.id WHERE thread_id=? ORDER BY q._merv_rowid',
        thread.id,
      );
      const standing = new Set(
        (await this.standing(tx, caller.projectId, { threads: [thread.id] })).questions.map(
          (row) => row.id,
        ),
      );
      const inquiries = await this.host.inquiryStatuses(tx, [
        ...new Set(
          rows.flatMap((row) => (row.inquiry_role === 'question' ? [row.inquiry_id!] : [])),
        ),
      ]);
      return {
        threadId: thread.id,
        messages: rows.map((row) => this.publicMessage(row, thread.instance_id, inquiries)),
        questions: questions.map((row) => question(row, standing.has(row.id))),
      };
    });
  }
  /**
   * What the owner answered on one work item: the ten newest questions its agents asked with
   * session.ask_owner, on any of its threads, that a message answered, with that answer, oldest
   * first. A reviewer or a later stage of the work is offered them with its assignment, since it
   * reads no other thread's messages.
   */
  async ownerAnswers(
    tx: Transaction,
    projectId: string,
    instanceId: string,
  ): Promise<OwnerAnswer[]> {
    const rows = await tx.all<{
      id: string;
      thread_id: string;
      state: string;
      role: string;
      revision: number | string;
      asked_at: string;
      question: string;
      answered_at: string;
      answer_message_id: string;
      body: string;
    }>(
      // The stage of the visit that asked: a continuing thread's own state moves on with it.
      `SELECT q.id,q.thread_id,COALESCE(s.execution_state,t.state) AS state,t.role,q.revision,q.asked_at,q.question,q.answered_at,q.answer_message_id,m.body
        FROM session_questions q JOIN session_threads t ON t.id=q.thread_id JOIN worker_sessions s ON s.id=q.session_id
          JOIN session_messages m ON m.id=q.answer_message_id
        WHERE q.project_id=? AND q.instance_id=? AND q.answered_at IS NOT NULL
        ORDER BY q.answered_at DESC,q._merv_rowid DESC LIMIT 10`,
      projectId,
      instanceId,
    );
    return rows.reverse().map((row) => ({
      questionId: row.id,
      threadId: row.thread_id,
      state: row.state,
      role: row.role,
      revision: Number(row.revision),
      askedAt: row.asked_at,
      question: row.question,
      answeredAt: row.answered_at,
      messageId: row.answer_message_id,
      answer: row.body,
    }));
  }
  async acknowledgeMessage(
    caller: Caller,
    input: { messageId: string; reply?: string; requestId: string },
  ): Promise<SessionMessage> {
    ordinary(caller);
    check(caller.session, 'session_required', 'Only the assigned worker may acknowledge', 403);
    check(
      text(input.messageId, 200) &&
        text(input.requestId, 200) &&
        (input.reply === undefined || text(input.reply, 8_000)),
      'invalid_session_message',
      'Acknowledgement requires messageId, stable requestId and an optional reply of 1–8000 characters',
    );
    caller = structuredClone(caller);
    input = structuredClone(input);
    return await this.host.transaction(async (tx) => {
      await this.scope.require(caller, 'read', tx);
      const row = await this.messageRow(tx, input.messageId);
      const session = this.host.decode(await this.host.row(tx, caller.session!.id));
      check(
        row.project_id === caller.projectId &&
          (session.kind === 'inquiry'
            ? row.id === session.inquiry.messageId
            : row.inquiry_role !== 'question' &&
              !!(await tx.get(
                `SELECT 1 FROM (${KEY_THREADS}) k(id) WHERE k.id=?`,
                ...keyThreads(session),
                row.thread_id,
              ))),
        'session_message_not_found',
        'Message not found in this session',
        404,
      );
      check(
        session.kind === 'work' || input.reply !== undefined,
        'invalid_session_message',
        'An inquiry is answered by its reply: give one',
      );
      check(
        live(session) && session.actorId === caller.actorId,
        'session_ended',
        'This session has ended',
        409,
      );
      // An inquiry visit's reply says where its question stands: answered, its visit ended.
      const read = async (item: MessageRow) =>
        this.publicMessage(
          item,
          session.instanceId,
          session.kind === 'inquiry'
            ? await this.host.inquiryStatuses(tx, [session.inquiry.id])
            : undefined,
        );
      if (row.acknowledged_at) {
        // An acknowledgement is written once: a worker with more to say has no second reply.
        check(
          row.ack_request_id === input.requestId && row.reply_body === (input.reply ?? null),
          'request_conflict',
          `This message was already acknowledged, with requestId ${row.ack_request_id}, and an acknowledgement and its reply are written once. Put anything more for the people over your work in your work's own records and handoff, or in the reply to the next message you acknowledge; ask with session.ask_owner only when the work cannot go on without their decision.`,
          409,
        );
        return await read(row);
      }
      await tx.run(
        'UPDATE session_messages SET acknowledged_at=?,ack_request_id=?,reply_body=? WHERE id=? AND acknowledged_at IS NULL',
        isoNow(this.clock),
        input.requestId,
        input.reply ?? null,
        row.id,
      );
      await this.state.appendEvent(tx, {
        projectId: caller.projectId,
        actorId: caller.actorId,
        type: 'session.message_acknowledged',
        subjectId: session.id,
        data: {
          messageId: row.id,
          sessionId: session.id,
          threadId: row.thread_id,
          replied: input.reply !== undefined,
          ...(session.kind === 'inquiry' && { inquiryId: session.inquiry.id }),
        },
      });
      if (session.kind === 'inquiry') await this.host.answered(session, row.body, input.reply!, tx);
      return await read(await this.messageRow(tx, row.id));
    });
  }
}

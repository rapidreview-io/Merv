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
  type WorkflowProvidedBlockerInput,
} from '@merv/contracts';
import { isoNow, live, ordinary, text, type Row } from './common.js';
import type {
  QuestionMove,
  Session,
  SessionMessage,
  SessionMessageInput,
  ThreadMessages,
  ThreadQuestion,
} from './types.js';

interface MessageRow {
  id: string;
  project_id: string;
  session_id: string | null;
  thread_id: string | null;
  sender_actor_id: string;
  request_id: string;
  fingerprint: string;
  body: string;
  created_at: string;
  acknowledged_at: string | null;
  ack_request_id: string | null;
  reply_body: string | null;
}
interface QuestionRow {
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
interface ThreadRow {
  id: string;
  project_id: string;
  instance_id: string;
  status: 'open' | 'dormant' | 'retired';
}
/**
 * The threads whose messages a visit of thread `?` reads: its own, and each other one of its
 * continuity key, so a message to a thread its key has since replaced (a conversation that
 * never reached the store) still reaches the key's worker.
 */
const KEY_THREADS = `SELECT o.id FROM session_threads t JOIN session_threads o
  ON o.id=t.id OR (o.project_id=t.project_id AND o.continuity_key=t.continuity_key) WHERE t.id=?`;
/** The provider Sessions publishes an unanswered question as, on the work it withholds. */
export const QUESTION_PROVIDER = 'session-question';
const question = (row: QuestionRow): ThreadQuestion => ({
  id: row.id,
  threadId: row.thread_id,
  sessionId: row.session_id,
  instanceId: row.instance_id,
  revision: Number(row.revision),
  question: row.question,
  askedAt: row.asked_at,
  answeredAt: row.answered_at,
  answerMessageId: row.answer_message_id,
});

/** What messaging uses of Sessions: its transactions, session rows, lease check and close. */
export interface MessageHost {
  transaction<T>(fn: (tx: Transaction) => T | Promise<T>): Promise<T>;
  reading<T>(fn: (tx: Transaction) => T | Promise<T>): Promise<T>;
  row(tx: Transaction, id: string): Promise<Row>;
  decode(row: Row): Session;
  valid(session: Session, tx: Transaction): Promise<unknown>;
  /** Closes a visit that asked its owner: released, not counted against the work. */
  asked(session: Session, tx: Transaction): Promise<void>;
  /** Refuses a caller who may not read the work item. */
  readable(caller: Caller, instanceId: string, tx: Transaction): Promise<unknown>;
  /** Sessions' whole opinion of one instance, as Workflows keeps it for the work's gate. */
  publish(
    input: { projectId: string; instanceId: string; blockers: WorkflowProvidedBlockerInput[] },
    tx: Transaction,
  ): Promise<void>;
  /** Which of these work items of the project have ended. */
  ended(projectId: string, instanceIds: string[], tx: Transaction): Promise<Set<string>>;
  /** The question blockers standing in the caller's project. */
  standing(caller: Caller, tx: Transaction): Promise<{ instanceId: string; key: string }[]>;
}

/**
 * Messages between the people over a project and its workers: a person's to one live visit or
 * to a thread, which the visit that reads it acknowledges, and a worker's question to its owner,
 * which ends its visit and withholds its work from dispatch until a message to its thread
 * answers it.
 */
export class SessionMessages {
  constructor(
    private readonly state: State,
    private readonly scope: Scope,
    private readonly clock: () => number,
    private readonly host: MessageHost,
  ) {}
  private async messageRow(tx: Transaction, id: string): Promise<MessageRow> {
    const row = await tx.get<MessageRow>('SELECT * FROM session_messages WHERE id=?', id);
    check(row, 'session_message_not_found', 'Session message not found', 404);
    return row;
  }
  private publicMessage(row: MessageRow, instanceId: string, session?: Session): SessionMessage {
    return {
      id: row.id,
      sessionId: row.session_id,
      threadId: row.thread_id,
      instanceId,
      expectedRevision: row.session_id === null ? null : session!.expectedRevision,
      senderActorId: row.sender_actor_id,
      body: row.body,
      createdAt: row.created_at,
      acknowledgedAt: row.acknowledged_at,
      reply: row.reply_body,
    };
  }
  /** A visit reads the messages to it and to its thread's (`KEY_THREADS`). */
  private async addressed(tx: Transaction, session: Session): Promise<MessageRow[]> {
    return await tx.all<MessageRow>(
      `SELECT * FROM session_messages WHERE project_id=? AND (session_id=? OR thread_id IN (${KEY_THREADS})) ORDER BY _merv_rowid`,
      session.projectId,
      session.id,
      session.threadId,
    );
  }
  async requireMessagesAcknowledged(sessionId: string, tx: Transaction): Promise<void> {
    const row = await tx.get<{ id: string }>(
      `SELECT id FROM session_messages WHERE acknowledged_at IS NULL AND (session_id=? OR thread_id IN
        (${KEY_THREADS.replace('t.id=?', 't.id=(SELECT thread_id FROM worker_sessions WHERE id=?)')})) ORDER BY _merv_rowid LIMIT 1`,
      sessionId,
      sessionId,
    );
    if (row)
      throw new MervError(
        'session_message_pending',
        'A queued session message must be read with session.messages and acknowledged with session.message.ack before continuing.',
        409,
        { messageId: row.id },
      );
  }
  async message(caller: Caller, input: SessionMessageInput): Promise<SessionMessage> {
    ordinary(caller);
    check(
      !caller.session && !caller.managed,
      'forbidden',
      'Workers cannot send operator messages',
      403,
    );
    const address = input?.threadId === undefined ? input?.sessionId : input.threadId;
    check(
      (input?.sessionId === undefined) !== (input?.threadId === undefined) &&
        text(address, 200) &&
        text(input.body, 8_000) &&
        text(input.requestId, 200),
      'invalid_session_message',
      'A session ID or a thread ID, a message of 1–8000 characters and a stable requestId are required',
    );
    caller = structuredClone(caller);
    input = structuredClone(input);
    return await this.host.transaction(async (tx) => {
      await this.scope.require(caller, 'write', tx);
      const fingerprint = digest(
        input.threadId === undefined
          ? { sessionId: input.sessionId, body: input.body }
          : { threadId: input.threadId, body: input.body },
      );
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
        return await this.view(tx, old);
      }
      if (input.threadId !== undefined) return await this.toThread(caller, input, fingerprint, tx);
      const row = await this.host.row(tx, input.sessionId!);
      check(
        row.project_id === caller.projectId,
        'session_not_found',
        'Session not found in this project',
        404,
      );
      const session = this.host.decode(row);
      check(
        live(session),
        'session_ended',
        'This session has ended; send to its successor instead',
        409,
      );
      try {
        await this.host.valid(session, tx);
      } catch (error) {
        if (!(error instanceof MervError) || error.status >= 500) throw error;
        throw new MervError(
          'session_ended',
          'This assignment has ended; send to its successor instead',
          409,
        );
      }
      const id = await this.insert(tx, caller, input, fingerprint, { session: session.id });
      await this.state.appendEvent(tx, {
        projectId: caller.projectId,
        actorId: caller.actorId,
        type: 'session.message_queued',
        subjectId: session.id,
        data: {
          messageId: id,
          sessionId: session.id,
          instanceId: session.instanceId,
          revision: session.expectedRevision,
        },
      });
      return this.publicMessage(await this.messageRow(tx, id), session.instanceId, session);
    });
  }
  private async insert(
    tx: Transaction,
    caller: Caller,
    input: SessionMessageInput,
    fingerprint: string,
    to: { session: string } | { thread: string },
  ): Promise<string> {
    const id = newId('session_message');
    await tx.run(
      'INSERT INTO session_messages(id,project_id,session_id,thread_id,sender_actor_id,request_id,fingerprint,body,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      id,
      caller.projectId,
      'session' in to ? to.session : null,
      'thread' in to ? to.thread : null,
      caller.actorId,
      input.requestId,
      fingerprint,
      input.body,
      isoNow(this.clock),
    );
    return id;
  }
  private async threadRow(tx: Transaction, caller: Caller, id: string): Promise<ThreadRow> {
    const thread = await tx.get<ThreadRow>(
      'SELECT id,project_id,instance_id,status FROM session_threads WHERE id=?',
      id,
    );
    check(
      thread && thread.project_id === caller.projectId,
      'thread_not_found',
      'Thread not found in this project',
      404,
    );
    return thread;
  }
  /**
   * A message to a thread waits for its live or next visit. It answers every question the thread
   * asked that is still open, which lets dispatch offer that work again; a retired thread, which
   * no visit will take up again, takes a message only as such an answer.
   */
  private async toThread(
    caller: Caller,
    input: SessionMessageInput,
    fingerprint: string,
    tx: Transaction,
  ): Promise<SessionMessage> {
    const thread = await this.threadRow(tx, caller, input.threadId!);
    await this.host.readable(caller, thread.instance_id, tx);
    const open = await tx.all<QuestionRow>(
      'SELECT * FROM session_questions WHERE thread_id=? AND answered_at IS NULL ORDER BY _merv_rowid',
      thread.id,
    );
    check(
      thread.status !== 'retired' || open.length,
      'thread_retired',
      'This thread has ended and no visit will read a message to it',
      409,
    );
    const id = await this.insert(tx, caller, input, fingerprint, { thread: thread.id });
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
        'UPDATE session_questions SET answered_at=?,answer_message_id=? WHERE thread_id=? AND answered_at IS NULL',
        at,
        id,
        thread.id,
      );
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
  /** A message as its sender reads it again, from its own row. */
  private async view(tx: Transaction, row: MessageRow): Promise<SessionMessage> {
    if (row.session_id === null) {
      const thread = await tx.get<ThreadRow>(
        'SELECT instance_id FROM session_threads WHERE id=?',
        row.thread_id,
      );
      return this.publicMessage(row, thread!.instance_id);
    }
    const session = this.host.decode(await this.host.row(tx, row.session_id));
    return this.publicMessage(row, session.instanceId, session);
  }
  /**
   * Sessions' opinion of one work item: a blocker for each of its threads with a question still
   * open, so the work's gate and session.stuck say what it waits for, or none.
   */
  private async report(projectId: string, instanceId: string, tx: Transaction): Promise<void> {
    // Ended work waits on no answer: its question is cleared with the work's other blockers.
    const ended = (await this.host.ended(projectId, [instanceId], tx)).has(instanceId);
    const open = ended
      ? []
      : await tx.all<QuestionRow>(
          'SELECT * FROM session_questions WHERE project_id=? AND instance_id=? AND answered_at IS NULL ORDER BY _merv_rowid',
          projectId,
          instanceId,
        );
    const newest = new Map(open.map((row) => [row.thread_id, row]));
    await this.host.publish(
      {
        projectId,
        instanceId,
        blockers: [...newest.values()].map((row) => ({
          key: row.thread_id,
          code: 'agent_question',
          status: 409,
          message: `Its agent asked its owner: ${clip(row.question, 3_900)}`,
          next: `Answer with session.message {threadId: "${row.thread_id}"}; dispatch offers the work again once it is answered.`,
          cause: 'agent_question',
          // Its owner's move, as Workflows tells that owner; an operator answers too.
          whose: 'owner' as const,
          related: [],
        })),
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
      );
    });
  }
  async messages(caller: Caller, sessionId?: string): Promise<SessionMessage[]> {
    ordinary(caller);
    caller = structuredClone(caller);
    return await this.host.reading(async (tx) => {
      await this.scope.require(caller, 'read', tx);
      const id = sessionId ?? caller.session?.id;
      check(id && text(id, 200), 'invalid_session_message', 'A session ID is required');
      const row = await this.host.row(tx, id);
      check(
        row.project_id === caller.projectId,
        'session_not_found',
        'Session not found in this project',
        404,
      );
      if (caller.session)
        check(
          caller.session.id === id,
          'forbidden',
          'Workers can read only their own messages',
          403,
        );
      const session = this.host.decode(row);
      return (await this.addressed(tx, session)).map((item) =>
        this.publicMessage(item, session.instanceId, item.session_id ? session : undefined),
      );
    });
  }
  /** A thread's messages, to it and to each of its visits, and its questions, oldest first. */
  async thread(caller: Caller, threadId: string): Promise<ThreadMessages> {
    ordinary(caller);
    check(!caller.session, 'session_forbidden', 'A leased worker reads its own messages', 403);
    check(text(threadId, 200), 'invalid_input', 'A thread id of 1–200 characters is required');
    caller = structuredClone(caller);
    return await this.host.reading(async (tx) => {
      await this.scope.require(caller, 'read', tx);
      const thread = await this.threadRow(tx, caller, threadId);
      await this.host.readable(caller, thread.instance_id, tx);
      const rows = await tx.all<MessageRow & { revision: number | string | null }>(
        `SELECT m.*,s.revision FROM session_messages m LEFT JOIN worker_sessions s ON s.id=m.session_id
          WHERE m.project_id=? AND (m.thread_id=? OR s.thread_id=?) ORDER BY m._merv_rowid`,
        caller.projectId,
        thread.id,
        thread.id,
      );
      const questions = await tx.all<QuestionRow>(
        'SELECT * FROM session_questions WHERE thread_id=? ORDER BY _merv_rowid',
        thread.id,
      );
      return {
        threadId: thread.id,
        messages: rows.map(({ revision, ...row }) => ({
          ...this.publicMessage(row, thread.instance_id),
          expectedRevision: revision === null ? null : Number(revision),
        })),
        questions: questions.map(question),
      };
    });
  }
  /** Each question still open whose blocker stands, as Needs you asks a person to answer it. */
  async questionMoves(caller: Caller): Promise<QuestionMove[]> {
    ordinary(caller);
    caller = structuredClone(caller);
    return await this.host.reading(async (tx) => {
      await this.scope.require(caller, 'read', tx);
      return (await this.host.standing(caller, tx)).map(({ instanceId, key }) => ({
        instanceId,
        provider: QUESTION_PROVIDER,
        key,
        move: {
          sentence: 'Answer its agent’s question',
          who: 'Anyone who may write to the project answers it with a message to the thread',
          whose: 'owner' as const,
        },
      }));
    });
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
          (row.session_id === session.id ||
            (row.thread_id !== null &&
              !!(await tx.get(
                `SELECT 1 FROM (${KEY_THREADS}) k WHERE k.id=?`,
                session.threadId,
                row.thread_id,
              )))),
        'session_message_not_found',
        'Message not found in this session',
        404,
      );
      check(
        live(session) && session.actorId === caller.actorId,
        'session_ended',
        'This session has ended',
        409,
      );
      const read = (item: MessageRow) =>
        this.publicMessage(item, session.instanceId, item.session_id ? session : undefined);
      if (row.acknowledged_at) {
        check(
          row.ack_request_id === input.requestId && row.reply_body === (input.reply ?? null),
          'request_conflict',
          'Message was acknowledged with different input',
          409,
        );
        return read(row);
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
          ...(row.thread_id ? { threadId: row.thread_id } : {}),
          replied: input.reply !== undefined,
        },
      });
      return read(await this.messageRow(tx, row.id));
    });
  }
}

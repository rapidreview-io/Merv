import {
  check,
  digest,
  MervError,
  newId,
  type Caller,
  type Scope,
  type State,
  type Transaction,
} from '@merv/contracts';
import { isoNow, live, ordinary, text, type Row } from './common.js';
import type { Session, SessionMessage, SessionMessageInput } from './types.js';

interface MessageRow {
  id: string;
  project_id: string;
  session_id: string;
  sender_actor_id: string;
  request_id: string;
  fingerprint: string;
  body: string;
  created_at: string;
  acknowledged_at: string | null;
  ack_request_id: string | null;
  reply_body: string | null;
}
/** What operator messaging uses of Sessions: its transactions, session rows and lease check. */
export interface MessageHost {
  transaction<T>(fn: (tx: Transaction) => T | Promise<T>): Promise<T>;
  reading<T>(fn: (tx: Transaction) => T | Promise<T>): Promise<T>;
  row(tx: Transaction, id: string): Promise<Row>;
  decode(row: Row): Session;
  valid(session: Session, tx: Transaction): Promise<unknown>;
}

/** An operator's messages to a live session, which its worker reads and acknowledges. */
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
  private publicMessage(row: MessageRow, session: Session): SessionMessage {
    return {
      id: row.id,
      sessionId: row.session_id,
      instanceId: session.instanceId,
      expectedRevision: session.expectedRevision,
      senderActorId: row.sender_actor_id,
      body: row.body,
      createdAt: row.created_at,
      acknowledgedAt: row.acknowledged_at,
      reply: row.reply_body,
    };
  }
  async requireMessagesAcknowledged(sessionId: string, tx: Transaction): Promise<void> {
    const row = await tx.get<{ id: string }>(
      'SELECT id FROM session_messages WHERE session_id=? AND acknowledged_at IS NULL ORDER BY _merv_rowid LIMIT 1',
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
    check(
      text(input.sessionId, 200) && text(input.body, 8_000) && text(input.requestId, 200),
      'invalid_session_message',
      'A session ID, message of 1–8000 characters and stable requestId are required',
    );
    caller = structuredClone(caller);
    input = structuredClone(input);
    return await this.host.transaction(async (tx) => {
      await this.scope.require(caller, 'write', tx);
      const fingerprint = digest({ sessionId: input.sessionId, body: input.body });
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
        const session = this.host.decode(await this.host.row(tx, old.session_id));
        return this.publicMessage(old, session);
      }
      const row = await this.host.row(tx, input.sessionId);
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
      const createdAt = isoNow(this.clock);
      const id = newId('session_message');
      await tx.run(
        'INSERT INTO session_messages(id,project_id,session_id,sender_actor_id,request_id,fingerprint,body,created_at) VALUES(?,?,?,?,?,?,?,?)',
        id,
        caller.projectId,
        session.id,
        caller.actorId,
        input.requestId,
        fingerprint,
        input.body,
        createdAt,
      );
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
      return this.publicMessage(await this.messageRow(tx, id), session);
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
      const rows = await tx.all<MessageRow>(
        'SELECT * FROM session_messages WHERE project_id=? AND session_id=? ORDER BY _merv_rowid',
        caller.projectId,
        id,
      );
      return rows.map((item) => this.publicMessage(item, session));
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
      check(
        row.project_id === caller.projectId && row.session_id === caller.session!.id,
        'session_message_not_found',
        'Message not found in this session',
        404,
      );
      const session = this.host.decode(await this.host.row(tx, row.session_id));
      check(
        live(session) && session.actorId === caller.actorId,
        'session_ended',
        'This session has ended',
        409,
      );
      if (row.acknowledged_at) {
        check(
          row.ack_request_id === input.requestId && row.reply_body === (input.reply ?? null),
          'request_conflict',
          'Message was acknowledged with different input',
          409,
        );
        return this.publicMessage(row, session);
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
        data: { messageId: row.id, sessionId: session.id, replied: input.reply !== undefined },
      });
      return this.publicMessage(await this.messageRow(tx, row.id), session);
    });
  }
}

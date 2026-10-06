import { check, type Blobs, type Caller, type State, type Transaction } from '@merv/contracts';
import { isoNow, live, readFirst } from './common.js';
import { postgresMigrations } from './conversations.postgres.js';
import { freezeLaunchSnapshot } from './launch-connections.js';
import { deliver, uploads } from './transcripts.js';
import type {
  ContinuityProvider,
  ContinuityUnit,
  Session,
  SessionControl,
  SessionConversationDeclaration,
  SessionResume,
  SessionTranscript,
} from './types.js';

type Row = {
  project_id: string;
  continuity_key: string;
  session_id: string;
  agent_id: string;
  harness: SessionResume['harness'] | null;
  conversation_id: string | null;
  sha256: string | null;
  size: number | string | null;
  updated_at: string;
  uploaded_at: string | null;
};
type Facts = Omit<SessionConversationDeclaration, 'hostRef' | 'deliver'>;
/** One prefix per project, as transcripts have. */
const namespace = (projectId: string) => `conversations-${projectId}`;
/** How long an agent waits, dormant, for its work to come back to it. */
export const dormantMs = 14 * 86_400_000;

/**
 * Continuity: when work comes back to a state it was in, the agent that held that state takes it
 * up again with its own conversation. A session's key is its workflow's provider's, else its
 * instance, state and role, so a reviewer never continues a producer, and no reviewer continues at all. The key's row names its
 * latest closed session and agent; a conversation that session's runner delivers is what the
 * next offer of the key resumes. An agent the row no longer names, or that waited longer than
 * `dormantMs`, is retired.
 */
export class SessionConversations {
  /** Late-bound like transcripts'. */
  blobs?: Blobs;
  private readonly providers = new Map<string, ContinuityProvider>();
  constructor(
    private state: State,
    private clock: () => number,
    private controlled: (
      caller: Caller,
      id: string,
      runnerId: string,
      tx: Transaction,
    ) => Promise<Session>,
    /** Retires a dormant agent; one in use is left as it is. */
    private retire: (agentId: string, reason: string, tx: Transaction) => Promise<void>,
    /** Refuses once Sessions has closed. */
    private available: () => void,
  ) {}
  async initialize() {
    await this.state.migrate('session_conversations', [
      { version: 1, sql: postgresMigrations[1]! },
    ]);
  }
  register(workflow: string, provider: ContinuityProvider): () => void {
    this.available();
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
   * The conversation the key's latest session declared, and its agent. Its upload may still be
   * on its way: a runner that cannot fetch it yet launches the same agent fresh.
   */
  async latest(projectId: string, key: string, tx: Transaction) {
    const row = await tx.get<Row>(
      'SELECT * FROM session_conversations WHERE project_id=? AND continuity_key=? AND sha256 IS NOT NULL',
      projectId,
      key,
    );
    return row && { agentId: row.agent_id, resume: resumeOf(row) };
  }
  /**
   * A session holding a key closed: it is now the key's latest, with what it declared. One of the
   * row's own agent that declared nothing yet (a lapsed offer, a failed launch, a lost machine)
   * leaves the row's conversation in place, stamped with its close so it may still declare.
   * One whose harness could not take up the conversation it was offered drops it: on whatever
   * machine, the key's next offer starts afresh rather than failing to resume it again.
   */
  async closed(session: Session, tx: Transaction): Promise<void> {
    const row = await this.row(session, tx);
    const failed = session.deferral?.cause === 'resume_failed' && session.continuity?.resume;
    // The failed session holds the dropped row, so an earlier one's late declaration is refused.
    const drop = !!failed && row?.sha256 === failed.sha256;
    if (row && (row.session_id === session.id || row.agent_id === session.agentId))
      await tx.run(
        `UPDATE session_conversations SET updated_at=?${drop ? ',session_id=?,harness=NULL,conversation_id=NULL,sha256=NULL,size=NULL,uploaded_at=NULL' : ''}
         WHERE project_id=? AND continuity_key=?`,
        session.closedAt ?? isoNow(this.clock),
        ...(drop ? [session.id] : []),
        row.project_id,
        row.continuity_key,
      );
    else await this.hold(session, row, null, tx);
  }
  /** The key's row passes to `session`; the agent it named before is retired if it was another. */
  private async hold(session: Session, row: Row | undefined, facts: Facts | null, tx: Transaction) {
    await tx.run(
      `INSERT INTO session_conversations(project_id,continuity_key,session_id,agent_id,harness,conversation_id,sha256,size,updated_at,uploaded_at)
       VALUES(?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(project_id,continuity_key) DO UPDATE SET
       session_id=EXCLUDED.session_id,agent_id=EXCLUDED.agent_id,harness=EXCLUDED.harness,
       conversation_id=EXCLUDED.conversation_id,sha256=EXCLUDED.sha256,size=EXCLUDED.size,
       updated_at=EXCLUDED.updated_at,uploaded_at=NULL`,
      session.projectId,
      session.continuity!.key,
      session.id,
      session.agentId!,
      facts?.harness ?? null,
      facts?.conversationId ?? null,
      facts?.sha256 ?? null,
      facts?.size ?? null,
      isoNow(this.clock),
    );
    if (row && row.agent_id !== session.agentId) await this.retire(row.agent_id, 'superseded', tx);
  }
  private async row(session: Session, tx: Transaction) {
    return await tx.get<Row>(
      'SELECT * FROM session_conversations WHERE project_id=? AND continuity_key=?',
      session.projectId,
      session.continuity!.key,
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
      const session = await this.controlled(caller, input.sessionId, input.runnerId, tx);
      check(
        session.hostRef !== null && session.hostRef === input.hostRef,
        'host_conflict',
        'A conversation must name the attached host',
        409,
      );
      check(session.continuity, 'conversation_unkept', 'This session keeps no conversation', 409);
      const found = await this.row(session, tx);
      if (found?.session_id === session.id && found.sha256 !== null) return found;
      // A closed session's row passed to a later one: what it kept is no longer the latest.
      // A session of the row's agent newer than the row's own still may, though a later one
      // closed since with nothing declared; another agent's never.
      check(
        found?.session_id === session.id ||
          live(session) ||
          (found !== undefined &&
            found.agent_id === session.agentId &&
            !!(await tx.get(
              'SELECT 1 FROM worker_sessions s, worker_sessions r WHERE s.id=? AND r.id=? AND s._merv_rowid>r._merv_rowid',
              session.id,
              found.session_id,
            ))),
        'conversation_superseded',
        'A later session of this work holds its conversation',
        409,
      );
      await this.hold(session, found, facts, tx);
      return (await this.row(session, tx))!;
    });
    check(
      row.session_id === input.sessionId &&
        row.sha256 === input.sha256 &&
        Number(row.size) === input.size &&
        row.harness === input.harness &&
        row.conversation_id === input.conversationId,
      'conversation_conflict',
      'This session declared another conversation',
      409,
    );
    const view = (row: Row): SessionTranscript => ({
      sessionId: row.session_id,
      sha256: row.sha256!,
      size: Number(row.size),
      uploadedAt: row.uploaded_at,
    });
    if (row.uploaded_at !== null || !input.deliver) return view(row);
    return await deliver(blobs, 'conversation', namespace(row.project_id), view(row), () =>
      this.state.transaction(async (tx) => {
        await tx.run(
          'UPDATE session_conversations SET uploaded_at=? WHERE project_id=? AND continuity_key=? AND session_id=? AND sha256=? AND uploaded_at IS NULL',
          isoNow(this.clock),
          row.project_id,
          row.continuity_key,
          row.session_id,
          row.sha256,
        );
        const now = await tx.get<Row>(
          'SELECT * FROM session_conversations WHERE project_id=? AND continuity_key=?',
          row.project_id,
          row.continuity_key,
        );
        check(
          now?.session_id === row.session_id,
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
      this.controlled(caller, input.sessionId, input.runnerId, tx),
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
  /** The sweep: agents whose work has not come back for `dormantMs`, a bounded batch a pass. */
  async expire(tx: Transaction): Promise<void> {
    const rows = await tx.all<{ agent_id: string }>(
      `SELECT c.agent_id FROM session_conversations c JOIN agents a ON a.id=c.agent_id
       WHERE a.status='active' AND c.updated_at<? ORDER BY c.updated_at LIMIT 100`,
      isoNow(() => this.clock() - dormantMs),
    );
    for (const row of rows) await this.retire(row.agent_id, 'dormant', tx);
  }
}
const resumeOf = (row: Row): SessionResume => ({
  sessionId: row.session_id,
  harness: row.harness!,
  conversationId: row.conversation_id!,
  sha256: row.sha256!,
  size: Number(row.size),
});

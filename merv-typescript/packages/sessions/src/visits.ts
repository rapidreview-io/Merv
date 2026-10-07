import { check, MervError, type Caller, type State, type Transaction } from '@merv/contracts';
import { tokenDigest, type CredentialStore } from '@merv/identity/credentials';
import { clone, type Row } from './common.js';
import type { Session } from './types.js';

/** What a visit's offer is made from: its runner's request and the secret it will present. */
export interface VisitRequest {
  runnerId: string;
  requestId: string;
  secret: string;
}

/**
 * How every visit, of its work or answering a question, is admitted and written: a request made
 * once, and a row, a credential and an offered event. Sessions' work offer and Inquiries' offer
 * both use it.
 */
export class Visits {
  constructor(
    private readonly state: State,
    private readonly credentials: () => CredentialStore,
    private readonly decode: (row: Row) => Session,
  ) {}
  /** What every visit's offer checks first: a request it already made for this input answers the
   *  visit it made, and one made for other input is refused. */
  async admit(
    owner: { hash: string },
    input: VisitRequest,
    fingerprint: string,
    tx: Transaction,
  ): Promise<Session | undefined> {
    const old = await tx.get<Row>(
      'SELECT s.*,w.attachment_json,w.result_json FROM worker_sessions s LEFT JOIN session_workspaces w ON w.session_id=s.id WHERE s.owner_hash=? AND s.runner_id=? AND s.request_id=?',
      owner.hash,
      input.runnerId,
      input.requestId,
    );
    if (!old) return undefined;
    check(
      old.fingerprint === fingerprint,
      'request_conflict',
      'Session request was already used for different input',
      409,
    );
    return this.decode(old);
  }
  /**
   * A visit admitted and built: its row, its credential and its offered event. Its secret is used
   * once: historical rows retain their hashes even after their Identity credentials are revoked,
   * and Identity holds every other authority's. Reuse is a malformed runner offer, never a failed
   * launch of the target.
   */
  async insert<S extends Session>(
    session: S,
    owner: { hash: string },
    input: VisitRequest,
    fingerprint: string,
    caller: Caller,
    tx: Transaction,
  ): Promise<S> {
    const tokenHash = tokenDigest(input.secret);
    check(
      !(await tx.get('SELECT id FROM worker_sessions WHERE token_hash=?', tokenHash)),
      'session_secret_used',
      'Session secret was already used',
      409,
    );
    const { threadId: _thread, ...stored } = session;
    await tx.run(
      'INSERT INTO worker_sessions(id,project_id,actor_id,thread_id,instance_id,revision,owner_hash,runner_id,request_id,token_hash,fingerprint,status,session_json,kind) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      session.id,
      session.projectId,
      session.actorId,
      session.threadId,
      session.instanceId,
      session.expectedRevision,
      owner.hash,
      input.runnerId,
      input.requestId,
      tokenHash,
      fingerprint,
      session.status,
      JSON.stringify(stored),
      session.kind,
    );
    try {
      await this.credentials().issue(
        {
          owner: 'sessions',
          subject: session.id,
          kind: 'session-execution',
          token: input.secret,
          expiresAt: session.expiresAt,
          hardDeadline: session.hardDeadline,
        },
        tx,
      );
    } catch (error) {
      if (error instanceof MervError && error.code === 'credential_conflict')
        throw new MervError('session_secret_used', 'Session secret was already used', 409);
      throw error;
    }
    await this.state.appendEvent(tx, {
      projectId: session.projectId,
      actorId: caller.actorId,
      type: session.kind === 'inquiry' ? 'session.inquiry_offered' : 'session.offered',
      subjectId: session.id,
      data: {
        sessionId: session.id,
        workerActorId: session.actorId,
        instanceId: session.instanceId,
        revision: session.expectedRevision,
        role: session.role,
        source: session.source,
        runnerId: session.runnerId,
        ...(session.kind === 'inquiry' && {
          inquiryId: session.inquiry.id,
          threadId: session.threadId,
        }),
      },
    });
    return clone(session);
  }
}

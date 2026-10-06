import { check, type Blobs, type Caller, type State, type Transaction } from '@merv/contracts';
import { isoNow, readFirst } from './common.js';
import { postgresMigrations } from './transcripts.postgres.js';
import type {
  Session,
  SessionControl,
  SessionTranscript,
  SessionTranscriptDeclaration,
} from './types.js';

type Row = {
  session_id: string;
  project_id: string;
  sha256: string;
  size: number | string;
  uploaded_at: string | null;
};
/** One prefix per project: a project's purge or expiry never touches another's bytes. */
const namespace = (projectId: string) => `transcripts-${projectId}`;
const view = (row: Row): SessionTranscript => ({
  sessionId: row.session_id,
  sha256: row.sha256,
  size: Number(row.size),
  uploadedAt: row.uploaded_at,
});

type Uploads = Required<Pick<Blobs, 'upload' | 'stored'>>;
/** Blobs that take a session's transcript or conversation, or why they cannot. */
export function uploads(blobs: Blobs | undefined, kind: 'transcript' | 'conversation'): Uploads {
  const name = `${kind[0]!.toUpperCase()}${kind.slice(1)} storage`;
  check(blobs, 'blob_unavailable', `${name} is not loaded`, 503);
  check(blobs.upload && blobs.stored, `${kind}s_unsupported`, `${name} takes no uploads`, 409);
  return blobs as Uploads;
}
/**
 * The delivery of what a session declared, one HEAD outside any transaction: with nothing
 * stored, one signed PUT (local signing, 1 h, exact size, checksum, If-None-Match:*); stored,
 * `uploaded` records the upload once, and a racing delivery updates nothing.
 */
export async function deliver(
  blobs: Uploads,
  kind: 'transcript' | 'conversation',
  key: string,
  declared: SessionTranscript,
  uploaded: () => Promise<SessionTranscript>,
): Promise<SessionTranscript> {
  const stored = await blobs.stored(key, declared.sha256);
  check(
    stored === null || stored === declared.size,
    `${kind}_mismatch`,
    `A stored ${kind} with this SHA-256 has another size`,
    409,
  );
  if (stored !== null) return await uploaded();
  return { ...declared, upload: await blobs.upload(key, declared.sha256, declared.size) };
}

/** The one copy of what a worker's process printed, kept for operators; nothing in Merv reads it back. */
export class SessionTranscripts {
  /** Late-bound like `tools`: unbound while Blobs loads or reloads. */
  blobs?: Blobs;
  constructor(
    private state: State,
    private clock: () => number,
    private controlled: (
      caller: Caller,
      id: string,
      runnerId: string,
      tx: Transaction,
    ) => Promise<Session>,
  ) {}
  async initialize() {
    await this.state.migrate('session_transcripts', [{ version: 1, sql: postgresMigrations[1]! }]);
  }
  /** A declaration costs no store I/O; a delivery costs one HEAD, outside any transaction. */
  async record(
    caller: Caller,
    input: SessionControl & SessionTranscriptDeclaration,
  ): Promise<SessionTranscript> {
    const blobs = uploads(this.blobs, 'transcript');
    // Like a workspace result: the runner that held it, whatever the session's state now.
    const row = await readFirst(this.state, async (tx) => {
      const session = await this.controlled(caller, input.sessionId, input.runnerId, tx);
      check(
        session.hostRef !== null && session.hostRef === input.hostRef,
        'host_conflict',
        'A transcript must name the attached host',
        409,
      );
      const select = () =>
        tx.get<Row>('SELECT * FROM session_transcripts WHERE session_id=?', session.id);
      const found = await select();
      if (found) return found;
      // The hostname is the dispatching runner's presence now: presence is overwritten on every
      // heartbeat, so this keeps it. A hand offer has no receipt and no hostname.
      await tx.run(
        `INSERT INTO session_transcripts(session_id,project_id,workflow,role,runner_id,agent_id,host_ref,hostname,sha256,size,log_bytes,truncated,declared_at)
         VALUES(?,?,?,?,?,?,?,(SELECT r.presence_json::jsonb#>>'{machine,hostname}' FROM session_dispatch_receipts d
           JOIN session_runners r ON r.id=d.runner_ref WHERE d.session_id=?),?,?,?,?,?) ON CONFLICT(session_id) DO NOTHING`,
        session.id,
        session.projectId,
        session.execution.workflow,
        session.role,
        session.runnerId,
        // agent_id predates threads: an agent's id is its thread's.
        session.threadId,
        session.hostRef,
        session.id,
        input.sha256,
        input.size,
        input.logBytes,
        input.truncated ? 1 : 0,
        isoNow(this.clock),
      );
      return (await select())!;
    });
    check(
      row.sha256 === input.sha256 && Number(row.size) === input.size,
      'transcript_conflict',
      'This session declared another transcript',
      409,
    );
    if (row.uploaded_at !== null || !input.deliver) return view(row);
    return await deliver(blobs, 'transcript', namespace(row.project_id), view(row), () =>
      this.state.transaction(async (tx) => {
        await tx.run(
          'UPDATE session_transcripts SET uploaded_at=? WHERE session_id=? AND uploaded_at IS NULL',
          isoNow(this.clock),
          row.session_id,
        );
        return view(
          (await tx.get<Row>(
            'SELECT * FROM session_transcripts WHERE session_id=?',
            row.session_id,
          ))!,
        );
      }),
    );
  }
}

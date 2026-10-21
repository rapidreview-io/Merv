import { bootMaintenance } from '@merv/contracts/maintenance';
import { z } from 'zod';
import {
  canonical,
  check,
  digest,
  MervError,
  now,
  recorded,
  type Caller,
  type ReviewRequest,
  type Reviews,
  type Scope,
  type Sql,
  type State,
  type Transaction,
} from '@merv/contracts';
import { idSchema, oidSchema } from '@merv/contracts/schemas';
import type { Sessions } from '@merv/sessions/types';
import { live, ownEnd } from '@merv/sessions/rules';
import type { CodeWriterService } from '@merv/code/writers';
import { parseCodeInput } from '@merv/code/input';
import type { CodeCapture } from './types.js';
import type { CodeUnitAcceptInput } from './models.js';

/** A tree is retained by Git without inventing a commit before independent approval. */
export interface SubmissionStorage {
  verifySubmission(
    projectId: string,
    input: {
      sessionId: string;
      parentOid: string;
      treeOid: string;
      unitId?: string;
    },
  ): Promise<unknown>;
  materializeSubmission(
    projectId: string,
    input: {
      sessionId: string;
      parentOid: string;
      treeOid: string;
      approvalId: string;
      createdAt: string;
      message: string;
      unitId: string;
    },
  ): Promise<{ head: string; tree: string; ref: string }>;
}
export type SubmissionApproval = CodeUnitAcceptInput & { kind: 'plan' | 'results' | 'task' };
export type ApprovedSubmission = {
  approval: SubmissionApproval;
  capture: CodeCapture;
  commit: { head: string; tree: string; ref: string };
  acceptedBy: string;
  review: ReviewRequest;
};

export const submissionReceiptSchema = z.strictObject({
  sessionId: idSchema,
  runnerId: idSchema,
  hostRef: idSchema,
  generation: z.number().int().positive().safe(),
  leaseId: idSchema,
  parentOid: oidSchema,
  treeOid: oidSchema,
  stopped: z.literal(true),
});

const schema = `
CREATE TABLE code_submissions (
 project_id TEXT NOT NULL, session_id TEXT NOT NULL, unit_id TEXT NOT NULL,
 generation BIGINT NOT NULL, lease_id TEXT NOT NULL, source_json TEXT NOT NULL,
 frozen_json TEXT, frozen_hash TEXT, created_at TEXT NOT NULL, frozen_at TEXT,
 PRIMARY KEY(project_id,session_id),
 CHECK ((frozen_json IS NULL)=(frozen_hash IS NULL) AND (frozen_json IS NULL)=(frozen_at IS NULL))
);
CREATE TABLE code_approval_milestones (
 project_id TEXT NOT NULL, review_id TEXT NOT NULL, unit_id TEXT NOT NULL,
 session_id TEXT NOT NULL, approval_json TEXT NOT NULL, approval_hash TEXT NOT NULL, review_json TEXT NOT NULL,
 accepted_by TEXT NOT NULL, created_at TEXT NOT NULL,
 result_json TEXT, completed_at TEXT, last_error TEXT,
 PRIMARY KEY(project_id,review_id),
 FOREIGN KEY(project_id,session_id) REFERENCES code_submissions(project_id,session_id),
 CHECK ((result_json IS NULL)=(completed_at IS NULL))
);
CREATE INDEX code_milestones_pending ON code_approval_milestones(project_id,unit_id) WHERE result_json IS NULL;
CREATE FUNCTION code_submission_immutable() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Code submission evidence is retained'; END IF;
 IF NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.session_id IS DISTINCT FROM OLD.session_id
 OR NEW.unit_id IS DISTINCT FROM OLD.unit_id OR NEW.generation IS DISTINCT FROM OLD.generation
 OR NEW.lease_id IS DISTINCT FROM OLD.lease_id OR NEW.source_json IS DISTINCT FROM OLD.source_json
 OR NEW.created_at IS DISTINCT FROM OLD.created_at
 OR (OLD.frozen_json IS NOT NULL AND (NEW.frozen_json IS DISTINCT FROM OLD.frozen_json
 OR NEW.frozen_hash IS DISTINCT FROM OLD.frozen_hash OR NEW.frozen_at IS DISTINCT FROM OLD.frozen_at))
 THEN RAISE EXCEPTION 'Code submission evidence is immutable'; END IF;
 RETURN NEW;
END; $merv$;
CREATE TRIGGER code_submission_immutable BEFORE UPDATE OR DELETE ON code_submissions
 FOR EACH ROW EXECUTE FUNCTION code_submission_immutable();
CREATE FUNCTION code_milestone_immutable() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Code approval evidence is retained'; END IF;
 IF NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.review_id IS DISTINCT FROM OLD.review_id
 OR NEW.unit_id IS DISTINCT FROM OLD.unit_id OR NEW.session_id IS DISTINCT FROM OLD.session_id
 OR NEW.approval_json IS DISTINCT FROM OLD.approval_json OR NEW.approval_hash IS DISTINCT FROM OLD.approval_hash
 OR NEW.review_json IS DISTINCT FROM OLD.review_json
 OR NEW.accepted_by IS DISTINCT FROM OLD.accepted_by OR NEW.created_at IS DISTINCT FROM OLD.created_at
 OR (OLD.result_json IS NOT NULL AND (NEW.result_json IS DISTINCT FROM OLD.result_json
 OR NEW.completed_at IS DISTINCT FROM OLD.completed_at))
 THEN RAISE EXCEPTION 'Code approval evidence is immutable'; END IF;
 RETURN NEW;
END; $merv$;
CREATE TRIGGER code_milestone_immutable BEFORE UPDATE OR DELETE ON code_approval_milestones
 FOR EACH ROW EXECUTE FUNCTION code_milestone_immutable();
`;
interface SubmissionRow {
  project_id: string;
  session_id: string;
  unit_id: string;
  generation: number | string;
  lease_id: string;
  source_json: string;
  frozen_json: string | null;
  frozen_hash: string | null;
  created_at: string;
  frozen_at: string | null;
}
interface MilestoneRow {
  project_id: string;
  review_id: string;
  unit_id: string;
  session_id: string;
  approval_json: string;
  approval_hash: string;
  review_json: string;
  accepted_by: string;
  created_at: string;
  result_json: string | null;
}

/** Coordinates only submissions and approved milestones, never timers or session-end backups. */
export class CodeSubmissionService {
  private pending?: Promise<void>;
  private closed = false;
  private release?: () => void;
  private retry?: NodeJS.Timeout;
  constructor(
    private readonly state: State,
    private readonly scope: Scope,
    private readonly sessions: Sessions,
    private readonly writers: CodeWriterService,
    private readonly reviews: Reviews,
    private readonly storage: SubmissionStorage,
    private readonly complete: (
      tx: Transaction,
      projectId: string,
      value: ApprovedSubmission,
    ) => Promise<void>,
  ) {}

  async initialize() {
    await this.state.migrate('code_submissions', { 1: schema });
  }
  start() {
    if (bootMaintenance.active) return;
    this.release = this.state.onEventsCommitted(() => this.wake());
    this.wake();
  }
  /** Recovery retries only already-approved journal entries; it never captures a working tree. */
  wake() {
    if (bootMaintenance.active) return;
    if (this.closed || this.pending) return;
    this.pending = this.reconcile()
      .catch(() => undefined)
      .finally(() => {
        this.pending = undefined;
        if (!this.closed) {
          clearTimeout(this.retry);
          this.retry = setTimeout(() => this.wake(), 30_000);
          this.retry.unref();
        }
      });
  }
  async close() {
    this.closed = true;
    this.release?.();
    clearTimeout(this.retry);
    await this.pending;
  }

  private async row(sql: Sql, projectId: string, sessionId: string) {
    return await sql.get<SubmissionRow>(
      'SELECT * FROM code_submissions WHERE project_id=? AND session_id=?',
      projectId,
      sessionId,
    );
  }
  async requested(projectId: string, sessionId: string, tx?: Transaction): Promise<boolean> {
    const read = async (sql: Sql) => !!(await this.row(sql, projectId, sessionId));
    return tx ? read(tx) : this.state.read(read);
  }
  /** Called by the owner only in the transaction that submits this producer's work. */
  /** Internal protocol metadata; the caller must already authorize the exact controlled session. */
  async frozen(projectId: string, sessionId: string): Promise<boolean> {
    check(!this.closed, 'code_unavailable', 'Submission service is unavailable', 503);
    return this.state.read(async (sql) => {
      const row = await this.row(sql, projectId, sessionId);
      if (!row?.frozen_json) return false;
      check(
        digest(JSON.parse(row.frozen_json)) === row.frozen_hash,
        'code_submission_corrupt',
        'Submitted evidence no longer matches its hash',
        409,
      );
      return true;
    });
  }
  async expect(caller: Caller, tx: Transaction): Promise<CodeCapture> {
    check(!this.closed, 'code_unavailable', 'Submission service is unavailable', 503);
    this.state.assertTransaction(tx);
    check(
      caller.session,
      'session_required',
      'Only the producing session can submit its code',
      403,
    );
    await this.scope.require(caller, 'write', tx);
    const sessionId = caller.session.id;
    const observation = await this.sessions.workspaceObservation(caller, sessionId, tx);
    const p = observation.provenance;
    check(
      p.actorId === caller.actorId &&
        !p.readOnly &&
        observation.live &&
        p.hostRef &&
        observation.workspace,
      'code_submission_provenance',
      'Submit from the attached writable producer before stopping',
      409,
    );
    let writer = await this.writers.row(tx, caller.projectId, p.instanceId);
    // Attachments are authoritative even when the asynchronous projection has not caught up.
    if (writer?.writer_state === 'reserved' && writer.writer_session_id === sessionId) {
      await this.writers.sessionChanged(caller.projectId, sessionId, 'attached', tx);
      writer = await this.writers.row(tx, caller.projectId, p.instanceId);
    }
    check(
      writer &&
        writer.writer_session_id === sessionId &&
        writer.writer_lease_id &&
        writer.writer_state === 'active',
      'code_generation_stale',
      'Only the active writer may submit',
      409,
    );
    const source: CodeCapture = {
      ref: { kind: 'submission', sessionId },
      status: 'pending',
      provenance: p,
      workspace: observation.workspace.attachment,
      attachedBaseOid: observation.workspace.attachment.baseOid,
      observedAt: null,
      eventId: null,
    };
    const existing = await this.row(tx, caller.projectId, sessionId);
    if (!existing) {
      await tx.run(
        'INSERT INTO code_submissions(project_id,session_id,unit_id,generation,lease_id,source_json,created_at) VALUES(?,?,?,?,?,?,?)',
        caller.projectId,
        sessionId,
        p.instanceId,
        Number(writer.generation),
        writer.writer_lease_id,
        canonical(source),
        now(),
      );
      await recorded(this.state, tx, caller, 'code.submission_requested', p.instanceId, {
        sessionId,
      });
    }
    return await this.capture(caller, sessionId, tx);
  }
  async capture(caller: Caller, sessionId: string, tx?: Transaction): Promise<CodeCapture> {
    check(!this.closed, 'code_unavailable', 'Submission service is unavailable', 503);
    await this.scope.require(caller, 'read', tx);
    const read = async (sql: Sql) => {
      const row = await this.row(sql, caller.projectId, sessionId);
      check(row, 'code_capture_not_found', 'No submitted code for this session', 404);
      if (!row.frozen_json) return JSON.parse(row.source_json) as CodeCapture;
      const capture = JSON.parse(row.frozen_json) as CodeCapture;
      check(
        digest(capture) === row.frozen_hash,
        'code_submission_corrupt',
        'Submitted evidence no longer matches its hash',
        409,
      );
      return capture;
    };
    return tx ? read(tx) : this.state.read(read);
  }
  /** Runner-authenticated stop receipt, after ordinary Git durably retained both immutable refs. */
  async freeze(caller: Caller, value: unknown): Promise<CodeCapture> {
    check(!this.closed, 'code_unavailable', 'Submission service is unavailable', 503);
    check(!caller.session, 'session_forbidden', 'Only the runner seals stopped code', 403);
    const input = parseCodeInput(submissionReceiptSchema, value);
    const session = await this.sessions.get(caller, input.sessionId);
    check(
      session.runnerId === input.runnerId && session.hostRef === input.hostRef,
      'session_forbidden',
      'The submission belongs to another runner or launch',
      403,
    );
    const row = await this.state.read((sql) => this.row(sql, caller.projectId, input.sessionId));
    check(
      row && row.generation == input.generation && row.lease_id === input.leaseId,
      'code_submission_required',
      'Only a requested submission can be frozen',
      409,
    );
    if (row.frozen_json) {
      const capture = JSON.parse(row.frozen_json) as CodeCapture;
      check(
        digest(capture) === row.frozen_hash,
        'code_submission_corrupt',
        'Submitted evidence no longer matches its hash',
        409,
      );
      check(
        capture.workspace?.submission?.parentOid === input.parentOid &&
          capture.workspace.treeOid === input.treeOid,
        'code_submission_conflict',
        'This submission already names a different immutable tree',
        409,
      );
      return capture;
    }
    await this.storage.verifySubmission(caller.projectId, { ...input, unitId: row.unit_id });
    return await this.state.transaction(async (tx) => {
      const stored = (await this.row(tx, caller.projectId, input.sessionId))!;
      if (stored.frozen_json) {
        const found = JSON.parse(stored.frozen_json) as CodeCapture;
        check(
          found.workspace?.submission?.parentOid === input.parentOid &&
            found.workspace.treeOid === input.treeOid,
          'code_submission_conflict',
          'This submission already names a different immutable tree',
          409,
        );
        return found;
      }
      await this.writers.settle(
        tx,
        {
          projectId: caller.projectId,
          unitId: row.unit_id,
          generation: input.generation,
          sessionId: input.sessionId,
          leaseId: input.leaseId,
          expectedHead: input.parentOid,
          moves: false,
        },
        !live(session) && ownEnd(session.closeReason),
      );
      const source = JSON.parse(stored.source_json) as CodeCapture;
      const frozen: CodeCapture = {
        ...source,
        status: 'ready',
        parentOid: input.parentOid,
        observedAt: now(),
        workspace: {
          ...source.workspace!,
          headOid: input.parentOid,
          treeOid: input.treeOid,
          submission: {
            sessionId: input.sessionId,
            parentOid: input.parentOid,
            treeOid: input.treeOid,
          },
        },
      };
      await tx.run(
        'UPDATE code_submissions SET frozen_json=?,frozen_hash=?,frozen_at=? WHERE project_id=? AND session_id=? AND frozen_json IS NULL',
        canonical(frozen),
        digest(frozen),
        frozen.observedAt,
        caller.projectId,
        input.sessionId,
      );
      await recorded(this.state, tx, caller, 'code.submission_frozen', row.unit_id, {
        sessionId: input.sessionId,
        parentOid: input.parentOid,
        treeOid: input.treeOid,
      });
      return frozen;
    });
  }

  /** The approving owner's transaction has already recorded the independent passing verdict. */
  async approve(caller: Caller, input: SubmissionApproval, tx: Transaction): Promise<void> {
    check(!this.closed, 'code_unavailable', 'Submission service is unavailable', 503);
    this.state.assertTransaction(tx);
    check(
      input.codeRef?.kind === 'submission',
      'code_submission_required',
      'Approval names the exact submission',
      409,
    );
    const capture = await this.capture(caller, input.codeRef.sessionId, tx);
    check(
      capture.status === 'ready' &&
        capture.provenance.instanceId === input.unitId &&
        capture.workspace?.submission,
      'code_submission_pending',
      'The producer must stop and freeze its code before approval',
      409,
    );
    const review = await this.reviews.get(caller, input.reviewRef, tx);
    check(
      review.subjectId === input.unitId &&
        review.status === 'submitted' &&
        review.verdict === 'pass' &&
        review.reviewerId === caller.actorId &&
        review.subjectRevision === input.terminalRevision - 1,
      'code_approval_required',
      'An independently recorded passing review is required',
      409,
    );
    check(
      input.reviewSessionId,
      'code_review_unattached',
      'Approval requires an isolated review checkout',
      409,
    );
    const own = await this.sessions.workspaceObservation(caller, input.reviewSessionId, tx);
    check(
      own.provenance.readOnly &&
        own.provenance.instanceId === input.unitId &&
        own.provenance.actorId === caller.actorId &&
        canonical(own.workspace?.attachment.submission ?? null) ===
          canonical(capture.workspace.submission),
      'code_review_unattached',
      'The reviewer must inspect exactly this immutable submitted tree',
      409,
    );
    const body = canonical(input),
      hash = digest(input);
    const previous = await tx.get<MilestoneRow>(
      'SELECT * FROM code_approval_milestones WHERE project_id=? AND review_id=?',
      caller.projectId,
      input.reviewRef,
    );
    if (previous) {
      check(
        previous.approval_hash === hash && previous.accepted_by === caller.actorId,
        'code_approval_conflict',
        'This review already approved another milestone',
        409,
      );
      return;
    }
    await tx.run(
      'INSERT INTO code_approval_milestones(project_id,review_id,unit_id,session_id,approval_json,approval_hash,review_json,accepted_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      caller.projectId,
      input.reviewRef,
      input.unitId,
      input.codeRef.sessionId,
      body,
      hash,
      canonical(review),
      caller.actorId,
      now(),
    );
    await recorded(this.state, tx, caller, 'code.approval_queued', input.unitId, {
      reviewId: input.reviewRef,
      kind: input.kind,
    });
  }
  async requireSettled(projectId: string, unitId: string, tx: Transaction) {
    const pending = await tx.get(
      'SELECT review_id FROM code_approval_milestones WHERE project_id=? AND unit_id=? AND result_json IS NULL',
      projectId,
      unitId,
    );
    check(
      !pending,
      'code_approval_pending',
      'Approved code is being committed and retained before the next writer starts',
      409,
    );
  }
  /** Journal replay is safe after any crash, including durable Git success before DB acknowledgement. */
  async reconcile(): Promise<void> {
    if (bootMaintenance.active) return;
    check(
      !this.state.ambient,
      'code_commit_in_transaction',
      'Git approval materialization runs only after approval commits',
      409,
    );
    const rows = await this.state.read((sql) =>
      sql.all<MilestoneRow>(
        'SELECT * FROM code_approval_milestones WHERE result_json IS NULL ORDER BY created_at,review_id',
      ),
    );
    for (const row of rows) {
      if (this.closed) return;
      try {
        const approval = JSON.parse(row.approval_json) as SubmissionApproval;
        check(
          digest(approval) === row.approval_hash,
          'code_approval_corrupt',
          'Approval journal hash differs',
          409,
        );
        const caller = { projectId: row.project_id, actorId: row.accepted_by };
        const frozen = await this.state.read((sql) =>
          this.row(sql, row.project_id, row.session_id),
        );
        check(
          frozen?.frozen_json,
          'code_submission_missing',
          'Approved submitted tree is missing',
          409,
        );
        const capture = JSON.parse(frozen.frozen_json) as CodeCapture;
        check(
          digest(capture) === frozen.frozen_hash,
          'code_submission_corrupt',
          'Submitted evidence no longer matches its hash',
          409,
        );
        const submission = capture.workspace!.submission!;
        const commit = await this.storage.materializeSubmission(row.project_id, {
          ...submission,
          unitId: row.unit_id,
          approvalId: row.review_id,
          createdAt: row.created_at,
          message: `merv: approved ${approval.kind} ${row.unit_id} (${row.review_id})`,
        });
        check(
          commit.tree === submission.treeOid,
          'code_approval_tree_mismatch',
          'Approval must retain the exact reviewed tree',
          409,
        );
        await this.state.transaction(async (tx) => {
          const current = await tx.get<MilestoneRow>(
            'SELECT * FROM code_approval_milestones WHERE project_id=? AND review_id=?',
            row.project_id,
            row.review_id,
          );
          if (current?.result_json) return;
          await this.complete(tx, row.project_id, {
            approval,
            capture,
            commit,
            acceptedBy: row.accepted_by,
            review: JSON.parse(row.review_json) as ReviewRequest,
          });
          await tx.run(
            'UPDATE code_approval_milestones SET result_json=?,completed_at=?,last_error=NULL WHERE project_id=? AND review_id=? AND result_json IS NULL',
            canonical(commit),
            now(),
            row.project_id,
            row.review_id,
          );
          await recorded(this.state, tx, caller, 'code.approval_retained', row.unit_id, {
            reviewId: row.review_id,
            kind: approval.kind,
            commit: commit.head,
            tree: commit.tree,
          });
        });
      } catch (error) {
        await this.state.transaction((tx) =>
          tx.run(
            'UPDATE code_approval_milestones SET last_error=? WHERE project_id=? AND review_id=? AND result_json IS NULL',
            error instanceof MervError ? error.code : error instanceof Error ? error.name : 'error',
            row.project_id,
            row.review_id,
          ),
        );
      }
    }
  }
}

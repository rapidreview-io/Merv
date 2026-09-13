import type { Context } from 'cordis';
import {
  check,
  digest,
  inTransaction,
  newId,
  now,
  type Artifacts,
  type Caller,
  type ReviewInput,
  type ReviewRequest,
  type Reviews,
  type ReviewSubmit,
  type Scope,
  type Sql,
  type State,
  type Transaction,
} from '@merv/contracts';

export type { ReviewInput, ReviewRequest, ReviewSubmit, Reviews, Verdict } from '@merv/contracts';

interface ReviewRow {
  id: string;
  project_id: string;
  subject_id: string;
  subject_revision: number;
  producer_id: string;
  artifact_ids: string;
  criteria: string;
  manifest: string;
  snapshot_hash: string;
  status: ReviewRequest['status'];
  reviewer_id: string | null;
  verdict: ReviewRequest['verdict'];
  notes: string | null;
  created_at: string;
}
const hydrate = (row: ReviewRow): ReviewRequest => ({
  id: row.id,
  projectId: row.project_id,
  subjectId: row.subject_id,
  subjectRevision: row.subject_revision,
  producerId: row.producer_id,
  artifactIds: JSON.parse(row.artifact_ids),
  criteria: JSON.parse(row.criteria),
  snapshotHash: row.snapshot_hash,
  status: row.status,
  reviewerId: row.reviewer_id,
  verdict: row.verdict,
  notes: row.notes,
  createdAt: row.created_at,
});

/** Generic assessment of immutable evidence. Target state changes belong to the integrating program. */
export class ReviewService implements Reviews {
  constructor(
    private state: State,
    private scope: Scope,
    private artifacts: Artifacts,
  ) {
    state.migrate('reviews', [
      {
        version: 1,
        sql: `
      CREATE TABLE reviews (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, subject_id TEXT NOT NULL,
        subject_revision INTEGER NOT NULL CHECK(subject_revision >= 0), producer_id TEXT NOT NULL,
        artifact_ids TEXT NOT NULL, criteria TEXT NOT NULL, manifest TEXT NOT NULL,
        snapshot_hash TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('requested','started','submitted','superseded')),
        reviewer_id TEXT, verdict TEXT CHECK(verdict IN ('pass','needs_changes','fail')),
        notes TEXT, created_at TEXT NOT NULL,
        CHECK(reviewer_id IS NULL OR reviewer_id != producer_id)
      );
      CREATE INDEX reviews_project ON reviews(project_id, created_at);
      CREATE TABLE review_commands (
        project_id TEXT NOT NULL, actor_id TEXT NOT NULL, request_id TEXT NOT NULL,
        operation TEXT NOT NULL, input_hash TEXT NOT NULL, result TEXT NOT NULL,
        PRIMARY KEY(project_id, actor_id, request_id)
      );
    `,
      },
      {
        version: 2,
        sql: `
      CREATE TRIGGER reviews_snapshot_immutable BEFORE UPDATE OF project_id, subject_id, subject_revision, producer_id, artifact_ids, criteria, manifest, snapshot_hash, created_at ON reviews
        BEGIN SELECT RAISE(ABORT, 'A review snapshot is immutable'); END;
      CREATE TRIGGER reviews_verdict_immutable BEFORE UPDATE ON reviews WHEN OLD.status = 'submitted'
        BEGIN SELECT RAISE(ABORT, 'A submitted verdict is immutable'); END;
      CREATE TRIGGER reviews_no_delete BEFORE DELETE ON reviews
        BEGIN SELECT RAISE(ABORT, 'Review records are durable'); END;
    `,
      },
    ]);
  }

  private row(sql: Sql, caller: Caller, reviewId: string): ReviewRow {
    const row = sql.get<ReviewRow>(
      'SELECT * FROM reviews WHERE id = ? AND project_id = ?',
      reviewId,
      caller.projectId,
    );
    check(row, 'not_found', 'Review not found in this project', 404);
    return row;
  }

  private command<T>(
    tx: Transaction,
    caller: Caller,
    requestId: string,
    operation: string,
    input: unknown,
    fn: () => T,
  ): T {
    check(
      typeof requestId === 'string' && requestId.trim().length > 0,
      'invalid_request',
      'requestId is required',
    );
    const hash = digest(input);
    const old = tx.get<{ operation: string; input_hash: string; result: string }>(
      'SELECT operation, input_hash, result FROM review_commands WHERE project_id = ? AND actor_id = ? AND request_id = ?',
      caller.projectId,
      caller.actorId,
      requestId,
    );
    if (old) {
      check(
        old.operation === operation && old.input_hash === hash,
        'request_conflict',
        'requestId was already used with different input',
        409,
      );
      return JSON.parse(old.result) as T;
    }
    const result = fn();
    tx.run(
      'INSERT INTO review_commands VALUES (?, ?, ?, ?, ?, ?)',
      caller.projectId,
      caller.actorId,
      requestId,
      operation,
      hash,
      JSON.stringify(result),
    );
    return result;
  }

  request(caller: Caller, input: ReviewInput, transaction?: Transaction): ReviewRequest {
    return inTransaction(this.state, transaction, (tx) => {
      this.scope.require(caller, 'write', tx);
      if (input.producerId !== caller.actorId) this.scope.require(caller, 'admin', tx);
      return this.command(tx, caller, input.requestId, 'request', input, () => {
        check(
          typeof input.subjectId === 'string' && input.subjectId.trim(),
          'invalid_subject',
          'A subject identifier is required',
        );
        check(
          Number.isSafeInteger(input.subjectRevision) && input.subjectRevision >= 0,
          'invalid_revision',
          'subjectRevision must be a nonnegative integer',
        );
        check(
          Array.isArray(input.criteria) &&
            input.criteria.length > 0 &&
            input.criteria.every((item) => typeof item === 'string' && item.trim()),
          'invalid_criteria',
          'At least one nonempty assessment criterion is required',
        );
        check(
          Array.isArray(input.artifactIds) &&
            input.artifactIds.length > 0 &&
            new Set(input.artifactIds).size === input.artifactIds.length,
          'invalid_artifacts',
          'A review requires a nonempty list of distinct artifacts',
        );
        const manifest = input.artifactIds.map((id) => this.artifacts.get(caller, id, tx));
        check(
          manifest.every((item) => item.createdBy === input.producerId),
          'forbidden',
          'Every submitted artifact must belong to the producer',
          403,
        );
        const id = newId('review');
        const createdAt = now();
        const snapshotHash = digest({
          subjectId: input.subjectId,
          subjectRevision: input.subjectRevision,
          producerId: input.producerId,
          criteria: input.criteria,
          manifest,
        });
        tx.run(
          `INSERT INTO reviews (id, project_id, subject_id, subject_revision, producer_id, artifact_ids,
          criteria, manifest, snapshot_hash, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?)`,
          id,
          caller.projectId,
          input.subjectId,
          input.subjectRevision,
          input.producerId,
          JSON.stringify(input.artifactIds),
          JSON.stringify(input.criteria),
          JSON.stringify(manifest),
          snapshotHash,
          createdAt,
        );
        this.state.appendEvent(tx, {
          projectId: caller.projectId,
          actorId: caller.actorId,
          type: 'review.requested',
          subjectId: id,
          data: {
            subjectId: input.subjectId,
            subjectRevision: input.subjectRevision,
            snapshotHash,
          },
        });
        return hydrate(this.row(tx, caller, id));
      });
    });
  }

  get(caller: Caller, reviewId: string, transaction?: Transaction): ReviewRequest {
    this.scope.require(caller, 'read', transaction);
    if (transaction) {
      this.state.assertTransaction(transaction);
      return hydrate(this.row(transaction, caller, reviewId));
    }
    return this.state.read((sql) => hydrate(this.row(sql, caller, reviewId)));
  }

  list(caller: Caller): ReviewRequest[] {
    this.scope.require(caller, 'read');
    return this.state.read((sql) =>
      sql
        .all<ReviewRow>(
          'SELECT * FROM reviews WHERE project_id = ? ORDER BY created_at, id',
          caller.projectId,
        )
        .map(hydrate),
    );
  }

  start(caller: Caller, reviewId: string, transaction?: Transaction): ReviewRequest {
    return inTransaction(this.state, transaction, (tx) => {
      this.scope.require(caller, 'review', tx);
      const row = this.row(tx, caller, reviewId);
      check(
        row.producer_id !== caller.actorId,
        'review_independence',
        'A producer cannot review their own submission',
        403,
      );
      if (row.status === 'started' && row.reviewer_id === caller.actorId) return hydrate(row);
      check(
        row.status === 'requested',
        'review_unavailable',
        'Review is already claimed or closed',
        409,
      );
      const changed = tx.run(
        "UPDATE reviews SET status = 'started', reviewer_id = ? WHERE id = ? AND status = 'requested'",
        caller.actorId,
        reviewId,
      );
      check(
        changed.changes === 1,
        'review_unavailable',
        'Another reviewer already claimed this review',
        409,
      );
      this.state.appendEvent(tx, {
        projectId: caller.projectId,
        actorId: caller.actorId,
        type: 'review.started',
        subjectId: reviewId,
        data: {},
      });
      return hydrate(this.row(tx, caller, reviewId));
    });
  }

  submit(caller: Caller, input: ReviewSubmit, transaction?: Transaction): ReviewRequest {
    return inTransaction(this.state, transaction, (tx) => {
      this.scope.require(caller, 'review', tx);
      return this.command(tx, caller, input.requestId, 'submit', input, () => {
        const row = this.row(tx, caller, input.reviewId);
        check(
          row.status === 'started',
          'review_closed',
          'Review must be claimed and open before a verdict can be submitted',
          409,
        );
        check(
          row.reviewer_id === caller.actorId && row.producer_id !== caller.actorId,
          'review_independence',
          'Only the independent reviewer who claimed this review may submit',
          403,
        );
        check(
          ['pass', 'needs_changes', 'fail'].includes(input.verdict),
          'invalid_verdict',
          'Verdict must be pass, needs_changes, or fail',
        );
        check(
          typeof input.notes === 'string' && input.notes.trim().length > 0,
          'invalid_notes',
          'A verdict must include assessment notes',
        );
        tx.run(
          "UPDATE reviews SET status = 'submitted', verdict = ?, notes = ? WHERE id = ?",
          input.verdict,
          input.notes,
          input.reviewId,
        );
        this.state.appendEvent(tx, {
          projectId: caller.projectId,
          actorId: caller.actorId,
          type: 'review.submitted',
          subjectId: input.reviewId,
          data: {
            verdict: input.verdict,
            subjectId: row.subject_id,
            subjectRevision: row.subject_revision,
          },
        });
        return hydrate(this.row(tx, caller, input.reviewId));
      });
    });
  }

  supersede(caller: Caller, reviewId: string, transaction?: Transaction): void {
    inTransaction(this.state, transaction, (tx) => {
      this.scope.require(caller, 'write', tx);
      const row = this.row(tx, caller, reviewId);
      if (row.producer_id !== caller.actorId) this.scope.require(caller, 'admin', tx);
      if (row.status === 'superseded') return;
      check(row.status !== 'submitted', 'review_closed', 'A submitted verdict is immutable', 409);
      tx.run("UPDATE reviews SET status = 'superseded' WHERE id = ?", reviewId);
      this.state.appendEvent(tx, {
        projectId: caller.projectId,
        actorId: caller.actorId,
        type: 'review.superseded',
        subjectId: reviewId,
        data: {},
      });
    });
  }
}

export const reviewsPlugin = {
  name: 'merv-reviews',
  inject: ['state', 'scope', 'artifacts'],
  apply(ctx: Context) {
    ctx.provide('reviews', new ReviewService(ctx.state, ctx.scope, ctx.artifacts));
  },
};
export default reviewsPlugin;

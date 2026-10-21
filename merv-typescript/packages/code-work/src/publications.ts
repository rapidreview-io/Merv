import { z } from 'zod';
import type { CodeUnitStore } from '@merv/code/units';
import { parseCodeInput } from '@merv/code/input';
import { migratePublications } from './publications-schema.js';
import {
  canonical,
  check,
  clip,
  digest,
  MervError,
  newId,
  now,
  recorded,
  type Caller,
  type Scope,
  type Sql,
  type State,
  type Transaction,
} from '@merv/contracts';
import { sourceCaller } from '@merv/scope/rules';
import type { CodePublication, CodePublicationState } from './models.js';
import type { PublicationHost } from './publication-host.js';
import type { CodePublicationApi } from './types.js';

export const codePublicationIdSchema = z.strictObject({
  proposalId: z.string().regex(/^codeprop_[A-Za-z0-9_-]+$/),
});
/** What an accepted unit hands the journal: its own facts, already verified where it was sealed. */
export interface CodeUnitPublicationSeal {
  publicationId: string;
  unitId: string;
  title: string;
  reviewId: string;
  /** The commit its work was prepared from, which is what the pull request is opened against. */
  baseOid: string;
  headOid: string;
  treeOid: string;
  approval: NonNullable<CodePublication['approval']>;
}

interface Row {
  proposal_id: string;
  project_id: string;
  record_json: string;
  binding_json: string;
  review_json: string | null;
  pull_json: string | null;
  merge_json: string | null;
  error: string | null;
  lock_id: string | null;
  lock_until: string | null;
  synced_at: string;
  settled: number;
  stale: number;
  verified: number;
  incident_json: string | null;
}

/** Retry local integration without polling any external service. */
const due = 'settled=0 AND (synced_at<? OR (pull_json IS NULL AND synced_at<?))';
const since = (idle: number) => [idle, 30_000].map((ms) => new Date(Date.now() - ms).toISOString());
const IDLE = 600_000;
/** Merv's one word for where a publication stands; it also says where its verdict stands. */
export const publicationState = (p: Omit<CodePublication, 'state'>): CodePublicationState =>
  p.destination === 'local' && p.verified
    ? 'integrated'
    : p.lastError
      ? 'blocked'
      : p.pull?.merged
        ? 'merged'
        : p.review && p.review.verdict !== 'pass'
          ? 'returned'
          : p.pull?.state === 'closed'
            ? 'closed'
            : p.review?.verdict === 'pass' && p.pull && !p.pull.draft
              ? 'ready'
              : p.pull
                ? 'draft'
                : 'pending';

/** A durable external publication of immutable code facts. The domain alone supplies the review verdict. */
export class CodePublicationService implements CodePublicationApi {
  /** Set by Code Work's start: where it is on, a main that moved is merged by landing.ts. */
  landing?: { lands(sql: Sql, projectId: string, unitId: string, hash: string): Promise<boolean> };
  constructor(
    private state: State,
    private scope: Scope,
    private units: Pick<CodeUnitStore, 'binding'>,
    private host: PublicationHost,
  ) {}
  async initialize() {
    await migratePublications(this.state);
  }
  private decode(row: Row): CodePublication {
    const record: Omit<CodePublication, 'state'> = {
      ...JSON.parse(row.record_json),
      ...(row.binding_json !== 'null'
        ? ((b) => ({
            repository: b.repository.fullName,
            repositoryId: b.repository.id,
            connectionRevision: b.revision,
            baseBranch: b.baseBranch,
          }))(JSON.parse(row.binding_json))
        : {}),
      stale: !!row.stale,
      verified: !!row.verified,
      incident: row.incident_json ? JSON.parse(row.incident_json) : null,
      review: row.review_json ? JSON.parse(row.review_json) : null,
      pull: row.pull_json ? JSON.parse(row.pull_json) : null,
      merge: row.merge_json ? JSON.parse(row.merge_json) : null,
      lastError: row.error,
    };
    return { ...record, state: publicationState(record) };
  }
  private async row(caller: Caller, id: string, tx: Transaction) {
    await this.scope.require(caller, 'read', tx);
    const row = await tx.get<Row>(
      'SELECT * FROM code_publications WHERE proposal_id=? AND project_id=?',
      id,
      caller.projectId,
    );
    check(row, 'publication_not_found', 'Code integration not found in this project', 404);
    return row;
  }
  private fresh(caller: Caller, id: string) {
    return this.state.transaction((tx) => this.row(caller, id, tx));
  }
  /**
   * Opens the publication of an accepted unit with its passing review already sealed.
   */
  async openUnit(caller: Caller, input: CodeUnitPublicationSeal, tx: Transaction) {
    ({ caller, input } = structuredClone({ caller, input }));
    this.state.assertTransaction(tx);
    const destination = 'local' as const;
    const at = now();
    const record: Omit<CodePublication, 'state'> = {
      destination,
      proposalId: input.publicationId,
      instanceId: input.unitId,
      manifestHash: input.approval.acceptanceHash,
      repository: '',
      repositoryId: 0,
      connectionRevision: 0,
      branch: `merv/proposals/${input.publicationId}`,
      baseBranch: 'merv-main',
      baseOid: input.baseOid,
      headOid: input.headOid,
      treeOid: input.treeOid,
      title: clip(input.title, 240),
      createdAt: at,
      review: null,
      pull: null,
      merge: null,
      lastError: null,
      approval: input.approval,
    };
    await tx.run(
      'INSERT INTO code_publications(proposal_id,project_id,record_json,binding_json,review_json) VALUES(?,?,?,?,?) ON CONFLICT(proposal_id) DO NOTHING',
      input.publicationId,
      caller.projectId,
      canonical(record),
      'null',
      canonical({
        id: input.reviewId,
        actorId: caller.actorId,
        verdict: 'pass',
        recordedAt: at,
      }),
    );
  }
  async publications(caller: Caller) {
    caller = structuredClone(caller);
    return this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'read', tx);
      return (
        await tx.all<Row>(
          // Unsettled first, then newest: a proposal id is random, so it says nothing of age.
          "SELECT * FROM code_publications WHERE project_id=? ORDER BY settled,record_json::jsonb->>'createdAt' DESC,proposal_id LIMIT 100",
          caller.projectId,
        )
      ).map((r) => this.decode(r));
    });
  }
  private async locked<T>(caller: Caller, id: string, fn: (row: Row, lock: string) => Promise<T>) {
    const lock = newId('publication_lock');
    const row = await this.state.transaction(async (tx) => {
      const row = await this.row(caller, id, tx);
      check(
        !row.lock_until || row.lock_until < now(),
        'publication_busy',
        'Publication is being reconciled; retry shortly',
        409,
      );
      await tx.run(
        'UPDATE code_publications SET lock_id=?,lock_until=? WHERE proposal_id=?',
        lock,
        new Date(Date.now() + 300_000).toISOString(),
        id,
      );
      return row;
    });
    try {
      return await fn(row, lock);
    } catch (error) {
      const code =
        error instanceof MervError && /^[a-z_]{1,100}$/.test(error.code)
          ? error.code
          : 'code_unavailable';
      await this.state.transaction(async (tx) => {
        const held = await tx.run(
          'UPDATE code_publications SET error=? WHERE proposal_id=? AND lock_id=? AND settled=0',
          code,
          id,
          lock,
        );
        // A finished publication keeps its ending: a refused request never rewrites it.
        if (!held.changes) return;
        // A base quarantine that reached the accepted unit ends its publication, which would be
        // refused on every pass and hold the repository for good; a successor takes it.
        if (code === 'code_quarantined' && (await this.reached(tx, caller, row)))
          await this.markStale(caller, this.decode(row), code, tx);
        // A unit reads a failing sync as an operator's wait (unit-store publicationOf).
        else if (row.error !== code) await this.host.reconcile(caller, tx);
      });
      throw error;
    } finally {
      await this.state.transaction((tx) =>
        tx.run(
          'UPDATE code_publications SET lock_id=NULL,lock_until=NULL,synced_at=? WHERE proposal_id=? AND lock_id=?',
          now(),
          id,
          lock,
        ),
      );
    }
  }
  private async owned(caller: Caller, id: string, lock: string, tx: Transaction) {
    const row = await this.row(caller, id, tx);
    check(
      row.lock_id === lock && row.lock_until !== null && row.lock_until > now(),
      'publication_busy',
      'Publication reconciliation expired or was superseded',
      409,
    );
    return row;
  }
  private async mainOf(sql: Sql, projectId: string) {
    return (await this.units.binding(sql, projectId))?.main.oid ?? null;
  }
  /**
   * An accepted unit publishes once: a row that can no longer merge as reviewed settles stale,
   * and whoever waits on it learns, in the same commit, that a successor must take it.
   */
  private async markStale(
    caller: Caller,
    record: CodePublication,
    reason: string,
    tx: Transaction,
  ) {
    await tx.run(
      'UPDATE code_publications SET stale=1,settled=1,error=? WHERE proposal_id=?',
      reason,
      record.proposalId,
    );
    await this.host.reconcile(caller, tx);
    await recorded(this.state, tx, caller, 'code.publication_stale', record.proposalId, {
      unitId: record.instanceId,
      reason,
    });
  }
  /** Whether a base quarantine reached the publication's unit, which ends it for good. */
  private reached(sql: Sql, caller: Caller, row: Row) {
    return sql.get(
      'SELECT 1 FROM code_units WHERE project_id=? AND unit_id=? AND quarantine_base_key IS NOT NULL',
      caller.projectId,
      this.decode(row).instanceId,
    );
  }
  /** A reviewed local integration needs no remote, but retains the same review certificate. */
  private async publishLocal(caller: Caller, row: Row, lock: string) {
    const record = this.decode(row);
    await this.host.verifyLocal(caller, record);
    // A main the reviewed head already holds moved under it, not past it. Git answers that
    // before the transaction, which only accepts the main it was asked about.
    const seen = await this.state.read((sql) => this.mainOf(sql, caller.projectId));
    const held = !!seen && (await this.host.ancestor(caller.projectId, seen, record.headOid));
    // A main that already holds the reviewed head, landed there or bound past it, published it.
    const within = !!seen && (await this.host.ancestor(caller.projectId, record.headOid, seen));
    await this.state.transaction(async (tx) => {
      const current = this.decode(await this.owned(caller, row.proposal_id, lock, tx));
      await this.scope.require(caller, 'write', tx);
      await this.host.check(caller, current, tx);
      const main = await this.mainOf(tx, caller.projectId);
      // The checkout base may already merge accepted dependencies with main.
      // CAS the pinned integration main, not that derived checkout commit.
      const expectedMain = current.approval!.integrationBase;
      const contained = within && main === seen && main !== current.headOid;
      if (
        !contained &&
        main !== expectedMain &&
        main !== current.headOid &&
        !(held && main === seen)
      ) {
        // Where accepted work lands on main, landing merges this head; it waits for that,
        // unless landing skipped it, which leaves it to a successor like any moved main.
        const { instanceId, manifestHash } = current;
        if (await this.landing?.lands(tx, caller.projectId, instanceId, manifestHash)) return;
        await this.markStale(caller, current, 'code_main_changed', tx);
        return;
      }
      await tx.run(
        'UPDATE code_publications SET merge_json=?,verified=1,settled=1,error=NULL WHERE proposal_id=?',
        canonical({
          requestId: `local:${record.proposalId}`,
          actorId: caller.actorId,
          expectedBase: expectedMain,
          requestedAt: now(),
          commitSha: record.headOid,
          mainParent: main === record.headOid ? expectedMain : main,
        }),
        row.proposal_id,
      );
      if (contained) await this.host.reconcile(caller, tx);
      else await this.host.main(caller, record.headOid, tx, main);
      await recorded(this.state, tx, caller, 'code.publication_verified', record.proposalId, {
        destination: 'local',
        unitId: record.instanceId,
        previousMain: main,
        commitSha: record.headOid,
      });
    });
  }

  async syncPublications(caller: Caller) {
    caller = structuredClone(caller);
    check(
      !caller.session,
      'session_forbidden',
      'Worker credentials cannot integrate accepted code',
      403,
    );
    await this.sync(caller, 30_000);
    return this.publications(caller);
  }
  private async sync(caller: Caller, idle: number, stopped = () => false) {
    const records = await this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'write', tx);
      return tx.all<{ proposal_id: string }>(
        `SELECT proposal_id FROM code_publications WHERE project_id=? AND ${due} ORDER BY synced_at,proposal_id`,
        caller.projectId,
        ...since(idle),
      );
    });
    // Each intent is restartable, and one tried too recently waits for a later pass.
    for (const { proposal_id } of records) {
      if (stopped()) return;
      try {
        await this.locked(caller, proposal_id, async (row, lock) => {
          // Settled since this pass read it, by a person's merge or another pass: nothing is due,
          // and a stale one must not be reopened (and its head approved again) by saving it.
          if (Number(row.settled)) return;
          if (this.decode(row).destination === 'local')
            return await this.publishLocal(caller, row, lock);
          throw new MervError(
            'github_integration_retired',
            'Historical external publications are read-only',
            409,
          );
        });
      } catch {
        /* Durable status is returned; a later authorized poll can reconcile the same intent. */
      }
    }
  }
  /**
   * Nothing else carries an accepted unit to main, so Code syncs every project with a
   * publication due, as its owner: the person Fleet already works for there. A project with
   * no live operator waits for someone with write access to sync it. It stops once `stopped`.
   */
  async syncDue(stopped = () => false) {
    const projects = await this.state.read((sql) =>
      sql.all<{ project_id: string }>(
        `SELECT DISTINCT project_id FROM code_publications WHERE ${due}`,
        ...since(IDLE),
      ),
    );
    if (!projects.length) return;
    const owners = new Map(
      (await this.scope.projectOwners()).map((owner) => [owner.projectId, owner.source]),
    );
    for (const { project_id } of projects) {
      const owner = owners.get(project_id);
      if (owner) await this.sync(sourceCaller(owner), IDLE, stopped).catch(() => undefined);
    }
  }
  async publicationDetails(caller: Caller, proposalId: string) {
    caller = structuredClone(caller);
    const { proposalId: id } = parseCodeInput(codePublicationIdSchema, { proposalId });
    return { publication: this.decode(await this.fresh(caller, id)), details: null };
  }
}

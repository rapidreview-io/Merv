import type { CodeWriterService } from '@merv/code/writers';
import type { CodeRepositories } from '@merv/code/store/repository';
import { check, digest, type Caller, type Reviews, type Transaction } from '@merv/contracts';
import type { CodePublication } from './models.js';
import type { CodeUnitService } from './units.js';

/** What Code Work has started by the time its publications open. */
export interface PublicationCode {
  units: Pick<CodeUnitService, 'changed' | 'records'>;
}

/** Hosted publication borrows the repository and admission journal; it never owns a credential. */
export class PublicationHost {
  constructor(
    private reviews: Pick<Reviews, 'get'>,
    private repositories: CodeRepositories,
    private writers: CodeWriterService,
    private code: PublicationCode,
  ) {}
  async check(caller: Caller, record: CodePublication, tx: Transaction) {
    const envelope = record.approval!;
    const accepted = await tx.get<{ acceptance_json: string }>(
      'SELECT acceptance_json FROM code_units WHERE project_id=? AND unit_id=?',
      caller.projectId,
      record.instanceId,
    );
    check(
      accepted && digest(JSON.parse(accepted.acceptance_json)) === envelope.acceptanceHash,
      'publication_conflict',
      'The publication no longer matches its accepted review',
      409,
    );
    const review = await this.reviews.get(caller, record.review!.id, tx);
    check(
      review.verdict === 'pass' &&
        review.reviewerId === record.review!.actorId &&
        // An ordinary unit review carries no certificate; one that does is bound exactly.
        (envelope.certificateHash === null || review.provenance?.hash === envelope.certificateHash),
      'publication_review_required',
      'The exact independent review certificate is required',
      409,
    );
    const unit = await this.writers.row(tx, caller.projectId, record.instanceId);
    check(
      unit && !unit.blocked_by && !unit.quarantine_operation_id,
      'code_quarantined',
      'Quarantined work cannot be published',
      409,
    );
  }
  /**
   * Where a publication stands is Code's own row; the unit's blockers are read back from it.
   * An accepted unit has no producing state to return to, so this is all an outcome changes.
   */
  async reconcile(caller: Caller, tx: Transaction) {
    await this.code.units.changed(tx, caller.projectId);
  }
  async ancestor(projectId: string, base: string, head: string) {
    const repos = this.repositories;
    const result = await repos.git.run(['merge-base', '--is-ancestor', base, head], {
      env: repos.environment(projectId),
    });
    check(
      result.code === 0 || result.code === 1,
      'code_publication_objects_missing',
      'Import the current main and reviewed head before publishing',
      409,
    );
    return result.code === 0;
  }
  private async retainSnapshot(caller: Caller, record: CodePublication) {
    const repos = this.repositories;
    const ref = `refs/merv/proposals/${record.proposalId}`;
    await repos.run(caller.projectId, async () => {
      const env = repos.environment(caller.projectId);
      const found = await repos.git.run(['rev-parse', '--verify', ref], { env });
      if (found.code === 0)
        check(
          found.stdout.toString().trim() === record.headOid,
          'publication_conflict',
          'An immutable proposal ref has different code',
          409,
        );
      else
        await repos.git.ok(['update-ref', ref, record.headOid, '0'.repeat(record.headOid.length)], {
          env,
        });
    });
  }
  async main(caller: Caller, oid: string, tx: Transaction, expectedOid?: string) {
    await this.code.units.records.moveMain(caller, oid, tx, expectedOid);
    await this.reconcile(caller, tx);
  }
  async verifyLocal(caller: Caller, record: CodePublication) {
    check(
      record.destination === 'local',
      'publication_conflict',
      'This is not a local integration',
      409,
    );
    const repos = this.repositories;
    const tree = (
      await repos.git.ok(['rev-parse', `${record.headOid}^{tree}`], {
        env: repos.environment(caller.projectId),
      })
    )
      .toString()
      .trim();
    check(
      tree === record.treeOid &&
        (await this.ancestor(caller.projectId, record.baseOid, record.headOid)) &&
        (await this.ancestor(caller.projectId, record.approval!.integrationBase, record.headOid)),
      'publication_conflict',
      'The reviewed tree must retain the previous main history',
      409,
    );
    // Both destinations retain the same immutable snapshot before acknowledging publication.
    await this.retainSnapshot(caller, record);
  }
}

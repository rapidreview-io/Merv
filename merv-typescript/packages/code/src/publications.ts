import {
  clip,
  canonical,
  check,
  codePublicationIdSchema,
  codePublicationMergeSchema,
  MervError,
  now,
  newId,
  type Caller,
  type CodePublication,
  type CodePublicationMerge,
  type CodePublicationApi,
  type GitHubPullRequest,
  type Scope,
  type State,
  type Transaction,
} from '@merv/contracts';
import type { CodeProposal } from './types.js';
import { CodeGitHubService } from './github.js';
import type { CodeTransportService } from './transport.js';
import { parseCodeInput } from './input.js';

const schema = `CREATE TABLE code_publications (
  proposal_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,record_json TEXT NOT NULL,binding_json TEXT NOT NULL,
  review_json TEXT,pull_json TEXT,merge_json TEXT,error TEXT,lock_id TEXT,lock_until TEXT,synced_at TEXT NOT NULL DEFAULT '',settled INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX code_publications_project ON code_publications(project_id);`;
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
}

/** A durable external publication of immutable code facts. The domain alone supplies the review verdict. */
export class CodePublicationService implements CodePublicationApi {
  constructor(
    private state: State,
    private scope: Scope,
    private github: CodeGitHubService,
    private transport: CodeTransportService,
  ) {}
  async initialize() {
    await this.state.migrate('code_publications', [{ version: 1, sql: schema, postgres: schema }]);
  }
  private decode(row: Row): CodePublication {
    return {
      ...JSON.parse(row.record_json),
      review: row.review_json ? JSON.parse(row.review_json) : null,
      pull: row.pull_json ? JSON.parse(row.pull_json) : null,
      merge: row.merge_json ? JSON.parse(row.merge_json) : null,
      lastError: row.error,
    };
  }
  private async row(caller: Caller, id: string, tx: Transaction) {
    await this.scope.require(caller, 'read', tx);
    const row = await tx.get<Row>(
      'SELECT * FROM code_publications WHERE proposal_id=? AND project_id=?',
      id,
      caller.projectId,
    );
    check(row, 'publication_not_found', 'GitHub publication not found in this project', 404);
    return row;
  }
  async enqueue(caller: Caller, proposal: CodeProposal, tx: Transaction) {
    this.state.assertTransaction(tx);
    if (!proposal.receipt.repositoryId.startsWith('github:')) return;
    const binding = await this.transport.bindingForProposal(proposal.producer.sessionId, tx);
    check(
      binding && proposal.receipt.repositoryId === `github:${binding.repository.id}`,
      'github_conflict',
      'Proposal repository binding is unavailable',
      409,
    );
    // Record verified local facts even if publication authority has since expired.
    // Every external operation independently rechecks the frozen binding and current authority.
    const record: CodePublication = {
      proposalId: proposal.id,
      instanceId: proposal.instanceId,
      manifestHash: proposal.manifestHash,
      repository: binding.repository.fullName,
      repositoryId: binding.repository.id,
      connectionRevision: binding.revision,
      branch: `merv/proposals/${proposal.id}`,
      baseBranch: binding.baseBranch,
      baseOid: proposal.receipt.baseOid,
      headOid: proposal.receipt.headOid,
      treeOid: proposal.receipt.treeOid,
      title: clip(proposal.summary, 240),
      createdAt: now(),
      review: null,
      pull: null,
      merge: null,
      lastError: null,
    };
    await tx.run(
      'INSERT INTO code_publications(proposal_id,project_id,record_json,binding_json) VALUES(?,?,?,?) ON CONFLICT(proposal_id) DO NOTHING',
      proposal.id,
      caller.projectId,
      canonical(record),
      canonical(binding),
    );
  }
  /** Trusted domain hook only: invoked in the same transaction that commits its independent verdict. */
  async recordReview(
    caller: Caller,
    proposal: CodeProposal,
    reviewId: string,
    verdict: NonNullable<CodePublication['review']>['verdict'],
    tx: Transaction,
  ) {
    this.state.assertTransaction(tx);
    if (!proposal.receipt.repositoryId.startsWith('github:')) return;
    await this.scope.require(caller, 'review', tx);
    check(
      caller.actorId !== proposal.producer.actorId,
      'self_review',
      'The producer cannot approve its own publication',
      403,
    );
    const row = await this.row(caller, proposal.id, tx),
      record = this.decode(row);
    check(
      record.manifestHash === proposal.manifestHash && record.headOid === proposal.receipt.headOid,
      'publication_conflict',
      'The review does not match the immutable proposal',
      409,
    );
    if (record.review) {
      check(
        record.review.id === reviewId &&
          record.review.actorId === caller.actorId &&
          record.review.verdict === verdict,
        'publication_conflict',
        'This publication already has a different review verdict',
        409,
      );
      return;
    }
    await tx.run(
      "UPDATE code_publications SET review_json=?,synced_at='' WHERE proposal_id=?",
      canonical({ id: reviewId, actorId: caller.actorId, verdict, recordedAt: now() }),
      proposal.id,
    );
  }
  async publications(caller: Caller) {
    return this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'read', tx);
      return (
        await tx.all<Row>(
          'SELECT * FROM code_publications WHERE project_id=? ORDER BY proposal_id DESC LIMIT 100',
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
          : 'github_unavailable';
      await this.state.transaction((tx) =>
        tx.run(
          'UPDATE code_publications SET error=? WHERE proposal_id=? AND lock_id=?',
          code,
          id,
          lock,
        ),
      );
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
  private pinned(record: CodePublication, pull: GitHubPullRequest) {
    check(
      pull.head.sha === record.headOid &&
        pull.head.ref === record.branch &&
        pull.head.repositoryId === record.repositoryId &&
        pull.base.ref === record.baseBranch &&
        pull.base.repositoryId === record.repositoryId &&
        (!record.pull || pull.id === record.pull.id),
      'github_head_changed',
      'The pull request no longer matches the reviewed proposal; a new proposal and review are required',
      409,
    );
  }
  private async save(caller: Caller, row: Row, lock: string, pull: GitHubPullRequest) {
    return this.state.transaction(async (tx) => {
      const current = await this.row(caller, row.proposal_id, tx);
      check(
        current.lock_id === lock,
        'publication_busy',
        'Publication reconciliation was superseded',
        409,
      );
      await this.github.assertBinding(caller, JSON.parse(row.binding_json), tx, 'write');
      const record = this.decode(current);
      this.pinned(record, pull);
      await tx.run(
        'UPDATE code_publications SET pull_json=?,error=NULL,settled=? WHERE proposal_id=?',
        canonical(pull),
        Number(pull.merged || pull.state === 'closed'),
        row.proposal_id,
      );
      if (pull.merged && record.merge && pull.mergeCommitSha) {
        await tx.run(
          'UPDATE code_publications SET merge_json=? WHERE proposal_id=?',
          canonical({ ...record.merge, commitSha: pull.mergeCommitSha }),
          row.proposal_id,
        );
      }
      return this.decode(await this.row(caller, row.proposal_id, tx));
    });
  }
  async syncPublications(caller: Caller) {
    check(
      !caller.session,
      'session_forbidden',
      'Worker credentials cannot publish pull requests',
      403,
    );
    await this.scope.require(caller, 'write');
    const records = await this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'write', tx);
      return (
        await tx.all<Row>(
          'SELECT * FROM code_publications WHERE project_id=? AND settled=0 AND synced_at<? ORDER BY synced_at,proposal_id LIMIT 100',
          caller.projectId,
          new Date(Date.now() - 30_000).toISOString(),
        )
      ).map((row) => this.decode(row));
    });
    // One network reconciliation per poll keeps runner heartbeats bounded; each intent is restartable.
    for (const record of records.slice(0, 1)) {
      try {
        await this.locked(caller, record.proposalId, async (row, lock) => {
          await this.github.automation(
            caller,
            'write',
            JSON.parse(row.binding_json),
            async (client, token) => {
              const current = this.decode(row);
              let pull: GitHubPullRequest;
              if (current.pull)
                pull = await client.pull(token, current.repository, current.pull.number);
              else {
                const found = await client.pulls(token, current.repository, {
                  state: 'all',
                  head: `${current.repository.split('/')[0]}:${current.branch}`,
                });
                check(
                  found.length <= 1,
                  'github_conflict',
                  'Multiple pull requests use this proposal branch',
                  409,
                );
                if (found.length) pull = found[0];
                else {
                  // Creation may have succeeded before a previous process lost its reply.
                  // Always recover that PR before settling a rejected proposal.
                  if (current.review && current.review.verdict !== 'pass') {
                    await this.state.transaction(async (tx) => {
                      const result = await tx.run(
                        'UPDATE code_publications SET settled=1,error=NULL WHERE proposal_id=? AND lock_id=?',
                        current.proposalId,
                        lock,
                      );
                      check(
                        result.changes === 1,
                        'publication_busy',
                        'Publication reconciliation was superseded',
                        409,
                      );
                    });
                    return;
                  }
                  await client.ensureBranch(
                    token,
                    current.repository,
                    current.branch,
                    current.headOid,
                  );
                  try {
                    pull = await client.createPull(token, current.repository, {
                      title: current.title,
                      head: current.branch,
                      base: current.baseBranch,
                      draft: true,
                      body: `Merv consolidation proposal ${current.proposalId}\n\nExact commit: ${current.headOid}\nManifest SHA-256: ${current.manifestHash}\n\nMerv's independent verdict is tracked separately from GitHub reviews.`,
                    });
                  } catch (error) {
                    const recovered = await client.pulls(token, current.repository, {
                      state: 'all',
                      head: `${current.repository.split('/')[0]}:${current.branch}`,
                    });
                    if (recovered.length !== 1) throw error;
                    pull = recovered[0];
                  }
                }
              }
              this.pinned(current, pull);
              // A review may have arrived while the remote PR was being created. Reload its immutable verdict.
              const latest = await this.state.transaction((tx) =>
                this.row(caller, current.proposalId, tx),
              );
              const review = this.decode(latest).review;
              if (pull.state === 'open' && review) {
                if (review.verdict !== 'pass')
                  pull = await client.updatePull(token, current.repository, pull.number, {
                    state: 'closed',
                  });
                else if (pull.draft) {
                  await client.readyPull(token, pull.nodeId);
                  pull = await client.pull(token, current.repository, pull.number);
                }
              }
              await this.save(caller, row, lock, pull);
            },
          );
        });
      } catch {
        /* Durable status is returned; a later authorized poll can reconcile the same intent. */
      }
    }
    return this.publications(caller);
  }
  async publicationDetails(caller: Caller, proposalId: string) {
    const { proposalId: id } = parseCodeInput(codePublicationIdSchema, { proposalId });
    const row = await this.state.transaction((tx) => this.row(caller, id, tx)),
      publication = this.decode(row);
    if (!publication.pull) return { publication, details: null };
    const details = await this.github.automation(
      caller,
      'read',
      JSON.parse(row.binding_json),
      async (client, token) => {
        const details = await client.pullDetails(
          token,
          publication.repository,
          publication.pull!.number,
        );
        this.pinned(publication, details.pull);
        return details;
      },
    );
    return { publication: { ...publication, pull: details.pull }, details };
  }
  async mergePublication(caller: Caller, value: CodePublicationMerge) {
    const input = parseCodeInput(codePublicationMergeSchema, value);
    await this.scope.require(caller, 'admin');
    check(
      caller.human && !caller.session && !caller.key,
      'github_human_required',
      'A signed-in project operator must merge the reviewed proposal',
      403,
    );
    return this.locked(caller, input.proposalId, async (row, lock) => {
      const record = this.decode(row);
      check(
        record.review?.verdict === 'pass' && record.pull,
        'publication_review_required',
        'An independently approved proposal and its pull request are required',
        409,
      );
      check(
        record.headOid === input.expectedHead,
        'github_head_changed',
        'The selected commit differs from the reviewed proposal',
        409,
      );
      return this.github.automation(
        caller,
        'write',
        JSON.parse(row.binding_json),
        async (client, token) => {
          await this.scope.require(caller, 'admin');
          let pull = await client.pull(token, record.repository, record.pull!.number);
          this.pinned(record, pull);
          if (pull.merged) return this.save(caller, row, lock, pull);
          check(
            pull.state === 'open' && !pull.draft && pull.base.sha === input.expectedBase,
            'github_base_changed',
            'The pull request changed; refresh its current base, checks and review before merging',
            409,
          );
          const inspection = await client.pullDetails(token, record.repository, pull.number);
          this.pinned(record, inspection.pull);
          check(
            inspection.pull.base.sha === input.expectedBase,
            'github_base_changed',
            'The base changed during inspection; refresh before merging',
            409,
          );
          check(
            (inspection.statusCount === 0 || inspection.commitStatus === 'success') &&
              inspection.checks.every(
                (c) =>
                  c.status === 'completed' &&
                  ['success', 'neutral', 'skipped'].includes(c.conclusion ?? ''),
              ),
            'github_checks_pending',
            'GitHub checks must finish successfully before merging',
            409,
          );
          await this.state.transaction(async (tx) => {
            await this.scope.require(caller, 'admin', tx);
            await this.github.assertBinding(caller, JSON.parse(row.binding_json), tx, 'write');
            const latest = this.decode(await this.row(caller, record.proposalId, tx));
            if (latest.merge?.requestId === input.requestId)
              check(
                latest.merge.expectedBase === input.expectedBase &&
                  latest.merge.actorId === caller.actorId,
                'publication_conflict',
                'Merge request identifier has different input',
                409,
              );
            const saved = await tx.run(
              'UPDATE code_publications SET merge_json=? WHERE proposal_id=? AND lock_id=?',
              canonical({
                requestId: input.requestId,
                actorId: caller.actorId,
                expectedBase: input.expectedBase,
                requestedAt: now(),
                commitSha: null,
              }),
              record.proposalId,
              lock,
            );
            check(
              saved.changes === 1,
              'publication_busy',
              'Publication reconciliation was superseded',
              409,
            );
          });
          // GitHub atomically checks the head SHA and enforces protections. Its API has no expected-base CAS.
          const result = await client.mergePull(
            token,
            record.repository,
            pull.number,
            input.expectedHead,
            'merge',
          );
          check(
            result.merged,
            'github_merge_blocked',
            'GitHub did not merge this pull request; inspect checks and protection rules',
            409,
          );
          pull = await client.pull(token, record.repository, pull.number);
          check(
            pull.merged && pull.mergeCommitSha === result.sha,
            'github_merge_uncertain',
            'Refresh to reconcile the GitHub merge result',
            409,
          );
          return this.save(caller, row, lock, pull);
        },
      );
    });
  }
}

import {
  clip,
  canonical,
  digest,
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
import { z } from 'zod';
import type { CodeProposal } from './types.js';
import { CodeGitHubService } from './github.js';
import type { CodeTransportService } from './transport.js';
import { parseCodeInput } from './input.js';
import { publicationMigration } from './publications-schema.js';
import { PublicationIncident, type PublicationHost } from './publication-host.js';

const schema = `CREATE TABLE code_publications (
  proposal_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,record_json TEXT NOT NULL,binding_json TEXT NOT NULL,
  review_json TEXT,pull_json TEXT,merge_json TEXT,error TEXT,lock_id TEXT,lock_until TEXT,synced_at TEXT NOT NULL DEFAULT '',settled INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX code_publications_project ON code_publications(project_id);`;
export const publicationReleaseSchema = z
  .object({
    proposalId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/),
    reason: z.string().trim().min(1).max(4000),
    requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/),
  })
  .strict();
/**
 * Every way a publication's repository stops being reachable: the frozen binding no longer
 * matches the connection, or the project has no connection left to bind to at all. Unlinking a
 * repository turns automation off in the same statement, so it arrives here as the disabled
 * refusal. None of these is about the caller's own authority, and none is a passing server-wide
 * condition, which is why a refusal outside this list is reported as it arrived.
 */
const unreachable = [
  'github_reconnect',
  'github_conflict',
  'github_owner',
  'github_automation_disabled',
];
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
  successor: string | null;
  verified: number;
  incident_json: string | null;
}

/** A durable external publication of immutable code facts. The domain alone supplies the review verdict. */
export class CodePublicationService implements CodePublicationApi {
  constructor(
    private state: State,
    private scope: Scope,
    private github: CodeGitHubService,
    private transport: CodeTransportService,
    private host?: PublicationHost,
  ) {}
  async initialize() {
    await this.state.migrate('code_publications', [
      { version: 1, sql: schema, postgres: schema },
      publicationMigration,
    ]);
  }
  private decode(row: Row): CodePublication {
    return {
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
      successor: row.successor,
      verified: !!row.verified,
      incident: row.incident_json ? JSON.parse(row.incident_json) : null,
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
  async enqueue(caller: Caller, proposal: CodeProposal, tx: Transaction, reviewId?: string) {
    ({ caller, proposal } = structuredClone({ caller, proposal }));
    this.state.assertTransaction(tx);
    const hosted = proposal.workflow?.name === 'consolidation' && proposal.workflow.version === 5;
    if (!hosted && !proposal.receipt.repositoryId.startsWith('github:')) return;
    const binding = hosted
      ? null
      : await this.transport.bindingForProposal(proposal.producer.sessionId, tx);
    check(
      hosted || (binding && proposal.receipt.repositoryId === `github:${binding.repository.id}`),
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
      repository: binding?.repository.fullName ?? '',
      repositoryId: binding?.repository.id ?? 0,
      connectionRevision: binding?.revision ?? 0,
      branch: `merv/proposals/${proposal.id}`,
      baseBranch: binding?.baseBranch ?? 'main',
      baseOid: proposal.receipt.baseOid,
      headOid: proposal.receipt.headOid,
      treeOid: proposal.receipt.treeOid,
      title: clip(proposal.summary, 240),
      createdAt: now(),
      review: null,
      pull: null,
      merge: null,
      lastError: null,
      ...(hosted ? { approval: await this.approval(caller, proposal, reviewId!, tx) } : {}),
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
    ({ caller, proposal } = structuredClone({ caller, proposal }));
    this.state.assertTransaction(tx);
    if (proposal.workflow?.name === 'consolidation' && proposal.workflow.version === 5) {
      if (verdict !== 'pass') return;
      await this.enqueue(caller, proposal, tx, reviewId);
      await tx.run(
        "UPDATE code_publications SET successor=?,settled=0,synced_at='' WHERE project_id=? AND stale=1 AND successor IS NULL AND proposal_id IN (SELECT id FROM code_proposals WHERE instance_id=?)",
        proposal.id,
        caller.projectId,
        proposal.instanceId,
      );
    } else if (!proposal.receipt.repositoryId.startsWith('github:')) return;
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
  private async approval(
    caller: Caller,
    proposal: CodeProposal,
    reviewId: string,
    tx: Transaction,
  ) {
    const round = await tx.get<{ acceptance_json: string; review_id: string }>(
      'SELECT acceptance_json,review_id FROM code_review_acceptances WHERE project_id=? AND unit_id=? AND review_id=?',
      caller.projectId,
      proposal.instanceId,
      reviewId,
    );
    check(
      round,
      'publication_review_required',
      'A passing review acceptance must seal publication',
      409,
    );
    const accepted = JSON.parse(round.acceptance_json);
    const review = await tx.get<{ provenance_json: string; verdict: string }>(
      'SELECT provenance_json,verdict FROM reviews WHERE id=? AND project_id=?',
      round.review_id,
      caller.projectId,
    );
    const certificate = review?.provenance_json && JSON.parse(review.provenance_json);
    check(
      review?.verdict === 'pass' &&
        certificate?.reference === proposal.id &&
        accepted.code?.commit === proposal.receipt.headOid,
      'publication_review_required',
      'The acceptance and independent certificate must name this exact proposal',
      409,
    );
    const { candidates, manifest } = proposal.provenance as unknown as {
      candidates: { hash: string; integrationBase: string };
      manifest: { hash: string };
    };
    return {
      candidateSetHash: candidates.hash,
      decisionManifestHash: manifest.hash,
      integrationBase:
        (proposal.provenance.integrationBase as string | undefined) ?? candidates.integrationBase,
      certificateHash: certificate.hash,
      acceptanceHash: digest(accepted),
    };
  }
  async publications(caller: Caller) {
    caller = structuredClone(caller);
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
  private async save(caller: Caller, row: Row, lock: string, pull: GitHubPullRequest) {
    const original = this.decode(row);
    let mainParent: string | undefined;
    if (original.approval && pull.merged && !original.verified) {
      try {
        check(
          !original.incident,
          'code_publication_incident',
          'This publication has a retained incident; investigate it without rewriting its approved facts',
          409,
        );
        check(
          pull.mergeCommitSha && original.merge,
          'code_publication_incident',
          'A merge occurred without a retained human intent',
          409,
        );
        mainParent = await this.host!.verify(caller, original, pull.mergeCommitSha);
      } catch (error) {
        if (error instanceof MervError && error.code === 'code_publication_incident')
          await this.state.transaction(async (tx) => {
            await this.owned(caller, row.proposal_id, lock, tx);
            await tx.run(
              "UPDATE code_publications SET incident_json=COALESCE(incident_json,?),pull_json=?,error='code_publication_incident',settled=1 WHERE proposal_id=?",
              canonical({
                commitSha: pull.mergeCommitSha,
                expectedHead: original.headOid,
                expectedTree: original.treeOid,
                ...(error instanceof PublicationIncident ? error.observation : {}),
                at: now(),
              }),
              canonical(pull),
              row.proposal_id,
            );
          });
        throw error;
      }
    }
    return this.state.transaction(async (tx) => {
      const current = await this.owned(caller, row.proposal_id, lock, tx);
      await this.github.assertBinding(caller, JSON.parse(row.binding_json), tx, 'write');
      const record = this.decode(current);
      this.pinned(record, pull);
      await tx.run(
        'UPDATE code_publications SET pull_json=?,error=NULL,settled=? WHERE proposal_id=?',
        canonical(pull),
        Number(pull.merged || pull.state === 'closed'),
        row.proposal_id,
      );
      if (pull.merged && record.approval && !record.verified) {
        await this.host!.check(caller, record, tx);
        await this.host!.apply(caller, record, 'published', tx);
        await this.host!.main(caller, pull.mergeCommitSha!, tx);
      }
      if (pull.merged && record.merge && pull.mergeCommitSha) {
        await tx.run(
          'UPDATE code_publications SET merge_json=? WHERE proposal_id=?',
          canonical({
            ...record.merge,
            commitSha: pull.mergeCommitSha,
            ...(mainParent ? { mainParent } : {}),
          }),
          row.proposal_id,
        );
      }
      if (pull.merged && record.approval && !record.verified)
        await tx.run(
          'UPDATE code_publications SET verified=1 WHERE proposal_id=?',
          record.proposalId,
        );
      return this.decode(await this.row(caller, row.proposal_id, tx));
    });
  }
  async syncPublications(caller: Caller) {
    caller = structuredClone(caller);
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
          'SELECT * FROM code_publications WHERE project_id=? AND settled=0 AND synced_at<? ORDER BY CASE WHEN successor IS NOT NULL THEN 0 ELSE 1 END,synced_at,proposal_id LIMIT 100',
          caller.projectId,
          new Date(Date.now() - 30_000).toISOString(),
        )
      ).map((row) => this.decode(row));
    });
    // One network reconciliation per poll keeps runner heartbeats bounded; each intent is restartable.
    for (const record of records.slice(0, 1)) {
      try {
        await this.locked(caller, record.proposalId, async (row, lock) => {
          if (row.binding_json === 'null') {
            row = await this.state.transaction(async (tx) => {
              await this.owned(caller, row.proposal_id, lock, tx);
              const binding = await this.github.publicationBinding(caller, tx);
              await tx.run(
                'UPDATE code_publications SET binding_json=? WHERE proposal_id=?',
                canonical(binding),
                row.proposal_id,
              );
              return this.owned(caller, row.proposal_id, lock, tx);
            });
          }
          const hosted = !!this.decode(row).approval;
          if (hosted && row.stale && !row.successor) {
            await this.state.transaction(async (tx) => {
              const current = await this.owned(caller, row.proposal_id, lock, tx);
              if (!current.settled) {
                await this.host!.apply(caller, this.decode(current), 'resume', tx);
                await tx.run(
                  'UPDATE code_publications SET settled=1 WHERE proposal_id=?',
                  row.proposal_id,
                );
              }
            });
            return;
          }
          await (
            hosted
              ? this.github.publicationAutomation.bind(this.github)
              : this.github.automation.bind(this.github)
          )(
            caller,
            'write',
            JSON.parse(row.binding_json),
            async (client, token) => {
              const current = this.decode(row);
              let pull: GitHubPullRequest;
              if (hosted && !current.stale) {
                await this.host!.rules(caller, client, token, current, false);
                await this.state.transaction((tx) => this.host!.check(caller, current, tx));
                await this.host!.snapshot(caller, current);
              }
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
              if (hosted && current.successor && pull.state === 'open') {
                await client.successorComment(
                  token,
                  current.repository,
                  pull.number,
                  current.successor,
                );
                pull = await client.updatePull(token, current.repository, pull.number, {
                  state: 'closed',
                });
              }
              if (pull.state === 'open' && review) {
                if (hosted && review.verdict === 'pass')
                  await client.approvalStatus(token, current.repository, current.headOid, true);
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
            (tx) => this.owned(caller, row.proposal_id, lock, tx),
          );
        });
      } catch {
        /* Durable status is returned; a later authorized poll can reconcile the same intent. */
      }
    }
    return this.publications(caller);
  }
  async publicationDetails(caller: Caller, proposalId: string) {
    caller = structuredClone(caller);
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
  /**
   * The operator route out of a binding that can no longer be honoured. A publication keeps the
   * repository, base branch and connection revision it was sealed with, so reconnecting GitHub,
   * relinking the repository or turning write automation off fences it for good: every later
   * reconciliation refuses, and a hosted consolidation waits in awaiting_publication with no
   * action of its own. A publication that never got a binding at all is stuck the same way, so
   * the release asks the project for a binding now and takes the same refusals as proof. The
   * release is the whole ending: the consolidation is handed back here for another round against
   * whatever GitHub connection the project now has, and the publication is finished where its
   * failures were recorded. It is refused while the repository can still be reached, so nobody
   * can walk a live publication past its review this way.
   */
  async releasePublication(caller: Caller, value: unknown) {
    caller = structuredClone(caller);
    const input = parseCodeInput(publicationReleaseSchema, value);
    const { requestId, ...body } = input;
    const principal = `actor:${caller.actorId}`;
    return this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'admin', tx);
      check(
        !caller.session,
        'session_forbidden',
        'A leased worker cannot release a publication',
        403,
      );
      const previous = await tx.get<{ input_hash: string; result_json: string }>(
        'SELECT input_hash,result_json FROM code_operations WHERE project_id=? AND principal_scope=? AND request_id=?',
        caller.projectId,
        principal,
        requestId,
      );
      if (previous) {
        check(
          previous.input_hash === digest(body),
          'request_conflict',
          'This request id was used with different input',
          409,
        );
        return JSON.parse(previous.result_json) as CodePublication;
      }
      const row = await this.row(caller, input.proposalId, tx);
      check(
        !row.lock_until || row.lock_until < now(),
        'publication_busy',
        'Publication is being reconciled; retry shortly',
        409,
      );
      const record = this.decode(row);
      check(
        !row.settled && !row.verified && !record.merge?.commitSha,
        'publication_conflict',
        'A settled or merged publication is already finished',
        409,
      );
      // Both probes refuse in JavaScript after their reads succeed, so catching one here leaves
      // this transaction usable. Neither reaches GitHub or Git, and nothing below does either.
      // A publication that never got a binding is the one nothing can move: no poll ever
      // managed to freeze one, so ask the project for a binding now and let the same refusals
      // say that it still cannot have one.
      let bound = true;
      try {
        if (row.binding_json === 'null') await this.github.publicationBinding(caller, tx);
        else await this.github.assertBinding(caller, JSON.parse(row.binding_json), tx, 'write');
      } catch (error) {
        if (!(error instanceof MervError) || !unreachable.includes(error.code)) throw error;
        bound = false;
      }
      check(
        !bound,
        'code_publication_bound',
        'This publication can still reach its repository; reconcile or merge it instead',
        409,
      );
      // The two steps a moved main takes, minus everything that reaches GitHub, and both taken
      // here rather than left for a later sync: a row left stale is adopted as the predecessor
      // of the next round's approval, which would reopen this one into a reconciliation its
      // frozen binding can never satisfy. The approved facts are retained, and the ending is
      // recorded in the same column the failures were, so the publication list states it.
      if (record.approval) {
        await this.host!.apply(caller, record, 'stale', tx);
        await this.host!.apply(caller, record, 'resume', tx);
      }
      const result = await tx.run(
        "UPDATE code_publications SET settled=1,error='code_publication_released' WHERE proposal_id=? AND project_id=? AND settled=0",
        input.proposalId,
        caller.projectId,
      );
      check(result.changes === 1, 'publication_busy', 'Publication changed while releasing', 409);
      const released = this.decode(await this.row(caller, input.proposalId, tx));
      await tx.run(
        'INSERT INTO code_operations(id,project_id,principal_scope,request_id,kind,input_hash,payload_json,status,result_json,created_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        newId('cop'),
        caller.projectId,
        principal,
        requestId,
        'publication-release',
        digest(body),
        canonical(body),
        'completed',
        canonical(released),
        now(),
        now(),
      );
      return released;
    });
  }
  async mergePublication(caller: Caller, value: CodePublicationMerge) {
    caller = structuredClone(caller);
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
      await this.state.transaction(async (tx) => {
        await this.scope.require(caller, 'admin', tx);
        const old = await tx.get<{ input_hash: string }>(
          'SELECT input_hash FROM code_publication_requests WHERE project_id=? AND actor_id=? AND request_id=?',
          caller.projectId,
          caller.actorId,
          input.requestId,
        );
        check(
          !old || old.input_hash === digest(input),
          'publication_conflict',
          'Merge request identifier has different input',
          409,
        );
        if (!old)
          await tx.run(
            'INSERT INTO code_publication_requests VALUES(?,?,?,?,?)',
            caller.projectId,
            caller.actorId,
            input.requestId,
            digest(input),
            canonical({ proposalId: input.proposalId }),
          );
      });
      check(
        !record.incident,
        'code_publication_incident',
        'This publication has a retained incident requiring operator investigation',
        409,
      );
      check(
        !record.stale,
        'code_publication_stale',
        'This proposal is stale; integrate main on the same work branch and obtain another review',
        409,
      );
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
      // A released publication keeps a passing review and an open pull request, so only its
      // ending refuses it here. This comes last because a closed, incident or stale publication
      // is already refused above with the reason that fits it.
      check(
        !row.settled,
        'publication_conflict',
        'This publication is finished; it can no longer be merged',
        409,
      );
      return (
        record.approval
          ? this.github.publicationAutomation.bind(this.github)
          : this.github.automation.bind(this.github)
      )(
        caller,
        'write',
        JSON.parse(row.binding_json),
        async (client, token) => {
          await this.scope.require(caller, 'admin');
          let pull = await client.pull(token, record.repository, record.pull!.number);
          this.pinned(record, pull);
          if (pull.merged) return this.save(caller, row, lock, pull);
          let requiredChecks: string[] = [];
          if (record.approval) {
            const main = await client.branch(token, record.repository, record.baseBranch);
            await this.host!.import(caller, record, main.sha);
            if (!(await this.host!.ancestor(caller.projectId, main.sha, record.headOid))) {
              await this.state.transaction(async (tx) => {
                await this.scope.require(caller, 'admin', tx);
                await this.github.assertBinding(caller, JSON.parse(row.binding_json), tx, 'write');
                await this.owned(caller, record.proposalId, lock, tx);
                await this.host!.check(caller, record, tx);
                await this.host!.main(caller, main.sha, tx);
                await this.host!.apply(caller, record, 'stale', tx);
                await tx.run(
                  "UPDATE code_publications SET stale=1,synced_at='' WHERE proposal_id=?",
                  record.proposalId,
                );
              });
              return this.decode(
                await this.state.transaction((tx) => this.row(caller, record.proposalId, tx)),
              );
            }
            requiredChecks = await this.host!.rules(caller, client, token, record);
            check(
              await client.approvalStatus(token, record.repository, record.headOid),
              'publication_review_required',
              'The exact approved head must carry merv/consolidation-approved',
              409,
            );
          }
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
            (!record.approval ||
              (await client.requiredChecks(
                token,
                record.repository,
                record.headOid,
                requiredChecks,
                inspection.checks,
              ))) &&
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
            check(
              caller.human && !caller.session && !caller.key,
              'github_human_required',
              'A signed-in human must merge',
              403,
            );
            const latest = this.decode(await this.owned(caller, record.proposalId, lock, tx));
            check(
              latest.review?.verdict === 'pass' &&
                canonical(latest.review) === canonical(record.review) &&
                latest.headOid === input.expectedHead &&
                !latest.stale,
              'publication_review_required',
              'The exact approved publication must still be current',
              409,
            );
            if (latest.approval) await this.host!.check(caller, latest, tx);
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
                requestedAt:
                  latest.merge?.requestId === input.requestId ? latest.merge.requestedAt : now(),
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
          return this.save(
            caller,
            await this.state.transaction((tx) => this.row(caller, record.proposalId, tx)),
            lock,
            pull,
          );
        },
        async (tx) => {
          const current = this.decode(await this.owned(caller, row.proposal_id, lock, tx));
          await this.scope.require(caller, 'admin', tx);
          check(
            caller.human && !caller.session && !caller.key,
            'github_human_required',
            'A signed-in human must merge',
            403,
          );
          if (
            current.approval &&
            current.merge &&
            !current.verified &&
            !current.stale &&
            !current.incident
          ) {
            check(
              current.merge.requestId === input.requestId &&
                current.merge.actorId === caller.actorId,
              'publication_conflict',
              'The human merge intent changed',
              409,
            );
            await this.host!.check(caller, current, tx);
          }
        },
      );
    });
  }
}

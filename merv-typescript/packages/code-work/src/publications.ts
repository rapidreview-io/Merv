import { z } from 'zod';
import { CodeGitHubService } from '@merv/code/github';
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
  sourceCaller,
  type Caller,
  type CodePublication,
  type GitHubPullRequest,
  type Scope,
  type State,
  type Transaction,
} from '@merv/contracts';
import {
  publicationApproval,
  PublicationIncident,
  type PublicationHost,
} from './publication-host.js';
import type { CodePublicationApi, CodePublicationMerge } from './types.js';

const codePublicationIdSchema = z
  .object({ proposalId: z.string().regex(/^codeprop_[A-Za-z0-9_-]+$/) })
  .strict();
export const codePublicationMergeSchema = codePublicationIdSchema
  .extend({
    expectedHead: z.string().regex(/^[0-9a-f]{40}$/),
    expectedBase: z.string().regex(/^[0-9a-f]{40}$/),
    requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/),
  })
  .strict() satisfies z.ZodType<CodePublicationMerge>;

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

/**
 * An unsettled unit publication not tried in 30 seconds or, once its pull request is open and
 * waits on a person, in `idle`: ten minutes for Code's own pass, as each read costs ~7 GitHub calls.
 */
const due = 'settled=0 AND (synced_at<? OR (pull_json IS NULL AND synced_at<?))';
const since = (idle: number) => [idle, 30_000].map((ms) => new Date(Date.now() - ms).toISOString());
const IDLE = 600_000;

/** What a unit's publication reads of its pull request: which one, and whether it closed unmerged. */
const reading = (pull: GitHubPullRequest | null) =>
  pull ? `${pull.number} ${pull.url} ${pull.state === 'closed' && !pull.merged}` : '';

/** A durable external publication of immutable code facts. The domain alone supplies the review verdict. */
export class CodePublicationService implements CodePublicationApi {
  constructor(
    private state: State,
    private scope: Scope,
    private github: CodeGitHubService,
    private host: PublicationHost,
  ) {}
  async initialize() {
    await migratePublications(this.state);
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
  /**
   * Opens the publication of an accepted unit with its passing review already sealed.
   */
  async openUnit(caller: Caller, input: CodeUnitPublicationSeal, tx: Transaction) {
    ({ caller, input } = structuredClone({ caller, input }));
    this.state.assertTransaction(tx);
    const connection = await tx.get<{ repository_json: string | null }>(
      'SELECT repository_json FROM code_github WHERE project_id=?',
      caller.projectId,
    );
    const destination =
      connection?.repository_json && connection.repository_json !== 'null' ? 'github' : 'local';
    const at = now();
    const record: CodePublication = {
      destination,
      proposalId: input.publicationId,
      instanceId: input.unitId,
      manifestHash: input.approval.acceptanceHash,
      repository: '',
      repositoryId: 0,
      connectionRevision: 0,
      branch: `merv/proposals/${input.publicationId}`,
      baseBranch: 'main',
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
          : 'github_unavailable';
      await this.state.transaction(async (tx) => {
        await tx.run(
          'UPDATE code_publications SET error=? WHERE proposal_id=? AND lock_id=?',
          code,
          id,
          lock,
        );
        // A unit reads a failing sync as an operator's wait (unit-store publicationOf).
        if (row.error !== code) await this.host.reconcile(caller, tx);
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
  /** Whether a pull request still carries exactly the reviewed head onto the reviewed base. */
  private pins(record: CodePublication, pull: GitHubPullRequest) {
    return (
      pull.head.sha === record.headOid &&
      pull.head.ref === record.branch &&
      pull.head.repositoryId === record.repositoryId &&
      pull.base.ref === record.baseBranch &&
      pull.base.repositoryId === record.repositoryId &&
      (!record.pull || pull.id === record.pull.id)
    );
  }
  private pinned(record: CodePublication, pull: GitHubPullRequest) {
    check(
      this.pins(record, pull),
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
  private async mainOf(sql: Pick<Transaction, 'get'>, projectId: string) {
    const project = await sql.get<{ main_json: string }>(
      'SELECT main_json FROM code_projects WHERE project_id=?',
      projectId,
    );
    return project ? (JSON.parse(project.main_json).oid as string) : null;
  }
  /**
   * An accepted unit publishes once: a row that can no longer merge as reviewed settles stale,
   * and whoever waits on it learns, in the same commit, that a successor must take it.
   */
  private async markStale(
    caller: Caller,
    record: CodePublication,
    reason: string,
    pull: GitHubPullRequest | null,
    tx: Transaction,
  ) {
    await tx.run(
      'UPDATE code_publications SET stale=1,settled=1,error=?,pull_json=COALESCE(?,pull_json) WHERE proposal_id=?',
      reason,
      pull && canonical(pull),
      record.proposalId,
    );
    await this.host.reconcile(caller, tx);
    await recorded(this.state, tx, caller, 'code.publication_stale', record.proposalId, {
      unitId: record.instanceId,
      reason,
    });
  }
  /**
   * Settles a pull request that main overtook, or whose head is no longer the reviewed one, so
   * unreviewed commits never reach main. Only once that commits is the pull request closed,
   * best-effort, so nobody merges it against main by hand.
   */
  private async settleStale(
    caller: Caller,
    row: Row,
    lock: string,
    reason: string,
    pull: GitHubPullRequest,
    close: () => Promise<GitHubPullRequest>,
    before: (tx: Transaction) => Promise<void> = async () => {},
  ) {
    await this.state.transaction(async (tx) => {
      const current = this.decode(await this.owned(caller, row.proposal_id, lock, tx));
      await before(tx);
      await this.markStale(caller, current, reason, pull, tx);
    });
    if (pull.state === 'open')
      await close().then(
        (closed) =>
          this.state.transaction((tx) =>
            tx.run(
              'UPDATE code_publications SET pull_json=? WHERE proposal_id=?',
              canonical(closed),
              row.proposal_id,
            ),
          ),
        () => undefined,
      );
    return this.decode(await this.state.transaction((tx) => this.row(caller, row.proposal_id, tx)));
  }
  private async save(caller: Caller, row: Row, lock: string, pull: GitHubPullRequest) {
    const original = this.decode(row);
    let mainParent: string | undefined;
    if (pull.merged && !original.verified) {
      try {
        check(
          this.pins(original, pull),
          'code_publication_incident',
          'GitHub merged a head other than the reviewed one',
          409,
        );
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
        mainParent = await this.host.verify(caller, original, pull.mergeCommitSha);
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
            await this.host.reconcile(caller, tx);
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
      // The merge commit is written before the row is sealed as verified, because a verified
      // row's merge is immutable, and because what the host tells the unit next reads both.
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
      if (pull.merged && !record.verified) {
        await this.host.check(caller, record, tx);
        await tx.run(
          'UPDATE code_publications SET verified=1 WHERE proposal_id=?',
          record.proposalId,
        );
        await this.host.main(caller, pull.mergeCommitSha!, tx);
        // Commit the wake-up with the verified receipt and admitted main, never with a preview.
        await recorded(this.state, tx, caller, 'code.publication_verified', record.proposalId, {
          unitId: record.instanceId,
          commitSha: pull.mergeCommitSha!,
        });
      } else if (reading(record.pull) !== reading(pull)) {
        // A unit's blocker is read back from this row, so it follows the pull request the
        // moment one opens, and again when it closes unmerged: until then the wait said no
        // pull request existed, and named nobody who could end it.
        await this.host.reconcile(caller, tx);
        // Closed unmerged is a rejection, and whoever waits on it moves on without it.
        if (pull.state === 'closed' && !pull.merged)
          await recorded(this.state, tx, caller, 'code.publication_stale', record.proposalId, {
            unitId: record.instanceId,
            reason: 'closed',
          });
      }
      return this.decode(await this.row(caller, row.proposal_id, tx));
    });
  }
  /** A reviewed local integration needs no remote, but retains the same review certificate. */
  private async publishLocal(caller: Caller, row: Row, lock: string) {
    const record = this.decode(row);
    await this.host.verifyLocal(caller, record);
    // A main the reviewed head already holds moved under it, not past it. Git answers that
    // before the transaction, which only accepts the main it was asked about.
    const seen = await this.state.read((sql) => this.mainOf(sql, caller.projectId));
    const held = !!seen && (await this.host.ancestor(caller.projectId, seen, record.headOid));
    await this.state.transaction(async (tx) => {
      const current = this.decode(await this.owned(caller, row.proposal_id, lock, tx));
      await this.scope.require(caller, 'write', tx);
      await this.host.check(caller, current, tx);
      const main = await this.mainOf(tx, caller.projectId);
      // The checkout base may already merge accepted dependencies with main.
      // CAS the pinned integration main, not that derived checkout commit.
      const expectedMain = current.approval!.integrationBase;
      if (main !== expectedMain && main !== current.headOid && !(held && main === seen)) {
        await this.markStale(caller, current, 'code_main_changed', null, tx);
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
      await this.host.main(caller, record.headOid, tx, main);
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
      'Worker credentials cannot publish pull requests',
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
          if (this.decode(row).destination === 'local') {
            await this.publishLocal(caller, row, lock);
            return;
          }
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
          await this.github.publicationAutomation(
            caller,
            'write',
            JSON.parse(row.binding_json),
            async (client, token) => {
              const current = this.decode(row);
              let pull = current.pull
                ? await client.pull(token, current.repository, current.pull.number)
                : undefined;
              if (!current.stale) {
                await this.host.rules(caller, client, token, current, false);
                await this.state.transaction((tx) => this.host.check(caller, current, tx));
                // A pull request already off the reviewed head settles stale below, wherever
                // its branch now stands.
                if (!pull || pull.merged || this.pins(current, pull))
                  await this.host.snapshot(caller, current);
              }
              if (!pull) {
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
                      // This body is what a signed-in operator reads before the one
                      // irreversible action in the design, so it names the kind of work it
                      // is publishing and what the hash it asks them to trust actually is.
                      body: `Merv unit publication ${current.proposalId}\n\nUnit: ${current.instanceId}\nExact commit: ${current.headOid}\nAcceptance SHA-256: ${current.manifestHash}\n\nMerv's independent review of this unit is tracked separately from GitHub reviews.`,
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
              // A merged head that is not the reviewed one is an incident, which saving retains.
              if (!pull.merged && !this.pins(current, pull)) {
                const { number } = pull;
                await this.settleStale(caller, row, lock, 'github_head_changed', pull, () =>
                  client.updatePull(token, current.repository, number, { state: 'closed' }),
                );
                return;
              }
              // A unit's publication is opened with its passing review already sealed.
              if (pull.state === 'open' && current.review?.verdict === 'pass') {
                await client.appStatus(
                  token,
                  current.repository,
                  current.headOid,
                  publicationApproval,
                  true,
                );
                if (pull.draft) {
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
      const replay = await this.state.transaction(async (tx) => {
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
        return !!old;
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
      // A lost HTTP reply must be recoverable from the immutable, verified receipt even if
      // GitHub has since been disconnected. This replays only this actor's exact merge intent.
      if (
        replay &&
        row.settled &&
        record.pull.merged &&
        record.merge?.requestId === input.requestId &&
        record.merge.actorId === caller.actorId &&
        record.merge.commitSha === record.pull.mergeCommitSha &&
        !!record.merge.commitSha &&
        record.verified
      )
        return record;
      // A released publication keeps a passing review and an open pull request, so only its
      // ending refuses it here. This comes last because a closed, incident or stale publication
      // is already refused above with the reason that fits it.
      check(
        !row.settled,
        'publication_conflict',
        'This publication is finished; it can no longer be merged',
        409,
      );
      return this.github.publicationAutomation(
        caller,
        'write',
        JSON.parse(row.binding_json),
        async (client, token) => {
          await this.scope.require(caller, 'admin');
          let pull = await client.pull(token, record.repository, record.pull!.number);
          if (pull.merged) return this.save(caller, row, lock, pull);
          const close = () =>
            client.updatePull(token, record.repository, pull.number, { state: 'closed' });
          if (!this.pins(record, pull))
            return this.settleStale(caller, row, lock, 'github_head_changed', pull, close);
          const main = await client.branch(token, record.repository, record.baseBranch);
          await this.host.import(caller, record, main.sha);
          if (!(await this.host.ancestor(caller.projectId, main.sha, record.headOid))) {
            // Merv's main follows GitHub's only forward, from the main it was read against.
            const ours = await this.state.read((sql) => this.mainOf(sql, caller.projectId));
            const forward =
              !!ours &&
              ours !== main.sha &&
              (await this.host.ancestor(caller.projectId, ours, main.sha));
            return this.settleStale(
              caller,
              row,
              lock,
              'code_main_changed',
              pull,
              close,
              async (tx) => {
                await this.scope.require(caller, 'admin', tx);
                await this.github.assertBinding(caller, JSON.parse(row.binding_json), tx, 'write');
                await this.host.check(caller, record, tx);
                if (forward) await this.host.main(caller, main.sha, tx, ours!);
              },
            );
          }
          const requiredChecks = await this.host.rules(caller, client, token, record);
          check(
            await client.appStatus(token, record.repository, record.headOid, publicationApproval),
            'publication_review_required',
            'The exact approved head must carry merv/consolidation-approved',
            409,
          );
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
            (await client.requiredChecks(
              token,
              record.repository,
              record.headOid,
              requiredChecks,
              inspection.checks,
            )) &&
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
            await this.host.check(caller, latest, tx);
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
          if (current.merge && !current.verified && !current.stale && !current.incident) {
            check(
              current.merge.requestId === input.requestId &&
                current.merge.actorId === caller.actorId,
              'publication_conflict',
              'The human merge intent changed',
              409,
            );
            await this.host.check(caller, current, tx);
          }
        },
      );
    });
  }
}

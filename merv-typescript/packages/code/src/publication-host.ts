import {
  canonical,
  check,
  digest,
  now,
  MervError,
  type Caller,
  type CodePublication,
  type CodeProjectStatus,
  type Scope,
  type State,
  type Transaction,
} from '@merv/contracts';
import type { PublicationOwner } from './types.js';
import type { CodeRepositories } from './store/repository.js';
import type { MirrorTransport } from './store/mirror.js';
import type { GitHubBinding } from './github.js';
import type { GitHubClient } from './github-client.js';
import { z } from 'zod';
import { parseCodeInput } from './input.js';

export const publicationControlSchema = z
  .object({
    action: z.enum(['acknowledge_rules', 'record_canary', 'clear']),
    reason: z.string().trim().min(1).max(4000),
    /** The release operator attests the result of the deliberately stale merge attempt. */
    staleMerged: z.boolean().optional(),
    requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/),
  })
  .strict()
  .refine((v) => (v.action === 'record_canary') === (v.staleMerged !== undefined));
export class PublicationIncident extends MervError {
  constructor(readonly observation: { commitSha: string; tree: string; parents: string[] }) {
    super(
      'code_publication_incident',
      'Published merge differs from the reviewed tree or two-parent ancestry; operator investigation is required',
      409,
    );
  }
}
type Controls = Omit<NonNullable<CodeProjectStatus['publication']>['controls'], 'blockers'>;

/** Hosted publication borrows the repository and admission journal; it never owns a credential. */
export class PublicationHost {
  private owner?: PublicationOwner;
  constructor(
    private state: State,
    private scope: Scope,
    private repositories: () => CodeRepositories,
    private mirror: () => MirrorTransport,
    private imported: (caller: Caller, ref: string, oid: string) => Promise<void>,
    private binding: (caller: Caller, tx: Transaction) => Promise<GitHubBinding>,
    private certificate: (
      projectId: string,
      unitId: string,
      tx: Transaction,
    ) => Promise<{ hash: string }>,
    private changed: (projectId: string, tx: Transaction) => Promise<void>,
    private accepted: (
      caller: Caller,
      unitId: string,
      reviewId: string,
      revision: number,
      tx: Transaction,
    ) => Promise<void>,
  ) {}
  register(owner: PublicationOwner) {
    this.owner = owner;
    return () => {
      if (this.owner === owner) this.owner = undefined;
    };
  }
  /** No owner loaded means no consolidation can be holding anything, which is the honest answer. */
  async frozen(projectId: string, tx: Transaction): Promise<string[]> {
    return (await this.owner?.frozen(projectId, tx)) ?? [];
  }
  private requireOwner() {
    check(
      this.owner,
      'publication_owner_unavailable',
      'Load the publication owner before publishing',
      503,
    );
    return this.owner;
  }
  async check(caller: Caller, record: CodePublication, tx: Transaction) {
    const controls = await this.controls(caller.projectId, tx);
    check(
      !controls.disabled,
      'code_publication_disabled',
      'A stale-merge canary failed. An operator must repair enforcement and clear the publication disablement.',
      409,
    );
    check(
      controls.canary &&
        !controls.canary.staleMerged &&
        controls.canary.bindingHash ===
          digest({
            repositoryId: record.repositoryId,
            revision: record.connectionRevision,
            baseBranch: record.baseBranch,
          }),
      'code_publication_canary_required',
      'Run the release matrix with this App and rules, then record the successful canary before enabling publication.',
      409,
    );
    const envelope = record.approval!;
    // A consolidation's acceptance is one of its reviewed rounds; a unit's is the single
    // immutable acceptance its own review recorded. Either way the seal names it by hash.
    // Envelopes sealed before units could publish carry no source and record_json is
    // immutable, so anything that is not explicitly a unit is a consolidation.
    const consolidation = envelope.source !== 'unit';
    if (consolidation)
      await this.requireOwner().check(caller, record.instanceId, record.proposalId, tx);
    const accepted = consolidation
      ? await tx.get<{ acceptance_json: string }>(
          'SELECT acceptance_json FROM code_review_acceptances WHERE project_id=? AND unit_id=? AND review_id=?',
          caller.projectId,
          record.instanceId,
          record.review!.id,
        )
      : await tx.get<{ acceptance_json: string }>(
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
    const review = await tx.get<{
      verdict: string;
      reviewer_id: string;
      provenance_json: string | null;
    }>(
      'SELECT verdict,reviewer_id,provenance_json FROM reviews WHERE id=? AND project_id=?',
      record.review!.id,
      caller.projectId,
    );
    check(
      review?.verdict === 'pass' &&
        review.reviewer_id === record.review!.actorId &&
        // An ordinary unit review carries no certificate; one that does is bound exactly.
        (envelope.certificateHash === null ||
          (!!review.provenance_json &&
            JSON.parse(review.provenance_json).hash === envelope.certificateHash)),
      'publication_review_required',
      'The exact independent review certificate is required',
      409,
    );
    if (consolidation)
      check(
        (await this.certificate(caller.projectId, record.instanceId, tx)).hash ===
          envelope.certificateHash,
        'review_provenance_changed',
        'Publication contributor provenance changed after approval',
        409,
      );
    const unit = await tx.get<{
      quarantine_base_key: string | null;
      quarantine_operation_id: string | null;
    }>(
      'SELECT quarantine_base_key,quarantine_operation_id FROM code_units WHERE project_id=? AND unit_id=?',
      caller.projectId,
      record.instanceId,
    );
    check(
      unit && !unit.quarantine_base_key && !unit.quarantine_operation_id,
      'code_quarantined',
      'Quarantined work cannot be published',
      409,
    );
  }
  /** Where a publication stands is Code's own row; the unit's blockers are read back from it. */
  async reconcile(caller: Caller, tx: Transaction) {
    await this.changed(caller.projectId, tx);
  }
  async apply(
    caller: Caller,
    record: CodePublication,
    outcome: 'stale' | 'resume' | 'published',
    tx: Transaction,
  ) {
    // A unit has no producing state to return to and is already accepted: what an outcome
    // changes for it is what its own publication row now says, which it reads back here.
    if (record.approval!.source === 'unit') return await this.reconcile(caller, tx);
    const revision = await this.requireOwner().apply(
      caller,
      record.instanceId,
      record.proposalId,
      outcome,
      tx,
    );
    if (outcome === 'published')
      await this.accepted(caller, record.instanceId, record.review!.id, revision, tx);
  }
  async ancestor(projectId: string, base: string, head: string) {
    const repos = this.repositories();
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
  async snapshot(caller: Caller, record: CodePublication) {
    const repos = this.repositories();
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
    const mirror = this.mirror();
    const remote = `refs/heads/${record.branch}`;
    const current = await mirror.lsRemote(caller.projectId, remote);
    check(
      current === null || current === record.headOid,
      'github_head_changed',
      'The immutable proposal branch was changed',
      409,
    );
    if (current === null) {
      await mirror.push(caller.projectId, {
        ref: remote,
        oid: record.headOid,
        expectedRemote: null,
      });
      check(
        (await mirror.lsRemote(caller.projectId, remote)) === record.headOid,
        'github_push_mismatch',
        'The proposal snapshot has not reached GitHub',
        409,
      );
    }
  }
  async import(caller: Caller, record: CodePublication, oid: string) {
    await this.imported(caller, `refs/heads/${record.baseBranch}`, oid);
  }
  async main(caller: Caller, oid: string, tx: Transaction) {
    await tx.run(
      'UPDATE code_projects SET main_json=?,updated_at=? WHERE project_id=?',
      canonical({ oid, stored: true, admittedBy: caller.actorId, admittedAt: now() }),
      now(),
      caller.projectId,
    );
    await this.changed(caller.projectId, tx);
  }
  async verify(caller: Caller, record: CodePublication, oid: string) {
    await this.import(caller, record, oid);
    const repos = this.repositories();
    const output = await repos.git.ok(['show', '-s', '--format=%T%n%P', oid], {
      env: repos.environment(caller.projectId),
    });
    const [tree, parentsLine] = output.toString().trim().split('\n');
    const parents = parentsLine?.split(' ') ?? [];
    const contained =
      parents.length === 2 && (await this.ancestor(caller.projectId, parents[0], record.headOid));
    if (!contained)
      await this.state.transaction(async (tx) => {
        const controls = await this.controls(caller.projectId, tx);
        controls.disabled = true;
        controls.canary = {
          bindingHash: digest({
            repositoryId: record.repositoryId,
            revision: record.connectionRevision,
            baseBranch: record.baseBranch,
          }),
          staleMerged: true,
          actorId: caller.actorId,
          reason: `Publication ${record.proposalId} merged outside reviewed ancestry at ${oid}`,
          at: now(),
        };
        await this.saveControls(caller.projectId, controls, tx);
      });
    if (!(
      tree === record.treeOid &&
      parents.length === 2 &&
      parents[1] === record.headOid &&
      contained
    ))
      throw new PublicationIncident({ commitSha: oid, tree, parents });
    return parents[0];
  }
  async rules(
    caller: Caller,
    client: GitHubClient,
    token: string,
    record: CodePublication,
    merging = true,
  ) {
    let evidence: Awaited<ReturnType<GitHubClient['rules']>>;
    try {
      evidence = await client.rules(token, record.repository, record.baseBranch);
    } catch {
      evidence = {
        rules: [],
        details: [],
        incomplete: true,
        available: false,
        required: [],
        strict: false,
        pullRequest: false,
      };
    }
    await this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'write', tx);
      const controls = await this.controls(caller.projectId, tx);
      controls.visibility = { incomplete: evidence.incomplete, evidence, observedAt: now() };
      await this.saveControls(caller.projectId, controls, tx);
    });
    // Missing visibility alone does not refuse activation. Known absent rules refuse a merge,
    // and so do rules nobody could read: not knowing what protects main is exactly when
    // nothing else would stop an unreviewed merge from landing on it.
    check(
      !merging || (evidence.available && evidence.strict && evidence.pullRequest),
      'code_publication_rules_required',
      'Main must require PRs and strict checks including the App-sourced merv/consolidation-approved status, and a merge waits until those rules can be read',
      409,
    );
    return evidence.required;
  }
  private async controls(projectId: string, tx: Transaction): Promise<Controls> {
    const row = await tx.get<{ record_json: string }>(
      'SELECT record_json FROM code_publication_controls WHERE project_id=?',
      projectId,
    );
    return row ? JSON.parse(row.record_json) : {};
  }
  private async saveControls(projectId: string, controls: Controls, tx: Transaction) {
    await tx.run(
      'INSERT INTO code_publication_controls(project_id,record_json) VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET record_json=excluded.record_json',
      projectId,
      canonical(controls),
    );
  }
  async status(caller: Caller) {
    return this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'read', tx);
      const controls = await this.controls(caller.projectId, tx);
      return {
        ...controls,
        blockers: [
          ...(controls.disabled ? ['code_publication_disabled'] : []),
          ...(controls.visibility?.incomplete ? ['code_rules_visibility_incomplete'] : []),
          ...(!controls.canary ? ['code_publication_canary_required'] : []),
        ],
      };
    });
  }
  async control(caller: Caller, value: unknown) {
    caller = structuredClone(caller);
    const input = parseCodeInput(publicationControlSchema, value);
    return this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'admin', tx);
      check(
        caller.human && !caller.session && !caller.key,
        'github_human_required',
        'A signed-in human administrator must attest publication enforcement',
        403,
      );
      const previous = await tx.get<{ input_hash: string; result_json: string }>(
        'SELECT input_hash,result_json FROM code_publication_requests WHERE project_id=? AND actor_id=? AND request_id=?',
        caller.projectId,
        caller.actorId,
        input.requestId,
      );
      if (previous) {
        check(
          previous.input_hash === digest(input),
          'request_conflict',
          'Request id has different publication control input',
          409,
        );
        return JSON.parse(previous.result_json) as Controls;
      }
      const controls = await this.controls(caller.projectId, tx);
      const evidence = { actorId: caller.actorId, reason: input.reason, at: now() };
      if (input.action === 'acknowledge_rules') controls.acknowledgement = evidence;
      if (input.action === 'record_canary') {
        const binding = await this.binding(caller, tx);
        controls.canary = {
          ...evidence,
          staleMerged: input.staleMerged!,
          bindingHash: digest({
            repositoryId: binding.repository.id,
            revision: binding.revision,
            baseBranch: binding.baseBranch,
          }),
        };
        if (input.staleMerged) controls.disabled = true;
      }
      if (input.action === 'clear') {
        const binding = await this.binding(caller, tx);
        check(
          controls.canary &&
            !controls.canary.staleMerged &&
            controls.canary.bindingHash ===
              digest({
                repositoryId: binding.repository.id,
                revision: binding.revision,
                baseBranch: binding.baseBranch,
              }),
          'code_publication_disabled',
          'Record a passing canary after repairing enforcement before clearing disablement',
          409,
        );
        controls.disabled = false;
      }
      await this.saveControls(caller.projectId, controls, tx);
      // Turning publication off or on again changes what every unit waiting on one is waiting
      // for, so what they publish is refreshed here rather than at the next poll.
      await this.reconcile(caller, tx);
      await tx.run(
        'INSERT INTO code_publication_requests VALUES(?,?,?,?,?)',
        caller.projectId,
        caller.actorId,
        input.requestId,
        digest(input),
        canonical(controls),
      );
      return controls;
    });
  }
}

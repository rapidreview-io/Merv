import {
  check,
  digest,
  MervError,
  type Caller,
  type ReviewProvenance,
  type Scope,
  type State,
  type Transaction,
  type Workflows,
} from '@merv/contracts';
import type { Sessions } from '@merv/sessions/types';
import type {
  CodeCandidateSet,
  CodeCandidateDecision,
  CodeDecisionManifest,
  CodeReconciliation,
  CodeProposal,
} from './types.js';
import type { CodeRepositories } from '@merv/code/store/repository';
import { unitContributors } from './provenance.js';
import { bindsRepository } from '@merv/code/units';
import type { CodeBaseService } from './bases.js';

interface Accepted {
  unit_id: string;
  acceptance_hash: string;
  acceptance_json: string;
  quarantine_base_key: string | null;
}
interface Acceptance {
  terminalRevision: number;
  code: { commit: string; repositoryId: string } | null;
}
const columns = 'unit_id,acceptance_hash,acceptance_json,quarantine_base_key';

/** Frozen owner payloads carry identities; only Code interprets their ancestry. */
export class CodeConsolidation {
  constructor(
    private readonly state: State,
    private readonly scope: Scope,
    private readonly workflows: Workflows,
    private readonly sessions: Pick<Sessions, 'contributors'>,
    private readonly repositories: () => CodeRepositories | undefined,
    private readonly bases: () => CodeBaseService | undefined = () => undefined,
  ) {}

  private acceptance(row: Accepted): Acceptance {
    const accepted = JSON.parse(row.acceptance_json) as Acceptance;
    check(
      !row.quarantine_base_key && digest(accepted) === row.acceptance_hash,
      'code_candidate_invalid',
      'A candidate acceptance is quarantined or no longer matches its hash',
      409,
    );
    return accepted;
  }

  async freeze(caller: Caller, roots: string[], tx: Transaction): Promise<CodeCandidateSet> {
    caller = structuredClone(caller);
    roots = [...roots];
    await this.scope.require(caller, 'write', tx);
    const project = await tx.get<{
      repository_id: string;
      binding_json: string;
      main_json: string;
      store_json: string | null;
    }>(
      'SELECT repository_id,binding_json,main_json,store_json FROM code_projects WHERE project_id=?',
      caller.projectId,
    );
    const main = project && JSON.parse(project.main_json);
    check(
      this.repositories() && project?.store_json && main?.stored,
      'code_consolidation_unhosted',
      'Consolidation version 5 requires Code to host the project and its imported main. Use version 4 until binding and import are complete.',
      409,
    );
    const candidates: CodeCandidateSet['candidates'] = [];
    const seen = new Set<string>();
    const queue = [...new Set(roots)].sort();
    for (let id = queue.shift(); id; id = queue.shift()) {
      if (seen.has(id)) continue;
      seen.add(id);
      check(
        seen.size <= 10000,
        'code_candidate_scope',
        'Candidate dependency scope is too large',
        409,
      );
      const relations = await this.workflows.dependencyRelations(caller.projectId, id, tx);
      check(
        relations,
        'code_candidate_scope',
        'Candidate scope contains a foreign or missing workflow',
        404,
      );
      queue.push(
        ...relations.dependencies.filter((edge) => edge.kind !== 'system').map((edge) => edge.id),
      );
      if (!['task', 'experiment'].includes(relations.instance.workflow)) continue;
      const row = await tx.get<Accepted>(
        `SELECT ${columns} FROM code_units WHERE project_id=? AND unit_id=? AND acceptance_json IS NOT NULL`,
        caller.projectId,
        id,
      );
      if (!row) continue;
      const accepted = this.acceptance(row);
      check(
        relations.instance.settled && relations.instance.revision === accepted.terminalRevision,
        'code_candidate_invalid',
        'Candidate acceptance does not match its successful workflow',
        409,
      );
      // A rebind retains every repository the project has been bound to and proves Code holds
      // the commits accepted under each, so work accepted before one still reaches main.
      check(
        !accepted.code || bindsRepository(project, accepted.code.repositoryId),
        'code_candidate_invalid',
        'Candidate belongs to a repository this project has never been bound to',
        409,
      );
      candidates.push({
        unitId: id,
        acceptanceHash: row.acceptance_hash,
        reference: accepted.code?.commit ?? null,
      });
    }
    check(
      candidates.length <= 1000,
      'code_candidate_scope',
      'At most 1000 accepted candidates fit one consolidation; reduce the scope',
      409,
    );
    const body = {
      formatVersion: 1 as const,
      projectId: caller.projectId,
      repositoryId: project.repository_id,
      integrationBase: main.oid as string,
      candidates: candidates.sort((a, b) => a.unitId.localeCompare(b.unitId)),
    };
    return { ...body, hash: digest(body) };
  }

  private async validate(projectId: string, frozen: CodeCandidateSet, tx: Transaction) {
    const { hash, ...body } = frozen;
    check(
      body.projectId === projectId && digest(body) === hash,
      'code_candidate_invalid',
      'The exact frozen candidate set is required',
      409,
    );
    // The set is hash-exact and each acceptance is re-read by its own hash, so the repository
    // an acceptance names is asked of the binding — the same lineage the freeze admitted it by.
    const bound = (await tx.get<{ repository_id: string; binding_json: string }>(
      'SELECT repository_id,binding_json FROM code_projects WHERE project_id=?',
      projectId,
    ))!;
    for (const candidate of frozen.candidates) {
      const row = await tx.get<Accepted>(
        `SELECT ${columns} FROM code_units WHERE project_id=? AND unit_id=? AND acceptance_json IS NOT NULL`,
        projectId,
        candidate.unitId,
      );
      check(
        row && row.acceptance_hash === candidate.acceptanceHash,
        'code_candidate_invalid',
        'Frozen candidate acceptance is missing or changed',
        409,
      );
      const accepted = this.acceptance(row);
      check(
        (accepted.code?.commit ?? null) === candidate.reference &&
          (!accepted.code || bindsRepository(bound, accepted.code.repositoryId)),
        'code_candidate_invalid',
        'Frozen candidate reference does not match its acceptance',
        409,
      );
    }
  }

  /** Main's history is queried by identity, never returned as part of the graph. */
  private async ancestry(projectId: string, base: string, roots: string[], inputs: string[]) {
    const repositories = this.repositories();
    check(repositories, 'code_unavailable', 'Code repository is unavailable', 503);
    const deadline = Date.now() + 10000;
    let remainingBytes = 32 * 1024 * 1024;
    const run = async (args: string[], input?: string) => {
      check(
        Date.now() < deadline && remainingBytes > 0,
        'code_candidate_scope',
        'Ancestry inspection exceeds its time or output budget',
        409,
      );
      // A single walk can now spend the whole budget, so Git reaches the limit before the check
      // above does. Exhausting this path's own time or output budget is a scope refusal that
      // names the remedy, not an infrastructure failure.
      const result = await repositories.git
        .run(args, {
          env: repositories.environment(projectId),
          input,
          timeoutMs: Math.max(1, deadline - Date.now()),
          maxBuffer: remainingBytes,
        })
        .catch((error: unknown) => {
          if (
            error instanceof MervError &&
            ['code_git_timeout', 'code_git_failed'].includes(error.code)
          )
            throw new MervError(
              'code_candidate_scope',
              'Ancestry inspection exceeds its time or output budget',
              409,
            );
          throw error;
        });
      remainingBytes -= result.stdout.length + Buffer.byteLength(result.stderr);
      check(
        result.code === 0 || result.code === 1,
        'code_candidate_unavailable',
        'Code must hold the frozen main and every accepted candidate commit; import the missing history',
        409,
      );
      return result;
    };
    // Legacy accepted units may never have been imported. They cannot contribute an
    // object absent from this repository; required candidate roots are checked below.
    const objects = await run(
      ['cat-file', '--batch-check=%(objectname) %(objecttype)'],
      [...new Set([base, ...roots, ...inputs])].join('\n') + '\n',
    );
    check(
      objects.code === 0,
      'code_candidate_unavailable',
      'Accepted objects could not be inspected',
      409,
    );
    const available = new Set(
      objects.stdout
        .toString('utf8')
        .trim()
        .split('\n')
        .filter((line) => line.endsWith(' commit'))
        .map((line) => line.split(' ')[0]),
    );
    const result = await run(
      ['rev-list', '--parents', '--stdin'],
      [...new Set(roots), `^${base}`].join('\n') + '\n',
    );
    check(
      result.code === 0,
      'code_candidate_unavailable',
      'The frozen candidate history is unavailable',
      409,
    );
    const parents = new Map(
      result.stdout
        .toString('utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [commit, ...parents] = line.split(' ');
          return [commit!, parents] as const;
        }),
    );
    const ancestors = new Map<string, Set<string>>();
    let visits = 0;
    for (const root of new Set(roots)) {
      const seen = new Set<string>(),
        queue = [root];
      // A candidate the frozen base already holds left nothing above it to walk, so it met
      // main before the walk began. Older candidates may branch from an earlier main; they
      // meet it at a parent this walk left out. An unrelated history meets it nowhere, and
      // is not an input to this repository's consolidation.
      let met = !parents.has(root);
      for (let commit = queue.pop(); commit; commit = queue.pop()) {
        if (seen.has(commit)) continue;
        check(
          ++visits <= 1000000 && Date.now() < deadline,
          'code_candidate_scope',
          'Ancestry inspection exceeds its bounded graph budget; reduce the candidate scope',
          409,
        );
        seen.add(commit);
        // Parents omitted by ^base are boundaries. Never traverse behind main.
        for (const parent of parents.get(commit) ?? [])
          if (parents.has(parent)) queue.push(parent);
          else met = true;
      }
      check(
        met,
        'code_candidate_invalid',
        'A candidate has no common history with the frozen integration base',
        409,
      );
      ancestors.set(root, seen);
    }
    return {
      held: (commit: string) => available.has(commit),
      /** A frozen candidate absent from the walk above main is one main already holds. */
      onMain: (commit: string) => available.has(commit) && !parents.has(commit),
      /** Both sides are frozen candidates, so the walk above main already has the answer. */
      above: (ancestor: string, descendant: string) =>
        available.has(ancestor) && (ancestors.get(descendant)?.has(ancestor) ?? false),
      /**
       * The retained commits no other retained commit reaches. Git answers the whole set at
       * once, so a consolidation costs the same one query however many candidates it keeps.
       */
      independent: async (commits: string[]) => {
        if (commits.length < 2) return new Set(commits);
        const found = await run(['merge-base', '--independent', ...commits]);
        check(
          found.code === 0,
          'code_candidate_unavailable',
          'The frozen candidate history is unavailable',
          409,
        );
        return new Set(found.stdout.toString('utf8').trim().split('\n').filter(Boolean));
      },
      /**
       * Which of these commits the frontier already carries. Excluding the frontier leaves
       * the ones it does not reach, so one query answers every accepted unit the project has
       * ever produced instead of one Git call per unit.
       */
      carried: async (commits: string[], leaves: string[]) => {
        if (!commits.length || !leaves.length) return new Set<string>();
        const found = await run(
          ['rev-list', '--stdin'],
          [...commits, ...leaves.map((leaf) => `^${leaf}`)].join('\n') + '\n',
        );
        check(
          found.code === 0,
          'code_candidate_unavailable',
          'The accepted history is unavailable',
          409,
        );
        const outside = new Set(found.stdout.toString('utf8').trim().split('\n').filter(Boolean));
        return new Set(commits.filter((commit) => !outside.has(commit)));
      },
    };
  }

  private decisions(frozen: CodeCandidateSet, decisions: CodeCandidateDecision[]) {
    const selected = [...decisions].sort((a, b) => a.unitId.localeCompare(b.unitId));
    check(
      digest(selected.map((d) => d.unitId)) === digest(frozen.candidates.map((c) => c.unitId)),
      'consolidation_decisions',
      'Exactly one decision is required for every frozen candidate',
      409,
    );
    const candidates = new Map(frozen.candidates.map((candidate) => [candidate.unitId, candidate]));
    for (const decision of selected) {
      const candidate = candidates.get(decision.unitId)!;
      check(
        (candidate.reference === null) === (decision.decision === 'no_code'),
        'consolidation_decisions',
        'Only a candidate accepted without code takes no_code',
        409,
      );
      const replacement = 'replacementUnitId' in decision ? decision.replacementUnitId : undefined;
      check(
        decision.decision === 'adapt'
          ? replacement !== decision.unitId &&
              !!candidates.get(replacement!)?.reference &&
              selected.some((d) => d.unitId === replacement && d.decision === 'retain')
          : replacement === undefined,
        'consolidation_adaptation',
        'An adaptation must name a different accepted frozen candidate with a retain decision',
        409,
      );
    }
    return { selected, candidates };
  }

  async inspect(
    caller: Caller,
    frozen: CodeCandidateSet,
    decisions: CodeCandidateDecision[],
    reconciliations: CodeReconciliation[],
  ): Promise<CodeDecisionManifest> {
    caller = structuredClone(caller);
    frozen = structuredClone(frozen);
    decisions = structuredClone(decisions);
    reconciliations = structuredClone(reconciliations);
    // Opening our own short scope also refuses invocation from a writer transaction.
    const accepted = await this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'read', tx);
      await this.validate(caller.projectId, frozen, tx);
      return await tx.all<Accepted>(
        `SELECT ${columns} FROM code_units WHERE project_id=? AND acceptance_json IS NOT NULL ORDER BY unit_id`,
        caller.projectId,
      );
    });
    const { selected, candidates } = this.decisions(frozen, decisions);
    // Acceptances, the frozen set and commits are immutable, so a walk performed before
    // the owner's committing transaction remains valid when that transaction checks its proof.
    const commits = [
      ...new Set(
        accepted.flatMap((row) => {
          const acceptance = JSON.parse(row.acceptance_json) as Acceptance;
          return acceptance.code ? [acceptance.code.commit] : [];
        }),
      ),
    ].sort();
    const ancestry = await this.ancestry(
      caller.projectId,
      frozen.integrationBase,
      frozen.candidates.flatMap((candidate) => (candidate.reference ? [candidate.reference] : [])),
      commits,
    );
    const retained = selected
      .filter((decision) => decision.decision === 'retain')
      .map((decision) => candidates.get(decision.unitId)!);
    const independent = await ancestry.independent([
      ...new Set(retained.map((candidate) => candidate.reference!)),
    ]);
    // Equal commits contribute once, with a stable representative; their authors still contribute.
    const leaves = new Map<string, string>();
    for (const candidate of retained)
      if (independent.has(candidate.reference!) && !leaves.has(candidate.reference!))
        leaves.set(candidate.reference!, candidate.unitId);
    const frontier = [...leaves.values()].sort();
    const conflicts: CodeDecisionManifest['conflicts'] = [];
    for (const decision of selected.filter(
      (d) => d.decision === 'drop' || d.decision === 'adapt',
    )) {
      const reference = candidates.get(decision.unitId)!.reference!;
      if (ancestry.onMain(reference)) {
        conflicts.push({
          kind: 'on_main',
          unitId: decision.unitId,
          message: 'Effects remain; removal needs a corrective change.',
        });
      } else
        for (const retainedUnitId of frontier) {
          if (ancestry.above(reference, candidates.get(retainedUnitId)!.reference!))
            conflicts.push({
              kind: 'carried',
              unitId: decision.unitId,
              retainedUnitId,
              message:
                'The retained candidate carries this ancestor; explicit reviewed reconciliation is required.',
            });
        }
    }
    const references = await ancestry.carried(
      commits.filter((commit) => ancestry.held(commit)),
      frontier.map((id) => candidates.get(id)!.reference!),
    );
    for (const row of accepted) {
      const acceptance = JSON.parse(row.acceptance_json) as Acceptance;
      if (acceptance.code && references.has(acceptance.code.commit)) this.acceptance(row);
    }
    const contributors = await this.state.transaction((tx) =>
      this.contributors(caller.projectId, [...references].sort(), tx),
    );
    const reconciliation = this.reconciliations(reconciliations, conflicts);
    const body = {
      formatVersion: 1 as const,
      candidateSetHash: frozen.hash,
      decisionsHash: digest({ decisions: selected, reconciliations: reconciliation }),
      contributors,
      decisions: selected,
      reconciliations: reconciliation,
      frontier,
      conflicts,
    };
    return { ...body, hash: digest(body) };
  }

  private reconciliations(
    reconciliations: CodeReconciliation[],
    conflicts: CodeDecisionManifest['conflicts'],
  ) {
    const reconciliation = [...reconciliations].sort(
      (a, b) =>
        a.unitId.localeCompare(b.unitId) || a.retainedUnitId.localeCompare(b.retainedUnitId),
    );
    check(
      new Set(reconciliation.map((entry) => digest([entry.unitId, entry.retainedUnitId]))).size ===
        reconciliation.length &&
        reconciliation.every(
          (entry) =>
            entry.rationale.trim() &&
            conflicts.some(
              (conflict) =>
                conflict.kind === 'carried' &&
                conflict.unitId === entry.unitId &&
                conflict.retainedUnitId === entry.retainedUnitId,
            ),
        ),
      'consolidation_reconciliation',
      'Reconciliation must name each carried conflict once, with a rationale',
      409,
    );
    return reconciliation;
  }

  async verify(
    caller: Caller,
    frozen: CodeCandidateSet,
    decisions: CodeCandidateDecision[],
    reconciliations: CodeReconciliation[],
    manifest: CodeDecisionManifest | undefined,
    tx: Transaction,
  ): Promise<void> {
    await this.scope.require(caller, 'read', tx);
    const { selected } = this.decisions(frozen, decisions);
    if (!manifest) return;
    await this.validate(caller.projectId, frozen, tx);
    const { hash, ...body } = manifest;
    const reconciliation = this.reconciliations(reconciliations, body.conflicts);
    check(
      digest(body) === hash &&
        body.candidateSetHash === frozen.hash &&
        body.decisionsHash === digest({ decisions: selected, reconciliations: reconciliation }) &&
        body.decisionsHash ===
          digest({ decisions: body.decisions, reconciliations: body.reconciliations }),
      'code_candidate_invalid',
      'The prepared manifest must match the frozen set and submitted decisions',
      409,
    );
    check(
      body.conflicts.every(
        (conflict) =>
          conflict.kind !== 'carried' ||
          body.reconciliations.some(
            (entry) =>
              entry.unitId === conflict.unitId && entry.retainedUnitId === conflict.retainedUnitId,
          ),
      ),
      'consolidation_reconciliation',
      `Every carried dropped ancestor requires reconciliation: ${body.conflicts
        .filter((conflict) => conflict.kind === 'carried')
        .map((conflict) => `${conflict.unitId} carried by ${conflict.retainedUnitId}`)
        .join('; ')}`,
      409,
    );
  }

  private async contributors(projectId: string, references: string[], tx: Transaction) {
    const commits = new Set(references);
    const units = new Map<string, number | null>();
    const acceptances = [];
    for (const row of await tx.all<Accepted>(
      `SELECT ${columns} FROM code_units WHERE project_id=? AND acceptance_json IS NOT NULL ORDER BY unit_id`,
      projectId,
    )) {
      const accepted = JSON.parse(row.acceptance_json) as Acceptance;
      if (!accepted.code || !commits.has(accepted.code.commit)) continue;
      this.acceptance(row);
      units.set(row.unit_id, accepted.terminalRevision);
      acceptances.push({ unitId: row.unit_id, acceptanceHash: row.acceptance_hash });
    }
    const sources = await unitContributors(tx, this.sessions, projectId, units);
    return {
      references,
      sourceHash: digest({ acceptances, sources }),
      excludedActorIds: [
        ...new Set(sources.flatMap((source) => [source.actorId, source.authorityId])),
      ].sort(),
    };
  }

  async provenance(
    projectId: string,
    subjectId: string,
    tx: Transaction,
  ): Promise<ReviewProvenance> {
    const row = await tx.get<{ proposal_json: string }>(
      'SELECT proposal_json FROM code_proposals WHERE project_id=? AND instance_id=? ORDER BY revision DESC LIMIT 1',
      projectId,
      subjectId,
    );
    check(
      row,
      'code_provenance_unverifiable',
      'The sealed consolidation submission is missing',
      409,
    );
    const proposal = JSON.parse(row.proposal_json) as CodeProposal;
    const { candidates, manifest } = proposal.provenance as unknown as {
      candidates: CodeCandidateSet;
      manifest: CodeDecisionManifest;
    };
    check(
      candidates &&
        manifest &&
        proposal.workflow.version === 5 &&
        proposal.workflow.name === 'consolidation',
      'code_provenance_unverifiable',
      'The sealed proposal does not carry version-5 consolidation inputs',
      409,
    );
    await this.validate(projectId, candidates, tx);
    const { hash, ...body } = manifest;
    check(
      digest(body) === hash && body.candidateSetHash === candidates.hash,
      'code_provenance_unverifiable',
      'The decision manifest does not match the frozen candidates',
      409,
    );
    // The manifest already pins the ancestry projection and contributor certificate.
    // As with base provenance, claim and verdict recheck those identities, never Git.
    const contributors = await this.contributors(projectId, body.contributors.references, tx);
    check(
      digest(contributors) === digest(body.contributors),
      'review_provenance_changed',
      'The retained contributors no longer match the prepared manifest',
      409,
    );
    const units = new Map<string, number | null>([[subjectId, null]]);
    const unit = await tx.get<{ base_json: string | null }>(
      'SELECT base_json FROM code_units WHERE project_id=? AND unit_id=?',
      projectId,
      subjectId,
    );
    const pin = unit?.base_json ? JSON.parse(unit.base_json) : null;
    if (pin?.kind === 'merged') {
      // Resolution work happens after decisions, so its writers join the final certificate here.
      const bases = this.bases();
      // A base is named by the set of commits it merges, and several records can end at the
      // same result commit — a task-resolved base's commit is an accepted commit like any
      // other. So the pinned acceptances say which record this is, and its result confirms it.
      const pinned = new Set(pin.sources.map((source: { unitId: string }) => source.unitId));
      const merged = new Set<string>();
      for (const row of await tx.all<Accepted>(
        `SELECT ${columns} FROM code_units WHERE project_id=? AND acceptance_json IS NOT NULL ORDER BY unit_id`,
        projectId,
      )) {
        const accepted = JSON.parse(row.acceptance_json) as Acceptance;
        if (pinned.has(row.unit_id) && accepted.code) merged.add(accepted.code.commit);
      }
      const base = bases && (await bases.find(tx, projectId, merged));
      check(
        base && !base.quarantined && base.result?.commit === pin.reference,
        'code_provenance_unverifiable',
        'The consolidation base must retain its resolution provenance',
        409,
      );
      for (const step of await bases!.path(tx, projectId, base.key))
        if (step.resolutionTaskId) units.set(step.resolutionTaskId, null);
    }
    const writers = await unitContributors(tx, this.sessions, projectId, units);
    const certificate = {
      formatVersion: 1 as const,
      provider: 'code.consolidation',
      reference: proposal.id,
      revalidate: true as const,
      sourceHash: digest({
        candidates,
        manifest,
        proposal: proposal.manifestHash,
        receipt: proposal.receipt,
        artifacts: proposal.artifacts,
        contributors,
        writers,
      }),
      excludedActorIds: [
        ...new Set([
          ...contributors.excludedActorIds,
          ...writers.flatMap((writer) => [writer.actorId, writer.authorityId]),
        ]),
      ].sort(),
    };
    return { ...certificate, hash: digest(certificate) };
  }
}

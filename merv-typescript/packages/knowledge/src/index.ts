import { canonical, mapAsync } from '@merv/contracts';
import { createService } from '@merv/contracts';
import type { Context } from 'cordis';
import {
  check,
  inTransaction,
  type Artifacts,
  type Caller,
  type Reviews,
  type Scope,
  type State,
  type Tasks,
  type Transaction,
  type Workflows,
} from '@merv/contracts';
import type { Claims } from '@merv/claims/types';
import type { Experiments, ExperimentSubmission } from '@merv/experiments/types';
import type { Code, CodeCaptureRef } from '@merv/code/types';
import type {
  Knowledge,
  KnowledgeAssessment,
  KnowledgeArtifact,
  KnowledgeCapture,
  KnowledgePublication,
  KnowledgeRecords,
  KnowledgeReference,
  KnowledgeReferenceKind,
  KnowledgeSelection,
} from './types.js';
import { knowledgeIdSchema, knowledgeReferencesSchema, parseKnowledgeInput } from './input.js';
import { migrateKnowledge } from './storage.js';

export type * from './types.js';

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const publication = (): KnowledgePublication => ({
  status: 'none',
  reflection: null,
  lenses: [],
});
const terminalTasks = new Set(['done', 'failed']);
const terminalExperiments = new Set(['complete', 'abandoned', 'failed']);
const errorCode = (error: unknown) =>
  error && typeof error === 'object' && 'code' in error ? error.code : undefined;
const missingCodes = new Set([
  'not_found',
  'claim_not_found',
  'experiment_not_found',
  'code_proposal_not_found',
  'code_capture_not_found',
  'session_not_found',
]);

/** Owns selection and immutable snapshots; domain services continue to own every source record. */
export class KnowledgeService implements Knowledge {
  private closed = false;
  private codeBinding?: symbol;
  /** Complete storage migrations before publishing this service. */
  initialize!: () => Promise<void>;
  constructor(
    private state: State,
    private scope: Scope,
    private claims: Claims,
    private tasks: Tasks,
    private experiments: Experiments,
    private artifacts: Artifacts,
    private reviews: Reviews,
    private workflows: Pick<Workflows, 'get'>,
    private code: Code | undefined,
  ) {
    this.initialize = async () => {
      await migrateKnowledge(state);
    };
  }

  private open(): void {
    check(!this.closed, 'knowledge_unavailable', 'Knowledge is unavailable', 503);
  }
  bindCode(code: Code): () => void {
    this.open();
    const binding = Symbol('code');
    this.codeBinding = binding;
    this.code = code;
    return () => {
      if (this.codeBinding !== binding) return;
      this.codeBinding = undefined;
      this.code = undefined;
    };
  }
  close(): void {
    this.closed = true;
    this.codeBinding = undefined;
    this.code = undefined;
  }

  async records(caller: Caller, transaction?: Transaction): Promise<KnowledgeRecords> {
    caller = structuredClone(caller);
    this.open();
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      const result: KnowledgeRecords = {
        formatVersion: 1,
        project: await this.scope.project(caller, tx),
        claims: await this.claims.list(caller, tx),
        tasks: await this.tasks.records(caller, tx),
        experiments: await this.experiments.list(caller, tx),
        publication: publication(),
      };
      await this.scope.require(caller, 'read', tx);
      return structuredClone(result);
    });
  }

  private async optional<T>(read: () => T | Promise<T>): Promise<T | null> {
    try {
      return await read();
    } catch (error) {
      if (missingCodes.has(String(errorCode(error)))) return null;
      throw error;
    }
  }

  private async selection(
    caller: Caller,
    tx: Transaction,
    live = false,
  ): Promise<KnowledgeSelection> {
    const inventory = await this.records(caller, tx);
    const tasks = inventory.tasks.filter((task) => live || terminalTasks.has(task.workflow.state));
    const experiments = inventory.experiments.filter(
      (experiment) => live || terminalExperiments.has(experiment.workflow.state),
    );
    const reviewIds = new Map<string, string>();
    const artifactIds = new Set<string>();
    const evidenceHashes = new Map<string, string>();
    const captures: KnowledgeCapture[] = [];
    const review = (id: string | null | undefined, subject: string) => {
      if (id) {
        check(
          !reviewIds.has(id) || reviewIds.get(id) === subject,
          'knowledge_source_conflict',
          'One review cannot belong to different corpus subjects',
          409,
        );
        reviewIds.set(id, subject);
      }
    };
    for (const task of tasks) {
      artifactIds.add(task.briefId);
      task.deliveryIds.forEach((id) => artifactIds.add(id));
      Object.values(task.contextInputs)
        .flat()
        .forEach((id) => artifactIds.add(id));
      if (task.deliveryAssessmentId) artifactIds.add(task.deliveryAssessmentId);
      review(task.reviewId, task.id);
      review(task.failure?.reviewId, task.id);
      if (typeof task.workflow.data.reviewId === 'string')
        review(task.workflow.data.reviewId, task.id);
    }
    for (const experiment of experiments) {
      review(experiment.reviewId, experiment.id);
      for (const attempt of experiment.attempts) {
        review(attempt.approvedReviewId, experiment.id);
        attempt.feedbackReviewIds.forEach((id) => review(id, experiment.id));
      }
      for (const evidence of [
        ...experiment.evidence,
        ...experiment.submissions.flatMap((submission) => submission.evidence),
      ]) {
        artifactIds.add(evidence.artifactId);
        evidence.figureIds.forEach((id) => artifactIds.add(id));
        check(
          !evidenceHashes.has(evidence.artifactId) ||
            evidenceHashes.get(evidence.artifactId) === evidence.hash,
          'knowledge_source_conflict',
          'Evidence associations disagree about an immutable artifact hash',
          409,
        );
        evidenceHashes.set(evidence.artifactId, evidence.hash);
      }
      for (const submission of experiment.submissions) {
        review(submission.reviewId, experiment.id);
        submission.figureIds.forEach((id) => artifactIds.add(id));
        const ref = (submission as ExperimentSubmission & { codeCaptureRef?: CodeCaptureRef })
          .codeCaptureRef;
        if (ref) {
          const code = this.code;
          if (!code) {
            captures.push({ ref, status: 'unavailable' });
            continue;
          }
          const capture = await this.optional(async () => await code.capture(caller, ref, tx));
          if (capture) {
            const source = capture.provenance;
            check(
              source.projectId === caller.projectId &&
                source.instanceId === experiment.id &&
                source.actorId === submission.producerId &&
                source.sessionId === submission.sessionId &&
                source.revision === submission.subjectRevision - 1,
              'knowledge_capture_provenance',
              'Capture must name the exact submitting worker and workflow revision',
              409,
            );
            captures.push({ ref, status: 'observed', capture });
          } else captures.push({ ref, status: 'missing' });
        }
      }
    }
    const assessments: KnowledgeAssessment[] = await mapAsync(
      [...reviewIds.keys()].sort(compare),
      async (id) => {
        const result = await this.optional(async () => await this.reviews.get(caller, id, tx));
        if (!result) return { id, status: 'missing' };
        check(
          result.projectId === caller.projectId && result.subjectId === reviewIds.get(id),
          'knowledge_source_conflict',
          'Assessment must belong to its selected project and subject',
          409,
        );
        result.artifactIds.forEach((id) => artifactIds.add(id));
        result.pinnedInputIds?.forEach((id) => artifactIds.add(id));
        result.findings
          .flatMap((finding) => finding.evidenceIds)
          .forEach((id) => artifactIds.add(id));
        return { id, status: 'retained', review: result };
      },
    );
    const artifacts: KnowledgeArtifact[] = await mapAsync(
      [...artifactIds].sort(compare),
      async (id) => {
        const artifact = await this.optional(async () => await this.artifacts.get(caller, id, tx));
        if (!artifact) return { id, status: 'missing' };
        check(
          artifact.id === id &&
            artifact.projectId === caller.projectId &&
            (!evidenceHashes.has(id) || evidenceHashes.get(id) === artifact.hash),
          'knowledge_source_conflict',
          'Artifact metadata differs from its exact evidence association',
          409,
        );
        return { id, status: 'retained', artifact };
      },
    );
    captures.sort((a, b) => compare(canonical(a.ref), canonical(b.ref)));
    return {
      projectFacts: 'pinned-at-capture',
      project: inventory.project,
      claims: inventory.claims,
      tasks,
      experiments,
      assessments,
      artifacts,
      captures,
      publication: inventory.publication,
      taskReviewCoverage: 'current-record-references',
    };
  }

  async researchReferences(caller: Caller, transaction?: Transaction) {
    caller = structuredClone(caller);
    return await inTransaction(this.state, transaction, async (tx) => {
      const selection = await this.selection(caller, tx, true);
      await this.scope.require(caller, 'read', tx);
      return {
        artifacts: selection.artifacts.flatMap((entry) =>
          entry.status === 'retained' ? [entry.id] : [],
        ),
        reviews: selection.assessments.flatMap((entry) =>
          entry.status === 'retained' ? [entry.id] : [],
        ),
        experiments: selection.experiments
          .filter((entry) => terminalExperiments.has(entry.workflow.state))
          .map((entry) => entry.id),
      };
    });
  }

  async resolve(
    caller: Caller,
    refs: string[],
    transaction?: Transaction,
  ): Promise<KnowledgeReference[]> {
    caller = structuredClone(caller);
    this.open();
    const input = parseKnowledgeInput(knowledgeReferencesSchema, { refs });
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      const result = await mapAsync(
        input.refs,
        async (ref) => await this.reference(caller, ref, tx),
      );
      await this.scope.require(caller, 'read', tx);
      return structuredClone(result);
    });
  }

  private async reference(
    caller: Caller,
    ref: string,
    tx: Transaction,
  ): Promise<KnowledgeReference> {
    let kind: string | undefined, id: string;
    const colon = ref.indexOf(':');
    if (colon >= 0) {
      kind = ref.slice(0, colon);
      id = ref.slice(colon + 1);
    } else {
      id = ref;
      kind = [
        ['claim_', 'claim'],
        ['art_', 'artifact'],
        ['review_', 'review'],
        ['codeprop_', 'code-proposal'],
        ['codecmd_', 'code-commit'],
        ['session_', 'session-final'],
        ['wf_', 'work-item'],
      ].find(([prefix]) => ref.startsWith(prefix))?.[1];
      if (ref.startsWith('published-')) kind = ref;
    }
    if (kind && ['published-reflection', 'published-lens'].includes(kind))
      return { ref, status: 'unpublished', kind: kind as KnowledgeReferenceKind, id: null };
    const missing = (known: KnowledgeReferenceKind | null): KnowledgeReference => ({
      ref,
      status: 'missing',
      kind: known,
      id,
    });
    const resolved = (
      known: KnowledgeReferenceKind,
      facts: Omit<KnowledgeReference, 'ref' | 'status' | 'kind' | 'id'>,
    ): KnowledgeReference => ({ ref, status: 'resolved', kind: known, id, ...facts });
    if (!id || !knowledgeIdSchema.safeParse(id).success)
      return { ref, status: 'unsupported', kind: null, id: null };
    if (kind === 'claim') {
      const claim = await this.optional(async () => await this.claims.get(caller, id, tx));
      return claim
        ? resolved('claim', {
            label: claim.statement,
            revision: claim.revision,
            state: claim.status,
          })
        : missing('claim');
    }
    if (kind === 'work-item') {
      // A work item is whatever program its instance runs; only tasks and experiments resolve.
      const snapshot = await this.optional(async () => await this.workflows.get(caller, id, tx));
      if (!snapshot) return missing(null);
      if (snapshot.workflow !== 'task' && snapshot.workflow !== 'experiment')
        return { ref, status: 'unsupported', kind: null, id };
      kind = snapshot.workflow;
    }
    if (kind === 'task') {
      const task = await this.optional(async () => await this.tasks.record(caller, id, tx));
      return task
        ? resolved('task', {
            label: task.title,
            revision: task.workflow.revision,
            state: task.workflow.state,
          })
        : missing('task');
    }
    if (kind === 'experiment') {
      const experiment = await this.optional(
        async () => await this.experiments.get(caller, id, tx),
      );
      return experiment
        ? resolved('experiment', {
            label: experiment.name,
            revision: experiment.workflow.revision,
            state: experiment.workflow.state,
          })
        : missing('experiment');
    }
    if (kind === 'artifact') {
      const artifact = await this.optional(async () => await this.artifacts.get(caller, id, tx));
      return artifact
        ? resolved('artifact', { label: artifact.title, hash: artifact.hash })
        : missing('artifact');
    }
    if (kind === 'review') {
      const review = await this.optional(async () => await this.reviews.get(caller, id, tx));
      // A review is named by the work it judges, as a person would name it.
      const subject = review
        ? await this.optional(async () => await this.workflows.get(caller, review.subjectId, tx))
        : undefined;
      return review
        ? resolved('review', {
            label: `Review of ${String(subject?.data.title ?? subject?.data.name ?? review.subjectId)}`,
            revision: review.subjectRevision,
            state: review.status,
            hash: review.snapshotHash,
          })
        : missing('review');
    }
    if (kind === 'code-proposal') {
      const code = this.code;
      if (!code) return { ref, status: 'unavailable', kind: 'code-proposal', id };
      const proposal = await this.optional(async () => await code.proposal(caller, id, tx));
      return proposal
        ? resolved('code-proposal', {
            label: proposal.summary,
            revision: proposal.revision,
            hash: proposal.manifestHash,
          })
        : missing('code-proposal');
    }
    if (kind === 'session-final' || kind === 'code-commit') {
      const code = this.code;
      if (!code) return { ref, status: 'unavailable', kind: 'code-capture', id };
      const capture = await this.optional(
        async () =>
          await code.capture(
            caller,
            kind === 'session-final' ? { kind, sessionId: id } : { kind, commandId: id },
            tx,
          ),
      );
      return capture
        ? resolved('code-capture', { state: capture.status, capture })
        : missing('code-capture');
    }
    return { ref, status: 'unsupported', kind: null, id: null };
  }
}

export const knowledgePlugin = {
  name: 'merv-knowledge',
  inject: ['state', 'scope', 'claims', 'tasks', 'experiments', 'artifacts', 'reviews', 'workflows'],
  async apply(ctx: Context) {
    await ctx.effect(async function* () {
      const service = await createService(
        new KnowledgeService(
          ctx.state,
          ctx.scope,
          ctx.claims,
          ctx.tasks,
          ctx.experiments,
          ctx.artifacts,
          ctx.reviews,
          ctx.workflows,
          undefined,
        ),
      );
      yield () => service.close();
      ctx.inject(['code'], (ctx) => {
        ctx.effect(() => service.bindCode(ctx.code));
      });
      yield ctx.provide('knowledge', service);
    });
  },
};
export default knowledgePlugin;

import { mapAsync } from '@merv/contracts';
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
import type { Experiments } from '@merv/experiments/types';
import type { Code } from '@merv/code-research/types';
import type {
  Knowledge,
  KnowledgePublication,
  KnowledgeRecords,
  KnowledgeReference,
  KnowledgeReferenceKind,
} from './types.js';
import { knowledgeIdSchema, knowledgeReferencesSchema, parseKnowledgeInput } from './input.js';
import { migrateKnowledge } from './storage.js';

export type * from './types.js';

const publication = (): KnowledgePublication => ({
  status: 'none',
  reflection: null,
  lenses: [],
});
const errorCode = (error: unknown) =>
  error && typeof error === 'object' && 'code' in error ? error.code : undefined;
const missingCodes = new Set([
  'not_found',
  'experiment_not_found',
  'code_proposal_not_found',
  'code_capture_not_found',
  'session_not_found',
]);

/** Reads project records and resolves references; domain services own every source record. */
export class KnowledgeService implements Knowledge {
  private closed = false;
  private codeBinding?: symbol;
  /** Complete storage migrations before publishing this service. */
  initialize!: () => Promise<void>;
  constructor(
    private state: State,
    private scope: Scope,
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
        ['art_', 'artifact'],
        ['review_', 'review'],
        ['codeprop_', 'code-proposal'],
        ['codecmd_', 'code-commit'],
        ['session_', 'session-final'],
        ['wf_', 'work-item'],
      ].find(([prefix]) => ref.startsWith(prefix))?.[1];
    }
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
    if (kind === 'work-item' || kind === 'reflection' || kind === 'research') {
      // A work item is whatever program its instance runs; a wave and a cycle are named by it.
      const snapshot = await this.optional(async () => await this.workflows.get(caller, id, tx));
      if (kind !== 'work-item' && snapshot?.workflow !== kind) return missing(kind);
      if (!snapshot) return missing(null);
      if (snapshot.workflow === 'reflection' || snapshot.workflow === 'research')
        return resolved(snapshot.workflow, {
          label: String(snapshot.data.title ?? snapshot.data.name),
          revision: snapshot.revision,
          state: snapshot.state,
        });
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
  inject: ['state', 'scope', 'tasks', 'experiments', 'artifacts', 'reviews', 'workflows'],
  async apply(ctx: Context) {
    await ctx.effect(async function* () {
      const service = await createService(
        new KnowledgeService(
          ctx.state,
          ctx.scope,
          ctx.tasks,
          ctx.experiments,
          ctx.artifacts,
          ctx.reviews,
          ctx.workflows,
          undefined,
        ),
      );
      yield () => service.close();
      ctx.inject(['codeResearch'], (ctx) => {
        ctx.effect(() => service.bindCode(ctx.codeResearch));
      });
      yield ctx.provide('knowledge', service);
    });
  },
};
export default knowledgePlugin;

import type { Tasks } from '@merv/tasks/types';
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
  type Transaction,
  type Workflows,
} from '@merv/contracts';
import type { Experiments } from '@merv/experiments/types';
import type { Code } from '@merv/code-work/types';
import { instanceName } from '@merv/workflows/rules';
import type {
  Knowledge,
  KnowledgeRecords,
  KnowledgeReference,
  KnowledgeReferenceKind,
} from './types.js';
import { knowledgeIdSchema, knowledgeReferencesSchema, parseKnowledgeInput } from './input.js';
import { postgresMigrations } from './storage.postgres.js';

export type * from './types.js';

const errorCode = (error: unknown) =>
  error && typeof error === 'object' && 'code' in error ? error.code : undefined;
/** The work programs a reference names; any other workflow's instance is unsupported. */
const WORK = new Set(['task', 'experiment', 'reflection', 'research']);
/** A reference as its source reads it: everything but what the caller asked. */
type Found = Omit<KnowledgeReference, 'ref' | 'id'>;
const missingCodes = new Set([
  'not_found',
  'experiment_not_found',
  'code_capture_not_found',
  'session_not_found',
]);

/** Reads project records and resolves references; domain services own every source record. */
export class KnowledgeService implements Knowledge {
  private closed = false;
  private codeBinding?: symbol;
  constructor(
    private state: State,
    private scope: Scope,
    private tasks: Tasks,
    private experiments: Experiments,
    private artifacts: Artifacts,
    private reviews: Reviews,
    private workflows: Pick<Workflows, 'get'>,
    private code: Code | undefined,
  ) {}
  /** Complete storage migrations before publishing this service. */
  async initialize(): Promise<void> {
    await this.state.migrate('knowledge', postgresMigrations);
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

  /**
   * Each kind of reference, read from the service that holds it, and the kind a missing one is
   * reported as. A read is null when its service holds no such record for this caller.
   */
  private readonly sources: Record<
    string,
    {
      kind: KnowledgeReferenceKind | null;
      read(caller: Caller, id: string, tx: Transaction): Promise<Found | null>;
    }
  > = {
    // A work item is whatever program its instance runs, named as Workflows names it.
    'work-item': {
      kind: null,
      read: async (caller, id, tx) => {
        const snapshot = await this.optional(async () => await this.workflows.get(caller, id, tx));
        if (!snapshot) return null;
        if (!WORK.has(snapshot.workflow)) return { status: 'unsupported', kind: null };
        return {
          status: 'resolved',
          kind: snapshot.workflow as KnowledgeReferenceKind,
          label: instanceName(snapshot.data, snapshot.workflow),
          revision: snapshot.revision,
          state: snapshot.state,
        };
      },
    },
    artifact: {
      kind: 'artifact',
      read: async (caller, id, tx) => {
        const artifact = await this.optional(async () => await this.artifacts.get(caller, id, tx));
        return (
          artifact && {
            status: 'resolved',
            kind: 'artifact',
            label: artifact.title,
            hash: artifact.hash,
          }
        );
      },
    },
    review: {
      kind: 'review',
      read: async (caller, id, tx) => {
        const review = await this.optional(async () => await this.reviews.get(caller, id, tx));
        if (!review) return null;
        // A review is named by the work it judges, as a person would name it.
        const subject = await this.optional(
          async () => await this.workflows.get(caller, review.subjectId, tx),
        );
        return {
          status: 'resolved',
          kind: 'review',
          label: `Review of ${instanceName(subject?.data ?? {}, review.subjectId)}`,
          revision: review.subjectRevision,
          state: review.status,
          hash: review.snapshotHash,
        };
      },
    },
    'session-final': {
      kind: 'code-capture',
      read: async (caller, sessionId, tx) =>
        await this.capture(caller, { kind: 'session-final', sessionId }, tx),
    },
    'code-commit': {
      kind: 'code-capture',
      read: async (caller, commandId, tx) =>
        await this.capture(caller, { kind: 'code-commit', commandId }, tx),
    },
  };

  private async capture(
    caller: Caller,
    ref: Parameters<Code['capture']>[1],
    tx: Transaction,
  ): Promise<Found | null> {
    const code = this.code;
    if (!code) return { status: 'unavailable', kind: 'code-capture' };
    const capture = await this.optional(async () => await code.capture(caller, ref, tx));
    return capture && { status: 'resolved', kind: 'code-capture', state: capture.status, capture };
  }

  private async reference(
    caller: Caller,
    ref: string,
    tx: Transaction,
  ): Promise<KnowledgeReference> {
    const colon = ref.indexOf(':');
    const id = colon >= 0 ? ref.slice(colon + 1) : ref;
    if (!id || !knowledgeIdSchema.safeParse(id).success)
      return { ref, status: 'unsupported', kind: null, id: null };
    if (colon < 0) {
      // A bare id is whichever record holds it; one a source that is not loaded might hold is
      // unavailable rather than missing.
      let skipped: Found | undefined;
      for (const source of Object.values(this.sources)) {
        // A source that is shutting down holds nothing it can show now, not nothing at all.
        const found = await source.read(caller, id, tx).catch((error: unknown) => {
          if ((error as { status?: unknown })?.status !== 503) throw error;
          return { status: 'unavailable', kind: source.kind } as Found;
        });
        if (found?.status === 'unavailable') skipped ??= found;
        else if (found) return { ref, id, ...found };
      }
      return { ref, id, ...(skipped ?? { status: 'missing', kind: null }) };
    }
    const kind = ref.slice(0, colon);
    // A task, experiment, wave or cycle is a work item running the program it names.
    const work = WORK.has(kind);
    const source = work
      ? this.sources['work-item']
      : Object.hasOwn(this.sources, kind)
        ? this.sources[kind]
        : undefined;
    if (!source) return { ref, status: 'unsupported', kind: null, id: null };
    const found = await source.read(caller, id, tx);
    if (found && (!work || found.kind === kind)) return { ref, id, ...found };
    return {
      ref,
      status: 'missing',
      kind: work ? (kind as KnowledgeReferenceKind) : source.kind,
      id,
    };
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
      ctx.inject(['codeWork'], (ctx) => {
        ctx.effect(() => service.bindCode(ctx.codeWork));
      });
      yield ctx.provide('knowledge', service);
    });
  },
};
export default knowledgePlugin;

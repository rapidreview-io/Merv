import type { Tasks } from '@merv/tasks/types';
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
  type WorkflowSnapshot,
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

/** The work programs a reference names; any other workflow's instance is unsupported. */
const WORK = new Set(['task', 'experiment', 'reflection', 'research']);
/** A reference as its source reads it: everything but what the caller asked. */
type Found = Omit<KnowledgeReference, 'ref' | 'id'>;
/**
 * The owner each kind of ref names, in the order a bare id is asked of them, and the kind a
 * missing one is reported as. A work item is whatever program its instance runs.
 */
const SOURCES = {
  'work-item': null,
  artifact: 'artifact',
  review: 'review',
  'session-final': 'code-capture',
  'code-commit': 'code-capture',
} as const satisfies Record<string, KnowledgeReferenceKind | null>;
type Source = keyof typeof SOURCES;
const ORDER = Object.keys(SOURCES) as Source[];

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
    private workflows: Pick<Workflows, 'find'>,
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
      const result = await this.references(caller, input.refs, tx);
      await this.scope.require(caller, 'read', tx);
      return structuredClone(result);
    });
  }

  /**
   * Every ref of a request, each owner read once for all the ids it might hold. A bare id is
   * whichever record holds it, asked of each owner in SOURCES order; one an owner that is not
   * loaded, or is shutting down, might hold is unavailable rather than missing. A ref that names
   * an owner that is shutting down is refused.
   */
  private async references(
    caller: Caller,
    refs: string[],
    tx: Transaction,
  ): Promise<KnowledgeReference[]> {
    const asks = refs.map((ref) => {
      const colon = ref.indexOf(':');
      const id = colon >= 0 ? ref.slice(colon + 1) : ref;
      const kind = colon >= 0 ? ref.slice(0, colon) : null;
      // A task, experiment, wave or cycle is a work item running the program it names.
      const source =
        kind === null
          ? null
          : WORK.has(kind)
            ? 'work-item'
            : Object.hasOwn(SOURCES, kind)
              ? (kind as Source)
              : undefined;
      const valid = !!id && knowledgeIdSchema.safeParse(id).success;
      return { ref, id, kind, source: valid ? source : undefined };
    });
    /** What each owner holds of the ids asked of it; null when it could not be read. */
    const held: Partial<Record<Source, Map<string, Found> | null>> = {};
    const found = (source: Source, id: string): Found | undefined =>
      held[source] === null
        ? { status: 'unavailable', kind: SOURCES[source] }
        : held[source]?.get(id);
    /** What the owners before `until`, in SOURCES order, answer for a bare id. */
    const bare = (id: string, until?: Source) => {
      let skipped: Found | undefined;
      for (const source of ORDER.slice(0, until && ORDER.indexOf(until))) {
        const answer = found(source, id);
        if (answer?.status === 'unavailable') skipped ??= answer;
        else if (answer) return { answer, skipped };
      }
      return { skipped };
    };
    /** The ids to ask an owner: those refs name it by, and bare ids no owner before it holds. */
    const ids = (source: Source) => [
      ...new Set(
        asks.flatMap((ask) =>
          ask.source === source || (ask.source === null && !bare(ask.id, source).answer)
            ? [ask.id]
            : [],
        ),
      ),
    ];
    /** An owner's read; one shutting down holds nothing it can show now, not nothing at all. */
    const read = async <T>(sources: Source[], fn: () => Promise<T>) => {
      try {
        return await fn();
      } catch (error) {
        if (
          (error as { status?: unknown })?.status !== 503 ||
          asks.some(({ source }) => source && sources.includes(source))
        )
          throw error;
        return null;
      }
    };
    // Reviews come first, so the work they judge is read with the work items.
    const reviews = await read(['review'], () => this.reviews.find(caller, ids('review'), tx));
    const subjects = [...(reviews?.values() ?? [])].map(({ subjectId }) => subjectId);
    // Reviews cannot be named while their work cannot be read.
    const work = await read(subjects.length ? ['work-item', 'review'] : ['work-item'], () =>
      this.workflows.find(caller, [...ids('work-item'), ...subjects], tx),
    );
    held['work-item'] = work && map(work, workItem);
    const artifacts = await read(['artifact'], () =>
      this.artifacts.find(caller, ids('artifact'), tx),
    );
    held.artifact =
      artifacts &&
      map(artifacts, ({ title, hash }) => ({
        status: 'resolved',
        kind: 'artifact',
        label: title,
        hash,
      }));
    held.review =
      reviews &&
      (work || !subjects.length ? reviews : null) &&
      map(reviews, (review) => ({
        status: 'resolved',
        kind: 'review',
        // A review is named by the work it judges, as a person would name it.
        label: `Review of ${instanceName(work?.get(review.subjectId)?.data ?? {}, review.subjectId)}`,
        revision: review.subjectRevision,
        state: review.status,
        hash: review.snapshotHash,
      }));
    const finals = ids('session-final'),
      commits = ids('code-commit');
    const code = this.code;
    const captures = code
      ? await read(['session-final', 'code-commit'], () =>
          code.captures(
            caller,
            [
              ...finals.map((sessionId) => ({ kind: 'session-final' as const, sessionId })),
              ...commits.map((commandId) => ({ kind: 'code-commit' as const, commandId })),
            ],
            tx,
          ),
        )
      : null;
    const captured = (ids: string[], offset: number) =>
      captures &&
      new Map(
        ids.flatMap((id, index) => {
          const capture = captures[offset + index];
          const answer: Found | null = capture && {
            status: 'resolved',
            kind: 'code-capture',
            state: capture.status,
            capture,
          };
          return answer ? [[id, answer] as const] : [];
        }),
      );
    held['session-final'] = captured(finals, 0);
    held['code-commit'] = captured(commits, finals.length);
    return asks.map(({ ref, id, kind, source }): KnowledgeReference => {
      if (source === undefined) return { ref, status: 'unsupported', kind: null, id: null };
      if (source === null) {
        const { answer, skipped } = bare(id);
        return { ref, id, ...(answer ?? skipped ?? { status: 'missing', kind: null }) };
      }
      const answer = found(source, id);
      const work = WORK.has(kind!);
      if (answer && (!work || answer.kind === kind)) return { ref, id, ...answer };
      return {
        ref,
        status: 'missing',
        kind: work ? (kind as KnowledgeReferenceKind) : SOURCES[source],
        id,
      };
    });
  }
}

/** A work item as a reference names it: by the program its instance runs, as Workflows does. */
const workItem = (snapshot: WorkflowSnapshot): Found =>
  WORK.has(snapshot.workflow)
    ? {
        status: 'resolved',
        kind: snapshot.workflow as KnowledgeReferenceKind,
        label: instanceName(snapshot.data, snapshot.workflow),
        revision: snapshot.revision,
        state: snapshot.state,
      }
    : { status: 'unsupported', kind: null };
const map = <T>(records: Map<string, T>, fn: (record: T) => Found) =>
  new Map([...records].map(([id, record]) => [id, fn(record)]));

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

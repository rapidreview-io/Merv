import { mapAsync } from '@merv/contracts';
import { clip, createService, ordered, recorded, replayed, visible } from '@merv/contracts';
import { postgresMigrations } from './index.postgres.js';
import type { Context } from 'cordis';
import {
  check,
  digest,
  inTransaction,
  now,
  type Caller,
  type Data,
  type Scope,
  type State,
  type Tasks,
  type Transaction,
  type WorkflowCheckContext,
  type WorkflowDefinition,
  type WorkflowPolicy,
  type Workflows,
} from '@merv/contracts';
import type { Paper, PaperRevision } from '@merv/paper/types';
import type { Knowledge } from '@merv/knowledge/types';
import type { Experiments } from '@merv/experiments/types';
import type {
  ApprovedReflection,
  ChangeSpec,
  ReflectionCreate,
  Reflections,
} from '@merv/reflections/types';
import type { Consolidation } from '@merv/consolidation/types';
import type {
  Research,
  ResearchAdvance,
  ResearchCreate,
  ResearchEnd,
  ResearchOrigin,
  ResearchRecord,
  ResearchReplan,
} from './types.js';
import {
  advanceSchema,
  createSchema,
  endChoiceSchema,
  endSchema,
  getSchema,
  nextWaveChoiceSchema,
  parse,
  replanSchema,
} from './input.js';
export type * from './types.js';
const stages = ['defining', 'researching', 'reflecting', 'consolidating', 'complete'] as const;
type Stage = (typeof stages)[number];
interface Capabilities {
  paper: Paper;
  reflections: Reflections;
  consolidation: Consolidation;
  knowledge: Knowledge;
  tasks: Tasks;
  experiments: Experiments;
}
/** An approved reflection whose plan says the project continues. */
type Continuing = ApprovedReflection & {
  plan: ChangeSpec & { next: { decision: 'continue' } };
};
type Binding<T> = { value: T };
type BindingChecks = (() => void)[];
const unavailable = {
  paper: 'This stage needs Paper; enable it to continue',
  reflections: 'This stage needs Reflections; enable it to continue',
  consolidation: 'This cycle requires Consolidation and Code; enable them to continue',
  knowledge: 'This handoff needs live research evidence from Knowledge; enable it to continue',
  tasks:
    'Creating the approved plan\'s work needs Tasks; enable it, or complete this cycle with nextWave: "skip"',
  experiments:
    'Creating the approved plan\'s experiments needs Experiments; enable it, or complete this cycle with nextWave: "skip"',
};
const nextWaveGuidance =
  'When the approved reflection carries a structured plan that continues, completing the cycle requires nextWave: "create" opens the plan\'s tasks, experiments and the next research cycle in the same transaction, and "skip" completes without them. A text change specification creates nothing; follow-on work is then the owner\'s to create.';
/** Experiments counts these states as no longer active; the plan's experiments are sized against the rest. */
const finishedExperiment = new Set(['complete', 'abandoned', 'failed']);
const instructions: Record<Stage, string> = {
  defining:
    'Complete the living paper’s problem, scope, goals and constraints, then advance to research.',
  researching:
    'Finish the selected research workflows successfully, then advance to open a reflection wave over live research.',
  reflecting: `Complete all reflection lenses and independent synthesis review, then finish the cycle or start the selected Git consolidation. ${nextWaveGuidance}`,
  consolidating: `Finish consolidation and its independent review, then complete the research cycle. Paper changes are reviewed within the experiment and reflection workflows. ${nextWaveGuidance}`,
  complete:
    'The selected research, reflection and any required consolidation are complete. Paper changes were handled by their scientific reviews. If the owner chose to create an approved plan, the next research cycle is referenced here. Central Git publication is separate.',
};
const definition: WorkflowDefinition = {
  name: 'research',
  version: 2,
  managed: true,
  initial: 'defining',
  states: [...stages],
  terminal: ['complete'],
  edges: stages
    .slice(0, -1)
    .map((from, index) => ({ from, action: 'advance', to: stages[index + 1] })),
};
interface Row {
  id: string;
  record: string;
  problem: string | null;
  reflection_id: string | null;
  consolidation_id: string | null;
  methods_update_id: string | null;
  results_update_id: string | null;
  predecessor_id: string | null;
}
/** The immutable inputs as stored; which cycle it follows lives in predecessor_id alone. */
type StoredRecord = Pick<
  ResearchRecord,
  | 'id'
  | 'projectId'
  | 'ownerId'
  | 'name'
  | 'createdAt'
  | 'researchDependencies'
  | 'consolidationWorkspace'
  | 'consolidationDependencies'
> & { origin?: Omit<ResearchOrigin, 'researchId'> };

/** A small coordinator over existing workflows; child programs own their actual assignments. */
export class ResearchService implements Research {
  private closed = false;
  private releaseReadReferences?: () => void;
  private bindings: { [K in keyof Capabilities]?: Binding<Capabilities[K]> } = {};
  private handles = new Map<number, Awaited<ReturnType<Workflows['register']>>>();
  /** Complete storage migrations before publishing this service. */
  initialize!: () => Promise<void>;
  constructor(
    private state: State,
    private scope: Scope,
    private workflows: Workflows,
    paper?: Paper,
    reflections?: Reflections,
    consolidation?: Consolidation,
    knowledge?: Knowledge,
    tasks?: Tasks,
    experiments?: Experiments,
  ) {
    this.initialize = async () => {
      await state.migrate('research', [
        {
          version: 1,
          postgres: postgresMigrations[1],
          sql: `
CREATE TABLE research_cycles (id TEXT PRIMARY KEY,project_id TEXT NOT NULL,record TEXT NOT NULL,problem TEXT,reflection_id TEXT,consolidation_id TEXT,methods_update_id TEXT,results_update_id TEXT);
CREATE TRIGGER research_identity BEFORE UPDATE OF id,project_id,record ON research_cycles BEGIN SELECT RAISE(ABORT,'Research inputs are immutable'); END;
CREATE TRIGGER research_children BEFORE UPDATE ON research_cycles WHEN (OLD.problem IS NOT NULL AND NEW.problem IS NOT OLD.problem) OR (OLD.reflection_id IS NOT NULL AND NEW.reflection_id IS NOT OLD.reflection_id) OR (OLD.consolidation_id IS NOT NULL AND NEW.consolidation_id IS NOT OLD.consolidation_id) OR (OLD.methods_update_id IS NOT NULL AND NEW.methods_update_id IS NOT OLD.methods_update_id) OR (OLD.results_update_id IS NOT NULL AND NEW.results_update_id IS NOT OLD.results_update_id) BEGIN SELECT RAISE(ABORT,'Research children and accepted definition are immutable'); END;
CREATE TRIGGER research_retained BEFORE DELETE ON research_cycles BEGIN SELECT RAISE(ABORT,'Research history is retained'); END;
CREATE TABLE research_commands (project_id TEXT NOT NULL,actor_id TEXT NOT NULL,request_id TEXT NOT NULL,input_hash TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(project_id,actor_id,request_id));
`,
        },
        {
          // A cycle opened from an approved plan names the cycle it follows. The index makes
          // "one successor per cycle" a fact of storage rather than of a lookup before insert.
          version: 2,
          postgres: postgresMigrations[2],
          sql: `
ALTER TABLE research_cycles ADD COLUMN predecessor_id TEXT;
CREATE UNIQUE INDEX research_successor ON research_cycles(predecessor_id) WHERE predecessor_id IS NOT NULL;
CREATE TRIGGER research_predecessor BEFORE UPDATE OF predecessor_id ON research_cycles BEGIN SELECT RAISE(ABORT,'Research inputs are immutable'); END;
`,
        },
      ]);
      try {
        // Existing cycles keep their immutable state machine; only new cycles may skip
        // consolidation, and only version 4 can be ended before it reaches an answer.
        for (const version of [2, 3, 4]) {
          const ends = version >= 4;
          this.handles.set(
            version,
            await workflows.register(
              {
                ...definition,
                version,
                ...(ends
                  ? {
                      states: [...definition.states, 'abandoned', 'failed'],
                      terminal: [...definition.terminal, 'abandoned', 'failed'],
                    }
                  : {}),
                edges: [
                  ...definition.edges,
                  ...(version >= 3
                    ? [{ from: 'reflecting' as const, action: 'complete', to: 'complete' }]
                    : []),
                  ...(ends
                    ? stages.slice(0, -1).flatMap((from) => [
                        { from, action: 'abandon', to: 'abandoned' },
                        { from, action: 'mark_failed', to: 'failed' },
                      ])
                    : []),
                ],
              },
              this.policy(version),
            ),
          );
        }
        if (paper) this.bindPaper(paper);
        if (reflections) this.bindReflections(reflections);
        if (consolidation) this.bindConsolidation(consolidation);
        if (knowledge) this.bindKnowledge(knowledge);
        if (tasks) this.bindTasks(tasks);
        if (experiments) this.bindExperiments(experiments);
      } catch (error) {
        for (const handle of this.handles.values()) handle.dispose();
        throw error;
      }
    };
  }

  private policy(version: number): WorkflowPolicy {
    return {
      successStates: ['complete'],
      describe: async (context) => {
        const record = await this.get(context.caller, context.snapshot.id, context.tx);
        return {
          label: record.name,
          gate: context.snapshot.state,
          waiting: instructions[context.snapshot.state as Stage],
          references: [
            ...this.children(record).map((id) => ({
              kind: 'workflow',
              id,
              label: 'Child workflow',
            })),
            ...(record.successorId
              ? [{ kind: 'workflow', id: record.successorId, label: 'Next research cycle' }]
              : []),
          ],
        };
      },
      // A cycle whose selected work cannot succeed is ended, not advanced.
      ...(version >= 4 ? { dependencyFailureAction: 'end' } : {}),
      actions: [
        ...(version >= 4
          ? [
              {
                name: 'end',
                states: [...stages.slice(0, -1)],
                transitions: ['abandon', 'mark_failed'],
                // Never the suggested move: ending is what you reach for when the work cannot
                // go on, and the engine offers it by name when a prerequisite has died.
                suggested: false,
                tool: 'research.end',
                instruction:
                  'End this research cycle when it cannot reach an answer: abandoned when the question is no longer worth pursuing, failed when it was pursued and cannot be completed. Its children keep their own records. Requires a specific reason. This is terminal.',
                requiredInput: ['outcome', 'reason'],
                arguments: (context: WorkflowCheckContext) => ({
                  researchId: context.snapshot.id,
                  expectedRevision: context.snapshot.revision,
                }),
                check: async (context: WorkflowCheckContext) => {
                  const record = await this.get(context.caller, context.snapshot.id, context.tx);
                  await this.authorize(context.caller, record, context.tx);
                  if (context.input) parse(endChoiceSchema, context.input);
                },
              },
            ]
          : []),
        ...stages.slice(0, -1).map((stage) => ({
          name: `advance_${stage}`,
          states: [stage],
          transitions:
            version >= 3 && stage === 'reflecting' ? ['advance', 'complete'] : ['advance'],
          tool: 'research.advance',
          instruction: instructions[stage],
          requiresDependencies: stage !== 'defining',
          arguments: (context: WorkflowCheckContext) => ({
            researchId: context.snapshot.id,
            expectedRevision: context.snapshot.revision,
          }),
          check: async (context: WorkflowCheckContext) => {
            const record = await this.get(context.caller, context.snapshot.id, context.tx);
            await this.authorize(context.caller, record, context.tx);
            await this.ready(
              context.caller,
              record,
              context.tx,
              [],
              parse(nextWaveChoiceSchema, context.input ?? {}).nextWave,
            );
          },
          // Creating a plan's work is never implied by an advance: a caller that does not know
          // about the plan is asked, rather than launching work an agent wrote.
          ...(stage === 'reflecting' || stage === 'consolidating'
            ? {
                requiredInput: async (context: WorkflowCheckContext) => {
                  // A choice already made was judged by the check; a skip must not need Reflections.
                  if (parse(nextWaveChoiceSchema, context.input ?? {}).nextWave) return [];
                  const record = await this.get(context.caller, context.snapshot.id, context.tx);
                  return (await this.continuing(context.caller, record, context.tx, []))
                    ? ['nextWave']
                    : [];
                },
              }
            : {}),
        })),
      ],
    };
  }

  async startReflection(caller: Caller, input: ReflectionCreate, tx?: Transaction) {
    this.open();
    ({ caller, input } = structuredClone({ caller, input }));
    return await inTransaction(this.state, tx, async (transaction) => {
      const checks: BindingChecks = [];
      const result = await this.use('reflections', checks, (service) =>
        service.create(caller, input, transaction),
      );
      checks.forEach((check) => check());
      return result;
    });
  }
  private open() {
    check(!this.closed, 'research_unavailable', 'Research is unavailable', 503);
  }
  async get(caller: Caller, id: string, transaction?: Transaction): Promise<ResearchRecord> {
    this.open();
    caller = structuredClone(caller);
    parse(getSchema, { researchId: id });
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      const row = await tx.get<Row>(
        'SELECT * FROM research_cycles WHERE id=? AND project_id=?',
        id,
        caller.projectId,
      );
      check(row, 'research_not_found', 'Research cycle was not found in this project', 404);
      // The selection is what the cycle waits on now, not what it was created with.
      const children = [row.reflection_id, row.consolidation_id];
      const { origin, ...record } = JSON.parse(row.record) as StoredRecord;
      const successor = await tx.get<{ id: string }>(
        'SELECT id FROM research_cycles WHERE predecessor_id=? AND project_id=?',
        id,
        caller.projectId,
      );
      return {
        ...record,
        // The column is the one statement of which cycle this follows; the record pins the rest.
        origin: origin && row.predecessor_id ? { researchId: row.predecessor_id, ...origin } : null,
        successorId: successor?.id ?? null,
        researchDependencies: (await this.workflows.dependencies(caller, id, tx)).dependencies
          .map((item) => item.id)
          .filter((item) => !children.includes(item)),
        workflow: await this.workflows.get(caller, id, tx),
        problem: row.problem ? JSON.parse(row.problem) : null,
        reflectionId: row.reflection_id,
        consolidationId: row.consolidation_id,
      };
    });
  }
  async list(caller: Caller, transaction?: Transaction): Promise<ResearchRecord[]> {
    this.open();
    caller = structuredClone(caller);
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      return await mapAsync(
        await tx.all<{ id: string }>(
          tx.dialect === 'postgres'
            ? 'SELECT id FROM research_cycles WHERE project_id=? ORDER BY _merv_rowid'
            : 'SELECT id FROM research_cycles WHERE project_id=? ORDER BY rowid',
          caller.projectId,
        ),
        async (row) => await this.get(caller, row.id, tx),
      );
    });
  }
  async create(
    caller: Caller,
    value: ResearchCreate,
    transaction?: Transaction,
  ): Promise<ResearchRecord> {
    this.open();
    caller = structuredClone(caller);
    const input = parse(createSchema, value);
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'write', tx);
      return await this.command(
        caller,
        'create',
        input,
        tx,
        async () => await this.begin(caller, input, 'create', null, tx),
      );
    });
  }
  /**
   * Opens a cycle inside a command its caller already recorded. research_commands has one row
   * per request, so the cycle an advance opens must not record a second one under the same ID.
   */
  private async begin(
    caller: Caller,
    input: ReturnType<typeof parse<typeof createSchema>>,
    step: 'create' | 'successor',
    origin: ResearchOrigin | null,
    tx: Transaction,
  ): Promise<ResearchRecord> {
    check(
      !caller.session,
      'forbidden',
      'Assigned workers cannot create an outer research cycle',
      403,
    );
    check(
      input.consolidationWorkspace === 'git' || !input.consolidationDependsOn.length,
      'invalid_research_input',
      'Consolidation prerequisites require Git consolidation',
    );
    // Validate every prerequisite in this project even if consolidation starts much later.
    for (const id of [...input.dependsOn, ...input.consolidationDependsOn])
      await this.workflows.get(caller, id, tx);
    const workflow = await this.handles.get(4)!.start(
      caller,
      {
        workflow: 'research',
        version: 4,
        requestId: this.request(caller, input.requestId, step),
        dependsOn: input.dependsOn,
        data: { name: input.name },
      },
      tx,
    );
    let predecessorId: string | null = null;
    let pinned: StoredRecord['origin'];
    if (origin) ({ researchId: predecessorId, ...pinned } = origin);
    const record: StoredRecord = {
      id: workflow.id,
      projectId: caller.projectId,
      ownerId: caller.actorId,
      name: input.name,
      createdAt: now(),
      researchDependencies: [...new Set(input.dependsOn)],
      consolidationWorkspace: input.consolidationWorkspace,
      consolidationDependencies: [...new Set(input.consolidationDependsOn)],
      ...(pinned ? { origin: pinned } : {}),
    };
    await tx.run(
      'INSERT INTO research_cycles(id,project_id,record,predecessor_id) VALUES(?,?,?,?)',
      workflow.id,
      caller.projectId,
      JSON.stringify(record),
      predecessorId,
    );
    await this.event(
      caller,
      'created',
      workflow.id,
      { dependsOn: record.researchDependencies },
      tx,
    );
    return await this.get(caller, workflow.id, tx);
  }
  private async authorize(caller: Caller, record: ResearchRecord, tx: Transaction) {
    await this.scope.require(caller, 'write', tx);
    check(
      !caller.session,
      'forbidden',
      'Assigned workers cannot advance the outer research cycle',
      403,
    );
    if (caller.actorId !== record.ownerId) await this.scope.require(caller, 'admin', tx);
  }
  private async definition(
    caller: Caller,
    tx: Transaction,
    checks: BindingChecks,
  ): Promise<PaperRevision> {
    const problem = (await this.use('paper', checks, (service) => service.read(caller, tx)))
      .documents.problem.current;
    check(
      ['problem', 'scope', 'goals', 'constraints'].every((id) =>
        problem.sections.some((section) => section.id === id && visible(section.content)),
      ),
      'research_definition_required',
      'Fill the problem, scope, goals and constraints before starting research',
      409,
    );
    return problem;
  }
  /**
   * Exactly what this cycle would hand its consolidation. Built once, so the readiness check
   * measures the thing the advance will actually create rather than an estimate of it.
   */
  private async consolidationSelection(
    caller: Caller,
    record: ResearchRecord,
    checks: BindingChecks,
    tx: Transaction,
  ): Promise<{ sourceArtifactIds: string[]; experimentIds: string[]; dependsOn: string[] }> {
    const reflection = await this.use('reflections', checks, (service) =>
      service.approved(caller, record.reflectionId!, tx),
    );
    // Live research is selected at this handoff, not asserted to be part of the earlier
    // reflection approval. Consolidation reviews it itself.
    const sources = reflection.corpus
      ? null
      : await this.use('knowledge', checks, (service) => service.researchReferences(caller, tx));
    return {
      sourceArtifactIds: [
        ...new Set([
          reflection.report.id,
          // Legacy waves approved before the 2026-09-16 ruling still pin an authored graph.
          ...(reflection.graph ? [reflection.graph.id] : []),
          reflection.changeSpec.id,
          ...reflection.lenses.map((lens) => lens.artifact.id),
          ...(sources?.artifacts ?? []),
          ...(reflection.corpus?.selection.artifacts ?? []).flatMap((entry) =>
            entry.status === 'retained' ? [entry.artifact.id] : [],
          ),
        ]),
      ],
      experimentIds:
        sources?.experiments ??
        reflection.experimentIds ??
        reflection.corpus?.selection.experiments.map((e) => e.id) ??
        [],
      dependsOn: [record.reflectionId!, ...record.consolidationDependencies],
    };
  }

  private async ready(
    caller: Caller,
    record: ResearchRecord,
    tx: Transaction,
    checks: BindingChecks = [],
    nextWave?: ResearchAdvance['nextWave'],
  ): Promise<void> {
    const stage = record.workflow.state as Stage;
    check(stage !== 'complete', 'research_complete', 'This research cycle is complete', 409);
    if (stage === 'defining') {
      await this.definition(caller, tx, checks);
      return;
    }
    if (stage === 'researching' || stage === 'reflecting')
      this.requireCapability('reflections', checks);
    // Only one wave reflects at a time; the cycle's own, just started, is not another.
    if (stage === 'researching') {
      const open = await this.use('reflections', checks, (service) => service.open(caller, tx));
      check(
        !open || open === record.reflectionId,
        'reflection_open',
        'Complete the current reflection before starting another',
        409,
      );
    }
    if (stage === 'consolidating' || (stage === 'reflecting' && this.needsConsolidation(record)))
      this.requireCapability('consolidation', checks);
    await this.workflows.checkDependencies(caller, record.id, tx);
    if (stage === 'reflecting') {
      check(
        record.reflectionId,
        'research_child_missing',
        'The reflection workflow is missing',
        409,
      );
      const reflection = await this.use('reflections', checks, (service) =>
        service.approved(caller, record.reflectionId!, tx),
      );
      if (this.needsConsolidation(record) && !reflection.corpus)
        this.requireCapability('knowledge', checks);
      // A cycle that cannot compose its consolidation must say so here. Reported ready and
      // refused on every attempt, it is a dead end with no way out and nothing to read.
      if (this.needsConsolidation(record)) {
        const selection = await this.consolidationSelection(caller, record, checks, tx);
        const limits = await this.use('consolidation', checks, async (service) => service.limits);
        for (const [field, limit] of Object.entries(limits))
          check(
            selection[field as keyof typeof selection].length <= limit,
            'consolidation_selection_too_large',
            `This cycle would hand consolidation ${selection[field as keyof typeof selection].length} ${field}, and at most ${limit} are allowed. Reduce the cycle's selection with research.replan, or finish it without consolidation.`,
            409,
          );
      }
    }
    if (stage === 'consolidating') {
      check(
        record.consolidationId,
        'research_child_missing',
        'The consolidation workflow is missing',
        409,
      );
      await this.use('consolidation', checks, (service) =>
        service.approved(caller, record.consolidationId!, tx),
      );
    }
    // A skip reads no plan, so it completes a cycle whose plan can no longer be created, or
    // whose Reflections is gone. Anything else must know whether a plan waits for an answer.
    if (nextWave !== 'skip') {
      const approved = await this.continuing(caller, record, tx, checks);
      if (approved && nextWave === 'create')
        await this.creatable(caller, approved.plan, tx, checks);
    }
    checks.forEach((check) => check());
  }

  /** The approved reflection, when this advance completes the cycle and its plan continues. */
  private async continuing(
    caller: Caller,
    record: ResearchRecord,
    tx: Transaction,
    checks: BindingChecks,
  ): Promise<Continuing | undefined> {
    const stage = record.workflow.state;
    const completing =
      stage === 'consolidating' || (stage === 'reflecting' && !this.needsConsolidation(record));
    if (!completing || !record.reflectionId) return undefined;
    const approved = await this.use('reflections', checks, (service) =>
      service.approved(caller, record.reflectionId!, tx),
    );
    return approved.plan?.next.decision === 'continue' ? (approved as Continuing) : undefined;
  }

  /**
   * Everything about the project that can refuse the plan, judged before the cycle moves. A
   * plan reported ready and refused on every attempt would leave skipping as the only way on,
   * and skipping discards the reviewed plan. Only whether a tested claim exists is left to
   * creation: Research holds no Claims.
   */
  private async creatable(
    caller: Caller,
    plan: ChangeSpec,
    tx: Transaction,
    checks: BindingChecks,
  ): Promise<void> {
    this.requireCapability('tasks', checks);
    const planned = plan.items.flatMap((item) => (item.kind === 'experiment' ? [item.name] : []));
    if (planned.length) {
      const existing = await this.use('experiments', checks, (service) => service.list(caller, tx));
      const taken = new Set(existing.map((experiment) => experiment.name.toLowerCase()));
      for (const name of planned)
        check(
          !taken.has(name.toLowerCase()),
          'experiment_name_conflict',
          `An experiment already uses the planned name ${name}. Complete this cycle with nextWave: "skip" and create the work under another name`,
          409,
        );
      const active = existing.filter(
        (experiment) => !finishedExperiment.has(experiment.workflow.state),
      ).length;
      check(
        active + planned.length <= 7,
        'experiment_limit',
        `The plan adds ${planned.length} experiments to ${active} active ones, and at most seven may be active in this project. Finish or end active experiments first, or complete this cycle with nextWave: "skip"`,
        409,
      );
    }
    // The engine refuses the starts anyway; said here, the owner reads it before trying.
    check(
      !(await this.use('reflections', checks, (service) => service.open(caller, tx))),
      'reflection_open',
      'Another reflection wave pauses task and experiment creation; finish it, or complete this cycle with nextWave: "skip"',
      409,
    );
    for (const { workflowId } of plan.carriedOver) {
      const carried = await this.workflows.get(caller, workflowId, tx);
      check(
        ['task', 'experiment'].includes(carried.workflow),
        'next_wave_inapplicable',
        `Carried-over work ${workflowId} is neither a task nor an experiment; complete this cycle with nextWave: "skip"`,
        409,
      );
      // The next cycle ends when work it waits on has died, so it would be opened already dead.
      check(
        !['failed', 'abandoned'].includes(carried.state),
        'next_wave_inapplicable',
        `Carried-over work ${workflowId} has ${carried.state} and cannot be waited on; complete this cycle with nextWave: "skip"`,
        409,
      );
    }
  }

  /**
   * Creates the approved plan's work under the advancing owner and opens the cycle that waits
   * on it. Runs inside the advance's transaction, so a refusal anywhere leaves nothing behind.
   * Every request ID derives from the advance's, so a retry names the same records.
   */
  private async materialise(
    caller: Caller,
    record: ResearchRecord,
    approved: Continuing,
    requestId: string,
    tx: Transaction,
    checks: BindingChecks,
  ): Promise<ResearchRecord> {
    const { plan } = approved;
    const created = new Map<string, string>();
    for (const item of ordered(plan.items)!) {
      // The text was written by a leased agent and is filed under the owner who accepted it;
      // this line is what lets a reader of the record trace it back to the reviewed plan.
      const provenance = `\n\nWhy: ${item.rationale}\n\nOrigin: reflection ${approved.id}, change specification ${approved.changeSpec.id} (${approved.changeSpec.hash}), item ${item.key}.`;
      const dependsOn = item.dependsOn.map((key) => created.get(key)!);
      const itemRequestId = this.request(caller, requestId, `item:${item.key}`);
      const work =
        item.kind === 'task'
          ? await this.use('tasks', checks, (service) =>
              service.create(
                caller,
                {
                  title: item.title,
                  goal: `${item.goal}${provenance}`,
                  checks: item.checks,
                  dependsOn,
                  requestId: itemRequestId,
                },
                tx,
              ),
            )
          : await this.use('experiments', checks, (service) =>
              service.create(
                caller,
                {
                  name: item.name,
                  intent: item.question,
                  details: `${item.details}${provenance}`.trimStart(),
                  testedClaimIds: item.testedClaimIds,
                  dependsOn,
                  requestId: itemRequestId,
                },
                tx,
              ),
            );
      created.set(item.key, work.id);
    }
    const carriedOver = plan.carriedOver.map((entry) => entry.workflowId);
    return await this.begin(
      caller,
      parse(createSchema, {
        name: plan.next.name,
        dependsOn: [...created.values(), ...carriedOver],
        consolidationWorkspace: record.consolidationWorkspace,
        requestId,
      }),
      'successor',
      {
        researchId: record.id,
        reflectionId: approved.id,
        reviewId: approved.reviewId,
        changeSpec: { id: approved.changeSpec.id, hash: approved.changeSpec.hash },
        items: plan.items.map((item) => ({
          key: item.key,
          kind: item.kind,
          id: created.get(item.key)!,
        })),
        carriedOver,
      },
      tx,
    );
  }

  /**
   * The owner reselects the work a cycle waits on while it is still defining or researching:
   * an experiment abandoned after selection would otherwise hold the cycle forever. The
   * cycle's own children (its reflection, its consolidation) are never part of the selection.
   */
  async replan(
    caller: Caller,
    value: ResearchReplan,
    transaction?: Transaction,
  ): Promise<ResearchRecord> {
    caller = structuredClone(caller);
    const input = parse(replanSchema, value);
    return await inTransaction(this.state, transaction, async (tx) => {
      const record = await this.get(caller, input.researchId, tx);
      await this.authorize(caller, record, tx);
      return await this.command(caller, 'replan', input, tx, async () => {
        check(
          ['defining', 'researching'].includes(record.workflow.state),
          'invalid_transition',
          'A cycle is replanned before it reflects',
          409,
        );
        const current = record.researchDependencies;
        await this.handles.get(record.workflow.version)!.addDependencies(
          caller,
          {
            instanceId: record.id,
            expectedRevision: input.expectedRevision,
            dependsOn: input.dependsOn.filter((id) => !current.includes(id)),
            drop: current.filter((id) => !input.dependsOn.includes(id)),
            requestId: this.request(caller, input.requestId, 'replan'),
          },
          tx,
        );
        return await this.get(caller, record.id, tx);
      });
    });
  }

  /**
   * End a cycle that cannot reach an answer. Its children keep their own records and their
   * own endings; what ends here is the coordination. Before version 4 a cycle had no terminal
   * state but `complete`, so one whose work could not finish stayed where it stopped for good.
   */
  async end(
    caller: Caller,
    value: ResearchEnd,
    transaction?: Transaction,
  ): Promise<ResearchRecord> {
    this.open();
    caller = structuredClone(caller);
    const input = parse(endSchema, value);
    return await inTransaction(this.state, transaction, async (tx) => {
      const record = await this.get(caller, input.researchId, tx);
      await this.authorize(caller, record, tx);
      return await this.command(caller, 'end', input, tx, async () => {
        const handle = this.handles.get(record.workflow.version);
        check(
          handle && record.workflow.version >= 4,
          'research_version_unavailable',
          'This cycle was started on a workflow version with no ending transition',
          409,
        );
        const moved = await handle!.transition(
          caller,
          {
            instanceId: record.id,
            expectedRevision: input.expectedRevision,
            action: input.outcome === 'failed' ? 'mark_failed' : 'abandon',
            input: { outcome: input.outcome, reason: input.reason },
            requestId: this.request(caller, input.requestId, 'end'),
          },
          tx,
        );
        await this.event(
          caller,
          'ended',
          record.id,
          { from: record.workflow.state, to: moved.state, reason: input.reason },
          tx,
        );
        return await this.get(caller, record.id, tx);
      });
    });
  }

  async advance(
    caller: Caller,
    value: ResearchAdvance,
    transaction?: Transaction,
  ): Promise<ResearchRecord> {
    this.open();
    caller = structuredClone(caller);
    const input = parse(advanceSchema, value);
    return await inTransaction(this.state, transaction, async (tx) => {
      const record = await this.get(caller, input.researchId, tx);
      await this.authorize(caller, record, tx);
      const checks: BindingChecks = [];
      const result = await this.command(caller, 'advance', input, tx, async () => {
        check(
          record.workflow.revision === input.expectedRevision,
          'revision_conflict',
          'The research cycle changed; read its current revision',
          409,
        );
        const handle = this.handles.get(record.workflow.version);
        check(
          handle,
          'research_version_unavailable',
          'This historical research version cannot be advanced',
          409,
        );
        await this.ready(caller, record, tx, checks, input.nextWave);
        const continuing =
          input.nextWave === 'skip' ? undefined : await this.continuing(caller, record, tx, checks);
        check(
          !continuing || input.nextWave,
          'next_wave_choice_required',
          'The approved reflection carries a plan that continues. Call research.advance with nextWave: "create" to open its tasks, experiments and the next research cycle, or nextWave: "skip" to complete this cycle without them',
          400,
        );
        const childIds: string[] = [];
        switch (record.workflow.state as Stage) {
          case 'defining':
            await tx.run(
              'UPDATE research_cycles SET problem=? WHERE id=?',
              JSON.stringify(await this.definition(caller, tx, checks)),
              record.id,
            );
            break;
          case 'researching': {
            const wave = await this.use('reflections', checks, (service) =>
              service.create(
                caller,
                {
                  title: `${clip(record.name, 288)}: reflection`,
                  requestId: this.request(caller, input.requestId, 'reflection'),
                },
                tx,
              ),
            );
            await tx.run(
              'UPDATE research_cycles SET reflection_id=? WHERE id=?',
              wave.id,
              record.id,
            );
            childIds.push(wave.id);
            break;
          }
          case 'reflecting': {
            if (!this.needsConsolidation(record)) break;
            const reflection = await this.use('reflections', checks, (service) =>
              service.approved(caller, record.reflectionId!, tx),
            );
            // Live research is selected at this handoff, not asserted to be part
            // of the earlier reflection approval. Consolidation reviews it itself.
            const selection = await this.consolidationSelection(caller, record, checks, tx);
            const work = await this.use('consolidation', checks, (service) =>
              service.create(
                caller,
                {
                  ...selection,
                  name: `${clip(record.name, 185)}: consolidation`,
                  workspace: record.consolidationWorkspace,
                  requestId: this.request(caller, input.requestId, 'consolidation'),
                },
                tx,
              ),
            );
            await tx.run(
              'UPDATE research_cycles SET consolidation_id=? WHERE id=?',
              work.id,
              record.id,
            );
            childIds.push(work.id);
            break;
          }
          case 'consolidating':
            await this.use('consolidation', checks, (service) =>
              service.approved(caller, record.consolidationId!, tx),
            );
            break;
        }
        const moved = await handle.transition(
          caller,
          {
            instanceId: record.id,
            expectedRevision: input.expectedRevision,
            action:
              record.workflow.state === 'reflecting' && !this.needsConsolidation(record)
                ? 'complete'
                : 'advance',
            // The guard inside the transition judges the same choice the preflight did.
            ...(input.nextWave ? { input: { nextWave: input.nextWave } } : {}),
            requestId: this.request(caller, input.requestId, 'advance'),
          },
          tx,
        );
        // After the move, so every guard judged the project as it was before the plan's work
        // existed: seven planned experiments would otherwise refuse themselves.
        const successor = continuing
          ? await this.materialise(caller, record, continuing, input.requestId, tx, checks)
          : undefined;
        if (childIds.length)
          await handle.addDependencies(
            caller,
            {
              instanceId: record.id,
              expectedRevision: moved.revision,
              dependsOn: childIds,
              requestId: this.request(caller, input.requestId, 'children'),
            },
            tx,
          );
        await this.event(
          caller,
          'advanced',
          record.id,
          {
            from: record.workflow.state,
            to: moved.state,
            children: childIds,
            ...(successor ? { successorId: successor.id } : {}),
            ...(moved.state === 'complete' && input.nextWave === 'skip'
              ? { nextWave: 'skipped' }
              : {}),
          },
          tx,
        );
        return await this.get(caller, record.id, tx);
      });
      checks.forEach((check) => check());
      return result;
    });
  }
  private bind<K extends keyof Capabilities>(name: K, value: Capabilities[K]): () => void {
    this.open();
    const binding = { value };
    this.bindings = { ...this.bindings, [name]: binding };
    return () => {
      if (this.bindings[name] === binding) delete this.bindings[name];
    };
  }
  bindPaper(paper: Paper): () => void {
    return this.bind('paper', paper);
  }
  bindReflections(reflections: Reflections): () => void {
    return this.bind('reflections', reflections);
  }
  bindConsolidation(consolidation: Consolidation): () => void {
    return this.bind('consolidation', consolidation);
  }
  bindTasks(tasks: Tasks): () => void {
    return this.bind('tasks', tasks);
  }
  bindExperiments(experiments: Experiments): () => void {
    return this.bind('experiments', experiments);
  }
  bindKnowledge(knowledge: Knowledge): () => void {
    this.open();
    this.releaseReadReferences?.();
    const unbind = this.bind('knowledge', knowledge);
    const binding = this.bindings.knowledge;
    try {
      const release = this.workflows.registerReadReferences({
        id: 'research',
        resolve: async (context) => {
          if (
            context.snapshot.version < 2 ||
            !['reflection', 'reflection.lens'].includes(context.snapshot.workflow)
          )
            return null;
          check(
            this.bindings.knowledge === binding,
            'knowledge_unavailable',
            unavailable.knowledge,
            409,
          );
          const sources = await this.use('knowledge', [], (service) =>
            service.researchReferences(context.caller, context.tx),
          );
          return { artifacts: sources.artifacts, researchReviews: sources.reviews };
        },
      });
      const dispose = () => {
        release();
        unbind();
        if (this.releaseReadReferences === dispose) this.releaseReadReferences = undefined;
      };
      this.releaseReadReferences = dispose;
      return dispose;
    } catch (error) {
      unbind();
      throw error;
    }
  }
  private requireCapability<K extends keyof Capabilities>(name: K, checks: BindingChecks) {
    this.open();
    checks.forEach((check) => check());
    const binding = this.bindings[name];
    check(binding, `${name}_unavailable`, unavailable[name], 409);
    checks.push(() => {
      this.open();
      check(this.bindings[name] === binding, `${name}_unavailable`, unavailable[name], 409);
    });
    return binding.value;
  }
  private async use<K extends keyof Capabilities, T>(
    name: K,
    checks: BindingChecks,
    action: (service: Capabilities[K]) => Promise<T>,
  ): Promise<T> {
    const service = this.requireCapability(name, checks);
    const result = await action(service);
    checks.forEach((check) => check());
    return result;
  }
  private needsConsolidation(record: ResearchRecord): boolean {
    return record.workflow.version < 3 || record.consolidationWorkspace === 'git';
  }
  private children(record: ResearchRecord): string[] {
    return [record.reflectionId, record.consolidationId].filter((id): id is string => !!id);
  }
  private request(caller: Caller, requestId: string, step: string) {
    return `research:${step}:${digest({ actorId: caller.actorId, requestId })}`;
  }
  private async command<T>(
    caller: Caller,
    operation: string,
    input: { requestId: string },
    tx: Transaction,
    execute: () => T | Promise<T>,
  ): Promise<T> {
    return await replayed(tx, 'research_commands', caller, operation, input, execute);
  }
  private async event(caller: Caller, type: string, id: string, data: Data, tx: Transaction) {
    await recorded(this.state, tx, caller, `research.${type}`, id, data);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.releaseReadReferences?.();
    this.bindings = {};
    for (const handle of this.handles.values()) handle.dispose();
  }
}
export const researchPlugin = {
  name: 'merv-research',
  inject: ['state', 'scope', 'workflows'],
  async apply(ctx: Context) {
    await ctx.effect(async function* () {
      const service = await createService(new ResearchService(ctx.state, ctx.scope, ctx.workflows));
      yield () => service.close();
      ctx.inject(['paper'], (ctx) => {
        ctx.effect(() => service.bindPaper(ctx.paper));
      });
      ctx.inject(['reflections'], (ctx) => {
        ctx.effect(() => service.bindReflections(ctx.reflections));
      });
      ctx.inject(['knowledge'], (ctx) => {
        ctx.effect(() => service.bindKnowledge(ctx.knowledge));
      });
      ctx.inject(['consolidation'], (ctx) => {
        ctx.effect(() => service.bindConsolidation(ctx.consolidation));
      });
      ctx.inject(['tasks'], (ctx) => {
        ctx.effect(() => service.bindTasks(ctx.tasks));
      });
      ctx.inject(['experiments'], (ctx) => {
        ctx.effect(() => service.bindExperiments(ctx.experiments));
      });
      yield ctx.provide('research', service);
    });
  },
};
export default researchPlugin;

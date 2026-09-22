import type { Code } from '@merv/code-research/types';
import {
  check,
  clip,
  createService,
  digest,
  inTransaction,
  mapAsync,
  MervError,
  now,
  ordered,
  recorded,
  replayed,
  visible,
  type Artifact,
  type Artifacts,
  type Caller,
  type CodeAcceptedSince,
  type Data,
  type DomainEvents,
  type Scope,
  type ServiceTaskCreator,
  type State,
  type Tasks,
  type Transaction,
  type WorkflowCheckContext,
  type WorkflowDefinition,
  type WorkflowPolicy,
  type Workflows,
} from '@merv/contracts';
import type { Experiments } from '@merv/experiments/types';
import type { Knowledge } from '@merv/knowledge/types';
import type { Paper, PaperRevision } from '@merv/paper/types';
import type {
  ApprovedReflection,
  ChangeSpec,
  ReflectionCreate,
  Reflections,
} from '@merv/reflections/types';
import type { Context } from 'cordis';
import {
  automaticBlocker,
  automaticRequest,
  automaticResearch,
  automaticStatus,
  recordBlocker,
  type AutomaticRow,
} from './automatic.js';
import { postgresMigrations } from './index.postgres.js';
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
import type {
  Research,
  ResearchAdvance,
  ResearchAutomation,
  ResearchCreate,
  ResearchDigest,
  ResearchEnd,
  ResearchLineage,
  ResearchOrigin,
  ResearchRecord,
  ResearchReplan,
} from './types.js';
export type * from './types.js';
const stages = ['defining', 'researching', 'reflecting', 'consolidating', 'complete'] as const;
type Stage = (typeof stages)[number];
/** What Research asks of Code; a test may bind exactly this much. */
type ResearchCode = Pick<Code, 'acceptedSince' | 'hosted' | 'publishOnAcceptance' | 'unit'>;
interface Capabilities {
  paper: Paper;
  reflections: Reflections;
  knowledge: Knowledge;
  tasks: Tasks;
  integrations: ServiceTaskCreator;
  experiments: Experiments;
  artifacts: Artifacts;
  code: ResearchCode;
}
/** An approved reflection whose plan says the project continues. */
type Continuing = ApprovedReflection & {
  plan: ChangeSpec & { next: { decision: 'continue' } };
};
/** The accepted units main does not hold, read outside the transaction that acts on them. */
type Unpublished = Pick<CodeAcceptedSince, 'unitIds' | 'quarantined'>;
/** What an advance does from where the cycle stands; see `move`. */
type Move = 'advance' | 'complete' | 'inject' | 'reinject';
type Choice = ReturnType<typeof parse<typeof nextWaveChoiceSchema>>;
type Binding<T> = { value: T };
type BindingChecks = (() => void)[];
const unavailable = {
  paper: 'This stage needs Paper; enable it to continue',
  reflections: 'This stage needs Reflections; enable it to continue',
  knowledge: 'This handoff needs live research evidence from Knowledge; enable it to continue',
  tasks:
    'Creating the approved plan\'s work needs Tasks; enable it, or complete this cycle with nextWave: "skip"',
  integrations: 'Injecting the consolidation task needs Tasks; enable it to continue',
  experiments:
    'Creating the approved plan\'s experiments needs Experiments; enable it, or complete this cycle with nextWave: "skip"',
  artifacts: "Artifacts are unavailable, so the predecessor cycle's digest cannot be retained",
  code: 'This stage needs Code; enable it to continue',
};
const nextWaveGuidance =
  'When the approved reflection carries a structured plan that continues, completing the cycle requires nextWave: "create" opens the plan\'s tasks, experiments and the next research cycle in the same transaction, and "skip" completes without them. When Code hosts the project, the cycle also waits for accepted code to reach main before the next wave starts. A text change specification creates nothing; follow-on work is then the owner\'s to create.';
const integrationGoal =
  "Integrate this cycle's accepted work onto one branch. Account for every experiment in this cycle as kept, adapted or dropped, with reasons; a drop is a reverting commit visible in the diff. Main is part of your base; the branch you deliver is what reaches main.";
const integrationChecks = [
  'Every experiment in this cycle is accounted for as kept, adapted or dropped, with a reason each.',
  'The report names what was dropped and why.',
  'The delivered branch passes the checks the project defines.',
];
/** Where text an agent wrote and an owner accepted came from, for the record that carries it. */
const origin = (approved: ApprovedReflection, ...named: string[]) =>
  `\n\nOrigin: reflection ${approved.id}, ${named.join(', ')}.`;
const pinned = (kind: string, { id, hash }: Artifact) => `${kind} ${id} (${hash})`;
/** A cycle in one of these states is over: it may be digested and it may be followed. */
const over = new Set(['complete', 'abandoned', 'failed']);
/**
 * A digest rides inside a 24000-character reflection context, behind the assignment and any
 * rework feedback. At this bound it still fits beside them instead of being omitted whole.
 */
const DIGEST_MAX_CHARS = 12000;
const DIGEST_TEXT_CHARS = 300;
const ENDING_REASON_CHARS = 2000;
const DIGEST_LIST_LIMIT = 100;
/** How far research.lineage walks back before it says the chain goes on. */
const LINEAGE_LIMIT = 20;
/** Experiments counts these states as no longer active; the plan's experiments are sized against the rest. */
const finishedExperiment = new Set(['complete', 'abandoned', 'failed']);
const instructions: Record<Stage, string> = {
  defining:
    'Complete the living paper’s problem, scope, goals and constraints, then advance to research.',
  researching:
    'Finish the selected research workflows successfully, then advance to open a reflection wave over live research.',
  reflecting: `Complete all reflection lenses and independent synthesis review, then finish the cycle or start its consolidation: accepted code that main does not hold yet is integrated by one task and published to main. ${nextWaveGuidance}`,
  consolidating: `Wait for the consolidation task to be accepted and its publication to reach main, then complete the research cycle. A publication main overtook injects a successor task. Paper changes are reviewed within the experiment and reflection workflows. ${nextWaveGuidance}`,
  complete:
    'The selected research, reflection and any required code integration are complete. Paper changes were handled by their scientific reviews. If the owner chose to create an approved plan, the next research cycle is referenced here.',
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
  digest: string | null;
  integrations: string | null;
  code_required: number | null;
}
/**
 * The immutable inputs as stored; which cycle it follows lives in predecessor_id alone. A
 * record written before version 6 also carries the consolidation choice it was opened with.
 */
type StoredRecord = Pick<
  ResearchRecord,
  'id' | 'projectId' | 'ownerId' | 'name' | 'createdAt' | 'researchDependencies'
> & { origin?: Omit<ResearchOrigin, 'researchId'> };

/** A small coordinator over existing workflows; child programs own their actual assignments. */
export class ResearchService implements Research {
  private closed = false;
  private automaticBound = false;
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
    knowledge?: Knowledge,
    tasks?: Tasks,
    experiments?: Experiments,
    artifacts?: Artifacts,
    code?: ResearchCode,
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
        {
          // What a finished cycle decided, as the metadata of one immutable artifact. It is written
          // once, possibly long after the cycle ended, so only a second write is refused.
          version: 3,
          postgres: postgresMigrations[3],
          sql: `
ALTER TABLE research_cycles ADD COLUMN digest TEXT;
CREATE TRIGGER research_digest BEFORE UPDATE OF digest ON research_cycles WHEN OLD.digest IS NOT NULL BEGIN SELECT RAISE(ABORT,'A research cycle digest is immutable'); END;
`,
        },
        {
          version: 4,
          postgres: postgresMigrations[4],
          sql: `
CREATE TABLE research_automation (
 research_id TEXT PRIMARY KEY REFERENCES research_cycles(id),project_id TEXT NOT NULL,
 source_json TEXT NOT NULL,root_id TEXT NOT NULL REFERENCES research_cycles(id),
 cycle_index INTEGER NOT NULL,max_cycles INTEGER NOT NULL,blocker_json TEXT);
CREATE TRIGGER research_automation_identity BEFORE UPDATE OF research_id,project_id,source_json,root_id,cycle_index,max_cycles ON research_automation BEGIN SELECT RAISE(ABORT,'Research automation authority is immutable'); END;
CREATE TRIGGER research_automation_retained BEFORE DELETE ON research_automation BEGIN SELECT RAISE(ABORT,'Research automation is retained'); END;
`,
        },
        {
          // The consolidation tasks a version-6 cycle injected, newest last; unlike the children it changes.
          version: 5,
          postgres: postgresMigrations[5],
          sql: 'ALTER TABLE research_cycles ADD COLUMN integrations TEXT;',
        },
        {
          version: 6,
          postgres: postgresMigrations[6],
          // NULL preserves the uncertainty of cycles created before integration was optional.
          sql: 'ALTER TABLE research_cycles ADD COLUMN code_required INTEGER CHECK(code_required IN (0,1));',
        },
      ]);
      try {
        // Existing cycles keep their immutable state machine: only new cycles may skip
        // consolidation, only version 4 on can be ended before it reaches an answer, and only
        // version 6 consolidates through an injected task it may inject again.
        for (const version of [2, 3, 4, 5, 6]) {
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
                  ...(version >= 6
                    ? [{ from: 'consolidating' as const, action: 'reinject', to: 'consolidating' }]
                    : []),
                ],
              },
              this.policy(version),
            ),
          );
        }
        if (paper) this.bindPaper(paper);
        if (reflections) this.bindReflections(reflections);
        if (knowledge) this.bindKnowledge(knowledge);
        if (tasks) this.bindTasks(tasks);
        if (experiments) this.bindExperiments(experiments);
        if (artifacts) this.bindArtifacts(artifacts);
        if (code) this.bindCode(code);
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
        const previous = record.previousCycleId
          ? await this.row(context.caller, record.previousCycleId, context.tx)
          : null;
        return {
          label: record.name,
          gate: context.snapshot.state,
          waiting:
            version >= 5 && context.snapshot.state === 'researching'
              ? 'Wait for the selected work to finish, including failed and abandoned work, then open reflection.'
              : instructions[context.snapshot.state as Stage],
          references: [
            ...this.children(record).map((id) => ({
              kind: 'workflow',
              id,
              label: 'Child workflow',
            })),
            ...(record.successorId
              ? [{ kind: 'workflow', id: record.successorId, label: 'Next research cycle' }]
              : []),
            ...(record.digest
              ? [{ kind: 'artifact', id: record.digest.id, label: 'Cycle digest' }]
              : []),
            ...(previous?.digest
              ? [
                  {
                    kind: 'artifact',
                    id: (JSON.parse(previous.digest) as Artifact).id,
                    label: 'Predecessor cycle digest',
                  },
                ]
              : []),
          ],
        };
      },
      // Legacy v4 treats selected failures as a reason to end; v5 reflects on them.
      ...(version === 4 ? { dependencyFailureAction: 'end' } : {}),
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
          transitions: [
            'advance',
            ...(version >= 3 && stage === 'reflecting' ? ['complete'] : []),
            ...(version >= 6 && stage === 'consolidating' ? ['reinject'] : []),
          ],
          tool: 'research.advance',
          instruction:
            version >= 5 && stage === 'researching'
              ? 'Reflect once all selected work has finished. Failed and abandoned work are outcomes to examine.'
              : instructions[stage],
          requiresDependencies: version < 5 && stage !== 'defining',
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
              parse(nextWaveChoiceSchema, context.input ?? {}),
            );
          },
          // Creating a plan's work is never implied by an advance: a caller that does not know
          // about the plan is asked, rather than launching work an agent wrote.
          ...(stage === 'reflecting' || stage === 'consolidating'
            ? {
                requiredInput: async ({ caller, snapshot, tx, input }: WorkflowCheckContext) => {
                  // A choice already made was judged by the check; a skip must not need Reflections.
                  const choice = parse(nextWaveChoiceSchema, input ?? {});
                  if (choice.nextWave) return [];
                  const record = await this.get(caller, snapshot.id, tx);
                  return (await this.continuing(
                    caller,
                    record,
                    tx,
                    [],
                    await this.assumed(caller, record, tx, choice),
                  ))
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
      const row = await this.row(caller, id, tx);
      const integrations: string[] = row.integrations ? JSON.parse(row.integrations) : [];
      // The selection is what the cycle waits on now, not what it was created with.
      const children = [row.reflection_id, row.consolidation_id, ...integrations];
      const { origin, ...record } = JSON.parse(row.record) as StoredRecord;
      const successor = await tx.get<{ id: string }>(
        'SELECT id FROM research_cycles WHERE predecessor_id=? AND project_id=?',
        id,
        caller.projectId,
      );
      const automatic = await tx.get<AutomaticRow>(
        'SELECT * FROM research_automation WHERE research_id=?',
        id,
      );
      return {
        ...record,
        automation: automatic
          ? {
              ...automaticStatus(automatic),
              ...(!this.automaticBound &&
              !over.has((await this.workflows.get(caller, id, tx)).state)
                ? {
                    blocker: {
                      code: 'research_automatic_unavailable',
                      message:
                        'Automatic research is waiting for its durable event consumer to be available',
                    },
                  }
                : {}),
            }
          : null,
        // The column is the one statement of which cycle this follows; the record pins the rest.
        origin: origin && row.predecessor_id ? { researchId: row.predecessor_id, ...origin } : null,
        successorId: successor?.id ?? null,
        previousCycleId: row.predecessor_id,
        digest: row.digest ? (JSON.parse(row.digest) as Artifact) : null,
        researchDependencies: (await this.workflows.dependencies(caller, id, tx)).dependencies
          .map((item) => item.id)
          .filter((item) => !children.includes(item)),
        workflow: await this.workflows.get(caller, id, tx),
        problem: row.problem ? JSON.parse(row.problem) : null,
        reflectionId: row.reflection_id,
        consolidationId: row.consolidation_id,
        integrations,
      };
    });
  }
  private async row(caller: Caller, id: string, tx: Transaction): Promise<Row> {
    const row = await tx.get<Row>(
      'SELECT * FROM research_cycles WHERE id=? AND project_id=?',
      id,
      caller.projectId,
    );
    check(row, 'research_not_found', 'Research cycle was not found in this project', 404);
    return row;
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
      const checks: BindingChecks = [];
      const result = await this.command(caller, 'create', input, tx, async () => {
        if (input.previousCycleId) await this.follow(caller, input.previousCycleId, tx, checks);
        return await this.begin(caller, input, 'create', null, tx);
      });
      checks.forEach((check) => check());
      return result;
    });
  }
  /**
   * What naming a predecessor requires: it is over, nothing follows it yet, and it has a digest.
   * A predecessor that ended before digests existed, or while a capability was unbound, is
   * digested here. Any writer may cause that, not only the predecessor's owner or an admin:
   * the digest is composed by the server from records the caller can already read, it can be
   * written once, and nothing the caller supplies reaches it. Here a missing capability is
   * refused, because the caller asked for the digest to be carried forward.
   */
  private async follow(
    caller: Caller,
    previousCycleId: string,
    tx: Transaction,
    checks: BindingChecks,
  ): Promise<void> {
    const previous = await this.get(caller, previousCycleId, tx);
    check(
      over.has(previous.workflow.state),
      'previous_cycle_open',
      'The predecessor cycle is still open; complete or end it before starting its successor',
      409,
    );
    check(
      !previous.successorId,
      'previous_cycle_followed',
      `The predecessor cycle is already followed by ${previous.successorId}; follow that cycle instead, or read the chain with research.lineage`,
      409,
    );
    await this.digested(caller, previous, tx, checks, { late: true, required: true });
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
    for (const id of input.dependsOn) await this.workflows.get(caller, id, tx);
    check(
      input.automatic || input.maxCycles === undefined,
      'invalid_research_input',
      'maxCycles requires automatic mode',
    );
    if (input.automatic) {
      check(
        input.dependsOn.length > 0,
        'research_work_required',
        'Select at least one task or experiment for automatic research',
      );
      for (const id of input.dependsOn) {
        const work = await this.workflows.get(caller, id, tx);
        check(
          ['task', 'experiment'].includes(work.workflow),
          'invalid_research_input',
          'Automatic research selects tasks and experiments',
        );
      }
    }
    const workflow = await this.handles.get(6)!.start(
      caller,
      {
        workflow: 'research',
        version: 6,
        requestId: this.request(caller, input.requestId, step),
        dependsOn: input.dependsOn,
        data: { name: input.name },
      },
      tx,
    );
    let predecessorId = input.previousCycleId ?? null;
    let from: StoredRecord['origin'];
    if (origin) ({ researchId: predecessorId, ...from } = origin);
    const record: StoredRecord = {
      id: workflow.id,
      projectId: caller.projectId,
      ownerId: caller.actorId,
      name: input.name,
      createdAt: now(),
      researchDependencies: [...new Set(input.dependsOn)],
      ...(from ? { origin: from } : {}),
    };
    await tx.run(
      'INSERT INTO research_cycles(id,project_id,record,predecessor_id,code_required) VALUES(?,?,?,?,?)',
      workflow.id,
      caller.projectId,
      JSON.stringify(record),
      predecessorId,
      (await this.selectedCode(caller, input.dependsOn, tx)) ||
        (this.bindings.code
          ? await this.use('code', [], (code) => code.hosted(caller, tx))
          : await this.retainedCode(caller, tx))
        ? 1
        : 0,
    );
    const inherited = origin
      ? await tx.get<AutomaticRow>(
          'SELECT * FROM research_automation WHERE research_id=?',
          origin.researchId,
        )
      : undefined;
    if (input.automatic || inherited) {
      const source =
        inherited?.source_json ?? JSON.stringify(await this.scope.delegationSource(caller, tx));
      await tx.run(
        'INSERT INTO research_automation(research_id,project_id,source_json,root_id,cycle_index,max_cycles) VALUES(?,?,?,?,?,?)',
        workflow.id,
        caller.projectId,
        source,
        inherited?.root_id ?? workflow.id,
        inherited ? inherited.cycle_index + 1 : 1,
        inherited?.max_cycles ?? input.maxCycles ?? 10,
      );
    }
    await this.event(
      caller,
      'created',
      workflow.id,
      {
        dependsOn: record.researchDependencies,
        ...(input.previousCycleId ? { previousCycleId: input.previousCycleId } : {}),
      },
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
   * Refuses what the stage cannot pass and answers with the move the advance makes. `since` is
   * what main lacks, which only an advance has asked; the guard reads the move it chose instead.
   */
  private async ready(
    caller: Caller,
    record: ResearchRecord,
    tx: Transaction,
    checks: BindingChecks = [],
    choice: Choice = {},
    since?: Unpublished | null,
  ): Promise<Move> {
    const stage = record.workflow.state as Stage;
    check(stage !== 'complete', 'research_complete', 'This research cycle is complete', 409);
    if (stage === 'defining') {
      await this.definition(caller, tx, checks);
      return 'advance';
    }
    if (stage === 'researching' || stage === 'reflecting')
      this.requireCapability('reflections', checks);
    if (
      record.workflow.version >= 6 &&
      (stage === 'reflecting' || stage === 'consolidating') &&
      ((await this.row(caller, record.id, tx)).code_required !== 0 || record.integrations.length)
    )
      this.requireCapability('code', checks);
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
    check(
      !(
        record.workflow.version < 6 &&
        (stage === 'consolidating' ||
          (stage === 'reflecting' && this.usesRetiredConsolidation(record)))
      ),
      'research_consolidation_retired',
      'This cycle uses the retired Consolidation workflow. Its records are retained; start a new research cycle to consolidate through a task.',
      409,
    );
    if (record.workflow.version < 5) {
      await this.workflows.checkDependencies(caller, record.id, tx);
    } else if (stage === 'researching') {
      const selection = new Set(record.researchDependencies);
      const pending = (
        await this.workflows.dependencies(caller, record.id, tx)
      ).dependencies.filter((item) => selection.has(item.id) && !item.settled && !item.failed);
      check(
        !pending.length,
        'dependencies_pending',
        `Waiting for research outcomes: ${pending.map((item) => `${item.name} (${item.state})`).join(', ')}`,
        409,
      );
    }
    if (stage === 'reflecting') {
      check(
        record.reflectionId,
        'research_child_missing',
        'The reflection workflow is missing',
        409,
      );
      await this.use('reflections', checks, (service) =>
        service.approved(caller, record.reflectionId!, tx),
      );
    }
    const move = await this.move(caller, record, tx, checks, since, choice);
    // A skip reads no plan, so it completes a cycle whose plan can no longer be created, or
    // whose Reflections is gone. Anything else must know whether a plan waits for an answer.
    if (choice.nextWave !== 'skip') {
      const approved = await this.continuing(caller, record, tx, checks, move);
      if (approved && choice.nextWave === 'create') {
        this.checkAutomaticContinuation(caller, record);
        await this.creatable(caller, approved.plan, tx, checks, record.workflow.version >= 5);
      }
    }
    checks.forEach((check) => check());
    return move;
  }

  /**
   * The transition an advance makes; `inject` and `reinject` first inject a consolidation task.
   * A version-6 cycle consolidates through that task: an unfinished one, one that ended without
   * acceptance and one not on main yet are refused here, so a preflight reports the same wait.
   * Whether main lacks accepted code is Git's answer: an advance reads it as `since` and hands
   * the guard the move it chose; a preflight has neither and reads the move main lacking makes.
   */
  private async move(
    caller: Caller,
    record: ResearchRecord,
    tx: Transaction,
    checks: BindingChecks,
    since: Unpublished | null | undefined,
    choice: Choice,
  ): Promise<Move> {
    const stage = record.workflow.state as Stage;
    if (stage !== 'reflecting' && stage !== 'consolidating') return 'advance';
    if (record.workflow.version < 6)
      return stage === 'reflecting' && !this.usesRetiredConsolidation(record)
        ? 'complete'
        : 'advance';
    // A preflight that answers the completion question is read as completing, so a plan that
    // would refuse is reported before the advance, as it always was.
    const judged = (holds: Move, lacks: Move): Move => {
      if (since !== undefined) {
        this.asked(since);
        return since.unitIds.length ? lacks : holds;
      }
      return (choice.move ?? (choice.nextWave ? holds : lacks)) === holds ? holds : lacks;
    };
    if (stage === 'reflecting') return judged('complete', 'inject');
    const taskId = record.integrations.at(-1)!;
    const task = (await this.workflows.dependencies(caller, record.id, tx)).dependencies.find(
      (item) => item.id === taskId,
    )!;
    if (task.failed) {
      check(
        choice.retryIntegration,
        'integration_failed',
        `The consolidation task ${taskId} ended ${task.state}. Retry with research.advance { retryIntegration: true } to inject a fresh task, or end the cycle with research.end.`,
        409,
      );
      return judged('advance', 'reinject');
    }
    check(
      task.settled,
      'dependencies_pending',
      `Waiting for the consolidation task: ${task.name} (${task.state})`,
      409,
    );
    const { publication } = await this.use('code', checks, (code) => code.unit(caller, taskId, tx));
    if (publication?.state === 'published') return 'advance';
    // Main moved first, or the task ended without acceptance: what main lacks now decides
    // between a successor task and completing, as it did at reflection.
    if (publication?.state === 'stale') return judged('advance', 'reinject');
    const pull = publication?.pull ? ` ${publication.pull.url}` : '';
    throw new MervError(
      'publication_pending',
      publication?.state === 'pending'
        ? `The consolidation task ${taskId} is accepted; a signed-in operator merges its pull request${pull} before the cycle completes`
        : `The consolidation task ${taskId} is accepted, but its publication is ${publication?.state ?? 'not open'}; a signed-in operator clears or investigates it${pull} before the cycle completes`,
      409,
    );
  }

  /**
   * The move a preflight reads for the choice it asks. A version-6 cycle is read as completing:
   * without Git's answer the choice is asked whenever the plan continues, and honoured only when
   * the cycle does complete.
   */
  private async assumed(
    caller: Caller,
    record: ResearchRecord,
    tx: Transaction,
    choice: Choice,
  ): Promise<Move> {
    return record.workflow.version >= 6
      ? 'complete'
      : await this.move(caller, record, tx, [], undefined, choice);
  }

  /** Git answers what main lacks outside every transaction; null says it could not be asked. */
  private asked(since: Unpublished | null): asserts since is Unpublished {
    check(
      since !== null,
      'integration_candidates_unavailable',
      'What main lacks is asked of Git outside a transaction; this advance runs again on its own',
      409,
    );
  }

  /** The approved reflection, when this advance completes the cycle and its plan continues. */
  private async continuing(
    caller: Caller,
    record: ResearchRecord,
    tx: Transaction,
    checks: BindingChecks,
    move: Move,
  ): Promise<Continuing | undefined> {
    const completing =
      move === 'complete' || (record.workflow.state === 'consolidating' && move === 'advance');
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
   *
   * A workspace declaration is also admitted by the item's owner at creation, not pre-checked
   * here: a refusal while Code is unloaded rolls the whole advance back and leaves the
   * approved plan to retry.
   */
  private async creatable(
    caller: Caller,
    plan: ChangeSpec,
    tx: Transaction,
    checks: BindingChecks,
    acceptsFailures = false,
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
        acceptsFailures || !['failed', 'abandoned'].includes(carried.state),
        'next_wave_inapplicable',
        `Carried-over work ${workflowId} has ${carried.state} and cannot be waited on; complete this cycle with nextWave: "skip"`,
        409,
      );
    }
  }

  private checkAutomaticContinuation(caller: Caller, record: ResearchRecord) {
    if (record.automation) {
      check(
        caller.actorId === record.ownerId,
        'automatic_owner_required',
        'Only the authorizing owner creates an automatic successor',
        403,
      );
      check(
        record.automation.cycle < record.automation.maxCycles,
        'research_cycle_limit',
        'The automatic research run has reached its cycle limit; complete with nextWave: skip',
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
    this.checkAutomaticContinuation(caller, record);
    const created = new Map<string, string>();
    for (const item of ordered<ChangeSpec['items'][number]>(plan.items)!) {
      // The text was written by a leased agent and is filed under the owner who accepted it;
      // this line is what lets a reader of the record trace it back to the reviewed plan.
      const provenance = `\n\nWhy: ${item.rationale}${origin(approved, pinned('change specification', approved.changeSpec), `item ${item.key}`)}`;
      const dependsOn = item.dependsOn.map((key) => created.get(key)!);
      const itemRequestId = this.request(caller, requestId, `item:${item.key}`);
      // Retained v1 plans never requested a workspace; only an explicit declaration does.
      const workspace = item.workspace?.provider === 'code' ? ('git' as const) : undefined;
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
                  ...(workspace ? { workspace } : {}),
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
                  dependsOn,
                  ...(workspace ? { workspace } : {}),
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
   * One ordinary Git task that integrates the accepted units main lacks and publishes the
   * result: it stands on them, so its base holds them and main, and its acceptance seals the
   * publication. The advance records it after the move, so the guard judges the task before it.
   */
  private async inject(
    caller: Caller,
    record: ResearchRecord,
    units: Unpublished,
    requestId: string,
    tx: Transaction,
    checks: BindingChecks,
  ): Promise<string> {
    const approved = await this.use('reflections', checks, (service) =>
      service.approved(caller, record.reflectionId!, tx),
    );
    const count = record.integrations.length + 1;
    const step = count === 1 ? 'integration' : `integration:${count}`;
    const task = await this.use('integrations', checks, (service) =>
      service.create(
        {
          projectId: caller.projectId,
          requestId: this.request(caller, requestId, step),
          title: `${clip(record.name, 180)}: consolidation`,
          goal: `${integrationGoal}${origin(approved, pinned('report', approved.report), pinned('change specification', approved.changeSpec))}`,
          checks: integrationChecks,
          dependsOn: units.unitIds,
        },
        tx,
      ),
    );
    await this.use('code', checks, (code) =>
      code.publishOnAcceptance(caller, { unitId: task.id }, tx),
    );
    return task.id;
  }

  /** Workspace declarations survive provider unload; older experiments ask their owner. */
  private async selectedCode(
    caller: Caller,
    ids: string[] | undefined,
    tx: Transaction,
  ): Promise<boolean> {
    const selected = new Set(ids);
    for (const id of ids ?? [])
      for (const dependency of await this.workflows.dependencyClosure(caller, id, tx))
        selected.add(dependency);
    const work =
      ids === undefined
        ? await this.workflows.list(caller, tx)
        : await Promise.all([...selected].map((id) => this.workflows.get(caller, id, tx)));
    for (const item of work) {
      if (item.data.workspace === 'git') return true;
      if (item.workflow === 'experiment' && item.data.workspace === undefined) {
        const experiment = await this.use('experiments', [], (owner) =>
          owner.get(caller, item.id, tx),
        );
        if (experiment.workspace === 'git') return true;
      }
    }
    return false;
  }

  /** Integration considers the whole project; provider absence cannot erase earlier Git work. */
  private async retainedCode(caller: Caller, tx: Transaction): Promise<boolean> {
    return (
      !!(await tx.get(
        'SELECT id FROM research_cycles WHERE project_id=? AND (code_required=1 OR code_required IS NULL) LIMIT 1',
        caller.projectId,
      )) || (await this.selectedCode(caller, undefined, tx))
    );
  }

  /**
   * Absence is safe only for a cycle known to have no Git obligations. Remember observing a
   * hosted project even when a later advance fails: unloading its provider cannot erase that
   * obligation. Git itself is still read outside the transaction that advances the cycle.
   */
  private async unpublished(
    caller: Caller,
    researchId: string,
    tx?: Transaction,
  ): Promise<Unpublished | null> {
    const binding = this.bindings.code;
    const checks: BindingChecks = [];
    const asks = await inTransaction(this.state, tx, async (tx) => {
      const record = await this.get(caller, researchId, tx);
      if (
        record.workflow.version < 6 ||
        !['reflecting', 'consolidating'].includes(record.workflow.state)
      )
        return false;
      await this.authorize(caller, record, tx);
      const row = await this.row(caller, researchId, tx);
      const hosted = binding
        ? await this.use('code', checks, (code) => code.hosted(caller, tx))
        : false;
      const required =
        row.code_required === 1 ||
        !!record.integrations.length ||
        hosted ||
        (await this.selectedCode(caller, record.researchDependencies, tx)) ||
        (!binding && (await this.retainedCode(caller, tx)));
      if (required || (binding && row.code_required === null))
        await tx.run(
          'UPDATE research_cycles SET code_required=? WHERE id=?',
          required ? 1 : 0,
          researchId,
        );
      checks.forEach((check) => check());
      return hosted;
    });
    if (!asks) return { unitIds: [], quarantined: [] };
    return tx ? null : await this.use('code', checks, (code) => code.acceptedSince(caller));
  }

  /**
   * The cycle's digest, composed and stored if it has none. Completing and ending a cycle must
   * never wait on it, so there a missing capability leaves the column empty and whoever names
   * the cycle as a predecessor composes it late; `required` refuses instead.
   *
   * Two creators naming one undigested predecessor may both compose. The guarded update keeps
   * one: SQLite serialises the writers, Postgres makes the second wait and then match no row
   * or fail its transaction. Either way the stored digest is re-read and returned, and the
   * loser's artifact stays unreferenced.
   */
  private async digested(
    caller: Caller,
    record: ResearchRecord,
    tx: Transaction,
    checks: BindingChecks,
    options: { late: boolean; required: boolean },
  ): Promise<Artifact | null> {
    if (record.digest) return record.digest;
    const needed: (keyof Capabilities)[] = [
      'artifacts',
      'knowledge',
      ...(record.reflectionId ? (['reflections'] as const) : []),
      ...(record.integrations.length ? (['code'] as const) : []),
    ];
    if (!options.required && needed.some((name) => !this.bindings[name])) return null;
    const content = JSON.stringify(await this.compose(caller, record, tx, checks, options.late));
    const artifact = await this.use('artifacts', checks, (service) =>
      service.create(
        caller,
        {
          title: `Cycle digest: ${clip(record.name, 180)}`,
          content,
          mediaType: 'application/json',
        },
        tx,
      ),
    );
    await tx.run(
      'UPDATE research_cycles SET digest=? WHERE id=? AND digest IS NULL',
      JSON.stringify(artifact),
      record.id,
    );
    const stored = JSON.parse((await this.row(caller, record.id, tx)).digest!) as Artifact;
    if (stored.id === artifact.id)
      await this.event(
        caller,
        'digested',
        record.id,
        { artifactId: artifact.id, late: options.late },
        tx,
      );
    return stored;
  }

  /** Derived from records only, and naming no actor: see ResearchDigest. */
  private async compose(
    caller: Caller,
    record: ResearchRecord,
    tx: Transaction,
    checks: BindingChecks,
    late: boolean,
  ): Promise<ResearchDigest> {
    const text = (value: string) => clip(value, DIGEST_TEXT_CHARS);
    const ref = ({ id, title, hash }: Artifact) => ({ id, title: text(title), hash });
    const records = await this.use('knowledge', checks, (service) => service.records(caller, tx));
    const children = this.children(record);
    const selected = (await this.workflows.dependencies(caller, record.id, tx)).dependencies.filter(
      (item) => !children.includes(item.id),
    );
    // A cycle ended while reflecting has a child with nothing approved in it.
    const reflection = record.reflectionId
      ? await this.use('reflections', checks, async (service) =>
          (await service.get(caller, record.reflectionId!, tx)).workflow.state === 'approved'
            ? await service.approved(caller, record.reflectionId!, tx)
            : null,
        )
      : null;
    const taskId = record.integrations.at(-1);
    const integration = taskId
      ? {
          taskId,
          publication:
            (await this.use('code', checks, (code) => code.unit(caller, taskId, tx))).publication
              ?.state ?? null,
        }
      : null;
    const experimentIds = new Set([
      ...selected.filter((item) => item.workflow === 'experiment').map((item) => item.id),
      ...(reflection?.experimentIds ?? []),
    ]);
    const experiments = records.experiments.filter((entry) => experimentIds.has(entry.id));
    const taskIds = new Set(
      selected.filter((item) => item.workflow === 'task').map((item) => item.id),
    );
    const lists = {
      experiments: experiments.map((entry) => ({
        id: entry.id,
        name: text(entry.name),
        state: entry.workflow.state,
        attempts: entry.attempts.length,
        submissions: entry.submissions.length,
        conclusion: entry.conclusion === null ? null : text(entry.conclusion),
      })),
      tasks: records.tasks
        .filter((task) => taskIds.has(task.id))
        .map((task) => ({ id: task.id, title: text(task.title), state: task.workflow.state })),
      dropped: selected.filter((item) => item.failed).map((item) => item.id),
      carriedOver: selected.filter((item) => !item.settled).map((item) => item.id),
      rejected: (reflection?.plan?.rejected ?? []).map((entry) => ({
        title: text(entry.title),
        reason: text(entry.reason),
      })),
    };
    const composedAt = now();
    let omitted = 0;
    for (const list of Object.values(lists)) omitted += list.splice(DIGEST_LIST_LIMIT).length;
    const reason = record.workflow.data.reason;
    const composed = (): ResearchDigest => ({
      formatVersion: 1,
      cycle: {
        id: record.id,
        name: text(record.name),
        outcome: record.workflow.state as ResearchDigest['cycle']['outcome'],
        reason: typeof reason === 'string' ? text(reason) : null,
        createdAt: record.createdAt,
        composedAt,
        late,
      },
      previousCycleId: record.previousCycleId,
      reflection: reflection && {
        id: reflection.id,
        reviewId: reflection.reviewId,
        approvedAt: reflection.approvedAt,
        report: ref(reflection.report),
        changeSpec: ref(reflection.changeSpec),
        // The decision is the one line of the plan every later wave needs; the items that
        // became work are records, which the successor's origin names.
        next: reflection.plan
          ? {
              decision: reflection.plan.next.decision,
              reason: reflection.plan.next.decision === 'stop' ? reflection.plan.next.reason : null,
              rationale: text(reflection.plan.next.rationale),
            }
          : null,
      },
      integration,
      ...lists,
      omitted,
    });
    // The bound is a promise to every later context, so entries go, longest list first, until
    // it holds; what is left out is counted, and the records themselves remain readable.
    let digest = composed();
    while (JSON.stringify(digest).length > DIGEST_MAX_CHARS) {
      const longest = Object.values(lists).reduce((a, b) => (b.length > a.length ? b : a));
      if (!longest.length) break;
      longest.pop();
      omitted++;
      digest = composed();
    }
    return digest;
  }

  async lineage(caller: Caller, id: string, transaction?: Transaction): Promise<ResearchLineage> {
    this.open();
    caller = structuredClone(caller);
    return await inTransaction(this.state, transaction, async (tx) => {
      const asked = await this.get(caller, id, tx);
      const cycles = [asked];
      while (cycles[0].previousCycleId && cycles.length < LINEAGE_LIMIT)
        cycles.unshift(await this.get(caller, cycles[0].previousCycleId, tx));
      const successor = asked.successorId ? await this.get(caller, asked.successorId, tx) : null;
      return {
        researchId: id,
        cycles: cycles.map((cycle) => ({
          id: cycle.id,
          name: cycle.name,
          state: cycle.workflow.state,
          createdAt: cycle.createdAt,
          previousCycleId: cycle.previousCycleId,
          reflectionId: cycle.reflectionId,
          consolidationId: cycle.consolidationId,
          digest: cycle.digest,
        })),
        truncated: !!cycles[0].previousCycleId,
        successor: successor && {
          id: successor.id,
          name: successor.name,
          state: successor.workflow.state,
        },
      };
    });
  }

  /**
   * The owner reselects the work a cycle waits on while it is still defining or researching:
   * legacy cycles may need to remove unsuccessful prerequisites; v5 retains them as outcomes. The
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
        if (await this.selectedCode(caller, input.dependsOn, tx))
          await tx.run('UPDATE research_cycles SET code_required=1 WHERE id=?', record.id);
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
      const checks: BindingChecks = [];
      const result = await this.command(caller, 'end', input, tx, async () => {
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
            // Kept on the cycle, clipped, so a digest composed later can still say why it ended.
            data: { reason: clip(input.reason, ENDING_REASON_CHARS) },
            requestId: this.request(caller, input.requestId, 'end'),
          },
          tx,
        );
        await tx.run(
          'UPDATE research_automation SET blocker_json=NULL WHERE research_id=?',
          record.id,
        );
        await this.event(
          caller,
          'ended',
          record.id,
          { from: record.workflow.state, to: moved.state, reason: input.reason },
          tx,
        );
        await this.digested(caller, await this.get(caller, record.id, tx), tx, checks, {
          late: false,
          required: false,
        });
        return await this.get(caller, record.id, tx);
      });
      checks.forEach((check) => check());
      return result;
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
    // Git answers what main lacks outside every transaction, so it is asked before this opens.
    const since = await this.unpublished(caller, input.researchId, transaction);
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
        const move = await this.ready(caller, record, tx, checks, input, since);
        const injecting = move === 'inject' || move === 'reinject';
        const continuing =
          input.nextWave === 'skip'
            ? undefined
            : await this.continuing(caller, record, tx, checks, move);
        check(
          !continuing || input.nextWave,
          'next_wave_choice_required',
          'The approved reflection carries a plan that continues. Call research.advance with nextWave: "create" to open its tasks, experiments and the next research cycle, or nextWave: "skip" to complete this cycle without them',
          400,
        );
        const childIds: string[] = [];
        if (injecting)
          childIds.push(await this.inject(caller, record, since!, input.requestId, tx, checks));
        switch (record.workflow.state as Stage) {
          case 'defining':
            await tx.run(
              'UPDATE research_cycles SET problem=? WHERE id=?',
              JSON.stringify(await this.definition(caller, tx, checks)),
              record.id,
            );
            break;
          case 'researching': {
            // A predecessor a plan opened this cycle from may have no digest yet; without the
            // capabilities to compose one the wave simply starts without it.
            const carried = record.previousCycleId
              ? await this.digested(
                  caller,
                  await this.get(caller, record.previousCycleId, tx),
                  tx,
                  checks,
                  { late: true, required: false },
                )
              : null;
            const wave = await this.use('reflections', checks, (service) =>
              service.create(
                caller,
                {
                  title: `${clip(record.name, 288)}: reflection`,
                  ...(record.automation ? { requirePlan: true } : {}),
                  // Absent rather than null, so a cycle that follows nothing replays as before.
                  ...(carried ? { previousCycleDigestId: carried.id } : {}),
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
        }
        // The guard inside the transition judges the same choices the preflight did, and the
        // move Git's answer decided, which it cannot ask for itself.
        const choice: Choice = {
          ...(input.nextWave ? { nextWave: input.nextWave } : {}),
          ...(input.retryIntegration ? { retryIntegration: true } : {}),
          ...(record.workflow.version >= 6 ? { move } : {}),
        };
        const moved = await handle.transition(
          caller,
          {
            instanceId: record.id,
            expectedRevision: input.expectedRevision,
            action: move === 'inject' ? 'advance' : move,
            ...(Object.keys(choice).length ? { input: choice } : {}),
            requestId: this.request(caller, input.requestId, 'advance'),
          },
          tx,
        );
        // After the move, so every guard judged the project as it was before the plan's work
        // existed: seven planned experiments would otherwise refuse themselves.
        const successor = continuing
          ? await this.materialise(caller, record, continuing, input.requestId, tx, checks)
          : undefined;
        if (injecting)
          await tx.run(
            'UPDATE research_cycles SET integrations=? WHERE id=?',
            JSON.stringify([...record.integrations, ...childIds]),
            record.id,
          );
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
        await tx.run(
          'UPDATE research_automation SET blocker_json=NULL WHERE research_id=?',
          record.id,
        );
        await this.event(
          caller,
          'advanced',
          record.id,
          {
            from: record.workflow.state,
            to: moved.state,
            children: childIds,
            // Quarantined acceptances are unpublished code the task may not build on.
            ...(injecting && since?.quarantined.length ? { quarantined: since.quarantined } : {}),
            ...(successor ? { successorId: successor.id } : {}),
            ...(moved.state === 'complete' && input.nextWave === 'skip'
              ? { nextWave: 'skipped' }
              : {}),
          },
          tx,
        );
        if (moved.state === 'complete')
          await this.digested(caller, await this.get(caller, record.id, tx), tx, checks, {
            late: false,
            required: false,
          });
        return await this.get(caller, record.id, tx);
      });
      checks.forEach((check) => check());
      return result;
    });
  }
  /** Subscribe through the existing engine's durable events; workers keep their fixed grants. */
  async bindAutomatic(events: DomainEvents): Promise<() => Promise<void>> {
    this.open();
    const release = await automaticResearch(
      this.state,
      this.scope,
      events,
      async (caller, row, tx) => await this.reconcileAutomatic(caller, row, tx),
    );
    this.automaticBound = true;
    try {
      await this.wakeAutomatic();
    } catch (error) {
      this.automaticBound = false;
      await release();
      throw error;
    }
    return async () => {
      this.automaticBound = false;
      await release();
    };
  }

  /** Startup and provider restoration must also revisit events previously consumed while blocked. */
  async wakeAutomatic(): Promise<void> {
    if (!this.automaticBound || this.closed) return;
    await this.state.transaction(async (tx) => {
      const rows = await tx.all<{ project_id: string; source_json: string; research_id: string }>(
        "SELECT a.project_id,a.source_json,a.research_id FROM research_automation a JOIN wf_instances w ON w.id=a.research_id WHERE w.state NOT IN ('complete','abandoned','failed')",
      );
      const projects = new Set<string>();
      for (const row of rows) {
        if (projects.has(row.project_id)) continue;
        projects.add(row.project_id);
        await this.state.appendEvent(tx, {
          projectId: row.project_id,
          actorId: JSON.parse(row.source_json).actorId,
          type: 'research.resume',
          subjectId: row.research_id,
          data: { performedBy: 'system:research' },
        });
      }
    });
  }

  private async reconcileAutomatic(
    caller: Caller,
    automatic: AutomaticRow,
    tx: Transaction,
  ): Promise<ResearchAutomation['blocker']> {
    this.open();
    const record = await this.get(caller, automatic.research_id, tx);
    await this.authorize(caller, record, tx);
    if (over.has(record.workflow.state)) return null;
    if (record.workflow.state === 'defining' && record.previousCycleId) {
      const previous = await this.get(caller, record.previousCycleId, tx);
      const current = await this.definition(caller, tx, []);
      check(
        !previous.problem || current.revision === previous.problem.revision,
        'research_definition_changed',
        'The project definition changed; explicitly accept it before continuing this automatic run',
        409,
      );
    }
    if (record.workflow.state === 'researching') await this.closeBlockedWork(caller, record, tx);
    const atLimit = automatic.cycle_index >= automatic.max_cycles;
    const nextWave = atLimit ? 'skip' : 'create';
    const guidance = await this.workflows.evaluate(
      caller,
      record.id,
      {
        action: `advance_${record.workflow.state}`,
        input: { nextWave },
      },
      tx,
    );
    const action = guidance.nextAction;
    if (!action || action.status !== 'ready') {
      const blocker = guidance.blockers[0] ?? guidance.actions.flatMap((item) => item.blockers)[0];
      return blocker
        ? { code: blocker.code, message: clip(blocker.message, 2000) }
        : { code: 'research_waiting', message: guidance.instruction };
    }
    const stoppedByLimit =
      atLimit &&
      !!(await this.continuing(caller, record, tx, [], await this.assumed(caller, record, tx, {})));
    const input: ResearchAdvance = {
      researchId: record.id,
      expectedRevision: record.workflow.revision,
      nextWave,
      requestId: automaticRequest(record.id, record.workflow.revision, 'advance'),
    };
    let advanced: ResearchRecord;
    try {
      advanced = await this.advance(caller, input, tx);
    } catch (error) {
      // Git is asked outside every transaction, so the same advance runs again on its own.
      if (error instanceof MervError && error.code === 'integration_candidates_unavailable')
        this.soon(caller, automatic, input, automaticBlocker(error));
      throw error;
    }
    await this.event(
      caller,
      'automatically_advanced',
      record.id,
      {
        performedBy: 'system:research',
        from: record.workflow.state,
        to: advanced.workflow.state,
        ...(advanced.successorId ? { successorId: advanced.successorId } : {}),
      },
      tx,
    );
    return stoppedByLimit && advanced.workflow.state === 'complete'
      ? {
          code: 'research_cycle_limit',
          message: `Finished the authorized ${automatic.max_cycles} research cycles; no further wave was created`,
        }
      : null;
  }

  /**
   * The advance the consumer could not make, run on its own once its transaction has committed,
   * outside every transaction's context. Success is a transition event the consumer answers; a
   * refusal is written only over the marker the consumer left, so a reconcile since is never
   * overwritten and nothing loops: the marker returns on the next event, today's retry cadence.
   */
  private soon(
    caller: Caller,
    row: AutomaticRow,
    input: ResearchAdvance,
    marker: ResearchAutomation['blocker'],
  ): void {
    if (this.closed) return;
    const run = async () => {
      try {
        await this.advance(caller, input);
      } catch (error) {
        if (
          this.closed ||
          !(error instanceof MervError) ||
          (error.status >= 500 && error.status !== 503)
        )
          return;
        const left = JSON.stringify(marker);
        await this.state.transaction((tx) =>
          recordBlocker(this.state, tx, { ...row, blocker_json: left }, automaticBlocker(error), {
            onlyOver: left,
          }),
        );
      }
    };
    const release = this.state.onEventsCommitted(() => {
      release();
      void run().catch(() => undefined);
    });
  }

  /** A permanently failed input cannot strand never-started work in this selected wave. */
  private async closeBlockedWork(caller: Caller, record: ResearchRecord, tx: Transaction) {
    const remaining = new Set(record.researchDependencies);
    for (let pass = 0; remaining.size && pass < record.researchDependencies.length; pass++) {
      let changed = false;
      for (const id of [...remaining]) {
        const work = await this.workflows.get(caller, id, tx);
        if (
          !['task', 'experiment'].includes(work.workflow) ||
          !['in_progress', 'planned'].includes(work.state)
        ) {
          remaining.delete(id);
          continue;
        }
        // Never cancel a running producer or review to close a wave.
        if ((await this.workflows.workStarts(caller, id, tx)).length) {
          remaining.delete(id);
          continue;
        }
        const failed = (await this.workflows.dependencies(caller, id, tx)).dependencies.filter(
          (item) => item.failed,
        );
        if (!failed.length) continue;
        const reason = clip(
          `Not run: required input ended without success: ${failed.map((item) => `${item.name} (${item.id}, ${item.state})`).join(', ')}. Retained for reflection in ${record.name}.`,
          16000,
        );
        const requestId = automaticRequest(record.id, work.revision, `close:${id}`);
        if (work.workflow === 'task') {
          await this.use('tasks', [], (service) =>
            service.markFailed(
              caller,
              {
                taskId: id,
                expectedRevision: work.revision,
                reason,
                requestId,
              },
              tx,
            ),
          );
        } else {
          await this.use('experiments', [], (service) =>
            service.transition(
              caller,
              {
                experimentId: id,
                expectedRevision: work.revision,
                transition: 'abandon',
                evidence: { reason },
                requestId,
              },
              tx,
            ),
          );
        }
        await this.event(
          caller,
          'blocked_work_closed',
          record.id,
          {
            performedBy: 'system:research',
            workflowId: id,
            failedInputs: failed.map((item) => item.id),
            reason,
          },
          tx,
        );
        remaining.delete(id);
        changed = true;
      }
      if (!changed) break;
    }
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
  bindTasks(tasks: Tasks): () => void {
    const releases = [
      this.bind('tasks', tasks),
      this.bind('integrations', tasks.serviceTasks('research')),
    ];
    return () => releases.forEach((release) => release());
  }
  bindCode(code: ResearchCode): () => void {
    return this.bind('code', code);
  }
  bindExperiments(experiments: Experiments): () => void {
    return this.bind('experiments', experiments);
  }
  bindArtifacts(artifacts: Artifacts): () => void {
    return this.bind('artifacts', artifacts);
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
  /** Only retained cycles can refer to the retired dedicated workflow. */
  private usesRetiredConsolidation(record: ResearchRecord): boolean {
    const { version } = record.workflow;
    return version < 3 || (version < 6 && record.consolidationWorkspace === 'git');
  }
  private children(record: ResearchRecord): string[] {
    return [record.reflectionId, record.consolidationId, ...record.integrations].filter(
      (id): id is string => !!id,
    );
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
      ctx.inject(['domainEvents'], (ctx) => {
        ctx.effect(async () => await service.bindAutomatic(ctx.domainEvents));
      });
      ctx.inject(['paper'], (ctx) => {
        ctx.effect(async function* () {
          yield service.bindPaper(ctx.paper);
          await service.wakeAutomatic();
        });
      });
      ctx.inject(['reflections'], (ctx) => {
        ctx.effect(async function* () {
          yield service.bindReflections(ctx.reflections);
          await service.wakeAutomatic();
        });
      });
      ctx.inject(['knowledge'], (ctx) => {
        ctx.effect(async function* () {
          yield service.bindKnowledge(ctx.knowledge);
          await service.wakeAutomatic();
        });
      });
      ctx.inject(['tasks'], (ctx) => {
        ctx.effect(async function* () {
          yield service.bindTasks(ctx.tasks);
          await service.wakeAutomatic();
        });
      });
      ctx.inject(['experiments'], (ctx) => {
        ctx.effect(async function* () {
          yield service.bindExperiments(ctx.experiments);
          await service.wakeAutomatic();
        });
      });
      ctx.inject(['artifacts'], (ctx) => {
        ctx.effect(async function* () {
          yield service.bindArtifacts(ctx.artifacts);
          await service.wakeAutomatic();
        });
      });
      ctx.inject(['codeResearch'], (ctx) => {
        ctx.effect(async function* () {
          yield service.bindCode(ctx.codeResearch);
          await service.wakeAutomatic();
        });
      });
      yield ctx.provide('research', service);
    });
  },
};
export default researchPlugin;

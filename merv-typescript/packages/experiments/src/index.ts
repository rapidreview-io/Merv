import { visible, mapAsync, getArtifacts, executionOutputs, record } from '@merv/contracts';
import { childRequest, createService, plain, recorded, replayed, sha256Hex } from '@merv/contracts';
import { leaseReleaseConsumer } from '@merv/contracts';
import type { Context } from 'cordis';
import { MAX_ACTIVE_EXPERIMENTS } from './rules.js';
import { requireDependencies } from '@merv/workflows/rules';
import { z } from 'zod';
import {
  check,
  digest,
  inTransaction,
  keyId,
  keyKind,
  MervError,
  newId,
  now,
  type Artifact,
  type CodeUnit,
  type Caller,
  type Data,
  type ProcessGraph,
  type RunningNode,
  type RunningPanelPart,
  type Transaction,
  type WorkflowCheckContext,
  type WorkflowDependency,
  type WorkflowSnapshot,
  type WorkRoute,
} from '@merv/contracts';
import type { Code, CodeCaptureRef } from '@merv/code-work/types';
import type { Sandboxes } from '@merv/sandboxes/types';
import {
  enteredAgain,
  experimentNode,
  experimentPanel,
  type ExperimentStanding,
} from './running.js';
import type {
  Experiment,
  ExperimentAttach,
  ExperimentCreate,
  ExperimentEvidence,
  ExperimentExhibit,
  ExperimentOccupancy,
  ExperimentReview,
  Experiments,
  ExperimentSubmission,
  ExperimentTransition,
} from './types.js';
import {
  experimentAttachSchema,
  experimentCreateSchema,
  experimentGetSchema,
  experimentTransitionSchema,
  parseExperimentInput,
} from './input.js';
import {
  buildMetricsExhibit,
  decodeEvidence,
  exhibitBytes,
  markdownImageTargets,
  feasibilityShortfalls,
  parseFeasibility,
  parseResult,
  shouldPinExhibit,
  reportConclusion,
  validatePlan,
  validateReport,
} from './evidence.js';
import {
  approvedSubmission,
  currentEvidence,
  designCriteria,
  epochAfter,
  EXPERIMENT_LIMITS,
  EXPERIMENT_WORKFLOW,
  experimentEpoch,
  ExperimentProgram,
  feasibilityCriterion,
  programVersion,
  currentExperiment,
  producing,
  resultsCriteria,
  reviewing,
  rolesFor,
  TERMINAL,
  runningNode,
} from './program.js';
import {
  attemptMetadata,
  migrateExperiments,
  submissionMetadata,
  type AttemptRow,
  type ExperimentRow,
  type SubmissionRow,
} from './storage.js';
export type * from './types.js';

const terminal = new Set<string>(TERMINAL);
/** One experiment's row for the Running page: its place and the lease on it now. */
interface StandingRow extends Omit<WorkflowSnapshot, 'data'> {
  name: string;
  review_id: string | null;
  lease_id: string | null;
}
/** What one board read knows beside an experiment's own row. */
interface StandingContext {
  /** When the last lease on unheld work ended at its current revision, by experiment. */
  released: Map<string, string>;
  /** Experiments another plugin published a blocker on. */
  blocked: ReadonlySet<string>;
  /** On the board, what every open experiment waits on, read once for all of them. */
  waitsOn?: ReadonlyMap<string, WorkflowDependency[]>;
  /** Experiments back in a producing state they were in before. */
  again: ReadonlySet<string>;
  /** Experiments in review whose review rounds are used up. */
  exhausted: ReadonlySet<string>;
}
/** The gate a submission's review reads, as the verdict page names it. */
const GATE: Record<string, string> = { design: 'Design', results: 'Results' };
/** What review.start and review.get tell the reviewer of an experiment's design or results. */
const REVIEW_GUIDANCE =
  'Pass rejects returnTo. A rejected design returns only to planned. A rejected results review must choose returnTo planned for a new design/attempt, or running for repair under the same approved plan. Experiment design and results reviewers own Methods/Results updates: include your own paperChanges: {documents: [{kind: methods or results, expectedRevision, changes: [{id, title, content}]}]}. Cite experiments as [Experiment name](/experiments/EXPERIMENT_ID), using the actual name as the visible label and keeping IDs in link destinations. Read the current paper first, distinguish planned work from established findings, and integrate the evidence into the project narrative. Keep design-review paper updates brief, usually one or two sentences. Results reviewers may add comprehensive detail when it helps explain the project’s trajectory and informs what comes next. Edits save with any verdict; if none are needed, explain why in notes.';
/** The evidence, figures, exhibit and final capture a design or results submission pins. */
interface Submission {
  evidence: ExperimentEvidence[];
  figureIds: string[];
  exhibit: ExperimentExhibit | null;
  codeCaptureRef?: CodeCaptureRef;
}
/**
 * Ending or retrying names its reason under evidence. Guidance reaches here without the input
 * schema, so the check is made here once rather than only where the tool parses its input.
 */
function reasoned(input: Data | undefined, message: string): void {
  if (input)
    check(
      typeof (input.evidence as Data | undefined)?.reason === 'string' &&
        !!(input.evidence as Data).reason,
      'reason_required',
      message,
    );
}
const rounds = (fallback: number) => z.number().int().min(1).max(1000).default(fallback);
const configuration = z
  .object({
    limits: z
      .object({
        designRounds: rounds(EXPERIMENT_LIMITS.designRounds),
        resultRounds: rounds(EXPERIMENT_LIMITS.resultRounds),
      })
      .strict()
      .default({}),
  })
  .strict()
  .default({});

/** Owns the research experiment lifecycle; Workflows owns workflow execution and Reviews owns verdicts. */
export class ExperimentService extends ExperimentProgram implements Experiments {
  private codeBinding?: symbol;
  private releaseReviewOwner?: () => void;
  /** Complete storage migrations before publishing this service. */
  async initialize(): Promise<void> {
    await migrateExperiments(this.state);
    await this.register();
    try {
      this.releaseReviewOwner = this.reviews.registerSubmitOwner({
        id: 'experiments',
        owns: async (review, tx) =>
          !!(await tx.get(
            'SELECT id FROM experiments WHERE id=? AND project_id=?',
            review.subjectId,
            review.projectId,
          )),
        claim: async (caller, review, tx) => {
          const workflow = await this.workflows.get(caller, review.subjectId, tx);
          this.handleFor(workflow.version);
        },
        submit: async (caller, input, tx) => await this.submitReview(caller, input, tx),
        guidance: REVIEW_GUIDANCE,
        fields: ['paperChanges'],
        // An experiment is reviewed twice, so each review is named by the gate it read.
        gates: async (reviewIds, sql) => {
          if (!reviewIds.length) return {};
          const rows = await sql.all<{ review_id: string; stage: string }>(
            `SELECT review_id, stage FROM experiment_submissions WHERE review_id IN (${reviewIds.map(() => '?').join(',')})`,
            ...reviewIds,
          );
          return Object.fromEntries(
            rows.flatMap((row) =>
              Object.hasOwn(GATE, row.stage) ? [[row.review_id, GATE[row.stage]!]] : [],
            ),
          );
        },
      });
    } catch (error) {
      this.unregister();
      throw error;
    }
  }
  /** The optional Cordis child owns this binding, not the experiment lifecycle. */
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
  /** Captures, read from Sandboxes; it attaches compute to leases itself. */
  bindSandboxes(service: Pick<Sandboxes, 'captures'>): () => void {
    this.open();
    this.sandboxes = service;
    return () => {
      if (this.sandboxes === service) this.sandboxes = undefined;
    };
  }
  private open(): void {
    check(!this.closed, 'experiments_unavailable', 'Experiments is unavailable', 503);
  }
  async process(caller: Caller, id: string): Promise<ProcessGraph> {
    this.open();
    caller = structuredClone(caller);
    return await this.workflows.process(caller, id);
  }
  /**
   * The Running page's cards: every experiment on its way to a result, and any other one a key
   * in `include` names. Read without evaluating a gate, because a submission's checks read the
   * bytes it would submit.
   */
  async running(caller: Caller, include: ReadonlySet<string> = new Set()): Promise<RunningNode[]> {
    this.open();
    caller = structuredClone(caller);
    return await inTransaction(this.state, undefined, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      const held = [...include].filter((key) => keyKind(key) === 'work').map(keyId);
      const ids = [
        ...(await this.workflows.open('experiment', caller.projectId, tx)).map((w) => w.id),
        ...held,
      ];
      const rows = await this.standingRows(
        caller,
        tx,
        `e.id IN (${ids.map(() => '?').join(',') || 'NULL'})`,
        ...ids,
      );
      const context: StandingContext = {
        ...(await this.counted(caller, rows, tx)),
        released: await this.releases(caller, rows, tx),
        blocked: new Set(
          (await this.workflows.blockers(caller, undefined, tx)).map((item) => item.instanceId),
        ),
        // The board draws only what an experiment waits on; what waits on it is its sidebar's.
        waitsOn: await this.workflows.prerequisites(
          caller,
          rows.filter((row) => !terminal.has(row.state)).map((row) => row.id),
          tx,
        ),
      };
      const nodes: RunningNode[] = [];
      for (const row of rows.filter(
        (row) => currentExperiment(row.version) || held.includes(row.id),
      ))
        nodes.push(experimentNode(await this.standing(caller, row, context, tx)));
      return nodes;
    });
  }
  /**
   * The Running sidebar of `work:<experimentId>`, for any state, so an open sidebar outlives
   * the card. Null for a key that is not one of this project's.
   */
  async runningPanel(
    caller: Caller,
    key: string,
    route: WorkRoute = () => undefined,
  ): Promise<RunningPanelPart | null> {
    this.open();
    caller = structuredClone(caller);
    const kind = keyKind(key),
      id = keyId(key);
    if (kind !== 'work') return null;
    const read = await inTransaction(this.state, undefined, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      const [row] = await this.standingRows(caller, tx, 'e.id=?', id);
      if (!row) return null;
      const experiment = await this.get(caller, id, tx);
      const context: StandingContext = {
        ...(await this.counted(caller, [row], tx)),
        released: await this.releases(caller, [row], tx),
        blocked: new Set(
          (await this.workflows.blockers(caller, id, tx)).map((item) => item.instanceId),
        ),
      };
      return { standing: await this.standing(caller, row, context, tx), experiment };
    });
    if (!read) return null;
    // The ladder is where the record stands, so no action's check runs to draw it.
    const graph = await this.workflows.process(caller, id, { checks: false });
    return experimentPanel({ ...read, graph, route });
  }
  private async standingRows(
    caller: Caller,
    tx: Transaction,
    where: string,
    ...params: (string | number)[]
  ): Promise<StandingRow[]> {
    const rows = await tx.all<Pick<StandingRow, 'id' | 'name' | 'review_id'>>(
      `SELECT e.id,e.name,e.review_id FROM experiments e WHERE e.project_id=? AND ${where} ORDER BY e.created_at,e.id`,
      caller.projectId,
      ...params,
    );
    const ids = rows.map((row) => row.id);
    const at = await this.workflows.revisions(caller.projectId, ids, tx);
    const live = await tx.all<{ id: string; experiment_id: string; revision: number }>(
      `SELECT id,experiment_id,revision FROM experiment_leases WHERE project_id=? AND released_at IS NULL AND experiment_id IN (${ids.map(() => '?').join(',') || 'NULL'})`,
      caller.projectId,
      ...ids,
    );
    return rows.flatMap((row) => {
      const w = at.get(row.id);
      const lease = live.find((l) => l.experiment_id === row.id && l.revision === w?.revision);
      return w ? [{ ...w, ...row, lease_id: lease?.id ?? null }] : [];
    });
  }
  /**
   * When the last lease on each unheld experiment ended at its current revision. Only a live
   * lease is indexed, so this is one read for the whole board, and only for work an agent
   * would hold and nobody does.
   */
  private async releases(
    caller: Caller,
    rows: StandingRow[],
    tx: Transaction,
  ): Promise<Map<string, string>> {
    const unheld = rows.filter((row) => !row.lease_id && producing(row.state));
    if (!unheld.length) return new Map();
    const ended = await tx.all<{ experiment_id: string; released_at: string }>(
      `SELECT experiment_id,MAX(released_at) AS released_at FROM experiment_leases
       WHERE project_id=? AND released_at IS NOT NULL
       AND (${unheld.map(() => '(experiment_id=? AND revision=?)').join(' OR ')})
       GROUP BY experiment_id`,
      caller.projectId,
      ...unheld.flatMap((row) => [row.id, row.revision]),
    );
    return new Map(ended.map((row) => [row.experiment_id, row.released_at]));
  }
  /**
   * Which cards are back where they were, counted from their moves without the moves' data, and
   * which reviews have used every round, in a fixed number of reads however many cards.
   */
  private async counted(
    caller: Caller,
    rows: StandingRow[],
    tx: Transaction,
  ): Promise<Pick<StandingContext, 'again' | 'exhausted'>> {
    const producers = rows.filter((row) => producing(row.state));
    const moves = await this.workflows.transitionCounts(
      caller.projectId,
      producers.map((row) => row.id),
      tx,
    );
    const exhausted = new Set<string>();
    for (const [state, limit] of [
      ['design_review', 'design_rounds'],
      ['experiment_review', 'result_rounds'],
    ] as const) {
      const ids = rows
        .filter((row) => row.state === state && currentExperiment(row.version))
        .map((row) => row.id);
      if (ids.length)
        for (const [id, status] of await this.workflows.limitStatusOf(caller, ids, limit, tx))
          if (status.exhausted) exhausted.add(id);
    }
    return {
      // A new attempt is not a return by itself, so the record's own arrivals say it.
      again: new Set(
        producers.filter((row) => enteredAgain(moves.get(row.id)!, row.state)).map((row) => row.id),
      ),
      exhausted,
    };
  }
  /** One card's facts, read without evaluating a gate; a review state's only in one. */
  private async standing(
    caller: Caller,
    row: StandingRow,
    context: StandingContext,
    tx: Transaction,
  ): Promise<ExperimentStanding> {
    const ended = terminal.has(row.state);
    const review = reviewing(row.state) && row.review_id;
    const released = context.released.get(row.id);
    return {
      id: row.id,
      name: row.name,
      state: row.state,
      updatedAt: row.updatedAt,
      idleSince: released && released > row.updatedAt ? released : row.updatedAt,
      again: context.again.has(row.id),
      blocked: context.blocked.has(row.id),
      lease: row.lease_id
        ? {
            started: (await this.workflows.workStarts(caller, row.id, tx)).some(
              (start) => start.revision === row.revision,
            ),
          }
        : null,
      dependencies: ended
        ? []
        : (context.waitsOn?.get(row.id) ??
          (await this.workflows.prerequisites(caller, [row.id], tx)).get(row.id)!),
      // A review the experiment names and Reviews does not hold is drawn as no review, so one
      // dangling row costs its own card its reviewer and nothing else on the board.
      review: review
        ? await this.reviews.get(caller, review, tx).catch((error: unknown) => {
            if (error instanceof MervError && error.status === 404) return null;
            throw error;
          })
        : null,
      exhausted: context.exhausted.has(row.id),
    };
  }
  private async row(caller: Caller, id: string, tx: Transaction): Promise<ExperimentRow> {
    const row = await tx.get<ExperimentRow>(
      'SELECT * FROM experiments WHERE project_id=? AND id=?',
      caller.projectId,
      id,
    );
    check(row, 'experiment_not_found', 'Experiment not found in this project', 404);
    return row;
  }
  async get(caller: Caller, id: string, transaction?: Transaction): Promise<Experiment> {
    this.open();
    caller = structuredClone(caller);
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      parseExperimentInput(experimentGetSchema, { experimentId: id });
      return await this.experiment(caller, await this.row(caller, id, tx), tx);
    });
  }
  /** The experiment a row describes, for a caller already authorized to read it. */
  private async experiment(caller: Caller, row: ExperimentRow, tx: Transaction) {
    const workflow = await this.workflows.get(caller, row.id, tx);
    const starts = await this.workflows.workStarts(caller, row.id, tx);
    const attempts = (
      await tx.all<AttemptRow>(
        'SELECT * FROM experiment_attempts WHERE experiment_id=? ORDER BY attempt_index',
        row.id,
      )
    )
      .map(attemptMetadata)
      .map((attempt) => ({
        ...attempt,
        startedAt:
          starts
            .filter(
              (start) =>
                start.state === 'running' &&
                start.revision >= attempt.startedRevision &&
                (attempt.endedRevision === null || start.revision <= attempt.endedRevision),
            )
            .sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0]?.startedAt ?? null,
      }));
    const attempt = attempts.find((attempt) => attempt.index === row.attempt_index)!;
    const evidence = (
      await tx.all<{ record: string; selected: number }>(
        `SELECT e.record,CASE WHEN s.evidence_id=e.id THEN 1 ELSE 0 END AS selected
    FROM experiment_evidence e LEFT JOIN experiment_slots s ON s.experiment_id=e.experiment_id AND s.attempt_index=e.attempt_index AND s.role=e.role AND s.path=e.path
    WHERE e.experiment_id=? ORDER BY e.sequence`,
        row.id,
      )
    ).map(
      ({ record, selected }) =>
        ({ figureIds: [], ...JSON.parse(record), current: !!selected }) as ExperimentEvidence,
    );
    const submissions = (
      await tx.all<SubmissionRow>(
        'SELECT record FROM experiment_submissions WHERE experiment_id=? ORDER BY attempt_index,stage,round',
        row.id,
      )
    ).map(submissionMetadata);
    return {
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      intent: row.intent,
      details: row.details,
      ownerId: row.owner_id,
      createdBy: row.created_by,
      createdAt: row.created_at,
      ...(row.workspace === 'git' ? { workspace: 'git' as const } : {}),
      workflow,
      attempt,
      attempts,
      evidence,
      submissions,
      reviewId: row.review_id,
      conclusion: row.conclusion,
      // Only what this attempt's own compute captured, under any of its states' epochs.
      captureArtifactIds:
        (await this.sandboxes?.captures(
          caller.projectId,
          row.id,
          tx,
          EXPERIMENT_WORKFLOW.states.map((state) => experimentEpoch(attempt.index, state)),
        )) ?? [],
    };
  }
  /**
   * What Code holds for an experiment: its pinned base, where a base stands, its acceptance.
   * Null while Code is unloaded or knows no such unit. It is kept off the experiment record,
   * which leases freeze.
   */
  async codeUnit(caller: Caller, id: string): Promise<CodeUnit | null> {
    this.open();
    caller = structuredClone(caller);
    try {
      return (await this.code?.unit(caller, id)) ?? null;
    } catch (error) {
      if (error instanceof MervError && [404, 503].includes(error.status)) return null;
      throw error;
    }
  }
  async list(caller: Caller, transaction?: Transaction): Promise<Experiment[]> {
    this.open();
    caller = structuredClone(caller);
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      return await mapAsync(
        await tx.all<ExperimentRow>(
          'SELECT * FROM experiments WHERE project_id=? ORDER BY created_at,id',
          caller.projectId,
        ),
        async (row) => await this.experiment(caller, row, tx),
      );
    });
  }
  async summaries(caller: Caller) {
    this.open();
    return await this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'read', tx);
      const flows = new Map(
        (await this.workflows.list(caller, tx, 'experiment')).map((w) => [w.id, w]),
      );
      const sql =
        'SELECT id,name,intent,owner_id AS "ownerId",conclusion FROM experiments WHERE project_id=? ORDER BY created_at,id';
      return (
        await tx.all<Pick<Experiment, 'id' | 'name' | 'intent' | 'ownerId' | 'conclusion'>>(
          sql,
          caller.projectId,
        )
      ).map((row) => ({ ...row, workflow: flows.get(row.id)! }));
    });
  }
  async occupancy(caller: Caller, transaction?: Transaction): Promise<ExperimentOccupancy> {
    this.open();
    caller = structuredClone(caller);
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      const rows = await tx.all<{ name: string }>(
        'SELECT name FROM experiments WHERE project_id=?',
        caller.projectId,
      );
      return {
        names: rows.map((row) => row.name.toLowerCase()),
        active: (await this.workflows.open('experiment', caller.projectId, tx)).filter((w) =>
          currentExperiment(w.version),
        ).length,
      };
    });
  }
  async create(
    caller: Caller,
    value: ExperimentCreate,
    transaction?: Transaction,
  ): Promise<Experiment> {
    this.open();
    caller = structuredClone(caller);
    const input = parseExperimentInput(experimentCreateSchema, value);
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'write', tx);
      return await this.command(caller, 'create', input, tx, async () => {
        check(
          !caller.session,
          'forbidden',
          'An assigned experiment worker cannot create a separate experiment',
          403,
        );
        const { names, active } = await this.occupancy(caller, tx);
        check(
          !names.includes(input.name.toLowerCase()),
          'experiment_name_conflict',
          'An experiment already uses this name',
          409,
        );
        check(
          active < MAX_ACTIVE_EXPERIMENTS,
          'experiment_limit',
          `At most ${MAX_ACTIVE_EXPERIMENTS} experiments may be active in this project`,
          409,
        );
        for (const id of input.dependsOn) {
          const dependency = await this.workflows.get(caller, id, tx);
          // An ordering between two experiments is a task in between (founder, 2026-09-18).
          check(
            dependency.workflow === 'task',
            'invalid_dependency',
            'Experiment prerequisites must be tasks; order two experiments with a task between them',
          );
        }
        check(
          input.workspace === undefined || input.workspace === 'git',
          'invalid_workspace',
          'New experiments always use Git. Omit workspace or use git.',
        );
        const owner = await this.scope.authorityActor(caller, tx);
        check(this.code, 'code_unavailable', 'New experiments require managed Code storage', 503);
        await this.code.ensureRepository(caller, tx);
        check(
          await this.code.hosted(caller, tx),
          'code_store_required',
          'Import the existing project repository into Code before creating work',
          409,
        );
        const workflow = await this.handleFor(
          programVersion(this.artifacts.largeUploadAvailable),
        ).start(
          caller,
          {
            workflow: 'experiment',
            requestId: childRequest(caller, 'experiment', 'create', input.requestId),
            dependsOn: input.dependsOn,
            // What waits on this experiment names it, so the instance carries the name.
            data: {
              workspace: 'git',
              name: input.name,
              computeEpoch: experimentEpoch(1, EXPERIMENT_WORKFLOW.initial),
            },
          },
          tx,
        );
        const createdAt = now();
        await tx.run(
          'INSERT INTO experiments(id,project_id,name,intent,details,owner_id,created_by,created_at,attempt_index,workspace) VALUES(?,?,?,?,?,?,?,?,1,?)',
          workflow.id,
          caller.projectId,
          input.name,
          input.intent,
          input.details,
          owner.id,
          caller.actorId,
          createdAt,
          'git',
        );
        await this.addAttempt(workflow.id, 1, workflow.revision, null, [], createdAt, tx);
        await this.code!.declareUnit(caller, workflow.id, tx);
        await this.record(
          caller,
          'created',
          workflow.id,
          { name: input.name, dependsOn: input.dependsOn },
          tx,
        );
        return await this.get(caller, workflow.id, tx);
      });
    });
  }
  async attach(
    caller: Caller,
    value: ExperimentAttach,
    transaction?: Transaction,
  ): Promise<ExperimentEvidence> {
    this.open();
    caller = structuredClone(caller);
    const input = parseExperimentInput(experimentAttachSchema, value);
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'write', tx);
      return await this.command(caller, 'attach', input, tx, async () => {
        const experiment = await this.get(caller, input.experimentId, tx);
        this.handleFor(experiment.workflow.version);
        this.revision(experiment, input.expectedRevision);
        check(
          experiment.attempt.index === input.attemptIndex,
          'attempt_conflict',
          `Expected attempt ${input.attemptIndex}, the current attempt is ${experiment.attempt.index}`,
          409,
        );
        await this.assertProducer(caller, experiment, tx);
        check(
          rolesFor(experiment.workflow.state).includes(input.role),
          'invalid_experiment_role',
          'This evidence role is not writable in the current state',
          409,
        );
        // Evidence is written against the work this experiment depends on, like the step itself.
        requireDependencies(
          (await this.workflows.prerequisites(caller, [experiment.id], tx)).get(experiment.id)!,
        );
        const artifact = await this.artifacts.get(caller, input.artifactId, tx);
        const inherited = await this.pinnedRecovery(caller, experiment, tx);
        check(
          (await this.authoredInExecution(caller, artifact, tx)) ||
            experiment.captureArtifactIds?.includes(artifact.id) ||
            inherited.some(
              (e) =>
                e.artifactId === artifact.id &&
                e.role === input.role &&
                e.path === input.path &&
                e.hash === artifact.hash &&
                e.resultFormat === input.resultFormat,
            ),
          'invalid_evidence_author',
          'Evidence must be authored by this worker or be its exact frozen recovery input',
          403,
        );
        const text = await this.text(caller, artifact.id, tx);
        if (input.role === 'result') {
          parseResult(text, input.resultFormat ?? 'json');
          // The exhibit pins every current result, so one past its limits could never be submitted.
          const kept = currentEvidence(experiment, ['result']).filter((e) => e.path !== input.path);
          const added = {
            path: input.path,
            artifactId: artifact.id,
            hash: artifact.hash,
            createdAt: now(),
            resultFormat: input.resultFormat,
            sequence: 0,
          } as ExperimentEvidence;
          await this.buildExhibit(caller, experiment, [...kept, added], tx).catch((error) => {
            throw error instanceof MervError && error.code === 'invalid_experiment_evidence'
              ? new MervError(
                  error.code,
                  `The attempt's metrics exhibit cannot hold this result beside the others (${error.message}); attach it at the path of one it replaces`,
                )
              : error;
          });
        }
        if (input.role === 'feasibility') parseFeasibility(text);
        const figureIds = ['plan', 'report'].includes(input.role)
          ? await this.figures(caller, text, experiment, tx)
          : [];
        const association = await this.saveEvidence(
          caller,
          experiment,
          input.role,
          input.path,
          artifact,
          input.resultFormat,
          false,
          tx,
          figureIds,
        );
        await this.record(
          caller,
          'evidence_attached',
          experiment.id,
          {
            evidenceId: association.id,
            artifactId: artifact.id,
            role: input.role,
            path: input.path,
            attemptIndex: input.attemptIndex,
          },
          tx,
        );
        return association;
      });
    });
  }
  private async selected(
    caller: Caller,
    experiment: Experiment,
    roles: readonly string[],
    tx: Transaction,
  ): Promise<ExperimentEvidence[]> {
    const evidence = currentEvidence(experiment, roles);
    // The worker holding this experiment sees the evidence it was offered plus its own;
    // anyone else, another record's worker included, reads what the record holds.
    if (!caller.session || !(await this.holds(caller, experiment, tx))) return evidence;
    const allowed = new Set(await this.allowedArtifacts(caller, experiment, tx));
    return evidence.filter((e) => allowed.has(e.artifactId));
  }
  private one(evidence: ExperimentEvidence[], role: string): ExperimentEvidence {
    const matching = evidence.filter((e) => e.role === role);
    check(
      matching.length === 1,
      'experiment_evidence_required',
      `Exactly one current ${role} artifact is required`,
      409,
    );
    return matching[0]!;
  }
  private async authoredInExecution(
    caller: Caller,
    artifact: Artifact,
    tx: Transaction,
  ): Promise<boolean> {
    return caller.session
      ? (await executionOutputs(this.artifacts, caller, tx)).some(
          (output) => output.id === artifact.id,
        )
      : artifact.createdBy === caller.actorId;
  }
  private async text(caller: Caller, id: string, tx: Transaction): Promise<string> {
    return decodeEvidence((await this.artifacts.bytes(caller, id, tx)).bytes);
  }
  private async figures(
    caller: Caller,
    text: string,
    experiment: Experiment,
    tx: Transaction,
  ): Promise<string[]> {
    const ids = [...new Set(markdownImageTargets(text))];
    const allowed = caller.session
      ? new Set(await this.allowedArtifacts(caller, experiment, tx))
      : null;
    for (const id of ids) {
      check(
        !allowed || allowed.has(id),
        'forbidden',
        'Figure is outside this worker’s frozen inputs and authored outputs',
        403,
      );
      const { artifact, bytes } = await this.artifacts.bytes(caller, id, tx);
      check(
        ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(artifact.mediaType) &&
          bytes.length > 0,
        'invalid_experiment_evidence',
        'Figures must be retained PNG, JPEG, GIF or WebP image artifacts',
      );
    }
    return ids;
  }
  /** The metrics exhibit of the selected `result` evidence. */
  private async buildExhibit(
    caller: Caller,
    experiment: Experiment,
    results: ExperimentEvidence[],
    tx: Transaction,
  ): Promise<ExperimentExhibit> {
    const sources = [...results].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : a.sequence - b.sequence,
    );
    const inputs = await mapAsync(sources, async (source) => ({
      path: source.path,
      artifactId: source.artifactId,
      sha256: source.hash,
      submittedAt: source.createdAt,
      resultFormat: source.resultFormat ?? 'json',
      data: parseResult(
        await this.text(caller, source.artifactId, tx),
        source.resultFormat ?? 'json',
      ),
    }));
    const exhibit = buildMetricsExhibit({
      projectId: experiment.projectId,
      experimentId: experiment.id,
      attemptIndex: experiment.attempt.index,
      startedAt: experiment.attempt.startedAt,
      sources: inputs,
    });
    const bytes = exhibitBytes(exhibit);
    return {
      experimentId: experiment.id,
      attemptIndex: experiment.attempt.index,
      path: `experiments/${experiment.name}/metrics_exhibit.json`,
      content: bytes.toString('utf8'),
      hash: sha256Hex(bytes),
      willPin: shouldPinExhibit(inputs),
      sources,
      startedAt: experiment.attempt.startedAt,
    };
  }
  async exhibit(caller: Caller, id: string, transaction?: Transaction): Promise<ExperimentExhibit> {
    this.open();
    caller = structuredClone(caller);
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      const experiment = await this.get(caller, id, tx);
      check(
        experiment.workflow.state === 'running',
        'experiment_not_running',
        'Exhibit preview is available while running; read a pinned exhibit artifact after submission',
        409,
      );
      return await this.buildExhibit(
        caller,
        experiment,
        await this.selected(caller, experiment, ['result'], tx),
        tx,
      );
    });
  }
  async transition(
    caller: Caller,
    value: ExperimentTransition,
    transaction?: Transaction,
  ): Promise<Experiment> {
    this.open();
    caller = structuredClone(caller);
    const input: ExperimentTransition = parseExperimentInput(experimentTransitionSchema, value);
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'write', tx);
      return await this.command(caller, 'transition', input, tx, async () => {
        const experiment = await this.get(caller, input.experimentId, tx);
        this.handleFor(experiment.workflow.version);
        this.revision(experiment, input.expectedRevision);
        const prepared = await this.checkAction({
          caller,
          snapshot: experiment.workflow,
          tx,
          input: { ...input },
          transition: input.transition,
        });
        if (input.transition === 'submit_design' || input.transition === 'submit_results')
          return await this.submit(caller, experiment, input, prepared!, tx);
        if (experiment.reviewId && reviewing(experiment.workflow.state))
          await this.reviews.supersede(caller, experiment.reviewId, tx);
        const moved = await this.move(
          caller,
          experiment,
          {
            expectedRevision: input.expectedRevision,
            action: input.transition,
            input: { ...input },
            requestId: childRequest(caller, 'experiment', 'transition', input.requestId),
            data: { reason: input.evidence?.reason ?? null },
          },
          tx,
        );
        if (input.transition === 'retry_running')
          await this.feedback(
            experiment,
            `Infrastructure recovery: ${input.evidence?.reason}. ${input.evidence?.detail ?? ''} Recover existing jobs and retained outputs before starting new work.`,
            tx,
          );
        else {
          await tx.run(
            'UPDATE experiment_attempts SET ended_revision=? WHERE experiment_id=? AND attempt_index=?',
            moved.revision,
            experiment.id,
            experiment.attempt.index,
          );
          await tx.run(
            'UPDATE experiments SET review_id=NULL,conclusion=? WHERE id=?',
            input.evidence?.reason ?? null,
            experiment.id,
          );
        }
        await this.record(
          caller,
          'transitioned',
          experiment.id,
          {
            transition: input.transition,
            from: experiment.workflow.state,
            to: moved.state,
            revision: moved.revision,
            attemptIndex: experiment.attempt.index,
            reason: input.evidence?.reason ?? null,
            detail: input.evidence?.detail ?? null,
          },
          tx,
        );
        return await this.get(caller, experiment.id, tx);
      });
    });
  }
  /** The document, figure, exhibit and authorship gates over a submission's selected evidence. */
  private async prepareSubmission(
    caller: Caller,
    experiment: Experiment,
    selection: ExperimentEvidence[],
    tx: Transaction,
  ): Promise<Submission> {
    let evidence = selection;
    let figureIds: string[] = [];
    let exhibit: ExperimentExhibit | null = null;
    // A result submission includes the exact approved design, never a newer plan association.
    const approved =
      experiment.workflow.state === 'running' ? approvedSubmission(experiment) : undefined;
    if (!approved) {
      const plan = this.one(evidence, 'plan');
      const text = await this.text(caller, plan.artifactId, tx);
      figureIds = await this.figures(caller, text, experiment, tx);
      validatePlan(text, { figures: figureIds });
      const statement = parseFeasibility(
        await this.text(caller, this.one(evidence, 'feasibility').artifactId, tx),
      );
      // The cheap check: a design whose own figures fall short never reaches a reviewer.
      const shortfalls = feasibilityShortfalls(statement);
      check(
        shortfalls.length === 0,
        'experiment_infeasible',
        `This design's own feasibility statement does not admit it: ${shortfalls.join('; ')}. Redesign within what is available, or end the experiment with a reason`,
        409,
      );
    } else {
      evidence = [...approved.evidence, ...evidence];
      const report = this.one(evidence, 'report');
      const text = await this.text(caller, report.artifactId, tx);
      figureIds = [
        ...new Set([...approved.figureIds, ...(await this.figures(caller, text, experiment, tx))]),
      ];
      // Their bytes were read when the design was submitted, and artifacts never change.
      await getArtifacts(this.artifacts, caller, approved.figureIds, tx);
      exhibit = await this.buildExhibit(
        caller,
        experiment,
        selection.filter((e) => e.role === 'result'),
        tx,
      );
      validateReport(text, {
        figures: figureIds,
        ...(exhibit.willPin ? { exhibitPath: exhibit.path } : {}),
      });
    }
    const inherited = [
      ...(await this.pinnedRecovery(caller, experiment, tx)),
      ...(approved?.evidence ?? []),
    ];
    for (const item of evidence) {
      const metadata = await this.artifacts.get(caller, item.artifactId, tx);
      check(
        metadata.hash === item.hash,
        'artifact_hash_mismatch',
        'The selected evidence metadata changed',
        409,
      );
      check(
        (await this.authoredInExecution(caller, metadata, tx)) ||
          experiment.captureArtifactIds?.includes(item.artifactId) ||
          inherited.some(
            (pin) =>
              pin.experimentId === item.experimentId &&
              pin.attemptIndex === item.attemptIndex &&
              pin.role === item.role &&
              pin.path === item.path &&
              pin.artifactId === item.artifactId &&
              pin.hash === item.hash &&
              pin.resultFormat === item.resultFormat,
          ),
        'invalid_evidence_author',
        'Submission includes evidence outside the current worker’s authorship and frozen recovery selection',
        403,
      );
    }
    return { evidence, figureIds, exhibit };
  }
  /** A Git result is submitted from the attached running worker whose final capture is pending. */
  private async finalCaptureRef(
    caller: Caller,
    experiment: Experiment,
    tx: Transaction,
  ): Promise<CodeCaptureRef> {
    check(
      caller.session,
      'session_required',
      'Git result submission requires its actual worker session',
      403,
    );
    check(this.code, 'code_unavailable', 'Code captures are unavailable', 503);
    const ref: CodeCaptureRef = { kind: 'session-final', sessionId: caller.session.id };
    const checked = await this.code.checkCapture(
      caller,
      ref,
      {
        unitId: experiment.id,
        revision: experiment.workflow.revision,
        workflow: runningNode,
        actorId: caller.actorId,
      },
      tx,
    );
    check(
      checked.status === 'pending' && checked.capture.provenance.hostRef,
      'experiment_capture_provenance',
      'Submit from the exact attached running Git worker before final capture',
      409,
    );
    return ref;
  }
  /** The submission is what checkAction verified moments earlier in this transaction. */
  private async submit(
    caller: Caller,
    experiment: Experiment,
    input: ExperimentTransition,
    { evidence, figureIds, exhibit, codeCaptureRef }: Submission,
    tx: Transaction,
  ): Promise<Experiment> {
    const stage = input.transition === 'submit_design' ? 'design' : 'results';
    if (exhibit?.willPin) {
      const artifact = await this.artifacts.create(
        caller,
        {
          title: `Metrics exhibit: ${experiment.name}`,
          content: exhibit.content,
          mediaType: 'application/json',
        },
        tx,
      );
      evidence.push(
        await this.saveEvidence(
          caller,
          experiment,
          'exhibit',
          exhibit.path,
          artifact,
          undefined,
          true,
          tx,
        ),
      );
    }
    const artifactIds = [...new Set([...evidence.map((e) => e.artifactId), ...figureIds])];
    const pinnedInputIds = (await getArtifacts(this.artifacts, caller, artifactIds, tx))
      .filter((artifact) => artifact.createdBy !== caller.actorId)
      .map((artifact) => artifact.id);
    const moved = await this.move(
      caller,
      experiment,
      {
        expectedRevision: input.expectedRevision,
        action: input.transition,
        input: { ...input },
        requestId: childRequest(caller, 'experiment', 'transition', input.requestId),
      },
      tx,
    );
    const review = await this.reviews.request(
      caller,
      {
        subjectId: experiment.id,
        subjectRevision: moved.revision,
        producerId: caller.actorId,
        administrativeActorId: experiment.ownerId,
        // Neither the owner nor the authority that directed a worker is independent of its work.
        ...(caller.session
          ? {
              excludedActorIds: [
                ...new Set([experiment.ownerId, (await this.scope.authorityActor(caller, tx)).id]),
              ],
            }
          : {}),
        artifactIds,
        pinnedInputIds,
        criteria: [...(stage === 'design' ? designCriteria : resultsCriteria)],
        ...(stage === 'design' ? { requiredCriteria: [feasibilityCriterion] } : {}),
        formatVersion: 2,
        requestId: childRequest(caller, 'experiment', 'submission', input.requestId),
      },
      tx,
    );
    const round =
      ((
        await tx.get<{ count: number }>(
          'SELECT COALESCE(MAX(round),0) AS count FROM experiment_submissions WHERE experiment_id=? AND attempt_index=? AND stage=?',
          experiment.id,
          experiment.attempt.index,
          stage,
        )
      )?.count ?? 0) + 1;
    const submission: ExperimentSubmission = {
      id: newId('exp_sub'),
      experimentId: experiment.id,
      attemptIndex: experiment.attempt.index,
      stage,
      ...(codeCaptureRef ? { codeCaptureRef } : {}),
      round,
      subjectRevision: moved.revision,
      producerId: caller.actorId,
      sessionId: caller.session?.id ?? null,
      evidence,
      figureIds,
      manifestHash: digest({
        formatVersion: 1,
        evidence,
        figures: await getArtifacts(this.artifacts, caller, figureIds, tx),
        ...(codeCaptureRef ? { codeCaptureRef } : {}),
      }),
      reviewId: review.id,
      createdAt: now(),
    };
    await tx.run(
      'INSERT INTO experiment_submissions(id,experiment_id,attempt_index,stage,round,review_id,record) VALUES(?,?,?,?,?,?,?)',
      submission.id,
      experiment.id,
      experiment.attempt.index,
      stage,
      round,
      review.id,
      JSON.stringify(submission),
    );
    await tx.run('UPDATE experiments SET review_id=? WHERE id=?', review.id, experiment.id);
    await this.record(
      caller,
      'submitted',
      experiment.id,
      {
        submissionId: submission.id,
        stage,
        round,
        attemptIndex: experiment.attempt.index,
        reviewId: review.id,
        manifestHash: submission.manifestHash,
        artifactIds,
      },
      tx,
    );
    return await this.get(caller, experiment.id, tx);
  }
  async submitReview(
    caller: Caller,
    value: ExperimentReview,
    transaction?: Transaction,
  ): Promise<Experiment> {
    this.open();
    caller = structuredClone(caller);
    const input = plain<ExperimentReview>(value, 'invalid_experiment_input', {
      nodes: 8192,
      depth: 20,
      bytes: 262144,
    });
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'review', tx);
      check(record(input), 'invalid_experiment_input', 'Review input must be an object');
      if (input.paperChanges !== undefined)
        input.paperChanges = this.paper.parseChanges(input.paperChanges);
      check(
        Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0,
        'invalid_revision',
        'expectedRevision is required',
      );
      const review = await this.reviews.get(caller, input.reviewId, tx);
      const experiment = await this.get(caller, review.subjectId, tx);
      const submission = experiment.submissions.find((s) => s.reviewId === review.id);
      check(submission, 'stale_review', 'Review is not an experiment submission', 409);
      const action = this.route(submission.stage, input);
      return await this.command(caller, 'submit_review', input, tx, async () => {
        // The transition's guard runs checkReview before anything below is written.
        let conclusion: string | null = null;
        if (action === 'accept_results') {
          const report = this.one(submission.evidence, 'report');
          const body = await this.text(caller, report.artifactId, tx);
          const section = reportConclusion(body);
          conclusion =
            typeof input.evidence?.conclusion === 'string' && visible(input.evidence.conclusion)
              ? input.evidence.conclusion.trim()
              : section || input.notes;
        }
        const moved = await this.handleFor(experiment.workflow.version).transition(
          caller,
          {
            instanceId: experiment.id,
            expectedRevision: input.expectedRevision,
            action,
            input: { ...input },
            requestId: childRequest(caller, 'experiment', 'review', input.requestId),
            data: {
              verdict: input.verdict,
              reviewId: review.id,
              returnTo: input.returnTo ?? null,
              ...epochAfter(
                experiment,
                action,
                experiment.attempt.index +
                  (['revise_design', 'revise_plan'].includes(action) ? 1 : 0),
              ),
            },
          },
          tx,
        );
        const { expectedRevision: _revision, ...verdict } = input;
        await this.reviews.submit(
          caller,
          { ...verdict, requestId: childRequest(caller, 'experiment', 'review', input.requestId) },
          tx,
        );
        if (input.paperChanges !== undefined)
          await this.paper.applyReview(
            caller,
            {
              ...input.paperChanges,
              source: { kind: 'experiment', id: experiment.id, revision: review.subjectRevision },
              reviewId: review.id,
              verdict: input.verdict,
              evidenceIds: review.artifactIds,
            },
            tx,
          );
        if (action === 'approve_design')
          await tx.run(
            'UPDATE experiment_attempts SET approved_submission_id=?,approved_review_id=? WHERE experiment_id=? AND attempt_index=?',
            submission.id,
            review.id,
            experiment.id,
            experiment.attempt.index,
          );
        else if (['revise_design', 'revise_plan'].includes(action)) {
          await tx.run(
            'UPDATE experiment_attempts SET ended_revision=? WHERE experiment_id=? AND attempt_index=?',
            moved.revision - 1,
            experiment.id,
            experiment.attempt.index,
          );
          const index = experiment.attempt.index + 1;
          await this.addAttempt(
            experiment.id,
            index,
            moved.revision,
            experiment.attempt.index,
            [input.notes],
            now(),
            tx,
            [review.id],
          );
          await tx.run('UPDATE experiments SET attempt_index=? WHERE id=?', index, experiment.id);
        } else if (action === 'revise_execution')
          await this.feedback(experiment, input.notes, tx, review.id);
        else if (action === 'accept_results') {
          await tx.run(
            'UPDATE experiment_attempts SET ended_revision=? WHERE experiment_id=? AND attempt_index=?',
            moved.revision,
            experiment.id,
            experiment.attempt.index,
          );
          // Every version records its success, so later work can take its base from it. The
          // reference is the one the submission stored: the review capture is read only while
          // the experiment is under review, and the guard's checkReview has just verified it there.
          if (this.code)
            await this.code.acceptUnit(
              caller,
              {
                unitId: experiment.id,
                terminalRevision: moved.revision,
                submissionRef: submission.id,
                reviewRef: review.id,
                codeRef: submission.codeCaptureRef!,
                reviewSessionId: caller.session?.id ?? null,
              },
              tx,
            );
        }
        await tx.run(
          'UPDATE experiments SET review_id=NULL,conclusion=? WHERE id=?',
          conclusion,
          experiment.id,
        );
        await this.record(
          caller,
          'review_applied',
          experiment.id,
          {
            reviewId: review.id,
            submissionId: submission.id,
            verdict: input.verdict,
            returnTo: input.returnTo ?? null,
            action,
            from: experiment.workflow.state,
            to: moved.state,
            revision: moved.revision,
          },
          tx,
        );
        return await this.get(caller, experiment.id, tx);
      });
    });
  }
  /**
   * Exit readiness of an owner transition, shared by guidance and the command writer. For a
   * submission, it answers with what would be submitted.
   */
  protected async checkAction(context: WorkflowCheckContext): Promise<Submission | undefined> {
    const { caller, tx } = context,
      experiment = await this.current(context);
    const action = context.transition;
    if (context.input?.expectedRevision !== undefined)
      this.revision(experiment, context.input.expectedRevision as number);
    if (action === 'abandon' || action === 'mark_failed') {
      await this.scope.require(caller, 'write', tx);
      check(
        !terminal.has(experiment.workflow.state),
        'experiment_closed',
        'The experiment is already terminal',
        409,
      );
      await this.assertAdministration(caller, experiment, tx);
      reasoned(context.input, 'Ending an experiment requires a reason');
      return;
    }
    // Running work's approved plan and prerequisites are checked here as well.
    await this.assertProducer(caller, experiment, tx);
    if (action === 'submit_design' || action === 'submit_results') {
      check(
        experiment.workflow.state === (action === 'submit_design' ? 'planned' : 'running'),
        'invalid_transition',
        'This submission is not available in the current state',
        409,
      );
      const selection = await this.selected(
        caller,
        experiment,
        rolesFor(experiment.workflow.state),
        tx,
      );
      const own = this.one(selection, action === 'submit_design' ? 'plan' : 'report');
      check(
        await this.authoredInExecution(
          caller,
          await this.artifacts.get(caller, own.artifactId, tx),
          tx,
        ),
        'invalid_evidence_author',
        'The submitting worker must retain and attach its own plan or report after verifying any inherited evidence',
        403,
      );
      let codeCaptureRef: CodeCaptureRef | undefined;
      if (action === 'submit_results') {
        check(
          selection.some((e) => e.role === 'result'),
          'experiment_evidence_required',
          'At least one result is required',
          409,
        );
        // Only the worker that ran the attempt submits it, so guidance never offers it a person.
        codeCaptureRef = await this.finalCaptureRef(caller, experiment, tx);
      }
      return {
        ...(await this.prepareSubmission(caller, experiment, selection, tx)),
        codeCaptureRef,
      };
    }
    if (action === 'retry_running') {
      check(
        experiment.workflow.state === 'running',
        'invalid_transition',
        'retry_running is available only during execution',
        409,
      );
      // The submission requires the interruption's reason under evidence, as ending does.
      // Without this, guidance answered `ready` for a retry the tool then refused.
      reasoned(context.input, 'Retrying an experiment requires the reason for the interruption');
    }
  }
  private async addAttempt(
    id: string,
    index: number,
    revision: number,
    previous: number | null,
    feedback: string[],
    createdAt: string,
    tx: Transaction,
    feedbackReviewIds: string[] = [],
  ): Promise<void> {
    await tx.run(
      'INSERT INTO experiment_attempts(experiment_id,attempt_index,started_revision,previous_index,feedback,created_at,feedback_review_ids) VALUES(?,?,?,?,?,?,?)',
      id,
      index,
      revision,
      previous,
      JSON.stringify(feedback),
      createdAt,
      JSON.stringify(feedbackReviewIds),
    );
  }
  private async feedback(
    experiment: Experiment,
    note: string,
    tx: Transaction,
    reviewId?: string,
  ): Promise<void> {
    await tx.run(
      'UPDATE experiment_attempts SET feedback=?,feedback_review_ids=? WHERE experiment_id=? AND attempt_index=?',
      JSON.stringify([...experiment.attempt.feedback, note]),
      JSON.stringify([...experiment.attempt.feedbackReviewIds, ...(reviewId ? [reviewId] : [])]),
      experiment.id,
      experiment.attempt.index,
    );
  }
  private async saveEvidence(
    caller: Caller,
    experiment: Experiment,
    role: ExperimentEvidence['role'],
    path: string,
    artifact: Artifact,
    resultFormat: 'json' | 'qualitative' | undefined,
    systemGenerated: boolean,
    tx: Transaction,
    figureIds: string[] = [],
  ): Promise<ExperimentEvidence> {
    const sequence =
      ((
        await tx.get<{ sequence: number }>(
          'SELECT COALESCE(MAX(sequence),0) AS sequence FROM experiment_evidence WHERE experiment_id=?',
          experiment.id,
        )
      )?.sequence ?? 0) + 1;
    const evidence: ExperimentEvidence = {
      id: newId('exp_ev'),
      experimentId: experiment.id,
      attemptIndex: experiment.attempt.index,
      role,
      path,
      artifactId: artifact.id,
      hash: artifact.hash,
      figureIds,
      createdBy: caller.actorId,
      sessionId: caller.session?.id ?? null,
      createdAt: now(),
      sequence,
      current: true,
      ...(resultFormat ? { resultFormat } : {}),
      systemGenerated,
    };
    await tx.run(
      'INSERT INTO experiment_evidence(id,experiment_id,attempt_index,role,path,sequence,record) VALUES(?,?,?,?,?,?,?)',
      evidence.id,
      experiment.id,
      experiment.attempt.index,
      role,
      path,
      sequence,
      JSON.stringify(evidence),
    );
    // A plan, a feasibility statement and a report are one document each: a newer one at another
    // path replaces the earlier, so an attempt is never stuck with two current plans and no way
    // to choose.
    if (role === 'plan' || role === 'feasibility' || role === 'report')
      await tx.run(
        'DELETE FROM experiment_slots WHERE experiment_id=? AND attempt_index=? AND role=? AND path<>?',
        experiment.id,
        experiment.attempt.index,
        role,
        path,
      );
    await tx.run(
      'INSERT INTO experiment_slots(experiment_id,attempt_index,role,path,evidence_id) VALUES(?,?,?,?,?) ON CONFLICT(experiment_id,attempt_index,role,path) DO UPDATE SET evidence_id=excluded.evidence_id',
      experiment.id,
      experiment.attempt.index,
      role,
      path,
      evidence.id,
    );
    return evidence;
  }
  private async command<T>(
    caller: Caller,
    operation: string,
    input: { requestId: string },
    tx: Transaction,
    execute: () => T | Promise<T>,
  ): Promise<T> {
    return await replayed(tx, 'experiment_commands', caller, operation, input, execute, {
      after: async () =>
        await this.scope.require(caller, operation === 'submit_review' ? 'review' : 'write', tx),
    });
  }
  private async record(caller: Caller, type: string, id: string, data: Data, tx: Transaction) {
    await recorded(this.state, tx, caller, `experiment.${type}`, id, data);
  }
  withdrawReviewOwner(): void {
    this.releaseReviewOwner?.();
    this.releaseReviewOwner = undefined;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.codeBinding = undefined;
    this.code = undefined;
    this.withdrawReviewOwner();
    this.unregister();
  }
}
export const experimentsPlugin = {
  name: 'merv-experiments',
  inject: [
    'state',
    'scope',
    'artifacts',
    'workflows',
    'reviews',
    'contextBuilder',
    'paper',
    'domainEvents',
  ],
  Config: configuration,
  async apply(ctx: Context, config: z.infer<typeof configuration>) {
    const experiments = await createService(
      new ExperimentService(
        ctx.state,
        ctx.scope,
        ctx.artifacts,
        ctx.workflows,
        ctx.reviews,
        ctx.contextBuilder,
        undefined,
        ctx.paper,
        config.limits,
      ),
    );
    ctx.inject(['codeWork'], (ctx) => {
      ctx.effect(() => experiments.bindCode(ctx.codeWork));
    });
    ctx.inject(['sandboxes'], (ctx) => {
      ctx.effect(() => experiments.bindSandboxes(ctx.sandboxes));
    });
    ctx.effect(function* () {
      yield () => experiments.close();
      yield ctx.provide('experiments', experiments);
      yield () => experiments.withdrawReviewOwner();
    });
    await ctx.effect(async function* () {
      yield await ctx.domainEvents.subscribe(
        leaseReleaseConsumer('experiments.lease-release.v1', 'experiment_leases', ctx.reviews),
      );
    });
  },
};
export default experimentsPlugin;

import { experimentContinuity } from './continuity.js';
import { absent, mapAsync } from '@merv/contracts';
import { unitFiles } from '@merv/artifacts/unit-files';
import { recordUnit } from '@merv/code-work/record-unit';
import { bound, createService } from '@merv/contracts';
import type { Context } from 'cordis';
import type { Reports } from '@merv/reports/types';
import { experimentReportSubject } from './report-subject.js';
import { MAX_ACTIVE_EXPERIMENTS } from './rules.js';
import { CheckedTransitions } from '@merv/workflows/rules';
import { latestReleases, leaseRows } from '@merv/workflows/lease-rows';
import {
  check,
  inTransaction,
  keyId,
  keyKind,
  type Artifacts,
  type Caller,
  type ContextBuilder,
  type ContextRegistration,
  type RunningNode,
  type RunningPanelPart,
  type Reviews,
  type Scope,
  type State,
  type Transaction,
  type WorkflowRecord,
  type Workflows,
  type WorkRoute,
} from '@merv/contracts';
import type { WorkflowDependency, WorkflowSnapshot } from '@merv/workflows/models';
import type { Code } from '@merv/code-work/types';
import type { SandboxCaptureEvidence } from '@merv/sandboxes/sandbox-evidence';
import {
  enteredAgain,
  experimentFileIds,
  experimentNode,
  experimentHistory,
  experimentPanel,
  type ExperimentStanding,
} from './running.js';
import type { Experiment, ExperimentEvidence, ExperimentReview, Experiments } from './types.js';
import { experimentGetSchema, parseExperimentInput } from './input.js';
import {
  type ActiveState,
  captureEpochs,
  currentExperiment,
  EXPERIMENT_LIMITS,
  producing,
  reviewing,
  TERMINAL,
} from './program.js';
import { handleFor, register, unregister } from './policy.js';
import { leaseOf } from './lease.js';
import { attach, closeUnstarted, create, exhibit, submitReview, transition } from './commands.js';
import { REVIEW_RETURNS } from './definitions.js';
import { postgresMigrations } from './storage.postgres.js';
import {
  attemptMetadata,
  submissionMetadata,
  type AttemptRow,
  type ExperimentRow,
  type SubmissionRow,
} from './storage.js';
import { PAPER_REVIEWER_INSTRUCTION } from '@merv/paper/rules';
import type { Paper } from '@merv/paper/types';
export type * from './types.js';

const terminal = new Set<string>(TERMINAL);
/** One experiment's row for the Running page: its place and the lease on it now. */
interface StandingRow extends Omit<WorkflowSnapshot, 'data'> {
  name: string;
  review_id: string | null;
  created_at?: string;
  lease_id: string | null;
  /** Whether that lease's own worker has taken it up: a later visit starts afresh. */
  lease_started: boolean;
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
  /** Captures Sandboxes refused under each open experiment's current attempt, where any. */
  refused?: ReadonlyMap<string, number>;
}
/** The gate a submission's review reads, as the verdict page names it. */
const GATE: Record<string, string> = { design: 'Design', results: 'Results' };
/** What review.start and review.get tell the reviewer of an experiment's design or results. */
const REVIEW_GUIDANCE = `Pass rejects returnTo. A rejected design returns only to planned. A rejected results review must choose returnTo planned for a new design/attempt, or running for repair under the same approved plan. Experiment design and results reviewers keep the paper: ${PAPER_REVIEWER_INSTRUCTION} Keep design-review paper updates brief, usually one or two sentences. Results reviewers may add comprehensive detail when it helps explain the project’s trajectory and informs what comes next.`;

/** What the modules (policy.ts, lease.ts, context.ts, commands.ts) read of the service. */
export type ExperimentsContext = Pick<
  ExperimentService,
  | 'admits'
  | 'artifacts'
  | 'checked'
  | 'closed'
  | 'code'
  | 'contextBuilder'
  | 'contexts'
  | 'get'
  | 'handles'
  | 'limits'
  | 'many'
  | 'open'
  | 'paper'
  | 'reviews'
  | 'captureEvidence'
  | 'reports'
  | 'scope'
  | 'state'
  | 'workflows'
>;
/** Owns the research experiment lifecycle; Workflows owns workflow execution and Reviews owns verdicts. */
export class ExperimentService implements Experiments {
  // The workflow program (policy.ts, lease.ts, context.ts, execution-policy.ts) and the commands
  // (commands.ts) run on this service as their ExperimentsContext; the Experiments contract's
  // share of the commands is bound here.
  readonly create = bound(this, create);
  readonly attach = bound(this, attach);
  readonly exhibit = bound(this, exhibit);
  readonly transition = bound(this, transition);
  readonly closeUnstarted = bound(this, closeUnstarted);
  /** A verdict on this experiment's review, through Reviews.apply and every check it makes first. */
  async submitReview(
    caller: Caller,
    input: ExperimentReview,
    tx?: Transaction,
  ): Promise<Experiment> {
    return (await this.reviews.apply(caller, input, tx)) as Experiment;
  }
  closed = false;
  captureEvidence?: Pick<SandboxCaptureEvidence, 'captures' | 'evidence'>;
  /** Reports, while it is loaded: results submit the final report it rendered for the experiment. */
  reports?: Pick<Reports, 'finalFor'>;
  readonly handles = new Map<number, Awaited<ReturnType<Workflows['register']>>>();
  /** By state, and 'running:report' for the running recipe of versions that write the report. */
  readonly contexts = new Map<string, ContextRegistration>();
  /** The owner edge each transaction's command is taking after running its exit checks itself. */
  readonly checked = new CheckedTransitions();
  constructor(
    readonly state: State,
    readonly scope: Scope,
    readonly artifacts: Artifacts,
    readonly workflows: Workflows,
    readonly reviews: Reviews,
    readonly contextBuilder: ContextBuilder,
    readonly code: Code,
    readonly paper: Paper,
    readonly limits = EXPERIMENT_LIMITS,
  ) {}
  private releaseReviewOwner?: () => void;
  /** Complete storage migrations before publishing this service. */
  async initialize(): Promise<void> {
    await this.state.migrate('experiments', postgresMigrations);
    await register(this);
    try {
      this.releaseReviewOwner = this.reviews.registerSubmitOwner({
        id: 'experiments',
        owns: async (review, tx) =>
          !!(await tx.get(
            'SELECT id FROM experiments WHERE id=? AND project_id=?',
            review.subjectId,
            review.projectId,
          )),
        // A worker claims only while taking this review's lease (no row yet) or holding it.
        claim: async (caller, review, tx) => {
          const workflow = await this.workflows.get(caller, review.subjectId, tx);
          handleFor(this, workflow.version);
          const { projectId } = caller;
          if (caller.session && (await leaseRows(tx, { projectId, id: caller.session.id })).length)
            await leaseOf(this, caller, { id: workflow.id, projectId, workflow }, tx);
        },
        submit: async (caller, input, tx) => await submitReview(this, caller, input, tx),
        returns: async (review, tx) => {
          const row = await tx.get<{ stage: string }>(
            'SELECT stage FROM experiment_submissions WHERE review_id=?',
            review.id,
          );
          return (row && REVIEW_RETURNS[row.stage as keyof typeof REVIEW_RETURNS]) ?? [];
        },
        // Both rejecting verdicts return the experiment.
        returning: ['needs_changes', 'fail'],
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
      unregister(this);
      throw error;
    }
  }
  /** Registers experiment reports with Reports and checks submitted reports through it. */
  bindReports(service: Pick<Reports, 'finalFor' | 'registerSubject'>): () => void {
    this.reports = service;
    const unregister = service.registerSubject('experiment', experimentReportSubject(this));
    return () => {
      unregister();
      if (this.reports === service) this.reports = undefined;
    };
  }
  bindCaptureEvidence(service: Pick<SandboxCaptureEvidence, 'captures' | 'evidence'>): () => void {
    this.open();
    this.captureEvidence = service;
    return () => {
      if (this.captureEvidence === service) this.captureEvidence = undefined;
    };
  }
  open(): void {
    check(!this.closed, 'experiments_unavailable', 'Experiments is unavailable', 503);
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
        again: await this.counted(caller, rows, tx),
        released: await this.releases(caller, rows, tx),
        blocked: new Set(
          (await this.workflows.blockers(caller, undefined, tx)).map((item) => item.instanceId),
        ),
        refused: await this.refusals(caller, rows, tx),
        // The board draws only what an experiment waits on; what waits on it is its sidebar's.
        waitsOn: await this.workflows.prerequisites(
          caller,
          rows.filter((row) => !terminal.has(row.state)).map((row) => row.id),
          tx,
        ),
      };
      return await mapAsync(
        rows.filter((row) => currentExperiment(row.version) || held.includes(row.id)),
        async (row) => experimentNode(await this.standing(caller, row, context, tx)),
      );
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
    if (keyKind(key) !== 'work') return null;
    const id = keyId(key);
    const read = await inTransaction(this.state, undefined, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      const [row] = await this.standingRows(caller, tx, 'e.id=?', id);
      if (!row) return null;
      const experiment = await this.get(caller, id, tx);
      const context: StandingContext = {
        again: await this.counted(caller, [row], tx),
        released: await this.releases(caller, [row], tx),
        blocked: new Set(
          (await this.workflows.blockers(caller, id, tx)).map((item) => item.instanceId),
        ),
        refused: new Map([[id, experiment.refusedCaptures?.length ?? 0]]),
      };
      // Every submission's review, for the history and the verdict on what it handed in.
      const reviews = await this.reviews.find(
        caller,
        experiment.submissions.map((item) => item.reviewId),
        tx,
      );
      // Its files, for the Artifacts tab: those its record names and those its sessions made.
      const named = experimentFileIds(experiment, [...reviews.values()]);
      return {
        standing: await this.standing(caller, row, context, tx),
        experiment,
        reviews: [...reviews.values()],
        files: await unitFiles(this.artifacts, caller, named, tx),
      };
    });
    if (!read) return null;
    // The ladder is where the record stands, so no action's check runs to draw it.
    const graph = await this.workflows.process(caller, id, { checks: false });
    return experimentPanel({ ...read, graph, route });
  }
  /**
   * What its record page polls: the record, where it stands, read without running an action's
   * check (a submission's checks read the bytes it would submit, and the page draws no action),
   * and its history as its sidebar tells it, from that same graph and its reviews.
   */
  async page(caller: Caller, experimentId: string): ReturnType<Experiments['page']> {
    this.open();
    caller = structuredClone(caller);
    const read = await inTransaction(this.state, undefined, async (tx) => {
      const experiment = await this.get(caller, experimentId, tx);
      const reviews = await this.reviews.find(
        caller,
        experiment.submissions.map((item) => item.reviewId),
        tx,
      );
      return { experiment, reviews: [...reviews.values()] };
    });
    const graph = await this.workflows.process(caller, experimentId, { checks: false });
    return {
      experiment: read.experiment,
      process: graph,
      history: experimentHistory(read.experiment, graph, read.reviews),
      codeUnit: await recordUnit(this.code, caller, experimentId),
    };
  }
  private async standingRows(
    caller: Caller,
    tx: Transaction,
    where: string,
    ...params: (string | number)[]
  ): Promise<StandingRow[]> {
    const rows = await tx.all<Pick<StandingRow, 'id' | 'name' | 'review_id' | 'created_at'>>(
      `SELECT e.id,e.name,e.review_id,e.created_at FROM experiments e WHERE e.project_id=? AND ${where} ORDER BY e.created_at,e.id`,
      caller.projectId,
      ...params,
    );
    const ids = rows.map((row) => row.id);
    const at = await this.workflows.revisions(caller.projectId, ids, tx);
    const live = await leaseRows(tx, {
      projectId: caller.projectId,
      instanceIds: ids,
      active: true,
    });
    return rows.flatMap((row) => {
      const w = at.get(row.id);
      const lease = live.find((l) => l.instance_id === row.id && l.revision === w?.revision);
      return w
        ? [{ ...w, ...row, lease_id: lease?.id ?? null, lease_started: !!lease?.started_at }]
        : [];
    });
  }
  /**
   * When the last lease on each unheld experiment ended at its current revision: one read for
   * the whole board, and only for work an agent would hold and nobody does.
   */
  private async releases(
    caller: Caller,
    rows: StandingRow[],
    tx: Transaction,
  ): Promise<Map<string, string>> {
    const unheld = rows.filter((row) => !row.lease_id && producing(row.state));
    const at = new Map(unheld.map((row) => [row.id, row.revision]));
    const releases = await latestReleases(tx, {
      projectId: caller.projectId,
      instanceIds: unheld.map((row) => row.id),
    });
    return new Map(
      releases
        .filter((release) => at.get(release.instance_id) === release.revision)
        .map((release) => [release.instance_id, release.released_at]),
    );
  }
  /**
   * How many Captures Sandboxes refused under each open experiment's current attempt: two reads
   * for the whole board, and none without Sandboxes.
   */
  private async refusals(
    caller: Caller,
    rows: StandingRow[],
    tx: Transaction,
  ): Promise<Map<string, number>> {
    const open = new Map(
      rows.filter((row) => !terminal.has(row.state)).map((row) => [row.id, row]),
    );
    if (!this.captureEvidence || !open.size) return new Map();
    const current = await tx.all<AttemptRow>(
      `SELECT a.* FROM experiment_attempts a JOIN experiments e ON e.id=a.experiment_id AND e.attempt_index=a.attempt_index
      WHERE e.project_id=? AND e.id IN (SELECT jsonb_array_elements_text(?::jsonb))`,
      caller.projectId,
      JSON.stringify([...open.keys()]),
    );
    const found = await this.captureEvidence.evidence(
      caller.projectId,
      current.map((attempt) => ({
        instanceId: attempt.experiment_id,
        // An attempt's epochs rest on its revisions, never on the record's data.
        attempts: captureEpochs(attemptMetadata(attempt), {
          revision: open.get(attempt.experiment_id)!.revision,
          data: {},
        }),
      })),
      tx,
    );
    return new Map([...found].map(([id, evidence]) => [id, evidence.refused.length]));
  }
  /**
   * Which cards are back where they were, counted from their moves without the moves' data. A
   * new attempt is not a return by itself, so the record's own arrivals say it.
   */
  private async counted(caller: Caller, rows: StandingRow[], tx: Transaction) {
    const producers = rows.filter((row) => producing(row.state));
    const moves = await this.workflows.transitionCounts(
      caller.projectId,
      producers.map((row) => row.id),
      tx,
    );
    return new Set(
      producers.filter((row) => enteredAgain(moves.get(row.id)!, row.state)).map((row) => row.id),
    );
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
      lease: row.lease_id ? { started: row.lease_started } : null,
      dependencies: ended
        ? []
        : (context.waitsOn?.get(row.id) ??
          (await this.workflows.prerequisites(caller, [row.id], tx)).get(row.id)!),
      // A review the experiment names and Reviews does not hold is drawn as no review, so one
      // dangling row costs its own card its reviewer and nothing else on the board.
      review: review ? await this.reviews.get(caller, review, tx).catch(absent) : null,
      ...(row.created_at ? { started: new Date(row.created_at).toISOString() } : {}),
      ...(context.refused?.get(row.id) ? { refusedCaptures: context.refused.get(row.id) } : {}),
    };
  }
  /** Domain records only. Never evaluate guidance or render context in this read. */
  async get(caller: Caller, id: string, transaction?: Transaction): Promise<Experiment> {
    this.open();
    caller = structuredClone(caller);
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      parseExperimentInput(experimentGetSchema, { experimentId: id });
      const [experiment] = await this.many(caller, [id], tx);
      check(experiment, 'experiment_not_found', 'Experiment not found in this project', 404);
      return experiment;
    });
  }
  /** Experiments as get reads them, for a caller authorized to read them: one read per table. */
  async many(caller: Caller, ids: readonly string[], tx: Transaction): Promise<Experiment[]> {
    // An id list, not a jsonb set: each row is then read by its key, never the project's rows.
    const rows = await tx.all<ExperimentRow>(
      `SELECT * FROM experiments WHERE project_id=? AND id IN (${ids.map(() => '?').join(',')})`,
      caller.projectId,
      ...ids,
    );
    return await this.experiments(caller, rows, tx);
  }
  /**
   * The experiments rows describe, in their order, for a caller already authorized to read
   * them: each table is read once for all of them.
   */
  private async experiments(
    caller: Caller,
    rows: ExperimentRow[],
    tx: Transaction,
  ): Promise<Experiment[]> {
    if (!rows.length) return [];
    const ids = JSON.stringify(rows.map((row) => row.id));
    // One experiment reads only its own workflow; several read every workflow fact at once.
    const [one] = rows;
    const records: Map<string, Pick<WorkflowRecord, 'snapshot' | 'workStarts'>> = rows.length === 1
      ? new Map([
          [
            one.id,
            {
              snapshot: await this.workflows.get(caller, one.id, tx),
              workStarts: await this.workflows.workStarts(caller, one.id, tx),
            },
          ],
        ])
      : await this.workflows.records(
          caller,
          rows.map((row) => row.id),
          tx,
        );
    const grouped = async <T extends { experiment_id: string }>(sql: string) => {
      const found = new Map<string, T[]>();
      for (const item of await tx.all<T>(sql, ids))
        found.set(item.experiment_id, [...(found.get(item.experiment_id) ?? []), item]);
      return found;
    };
    // An array is read by index; an IN (jsonb set) hash-joins every project's rows of the table.
    const within = 'experiment_id = ANY(ARRAY(SELECT jsonb_array_elements_text(?::jsonb)))';
    const attemptRows = await grouped<AttemptRow>(
      `SELECT * FROM experiment_attempts WHERE ${within} ORDER BY experiment_id,attempt_index`,
    );
    const evidenceRows = await grouped<{
      experiment_id: string;
      record: string;
      selected: number;
    }>(
      `SELECT e.experiment_id,e.record,CASE WHEN s.evidence_id=e.id THEN 1 ELSE 0 END AS selected
    FROM experiment_evidence e LEFT JOIN experiment_slots s ON s.experiment_id=e.experiment_id AND s.attempt_index=e.attempt_index AND s.role=e.role AND s.path=e.path
    WHERE e.${within} ORDER BY e.experiment_id,e.sequence`,
    );
    const submissionRows = await grouped<SubmissionRow & { experiment_id: string }>(
      `SELECT experiment_id,record FROM experiment_submissions WHERE ${within} ORDER BY experiment_id,attempt_index,stage,round`,
    );
    const workflows = rows.map((row) => records.get(row.id)!.snapshot);
    const ends = await this.workflows.ends(workflows, tx);
    // Only what each current attempt's own compute captured, under any of its states' epochs.
    const captured = await this.captureEvidence?.evidence(
      caller.projectId,
      rows.map((row, index) => ({
        instanceId: row.id,
        attempts: captureEpochs(
          attemptMetadata(
            attemptRows.get(row.id)!.find((item) => item.attempt_index === row.attempt_index)!,
          ),
          workflows[index],
        ),
      })),
      tx,
    );
    return await mapAsync(rows, async (row, index) => {
      const workflow = workflows[index];
      const starts = records.get(row.id)!.workStarts;
      const attempts = (attemptRows.get(row.id) ?? []).map(attemptMetadata).map((attempt) => ({
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
      const evidence = (evidenceRows.get(row.id) ?? []).map(
        ({ record, selected }) =>
          ({ figureIds: [], ...JSON.parse(record), current: !!selected }) as ExperimentEvidence,
      );
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
        ...ends[index],
        attempt,
        attempts,
        evidence,
        submissions: (submissionRows.get(row.id) ?? []).map(submissionMetadata),
        reviewId: row.review_id,
        conclusion: row.conclusion,
        captureArtifactIds: captured?.get(row.id)!.artifactIds ?? [],
        ...(captured?.get(row.id)!.refused.length
          ? { refusedCaptures: captured.get(row.id)!.refused }
          : {}),
      };
    });
  }
  async list(caller: Caller, transaction?: Transaction): Promise<Experiment[]> {
    this.open();
    caller = structuredClone(caller);
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      return await this.experiments(
        caller,
        await tx.all<ExperimentRow>(
          'SELECT * FROM experiments WHERE project_id=? ORDER BY created_at,id',
          caller.projectId,
        ),
        tx,
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
      const rows = await tx.all<
        Pick<Experiment, 'id' | 'name' | 'intent' | 'ownerId' | 'conclusion'>
      >(sql, caller.projectId);
      const ends = await this.workflows.ends(
        rows.map((row) => flows.get(row.id)!),
        tx,
      );
      return rows.map((row, index) => ({ ...row, workflow: flows.get(row.id)!, ...ends[index] }));
    });
  }
  async active(caller: Caller, transaction?: Transaction): Promise<number> {
    this.open();
    caller = structuredClone(caller);
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      return (await this.workflows.open('experiment', caller.projectId, tx)).filter((w) =>
        currentExperiment(w.version),
      ).length;
    });
  }
  async admits(caller: Caller, names: readonly string[], transaction?: Transaction) {
    this.open();
    caller = structuredClone(caller);
    await inTransaction(this.state, transaction, async (tx) => {
      const active = await this.active(caller, tx);
      const taken = await tx.all<{ name: string }>(
        'SELECT name FROM experiments WHERE project_id=?',
        caller.projectId,
      );
      for (const name of names)
        check(
          !taken.some((row) => row.name.toLowerCase() === name.toLowerCase()),
          'experiment_name_conflict',
          `An experiment already uses the name ${name}`,
          409,
        );
      check(
        active + names.length <= MAX_ACTIVE_EXPERIMENTS,
        'experiment_limit',
        `At most ${MAX_ACTIVE_EXPERIMENTS} experiments may be active in this project; ${active} are, and ${names.length} more would not fit`,
        409,
      );
    });
  }
  withdrawReviewOwner(): void {
    this.releaseReviewOwner?.();
    this.releaseReviewOwner = undefined;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.withdrawReviewOwner();
    unregister(this);
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
    'codeWork',
    'paper',
    'sessions',
  ],
  async apply(ctx: Context) {
    await ctx.effect(async function* () {
      const experiments = await createService(
        new ExperimentService(
          ctx.state,
          ctx.scope,
          ctx.artifacts,
          ctx.workflows,
          ctx.reviews,
          ctx.contextBuilder,
          ctx.codeWork,
          ctx.paper,
        ),
      );
      yield () => experiments.close();
      yield ctx.sessions.threads.register('experiment', experimentContinuity, {
        conversationGraceMs: 60_000,
      });
      ctx.inject(['sandboxEvidence'], (ctx) => {
        ctx.effect(() => experiments.bindCaptureEvidence(ctx.sandboxEvidence));
      });
      ctx.inject(['reports'], (ctx) => {
        ctx.effect(() => experiments.bindReports(ctx.reports));
      });
      yield ctx.provide('experiments', experiments);
      yield () => experiments.withdrawReviewOwner();
    });
  },
};
export default experimentsPlugin;

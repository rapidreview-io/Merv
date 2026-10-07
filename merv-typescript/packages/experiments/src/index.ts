import { REVIEW_VERDICTS } from '@merv/reviews/rules';
import { MAX_ARTIFACT_IDS, mapAsync } from '@merv/contracts';
import { bound, createService } from '@merv/contracts';
import type { Context } from 'cordis';
import { MAX_ACTIVE_EXPERIMENTS } from './rules.js';
import { CheckedTransitions } from '@merv/workflows/rules';
import { latestReleases, leaseRows } from '@merv/workflows/lease-rows';
import {
  check,
  inTransaction,
  keyId,
  keyKind,
  MervError,
  type Artifact,
  type Artifacts,
  type Caller,
  type ContextBuilder,
  type ContextRegistration,
  type RunningNode,
  type RunningPanelPart,
  type RunningUnitEntry,
  type Reviews,
  type Scope,
  type State,
  type Transaction,
  type WorkflowRecord,
  type Workflows,
  type WorkRoute,
} from '@merv/contracts';
import type { ProcessGraph, WorkflowDependency, WorkflowSnapshot } from '@merv/workflows/models';
import type { Code } from '@merv/code-work/types';
import type { Sandboxes } from '@merv/sandboxes/types';
import {
  enteredAgain,
  experimentFileIds,
  experimentNode,
  experimentHistory,
  experimentPanel,
  type ExperimentStanding,
} from './running.js';
import type { Experiment, ExperimentEvidence, ExperimentOccupancy, Experiments } from './types.js';
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
import { attach, closeUnstarted, create, exhibit, submitReview, transition } from './commands.js';
import {
  attemptMetadata,
  migrateExperiments,
  submissionMetadata,
  type AttemptRow,
  type ExperimentRow,
  type SubmissionRow,
} from './storage.js';
import type { CodeUnit } from '@merv/code-work/models';
import { PAPER_REVIEW_GUIDANCE } from '@merv/paper/rules';
import type { Paper } from '@merv/paper/types';
export type * from './types.js';

const terminal = new Set<string>(TERMINAL);
/** One experiment's row for the Running page: its place and the lease on it now. */
interface StandingRow extends Omit<WorkflowSnapshot, 'data'> {
  name: string;
  review_id: string | null;
  created_at?: string;
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
}
/** The gate a submission's review reads, as the verdict page names it. */
const GATE: Record<string, string> = { design: 'Design', results: 'Results' };
/** Where a rejected design or results review may send the experiment, by the stage it read. */
const RETURNS: Record<string, { value: string; label: string }[]> = {
  design: [{ value: 'planned', label: 'Planning, for a new design' }],
  results: [
    { value: 'planned', label: 'Planning, for a new design and attempt' },
    { value: 'running', label: 'Running, to repair under the approved plan' },
  ],
};
/** What review.start and review.get tell the reviewer of an experiment's design or results. */
const REVIEW_GUIDANCE = `Pass rejects returnTo. A rejected design returns only to planned. A rejected results review must choose returnTo planned for a new design/attempt, or running for repair under the same approved plan. Experiment design and results reviewers ${PAPER_REVIEW_GUIDANCE} Keep design-review paper updates brief, usually one or two sentences. Results reviewers may add comprehensive detail when it helps explain the project’s trajectory and informs what comes next. Edits save with any verdict; if none are needed, explain why in notes.`;

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
  | 'open'
  | 'paper'
  | 'reviews'
  | 'sandboxes'
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
  readonly submitReview = bound(this, submitReview);
  closed = false;
  sandboxes?: Pick<Sandboxes, 'captures'>;
  readonly handles = new Map<number, Awaited<ReturnType<Workflows['register']>>>();
  readonly contexts = new Map<ActiveState, ContextRegistration>();
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
    await migrateExperiments(this.state);
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
        claim: async (caller, review, tx) => {
          const workflow = await this.workflows.get(caller, review.subjectId, tx);
          handleFor(this, workflow.version);
        },
        submit: async (caller, input, tx) => await this.submitReview(caller, input, tx),
        returns: async (review, tx) => {
          const row = await tx.get<{ stage: string }>(
            'SELECT stage FROM experiment_submissions WHERE review_id=?',
            review.id,
          );
          return (row && RETURNS[row.stage]) ?? [];
        },
        // Both rejecting verdicts return the experiment, so once the gate's rounds are used up
        // only a pass is left.
        verdicts: async (caller, review, tx) =>
          (await this.workflows.exhaustedLimit(caller, review.subjectId, tx))
            ? ['pass']
            : REVIEW_VERDICTS,
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
  /** Captures, read from Sandboxes; it attaches compute to leases itself. */
  bindSandboxes(service: Pick<Sandboxes, 'captures'>): () => void {
    this.open();
    this.sandboxes = service;
    return () => {
      if (this.sandboxes === service) this.sandboxes = undefined;
    };
  }
  open(): void {
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
      // Every submission's review, for the history and the verdict on what it handed in.
      const reviews = await this.reviews.find(
        caller,
        experiment.submissions.map((item) => item.reviewId),
        tx,
      );
      // Its files, for the Artifacts tab: those its record names and those its sessions made.
      const named = experimentFileIds(experiment, [...reviews.values()]);
      const found = await this.artifacts.find(caller, named.ids.slice(0, MAX_ARTIFACT_IDS), tx);
      const made: Artifact[] = [];
      for (const session of named.sessions)
        made.push(...(await this.artifacts.list(caller, { session, limit: 200 }, tx)));
      return {
        standing: await this.standing(caller, row, context, tx),
        experiment,
        reviews: [...reviews.values()],
        files: { found, made },
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
  async page(
    caller: Caller,
    experimentId: string,
  ): Promise<{ experiment: Experiment; process: ProcessGraph; history: RunningUnitEntry[] }> {
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
      return w ? [{ ...w, ...row, lease_id: lease?.id ?? null }] : [];
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
    if (!unheld.length) return new Map();
    const at = new Map(unheld.map((row) => [row.id, row.revision]));
    const ended = new Map<string, string>();
    for (const release of await latestReleases(tx, {
      projectId: caller.projectId,
      instanceIds: unheld.map((row) => row.id),
    }))
      if (at.get(release.instance_id) === release.revision)
        ended.set(release.instance_id, release.released_at);
    return ended;
  }
  /** Which cards are back where they were, counted from their moves without the moves' data. */
  private async counted(
    caller: Caller,
    rows: StandingRow[],
    tx: Transaction,
  ): Promise<Pick<StandingContext, 'again'>> {
    const producers = rows.filter((row) => producing(row.state));
    const moves = await this.workflows.transitionCounts(
      caller.projectId,
      producers.map((row) => row.id),
      tx,
    );
    return {
      // A new attempt is not a return by itself, so the record's own arrivals say it.
      again: new Set(
        producers.filter((row) => enteredAgain(moves.get(row.id)!, row.state)).map((row) => row.id),
      ),
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
      ...(row.created_at ? { started: new Date(row.created_at).toISOString() } : {}),
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
  /** Domain records only. Never evaluate guidance or render context in this read. */
  async get(caller: Caller, id: string, transaction?: Transaction): Promise<Experiment> {
    this.open();
    caller = structuredClone(caller);
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      parseExperimentInput(experimentGetSchema, { experimentId: id });
      return (await this.experiments(caller, [await this.row(caller, id, tx)], tx))[0];
    });
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
    const within = 'experiment_id IN (SELECT jsonb_array_elements_text(?::jsonb))';
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
        // Only what this attempt's own compute captured, under any of its states' epochs.
        captureArtifactIds:
          (await this.sandboxes?.captures(
            caller.projectId,
            row.id,
            tx,
            captureEpochs(attempt, workflow),
          )) ?? [],
      };
    });
  }
  /**
   * What Code holds for an experiment: its pinned base, where a base stands, its acceptance.
   * Null while Code is unavailable or knows no such unit. It is kept off the experiment record,
   * which leases freeze.
   */
  async codeUnit(caller: Caller, id: string): Promise<CodeUnit | null> {
    this.open();
    caller = structuredClone(caller);
    try {
      return await this.code.unit(caller, id);
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
  async admits(caller: Caller, names: readonly string[], transaction?: Transaction) {
    this.open();
    caller = structuredClone(caller);
    await inTransaction(this.state, transaction, async (tx) => {
      const { names: taken, active } = await this.occupancy(caller, tx);
      for (const name of names)
        check(
          !taken.includes(name.toLowerCase()),
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
  ],
  async apply(ctx: Context) {
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
    ctx.inject(['sandboxes'], (ctx) => {
      ctx.effect(() => experiments.bindSandboxes(ctx.sandboxes));
    });
    ctx.effect(function* () {
      yield () => experiments.close();
      yield ctx.provide('experiments', experiments);
      yield () => experiments.withdrawReviewOwner();
    });
  },
};
export default experimentsPlugin;

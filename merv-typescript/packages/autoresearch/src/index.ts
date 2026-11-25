import {
  check,
  clip,
  createService,
  digest,
  inTransaction,
  MervError,
  newId,
  now,
  recorded,
  replayed,
  visible,
  type Caller,
  type Data,
  type DelegationSource,
  type DomainEvents,
  type Scope,
  type State,
  type StoredEvent,
  type Transaction,
  type WorkflowAssignmentContent,
  type WorkflowCheckContext,
  type Workflows,
} from '@merv/contracts';
import type { WorkflowSnapshot } from '@merv/workflows/models';
import { bootMaintenance } from '@merv/contracts/maintenance';
import { permits, sourceCaller } from '@merv/scope/rules';
import type { Sessions } from '@merv/sessions/types';
import type { Context } from 'cordis';
import { dollars, MANAGER_BRIEF, spendLine, wakeReport } from './brief.js';
import { postgresMigrations } from './index.postgres.js';
import type {
  AutoresearchConfigure,
  AutoresearchDecide,
  AutoresearchLine,
  AutoresearchPause,
  AutoresearchRun,
  AutoresearchSpend,
  AutoresearchState,
  AutoresearchStatus,
} from './models.js';
import { definition, policy } from './policy.js';
import { sandboxesSpend, type SpendSource } from './spend.js';
import type { Autoresearch } from './types.js';
export type * from './types.js';

/** Off by default; turning it on takes a goal, and these until the person sets their own. */
export const AUTORESEARCH_DEFAULTS = { capUsd: 20, runEstimateUsd: 2, wakeLimit: 20 };
/** The provider Autoresearch's blockers are published as, on the manager's instance. */
export const AUTORESEARCH_PROVIDER = 'autoresearch';
const CONSUMER = 'autoresearch.wakes.v1';
/** How long a spend read may take before scheduling is refused for now (503). */
const SPEND_MS = 5_000;
const LINES = 30;
/** The label a visit's references give each run its brief reports as ended. */
const ENDED_RUN = 'Ended run';
const RUNS = 50;
/** How many of an ended run's own last events its wake report carries. */
const RESULT_EVENTS = 4;

interface Row {
  project_id: string;
  enabled: boolean;
  manager_id: string | null;
  goal: string | null;
  cap_cents: number;
  run_estimate_cents: number;
  wake_limit: number;
  automatic_wakes: number;
  paused: AutoresearchPause | null;
  round_started_at: string | null;
  source_json: string | null;
  updated_at: string;
  updated_by: string;
}
interface RunRow {
  id: string;
  workflow: 'task' | 'experiment';
  name: string;
  started_at: string;
  ended_at: string | null;
  final_state: string | null;
}
interface WakeRow {
  id: string;
  run_id: string;
  report: string;
  created_at: string;
  delivered_revision: number | null;
}

const cents = (usd: number) => Math.round(usd * 100);
/** The settings of a project that never configured autoresearch. */
const defaults = (projectId: string, actorId: string): Row => ({
  project_id: projectId,
  enabled: false,
  manager_id: null,
  goal: null,
  cap_cents: cents(AUTORESEARCH_DEFAULTS.capUsd),
  run_estimate_cents: cents(AUTORESEARCH_DEFAULTS.runEstimateUsd),
  wake_limit: AUTORESEARCH_DEFAULTS.wakeLimit,
  automatic_wakes: 0,
  paused: null,
  round_started_at: null,
  source_json: null,
  updated_at: now(),
  updated_by: actorId,
});
const money = (value: unknown, what: string, max: number) =>
  check(
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max,
    'invalid_input',
    `${what} must be a number of US dollars from 0 to ${max}`,
  );
const line = (value: unknown, max: number, what: string) =>
  check(
    typeof value === 'string' && visible(value) && value.length <= max && !/[\r\n]/.test(value),
    'invalid_input',
    `${what} must be one line of at most ${max} characters`,
  );
const prose = (value: unknown, max: number, what: string) =>
  check(
    typeof value === 'string' && visible(value) && value.length <= max,
    'invalid_input',
    `${what} must be text of at most ${max} characters`,
  );

/** What the workflow policy (policy.ts) reads of the service. */
export type AutoresearchContext = Pick<
  AutoresearchService,
  'scope' | 'sessions' | 'row' | 'assignment'
>;

/**
 * A manager per research project: a worker Sessions dispatches on the project's `autoresearch`
 * instance, woken when a task or experiment it started ends. It schedules the next work through
 * the ordinary task and experiment tools, within a spend cap this service admits each start
 * against, and pauses for the person at the cap and after `wakeLimit` automatic wakes in a row.
 */
export class AutoresearchService implements Autoresearch {
  closed = false;
  handle?: Awaited<ReturnType<Workflows['register']>>;
  private withdraw?: () => void;
  constructor(
    readonly state: State,
    readonly scope: Scope,
    readonly workflows: Workflows,
    readonly sessions: Pick<Sessions, 'session' | 'findSession'>,
    /** Where spend is read; a test hands in its own. */
    public spendSource: SpendSource,
  ) {}

  async initialize(): Promise<void> {
    await this.state.migrate('autoresearch', postgresMigrations);
    this.handle = await this.workflows.register(definition, policy(this));
    this.withdraw = this.workflows.admitStarts((caller, snapshot, tx) =>
      this.admit(caller, snapshot, tx),
    );
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.withdraw?.();
    this.handle?.dispose();
  }
  private open() {
    check(
      !this.closed && this.handle,
      'autoresearch_unavailable',
      'Autoresearch is unavailable',
      503,
    );
    return this.handle!;
  }

  async row(projectId: string, tx: Transaction): Promise<Row | undefined> {
    return await tx.get<Row>('SELECT * FROM autoresearch_projects WHERE project_id=?', projectId);
  }
  private async manager(row: Row | undefined, caller: Caller, tx: Transaction) {
    return row?.manager_id ? await this.workflows.get(caller, row.manager_id, tx) : null;
  }

  // ── Spend ────────────────────────────────────────────────────────────────────────────────

  /** Spend reads for pages, kept a short while so a poll never waits on Sandboxes each time. */
  private readonly spent = new Map<
    string,
    { at: number; usd: number | null; source: AutoresearchSpend['source'] }
  >();
  /**
   * What the round has spent, held and may still start. Sandboxes is asked afresh where a run
   * is admitted or a decision taken (`fresh`); a page's read may take one up to 15 s old.
   */
  async spend(row: Row, tx: Transaction, fresh = true): Promise<AutoresearchSpend> {
    const open = row.manager_id
      ? ((await tx.get<{ n: number | string }>(
          'SELECT count(*) AS n FROM autoresearch_runs WHERE project_id=? AND manager_id=? AND ended_at IS NULL',
          row.project_id,
          row.manager_id,
        ))!.n as number)
      : 0;
    const openRuns = Number(open);
    const capUsd = row.cap_cents / 100;
    const runEstimateUsd = row.run_estimate_cents / 100;
    const since = row.round_started_at ?? row.updated_at;
    const key = `${row.project_id} ${since}`;
    const kept = this.spent.get(key);
    let spentUsd: number | null = null;
    let source: AutoresearchSpend['source'] = 'unavailable';
    if (!fresh && kept && Date.now() - kept.at < 15_000) ({ usd: spentUsd, source } = kept);
    else {
      try {
        const read = await within(this.spendSource.since(row.project_id, since), SPEND_MS);
        spentUsd = read ? Math.round(read.usd * 100) / 100 : 0;
        source = read ? 'sandboxes' : 'no_compute';
      } catch {
        // Unknown is never zero: no run is admitted until Sandboxes answers again.
      }
      if (this.spent.size > 1000) this.spent.clear();
      this.spent.set(key, { at: Date.now(), usd: spentUsd, source });
    }
    const committedUsd =
      spentUsd === null ? null : Math.round((spentUsd + runEstimateUsd * openRuns) * 100) / 100;
    return {
      capUsd,
      spentUsd,
      runEstimateUsd,
      openRuns,
      committedUsd,
      allowsRun: committedUsd !== null && committedUsd + runEstimateUsd <= capUsd + 1e-9,
      source,
    };
  }

  /**
   * Workflows' start admission: a task or experiment the manager's own visit starts is admitted
   * only while it fits under the cap, and becomes one of its runs, in the same transaction.
   */
  private async admit(caller: Caller, snapshot: WorkflowSnapshot, tx: Transaction) {
    if (!caller.session || (snapshot.workflow !== 'task' && snapshot.workflow !== 'experiment'))
      return;
    const row = await this.row(caller.projectId, tx);
    if (!row?.manager_id) return;
    const session = await this.sessions.session(caller, tx);
    if (session.instanceId !== row.manager_id) return;
    const spend = await this.spend(row, tx);
    if (spend.spentUsd === null)
      throw new MervError(
        'autoresearch_spend_unavailable',
        'Sandboxes did not say what this round has spent, so no new work is started now. Nothing changed; try again in a minute. If it still does not answer, end your visit with autoresearch.decide: next "wait" (once nothing you started runs, the person is asked to resume the loop when Sandboxes answers again), or next "end" with a summary.',
        503,
      );
    if (!spend.allowsRun)
      throw new MervError(
        'autoresearch_cap_reached',
        `The autoresearch spend cap blocks this run. ${spendLine(spend)} Nothing was created. End your visit with autoresearch.decide: next "wait" if work you started still runs (once nothing does, the person is asked whether to raise the cap), or next "end" with a summary.`,
        409,
        { spend },
      );
    const data = snapshot.data as { title?: unknown; name?: unknown };
    const name = String(data.title ?? data.name ?? snapshot.id);
    await tx.run(
      'INSERT INTO autoresearch_runs(id,project_id,manager_id,workflow,name,started_at) VALUES(?,?,?,?,?,?)',
      snapshot.id,
      caller.projectId,
      row.manager_id,
      snapshot.workflow,
      clip(name, 300),
      now(),
    );
  }

  /**
   * The project's cap and what its round has spent and holds: other programs admit their own
   * runs against it (Jobs' Run), read fresh; a page's read (`fresh` false) may be 15 s old. A
   * project never configured has the default cap.
   */
  async room(projectId: string, tx: Transaction, fresh = true): Promise<AutoresearchSpend> {
    const row = (await this.row(projectId, tx)) ?? defaults(projectId, '');
    return await this.spend(row, tx, fresh);
  }

  // ── Reads ────────────────────────────────────────────────────────────────────────────────

  async status(caller: Caller): Promise<AutoresearchStatus> {
    caller = structuredClone(caller);
    const status = await this.state.transaction(async (tx) => {
      const actor = await this.scope.require(caller, 'read', tx);
      return await this.view(
        caller,
        await this.row(caller.projectId, tx),
        tx,
        permits(actor.role, 'write') && !caller.session,
      );
    });
    if (status.managerId && !caller.session) {
      const found = await this.sessions.findSession(caller, status.managerId).catch(() => null);
      status.threadId = (found?.current ?? found?.latest)?.threadId ?? null;
    }
    return status;
  }
  private async view(
    caller: Caller,
    row: Row | undefined,
    tx: Transaction,
    writable: boolean,
  ): Promise<AutoresearchStatus> {
    const settings = row ?? defaults(caller.projectId, caller.actorId);
    const manager = await this.manager(row, caller, tx);
    const runs = settings.manager_id
      ? await tx.all<RunRow>(
          'SELECT * FROM autoresearch_runs WHERE project_id=? AND manager_id=? ORDER BY _merv_rowid DESC LIMIT ?',
          caller.projectId,
          settings.manager_id,
          RUNS,
        )
      : [];
    const pending = settings.manager_id
      ? Number(
          (await tx.get<{ n: number }>(
            'SELECT count(*) AS n FROM autoresearch_wakes WHERE project_id=? AND manager_id=? AND delivered_revision IS NULL',
            caller.projectId,
            settings.manager_id,
          ))!.n,
        )
      : 0;
    const lines = await tx.all<{
      id: string;
      at: string;
      kind: AutoresearchLine['kind'];
      revision: number | null;
      actor_id: string;
      text: string;
    }>(
      'SELECT * FROM autoresearch_lines WHERE project_id=? ORDER BY _merv_rowid DESC LIMIT ?',
      caller.projectId,
      LINES,
    );
    return {
      projectId: caller.projectId,
      enabled: settings.enabled,
      managerId: settings.manager_id,
      ownerId: row ? settings.updated_by : null,
      state: (manager?.state as AutoresearchState | undefined) ?? null,
      revision: manager?.revision ?? null,
      threadId: null,
      goal: settings.goal,
      paused: settings.paused,
      roundStartedAt: settings.round_started_at,
      wakes: { used: settings.automatic_wakes, limit: settings.wake_limit, pending },
      spend: await this.spend(settings, tx, false),
      runs: runs.map((run): AutoresearchRun => ({
        id: run.id,
        workflow: run.workflow,
        name: run.name,
        startedAt: run.started_at,
        endedAt: run.ended_at,
        finalState: run.final_state,
      })),
      lines: lines.map((item) => ({
        id: item.id,
        at: item.at,
        kind: item.kind,
        revision: item.revision === null ? null : Number(item.revision),
        actorId: item.actor_id,
        text: item.text,
      })),
      writable,
    };
  }

  /** What a manager visit is handed: its standing brief, what woke it, and the round's spend. */
  async assignment(context: WorkflowCheckContext): Promise<WorkflowAssignmentContent> {
    const { snapshot, tx } = context;
    const row = await this.row(snapshot.projectId, tx);
    // Those given to this visit, and those that ended since while it was still here (a run that
    // ended while it waited for the person's answer): its decision marks these as read.
    const wakes = await tx.all<WakeRow>(
      'SELECT * FROM autoresearch_wakes WHERE project_id=? AND manager_id=? AND (delivered_revision=? OR delivered_revision IS NULL) ORDER BY _merv_rowid',
      snapshot.projectId,
      snapshot.id,
      snapshot.revision,
    );
    const open = await tx.all<RunRow>(
      'SELECT * FROM autoresearch_runs WHERE project_id=? AND manager_id=? AND ended_at IS NULL ORDER BY _merv_rowid',
      snapshot.projectId,
      snapshot.id,
    );
    const spend = row ? await this.spend(row, tx) : null;
    const why = wakes.length
      ? `What woke you (${wakes.length} ${wakes.length === 1 ? 'run' : 'runs'} ended):\n${wakes.map((wake) => `- ${wake.report}`).join('\n')}`
      : snapshot.revision === 0 || (await this.roundStart(snapshot, tx))
        ? 'This round starts now: nothing has run yet. Plan the first work toward the goal.'
        : 'No work ended since your last visit: the person resumed the loop or wrote to you. Read session.messages first.';
    const brief = [
      MANAGER_BRIEF,
      `Goal of this round: ${row?.goal ?? '(none given: read the paper’s Problem)'}`,
      spend ? spendLine(spend) : '',
      why,
      open.length
        ? `Still running, started by you: ${open.map((run) => `${run.workflow} "${run.name}" (${run.id})`).join('; ')}.`
        : 'Nothing you started is running now.',
    ]
      .filter(Boolean)
      .join('\n\n');
    return {
      role: 'producer',
      label: 'Work: manage this project’s autoresearch',
      name: 'Autoresearch manager',
      brief,
      references: [
        ...wakes.map((wake) => ({ kind: 'workflow', id: wake.run_id, label: ENDED_RUN })),
        ...open.map((run) => ({ kind: 'workflow', id: run.id, label: 'Running' })),
      ],
      handoff: {
        instruction:
          'Hand in your decision with autoresearch.decide (next "wait" or "end"), or ask the person with session.ask_owner, then stop.',
        tools: ['autoresearch.decide', 'session.ask_owner'],
      },
      execution: {
        readOnly: false,
        tools: [
          {
            name: 'autoresearch.decide',
            arguments: { autoresearchId: snapshot.id, expectedRevision: snapshot.revision },
          },
        ],
      },
      context: null,
    };
  }
  /** Whether the manager came into this visit by a round's start. */
  private async roundStart(snapshot: WorkflowSnapshot, tx: Transaction) {
    const last = await tx.get<{ kind: string }>(
      "SELECT kind FROM autoresearch_lines WHERE project_id=? AND manager_id=? AND kind IN ('start','decide','end','wake','resume') ORDER BY _merv_rowid DESC LIMIT 1",
      snapshot.projectId,
      snapshot.id,
    );
    return last?.kind === 'start';
  }

  // ── The person's commands ────────────────────────────────────────────────────────────────

  async configure(caller: Caller, input: AutoresearchConfigure): Promise<AutoresearchStatus> {
    const handle = this.open();
    caller = structuredClone(caller);
    input = structuredClone(input);
    check(!caller.session, 'people_only', 'Only a person configures autoresearch', 403);
    if (input.capUsd !== undefined) money(input.capUsd, 'capUsd', 100_000);
    if (input.runEstimateUsd !== undefined) money(input.runEstimateUsd, 'runEstimateUsd', 100_000);
    if (input.wakeLimit !== undefined)
      check(
        Number.isSafeInteger(input.wakeLimit) && input.wakeLimit >= 1 && input.wakeLimit <= 1000,
        'invalid_input',
        'wakeLimit must be a whole number from 1 to 1000',
      );
    if (input.goal !== undefined) prose(input.goal, 4000, 'goal');
    check(
      input.enabled === undefined || typeof input.enabled === 'boolean',
      'invalid_input',
      'enabled must be true or false',
    );
    await this.command(caller, 'configure', input, async (tx) => {
      await this.scope.require(caller, 'admin', tx);
      const time = now();
      let row = await this.row(caller.projectId, tx);
      if (!row) {
        await tx.run(
          'INSERT INTO autoresearch_projects(project_id,cap_cents,run_estimate_cents,wake_limit,updated_at,updated_by) VALUES(?,?,?,?,?,?)',
          caller.projectId,
          cents(AUTORESEARCH_DEFAULTS.capUsd),
          cents(AUTORESEARCH_DEFAULTS.runEstimateUsd),
          AUTORESEARCH_DEFAULTS.wakeLimit,
          time,
          caller.actorId,
        );
        row = (await this.row(caller.projectId, tx))!;
      }
      await tx.run(
        'UPDATE autoresearch_projects SET cap_cents=?,run_estimate_cents=?,wake_limit=?,goal=?,updated_at=?,updated_by=? WHERE project_id=?',
        input.capUsd === undefined ? row.cap_cents : cents(input.capUsd),
        input.runEstimateUsd === undefined ? row.run_estimate_cents : cents(input.runEstimateUsd),
        input.wakeLimit ?? row.wake_limit,
        input.goal ?? row.goal,
        time,
        caller.actorId,
        caller.projectId,
      );
      row = (await this.row(caller.projectId, tx))!;
      const manager = await this.manager(row, caller, tx);
      const changes = [
        input.capUsd !== undefined && `cap ${dollars(input.capUsd)}`,
        input.runEstimateUsd !== undefined && `run estimate ${dollars(input.runEstimateUsd)}`,
        input.wakeLimit !== undefined && `wake limit ${input.wakeLimit}`,
        input.goal !== undefined && 'a new goal',
      ].filter(Boolean);
      if (input.enabled === true && !manager) {
        check(
          row.goal,
          'autoresearch_goal_required',
          'Give the goal the manager works toward',
          400,
        );
        // The manager's first visit is offered at once: the round starts with it.
        const source = await this.scope.delegationSource(caller, tx);
        await tx.run(
          'UPDATE autoresearch_projects SET enabled=TRUE,automatic_wakes=0,paused=NULL,round_started_at=?,source_json=? WHERE project_id=?',
          time,
          JSON.stringify(source),
          caller.projectId,
        );
        const started = await handle.start(
          caller,
          {
            workflow: 'autoresearch',
            requestId: `autoresearch:start:${digest({ caller: caller.actorId, requestId: input.requestId })}`,
          },
          tx,
        );
        await tx.run(
          'UPDATE autoresearch_projects SET manager_id=? WHERE project_id=?',
          started.id,
          caller.projectId,
        );
        await this.line(
          tx,
          caller,
          started.id,
          0,
          'start',
          `Autoresearch turned on: ${clip(row.goal, 160)}`,
        );
        await this.event(tx, caller, 'enabled', started.id, { capUsd: row.cap_cents / 100 });
        return;
      }
      if (input.enabled === false && manager) {
        if (manager.state !== 'off') await this.move(handle, caller, manager, 'turn_off', tx);
        await tx.run(
          'UPDATE autoresearch_projects SET enabled=FALSE,manager_id=NULL,paused=NULL WHERE project_id=?',
          caller.projectId,
        );
        await this.line(
          tx,
          caller,
          manager.id,
          manager.revision + 1,
          'configure',
          'Autoresearch turned off.',
        );
        await this.event(tx, caller, 'disabled', manager.id, {});
        return;
      }
      if (manager && changes.length)
        await this.line(
          tx,
          caller,
          manager.id,
          manager.revision,
          'configure',
          `Settings: ${changes.join(', ')}.`,
        );
      // Raising the cap is the person's answer to a cap pause: the loop goes on if a run fits.
      if (
        manager?.state === 'paused' &&
        row.paused === 'cap' &&
        (await this.spend(row, tx)).allowsRun
      )
        await this.resumed(caller, row, manager, tx, 'The cap was raised; the manager goes on.');
    });
    return await this.status(caller);
  }

  /** Pause, resume or start a round: a person's move, refused to every leased worker. */
  async control(
    caller: Caller,
    action: 'pause' | 'resume' | 'start_round' | 'end_round',
    input: { requestId: string; goal?: string; summary?: string },
  ): Promise<AutoresearchStatus> {
    const handle = this.open();
    caller = structuredClone(caller);
    input = structuredClone(input);
    check(!caller.session, 'people_only', 'Only a person pauses or resumes autoresearch', 403);
    if (input.goal !== undefined) prose(input.goal, 4000, 'goal');
    if (input.summary !== undefined) prose(input.summary, 4000, 'summary');
    await this.command(caller, action, input, async (tx) => {
      await this.scope.require(caller, 'write', tx);
      const row = await this.row(caller.projectId, tx);
      const manager = await this.manager(row, caller, tx);
      check(
        row?.enabled && manager,
        'autoresearch_off',
        'Autoresearch is off in this project',
        409,
      );
      if (action === 'pause') {
        check(
          manager.state === 'managing' || manager.state === 'waiting',
          'autoresearch_not_running',
          `Autoresearch is ${manager.state}, so there is nothing to pause`,
          409,
        );
        await this.pause(caller, row, manager, 'person', tx);
      } else if (action === 'resume') {
        check(
          manager.state === 'paused',
          'autoresearch_not_paused',
          'Autoresearch is not paused',
          409,
        );
        await this.resumed(caller, row, manager, tx, 'Resumed by the person.');
      } else if (action === 'start_round') {
        check(
          manager.state === 'idle',
          'autoresearch_round_open',
          'A round is still open: end it first',
          409,
        );
        const goal = input.goal ?? row.goal;
        check(goal, 'autoresearch_goal_required', 'Give the goal the manager works toward', 400);
        await tx.run(
          'UPDATE autoresearch_projects SET goal=?,automatic_wakes=0,paused=NULL,round_started_at=? WHERE project_id=?',
          goal,
          now(),
          caller.projectId,
        );
        const moved = await this.move(handle, caller, manager, 'start_round', tx);
        // Runs of the last round that ended since are read at the new round's first visit.
        await this.deliver(row, moved.revision, tx);
        await this.line(
          tx,
          caller,
          manager.id,
          moved.revision,
          'start',
          `New round: ${clip(goal, 160)}`,
        );
      } else {
        check(
          manager.state === 'waiting' || manager.state === 'paused',
          'autoresearch_round_busy',
          manager.state === 'idle'
            ? 'The round has already ended'
            : 'The manager is at work: pause it first, or let it end the round itself',
          409,
        );
        const moved = await this.move(handle, caller, manager, 'end_round', tx);
        await tx.run(
          'UPDATE autoresearch_projects SET paused=NULL WHERE project_id=?',
          caller.projectId,
        );
        await this.publish(row, moved, tx);
        await this.line(
          tx,
          caller,
          manager.id,
          moved.revision,
          'end',
          input.summary ?? 'The person ended the round.',
        );
      }
    });
    return await this.status(caller);
  }

  // ── The manager's decision ───────────────────────────────────────────────────────────────

  async decide(caller: Caller, input: AutoresearchDecide) {
    const handle = this.open();
    caller = structuredClone(caller);
    input = structuredClone(input);
    check(
      caller.session,
      'manager_only_decides',
      'Only the leased manager hands in its decision',
      403,
    );
    line(input.note, 200, 'note');
    check(
      input.next === 'wait' || input.next === 'end',
      'invalid_input',
      'next is "wait" or "end"',
    );
    if (input.next === 'end') prose(input.summary, 4000, 'summary');
    return await this.command(caller, 'decide', input, async (tx) => {
      const row = await this.row(caller.projectId, tx);
      check(
        row?.manager_id === input.autoresearchId,
        'not_found',
        'No such autoresearch manager',
        404,
      );
      const manager = await this.workflows.get(caller, input.autoresearchId, tx);
      check(
        manager.revision === input.expectedRevision,
        'stale_revision',
        'The manager moved on since this visit began',
        409,
      );
      // What this visit's brief reported is read: the rest wakes it again.
      const shown = (await this.sessions.session(caller, tx)).assignment.references
        .filter((item) => item.label === ENDED_RUN)
        .map((item) => item.id);
      if (shown.length)
        await tx.run(
          `UPDATE autoresearch_wakes SET delivered_revision=? WHERE project_id=? AND manager_id=? AND delivered_revision IS NULL AND run_id IN (${shown.map(() => '?').join(',')})`,
          manager.revision,
          row.project_id,
          row.manager_id,
          ...shown,
        );
      if (input.next === 'wait') {
        const pending = await this.count(
          tx,
          'SELECT count(*) AS n FROM autoresearch_wakes WHERE project_id=? AND manager_id=? AND delivered_revision IS NULL',
          row,
        );
        const spend = await this.spend(row, tx);
        // Waiting on nothing would never wake: only the cap's question to the person may follow.
        check(
          spend.openRuns > 0 || pending > 0 || !spend.allowsRun,
          'autoresearch_nothing_to_wait_for',
          'Nothing you started is running, so a wait would never wake you. Schedule the next work, ask the person with session.ask_owner, or end the round with next "end" and a summary.',
          409,
        );
      }
      const moved = await this.move(
        handle,
        caller,
        manager,
        input.next === 'wait' ? 'wait' : 'end_round',
        tx,
      );
      await this.line(tx, caller, manager.id, manager.revision, 'decide', input.note);
      if (input.next === 'end')
        await this.line(tx, caller, manager.id, moved.revision, 'end', clip(input.summary!, 2000));
      await this.event(tx, caller, 'decided', manager.id, {
        revision: manager.revision,
        next: input.next,
        note: input.note,
      });
      return {
        decided: input.next,
        state: moved.state,
        next:
          input.next === 'wait'
            ? 'Your visit has ended. Stop now: you wake in this same conversation when work you started ends.'
            : 'The round has ended. Stop now.',
      };
    });
  }

  // ── Moves ────────────────────────────────────────────────────────────────────────────────

  private async move(
    handle: NonNullable<AutoresearchService['handle']>,
    caller: Caller,
    manager: WorkflowSnapshot,
    action: string,
    tx: Transaction,
  ) {
    return await handle.transition(
      caller,
      {
        instanceId: manager.id,
        expectedRevision: manager.revision,
        action,
        requestId: `autoresearch:${digest({ id: manager.id, revision: manager.revision, action })}`,
      },
      tx,
    );
  }
  /** Gives the manager the wakes that wait, at the revision it comes back at. */
  private async deliver(row: Row, revision: number, tx: Transaction) {
    await tx.run(
      'UPDATE autoresearch_wakes SET delivered_revision=? WHERE project_id=? AND manager_id=? AND delivered_revision IS NULL',
      revision,
      row.project_id,
      row.manager_id,
    );
  }
  private async pause(
    caller: Caller,
    row: Row,
    manager: WorkflowSnapshot,
    why: AutoresearchPause,
    tx: Transaction,
    read?: AutoresearchSpend,
  ) {
    const moved = await this.move(this.open(), caller, manager, 'pause', tx);
    await tx.run(
      'UPDATE autoresearch_projects SET paused=? WHERE project_id=?',
      why,
      row.project_id,
    );
    const paused = { ...row, paused: why };
    const spend = read ?? (await this.spend(paused, tx));
    await this.line(
      tx,
      caller,
      manager.id,
      moved.revision,
      why === 'cap' ? 'cap' : 'pause',
      why === 'person'
        ? 'Paused by the person.'
        : why === 'cap'
          ? spend.spentUsd === null
            ? 'Paused: Sandboxes did not report the spend, so no run can be admitted.'
            : `Paused at the spend cap: ${spendLine(spend)}`
          : `Paused after ${row.automatic_wakes} automatic wakes in a row; updates are queued.`,
    );
    await this.publish(paused, moved, tx, spend);
    await this.event(tx, caller, 'paused', manager.id, { reason: why });
  }
  /** The person spoke: the wake count starts again and the manager reads what waits for it. */
  private async resumed(
    caller: Caller,
    row: Row,
    manager: WorkflowSnapshot,
    tx: Transaction,
    text: string,
  ) {
    await tx.run(
      'UPDATE autoresearch_projects SET automatic_wakes=0,paused=NULL WHERE project_id=?',
      row.project_id,
    );
    const action = manager.state === 'paused' ? 'resume' : 'hear';
    const moved = await this.move(this.open(), caller, manager, action, tx);
    await this.deliver(row, moved.revision, tx);
    await this.publish({ ...row, paused: null }, moved, tx);
    await this.line(tx, caller, manager.id, moved.revision, 'resume', text);
    await this.event(tx, caller, 'resumed', manager.id, { action });
  }
  /** Autoresearch's whole opinion of the manager, as Needs you reads it. */
  private async publish(
    row: Row,
    manager: WorkflowSnapshot,
    tx: Transaction,
    spend?: AutoresearchSpend,
  ) {
    const capped = manager.state === 'paused' && row.paused === 'cap';
    const read = capped ? (spend ?? (await this.spend(row, tx))) : undefined;
    const blockers =
      capped && read!.spentUsd === null
        ? [
            {
              key: 'cap',
              code: 'autoresearch_spend_unavailable',
              status: 503,
              message:
                'Autoresearch paused: Sandboxes did not report what this round has spent, so the manager cannot start another run, and nothing it started is running.',
              next: 'Choose: resume with autoresearch.write resume once Sandboxes answers again (the spend page shows it), or end the round with autoresearch.write end_round.',
              whose: 'owner' as const,
              related: [],
              revision: manager.revision,
            },
          ]
        : capped
          ? [
              {
                key: 'cap',
                code: 'autoresearch_cap_reached',
                status: 409,
                message: `Autoresearch reached its spend cap. ${spendLine(read!)}`,
                next: 'Choose: raise the cap with autoresearch.write configure (capUsd) and the manager goes on, or end the round with autoresearch.write end_round.',
                whose: 'owner' as const,
                related: [],
                revision: manager.revision,
              },
            ]
          : manager.state === 'paused' && row.paused === 'wake_limit'
            ? [
                {
                  key: 'wake_limit',
                  code: 'autoresearch_wake_limit',
                  status: 409,
                  message: `The manager woke ${row.automatic_wakes} times in a row on its own, the limit (${row.wake_limit}). What finished since is queued for it.`,
                  next: 'Choose: resume with autoresearch.write resume, or write to the manager’s thread, and it goes on; or end the round with autoresearch.write end_round.',
                  whose: 'owner' as const,
                  related: [],
                  revision: manager.revision,
                },
              ]
            : [];
    await this.workflows.replaceBlockers(
      {
        projectId: row.project_id,
        instanceId: manager.id,
        provider: AUTORESEARCH_PROVIDER,
        blockers,
      },
      tx,
    );
  }

  // ── The wake ─────────────────────────────────────────────────────────────────────────────

  /** Durable events wake the manager: an ended run, its own move, or the person's message. */
  async bind(events: DomainEvents): Promise<() => void | Promise<void>> {
    this.open();
    const release = await events.subscribe({
      id: CONSUMER,
      from: 'now',
      types: ['workflow.transition', 'session.message_queued', 'autoresearch.reconcile'],
      handle: async (event, tx) => await this.heard(event, tx),
    });
    try {
      await this.reconcileAll();
    } catch (error) {
      await release();
      throw error;
    }
    return release;
  }
  /** Startup revisits every project whose loop is on: an event consumed while blocked is not lost. */
  async reconcileAll() {
    if (bootMaintenance.active || this.closed) return;
    await this.state.transaction(async (tx) => {
      for (const row of await tx.all<{
        project_id: string;
        manager_id: string;
        updated_by: string;
      }>(
        'SELECT project_id,manager_id,updated_by FROM autoresearch_projects WHERE enabled AND manager_id IS NOT NULL ORDER BY project_id',
      ))
        await this.state.appendEvent(tx, {
          projectId: row.project_id,
          actorId: row.updated_by,
          type: 'autoresearch.reconcile',
          subjectId: row.manager_id,
          data: { performedBy: 'system:autoresearch' },
        });
    });
  }
  private async heard(event: StoredEvent, tx: Transaction) {
    if (this.closed) return;
    const row = await this.row(event.projectId, tx);
    if (!row?.enabled || !row.manager_id || !row.source_json) return;
    const data = event.data as Record<string, unknown>;
    if (event.type === 'workflow.transition') {
      if (data.workflow === 'task' || data.workflow === 'experiment') {
        if (!data.terminal) return;
        const run = await tx.get<RunRow>(
          'SELECT * FROM autoresearch_runs WHERE id=? AND project_id=? AND ended_at IS NULL',
          event.subjectId,
          event.projectId,
        );
        if (!run) return;
        await this.ended(row, run, event, tx);
      } else if (data.workflow !== 'autoresearch' || event.subjectId !== row.manager_id) return;
    } else if (event.type === 'session.message_queued' && data.instanceId !== row.manager_id)
      return;
    // A savepoint keeps one refusal from failing the event: it is said on the manager instead.
    await tx.run('SAVEPOINT autoresearch_wake');
    try {
      const source = JSON.parse(row.source_json) as DelegationSource;
      await this.scope.requireDelegation(source, 'write', tx);
      const caller = sourceCaller(source);
      if (event.type === 'session.message_queued') await this.spoke(caller, row, tx);
      else await this.reconcile(caller, (await this.row(event.projectId, tx))!, tx);
      await tx.run('RELEASE SAVEPOINT autoresearch_wake');
    } catch (error) {
      await tx.run('ROLLBACK TO SAVEPOINT autoresearch_wake');
      await tx.run('RELEASE SAVEPOINT autoresearch_wake');
      if (!(error instanceof MervError) || error.status >= 500) throw error;
      await this.workflows.replaceBlockers(
        {
          projectId: row.project_id,
          instanceId: row.manager_id,
          provider: AUTORESEARCH_PROVIDER,
          blockers: [
            {
              key: 'refused',
              code: error.code,
              status: error.status,
              message: clip(`Autoresearch could not move on: ${error.message}`, 2000),
              next: 'Pause and resume autoresearch, or turn it off and on, once whoever turned it on may still write in this project.',
              whose: 'owner',
              related: [],
            },
          ],
        },
        tx,
      );
    }
  }
  /** One run ended: it is a wake waiting for the manager, with its result and evidence. */
  private async ended(row: Row, run: RunRow, event: StoredEvent, tx: Transaction) {
    const data = event.data as Record<string, unknown>;
    const state = String(data.to);
    const [end] = await this.workflows.ends(
      [{ workflow: run.workflow, version: Number(data.version), state }],
      tx,
    );
    // Its result as its owner recorded it: the last of its own events as it ended (a
    // review's verdict, a failure's reason), never the engine's moves.
    const own = (
      await this.state.findEvents(
        { projectId: row.project_id, subjectId: run.id, since: run.started_at },
        1000,
        tx,
      )
    )
      .filter((item) => !item.type.startsWith('workflow.'))
      .slice(-RESULT_EVENTS)
      .map((item) => ({ type: item.type, data: item.data }));
    const time = now();
    await tx.run(
      'UPDATE autoresearch_runs SET ended_at=?,final_state=? WHERE id=? AND ended_at IS NULL',
      time,
      state,
      run.id,
    );
    await tx.run(
      'INSERT INTO autoresearch_wakes(id,project_id,manager_id,run_id,report,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT (run_id) DO NOTHING',
      newId('autoresearch_wake'),
      row.project_id,
      row.manager_id,
      run.id,
      wakeReport({
        workflow: run.workflow,
        id: run.id,
        name: run.name,
        state,
        action: String(data.action),
        succeeded: !!end?.settled && !end.failed,
        data,
        results: own,
      }),
      time,
    );
  }
  /** Where the manager stands, moved on where it waits and something woke it. */
  private async reconcile(caller: Caller, row: Row, tx: Transaction) {
    const manager = await this.workflows.get(caller, row.manager_id!, tx);
    if (manager.state !== 'waiting') return;
    const pending = await this.count(
      tx,
      'SELECT count(*) AS n FROM autoresearch_wakes WHERE project_id=? AND manager_id=? AND delivered_revision IS NULL',
      row,
    );
    if (pending) {
      // The person's word ends the run of automatic wakes; until then they wait here.
      if (row.automatic_wakes >= row.wake_limit)
        return await this.pause(caller, row, manager, 'wake_limit', tx);
      await tx.run(
        'UPDATE autoresearch_projects SET automatic_wakes=automatic_wakes+1 WHERE project_id=?',
        row.project_id,
      );
      const moved = await this.move(this.open(), caller, manager, 'wake', tx);
      await this.deliver(row, moved.revision, tx);
      await this.line(
        tx,
        caller,
        manager.id,
        moved.revision,
        'wake',
        `Woke for ${pending} finished ${pending === 1 ? 'run' : 'runs'} (automatic wake ${row.automatic_wakes + 1} of ${row.wake_limit}).`,
      );
      await this.event(tx, caller, 'woken', manager.id, { pending, wake: row.automatic_wakes + 1 });
      return;
    }
    const spend = await this.spend(row, tx);
    // Nothing runs and no run fits, or none can be admitted while the spend is unknown: nothing
    // would ever wake the manager, so it waits for the person, who is asked in Needs you.
    if (spend.openRuns === 0 && !spend.allowsRun)
      await this.pause(caller, row, manager, 'cap', tx, spend);
  }
  /** A message to the manager's thread: the person spoke. */
  private async spoke(caller: Caller, row: Row, tx: Transaction) {
    const manager = await this.workflows.get(caller, row.manager_id!, tx);
    await tx.run(
      'UPDATE autoresearch_projects SET automatic_wakes=0 WHERE project_id=?',
      row.project_id,
    );
    if (manager.state === 'waiting' || manager.state === 'paused')
      await this.resumed(caller, row, manager, tx, 'The person wrote to the manager.');
  }

  // ── Records ──────────────────────────────────────────────────────────────────────────────

  private async count(tx: Transaction, sql: string, row: Row) {
    return Number((await tx.get<{ n: number | string }>(sql, row.project_id, row.manager_id))!.n);
  }
  private async line(
    tx: Transaction,
    caller: Caller,
    managerId: string,
    revision: number | null,
    kind: AutoresearchLine['kind'],
    text: string,
  ) {
    await tx.run(
      'INSERT INTO autoresearch_lines(id,project_id,manager_id,revision,kind,actor_id,text,at) VALUES(?,?,?,?,?,?,?,?)',
      newId('autoresearch_line'),
      caller.projectId,
      managerId,
      revision,
      kind,
      caller.actorId,
      clip(text, 2000),
      now(),
    );
  }
  private async event(tx: Transaction, caller: Caller, type: string, id: string, data: Data) {
    await recorded(this.state, tx, caller, `autoresearch.${type}`, id, data);
  }
  private async command<T>(
    caller: Caller,
    operation: string,
    input: { requestId: string },
    execute: (tx: Transaction) => T | Promise<T>,
    transaction?: Transaction,
  ): Promise<T> {
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      // A command that answers nothing of its own still keeps a receipt, so a retry replays it.
      return await replayed(
        tx,
        'autoresearch_commands',
        caller,
        operation,
        input,
        async () => ((await execute(tx)) ?? { done: true }) as T,
      );
    });
  }
}

/** What `promise` gives, or a rejection once `ms` have passed. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Spend read timed out')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export const autoresearchPlugin = {
  name: 'merv-autoresearch',
  inject: ['state', 'scope', 'workflows', 'domainEvents', 'sessions'],
  async apply(ctx: Context) {
    await ctx.effect(async function* () {
      const service = await createService(
        new AutoresearchService(
          ctx.state,
          ctx.scope,
          ctx.workflows,
          ctx.sessions,
          sandboxesSpend(ctx),
        ),
      );
      yield () => service.close();
      yield await service.bind(ctx.domainEvents);
      yield ctx.provide('autoresearch', service);
    });
  },
};
export default autoresearchPlugin;

import {
  check,
  createService,
  digest,
  forRead,
  MervError,
  visible,
  type Caller,
  type Data,
  type Scope,
  type State,
  type Transaction,
  type Workflows,
} from '@merv/contracts';
import { bootMaintenance } from '@merv/contracts/maintenance';
import { reporter, swallowed, type Issues, silent } from '@merv/contracts/issues';
import type { CodeService } from '@merv/code/service';
import type {} from '@merv/api/types';
import type {} from '@merv/autoresearch/types';
import type { Sessions } from '@merv/sessions/types';
import type { WorkflowSnapshot } from '@merv/workflows/models';
import type { Context } from 'cordis';
import { z } from 'zod';
import { SandboxesMachine, type JobMachine, type MachineProgress } from './machine.js';
import { definition, JOB_WORKFLOW, policy, view } from './program.js';
import type { JobMove, JobPlan, JobRun, Jobs, JobView } from './types.js';
export type * from './types.js';

/** How long the machine's Git read lasts: renting and fetching happen well within it. */
const GRANT_SECONDS = 3600;
/** A run may cost at most this much more than its estimate. */
const MAX_COST_FACTOR = 1.5;
const LIVE_MS = 3000;
type Room = (
  projectId: string,
  tx: Transaction,
) => Promise<{ capUsd: number; committedUsd: number | null }>;

const text = (value: unknown, max: number, what: string) =>
  check(
    typeof value === 'string' && visible(value) && value.length <= max,
    'invalid_input',
    `${what} must be text of at most ${max} characters`,
  );
/** What a proposal must say, checked once for the tool and for a reviewer's next job. */
export function plan(input: JobPlan): JobPlan {
  text(input.title, 200, 'title');
  text(input.goal, 4000, 'goal');
  text(input.doneMeans, 4000, 'doneMeans');
  text(input.command, 4000, 'command');
  check(/^[A-Za-z0-9-]{1,32}$/.test(input.gpu), 'invalid_input', 'gpu names one GPU, as T4');
  check(
    Number.isSafeInteger(input.minutes) && input.minutes >= 1 && input.minutes <= 720,
    'invalid_input',
    'minutes is a whole number from 1 to 720',
  );
  check(
    Number.isFinite(input.estimateUsd) && input.estimateUsd > 0 && input.estimateUsd <= 1000,
    'invalid_input',
    'estimateUsd is a positive number of US dollars up to 1000',
  );
  const { title, goal, doneMeans, command, gpu, minutes, estimateUsd } = input;
  return { title, goal, doneMeans, command, gpu, minutes, estimateUsd };
}
const branch = /^(?!\/|.*(?:\.\.|\/\/|@\{|\.lock$|\/$))[A-Za-z0-9._/-]{1,200}$/;
const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const usd = (value: number) => `$${value.toFixed(2)}`;

/**
 * One job type on the workflow engine: its record is the instance's data, its steps the graph,
 * and its machine step is driven from here, never by an agent.
 */
export class JobsService implements Jobs {
  handle?: Awaited<ReturnType<Workflows['register']>>;
  machine?: JobMachine;
  room?: Room;
  issues: Issues = silent;
  private closed = false;
  private timer?: NodeJS.Timeout;
  private ticking?: Promise<void>;

  constructor(
    readonly state: State,
    readonly scope: Scope,
    readonly workflows: Workflows,
    readonly sessions: Pick<Sessions, 'session'>,
    readonly code: Pick<CodeService, 'repositories' | 'gitRemote'>,
    private readonly origin: () => string | undefined,
  ) {}

  async initialize() {
    this.handle = await this.workflows.register(definition, policy(this));
  }
  /** Drives every running or stopping job now and on an interval. */
  start(everyMs: number) {
    if (bootMaintenance.active || this.timer) return;
    const failed = swallowed(this.issues, 'jobs.machine');
    this.timer = setInterval(() => void this.tick().catch(failed), everyMs).unref();
    void this.tick().catch(failed);
  }
  close() {
    this.closed = true;
    clearInterval(this.timer);
    this.handle?.dispose();
  }
  private open() {
    check(!this.closed && this.handle, 'jobs_unavailable', 'Jobs are unavailable', 503);
    return this.handle!;
  }
  private soon() {
    this.state.afterCommit(() => void this.tick().catch(swallowed(this.issues, 'jobs.machine')));
  }

  // ── Reads ────────────────────────────────────────────────────────────────────────────────

  private async snapshot(caller: Caller, jobId: string, tx: Transaction) {
    const job = await this.workflows.get(caller, jobId, tx);
    check(job.workflow === JOB_WORKFLOW, 'not_found', 'No such job', 404);
    return job;
  }
  async list(caller: Caller) {
    const all = await this.workflows.list(caller, undefined, JOB_WORKFLOW);
    return { jobs: all.reverse().map(view) };
  }
  async get(caller: Caller, input: { jobId: string }) {
    const job = view(await forRead(this.state, (tx) => this.snapshot(caller, input.jobId, tx)));
    let live: Record<string, number> | null = null;
    // Live readings are best effort: a slow or failing read leaves them out.
    if (job.state === 'running' && job.run && this.machine) {
      const service = await this.scope.serviceActor('jobs', caller.projectId);
      live = await Promise.race([
        this.machine.live(service, job.id, job.run.attempt).catch(() => null),
        new Promise<null>((resolve) => setTimeout(resolve, LIVE_MS, null).unref()),
      ]);
    }
    return { job, live };
  }

  // ── The person's moves ───────────────────────────────────────────────────────────────────

  async propose(caller: Caller, input: JobPlan & { requestId: string }) {
    check(!caller.session, 'people_only', 'A leased agent proposes a job with its review', 403);
    const data = plan(input);
    return await this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'write', tx);
      return view(await this.begin(caller, data, null, input.requestId, tx));
    });
  }
  private async begin(
    caller: Caller,
    data: JobPlan,
    previousJobId: string | null,
    requestId: string,
    tx: Transaction,
  ) {
    return await this.open().start(
      caller,
      {
        workflow: JOB_WORKFLOW,
        requestId: `job:${digest({ actor: caller.actorId, requestId })}`,
        data: { ...data, previousJobId, proposedBy: caller.actorId } as unknown as Data,
      },
      tx,
    );
  }

  async run(caller: Caller, input: JobMove) {
    return await this.move(caller, input, 'run', async (job, tx) => {
      // A replay of an earlier Run is the engine's to answer, and is not admitted again.
      if (job.state === 'proposed' && job.revision === input.expectedRevision)
        await this.admit(caller.projectId, view(job), tx);
      return { ranBy: caller.actorId };
    });
  }

  async stop(caller: Caller, input: JobMove & { reason?: string }) {
    if (input.reason !== undefined) text(input.reason, 2000, 'reason');
    const stopped = await this.move(caller, input, 'stop', async (job) => {
      const run = view(job).run;
      return {
        stoppedBy: caller.actorId,
        stopReason: input.reason ?? null,
        ...(job.state === 'running' && run && { run: { ...run, state: 'cancelling' } }),
      };
    });
    this.soon();
    return stopped;
  }

  /** Spend is admitted where a run is started: Run, and each new commit a revision runs. */
  private async admit(projectId: string, job: JobView, tx: Transaction) {
    check(this.machine, 'job_compute_unavailable', 'This server has no compute for jobs', 503);
    check(
      await this.machine.linked(projectId),
      'sandbox_not_connected',
      'Connect compute for this project before you run a job',
      409,
    );
    if (!this.room) return;
    const room = await this.room(projectId, tx);
    check(
      room.committedUsd !== null,
      'job_spend_unavailable',
      'Sandboxes did not say what this project has spent, so no run starts now. Nothing changed; try again in a minute.',
      503,
    );
    const held = (await this.workflows.open(JOB_WORKFLOW, projectId, tx))
      .filter((item) => item.id !== job.id && ['running', 'stopping'].includes(item.state))
      .reduce((sum, item) => sum + Number(item.data.estimateUsd), 0);
    const committed = room.committedUsd + held;
    if (committed + job.estimateUsd > room.capUsd + 1e-9)
      throw new MervError(
        'job_cap_reached',
        `This run's estimate of ${usd(job.estimateUsd)} does not fit under the project's cap of ${usd(room.capUsd)}: ${usd(committed)} is already spent or held. Nothing started. Raise the cap (autoresearch.write configure capUsd) or lower the estimate.`,
        409,
        { capUsd: room.capUsd, committedUsd: committed, estimateUsd: job.estimateUsd },
      );
  }

  // ── The leased agents' hand-ins ──────────────────────────────────────────────────────────

  async submitCode(caller: Caller, input: JobMove & { ref: string; commit: string }) {
    check(caller.session, 'job_worker_only', 'Only the job’s leased writer hands in code', 403);
    check(branch.test(input.ref), 'invalid_input', 'ref is a branch name, as desk-run/name');
    check(oid.test(input.commit), 'invalid_input', 'commit is a full commit id');
    // Git never runs inside a transaction. The machine checks the commit again when it fetches.
    const found = await this.code.repositories.resolve(caller.projectId, `refs/heads/${input.ref}`);
    check(
      found === input.commit,
      'job_commit_mismatch',
      found
        ? `Branch ${input.ref} points at ${found}, not ${input.commit}. Push the commit, then hand in the one the branch points at.`
        : `This project's Merv git has no branch ${input.ref}. Push it first.`,
      409,
    );
    const moved = await this.move(caller, input, 'submit_code', async (job, tx) => {
      if (job.state === 'writing' && job.revision === input.expectedRevision)
        await this.admit(caller.projectId, view(job), tx);
      const run: JobRun = {
        attempt: job.revision + 1,
        state: 'starting',
        workflowId: null,
        costUsd: null,
        captureArtifactId: null,
        final: null,
        error: null,
        machineReleased: false,
      };
      return { code: { ref: input.ref, commit: input.commit }, run } as unknown as Data;
    });
    this.soon();
    return moved;
  }

  async review(
    caller: Caller,
    input: JobMove & {
      verdict: 'accept' | 'revise';
      commitRead: string;
      summary: string;
      next?: JobPlan;
    },
  ) {
    check(
      caller.session,
      'job_worker_only',
      'Only the job’s leased reviewer hands in a review',
      403,
    );
    check(
      ['accept', 'revise'].includes(input.verdict),
      'invalid_input',
      'verdict is accept or revise',
    );
    text(input.summary, 4000, 'summary');
    check(
      input.next === undefined || input.verdict === 'accept',
      'invalid_input',
      'Only an accepted job proposes a next one',
    );
    const next = input.next && plan(input.next);
    return await this.move(caller, input, input.verdict, async (job, tx) => {
      const read = view(job);
      check(
        read.code?.commit === input.commitRead,
        'job_commit_stale',
        `This run is of commit ${read.code?.commit}; review that commit.`,
        409,
      );
      const proposed =
        next && (await this.begin(caller, next, job.id, `${input.requestId}:next`, tx));
      return {
        result: {
          verdict: input.verdict,
          commitRead: input.commitRead,
          summary: input.summary,
          nextJobId: proposed?.id ?? null,
        },
        ...(input.verdict === 'revise' && { revisions: (Number(job.data.revisions) || 0) + 1 }),
      };
    });
  }

  /** One move of a job; `data` reads the job as it stands and says what the move records. */
  private async move(
    caller: Caller,
    input: JobMove,
    action: string,
    data: (job: WorkflowSnapshot, tx: Transaction) => Promise<Data>,
  ): Promise<JobView> {
    const handle = this.open();
    return await this.state.transaction(async (tx) => {
      const job = await this.snapshot(caller, input.jobId, tx);
      const moved = await handle.transition(
        caller,
        {
          instanceId: job.id,
          expectedRevision: input.expectedRevision,
          action,
          requestId: `job:${digest({ actor: caller.actorId, requestId: input.requestId })}`,
          data: await data(job, tx),
        },
        tx,
      );
      return view(moved);
    });
  }

  // ── The machine step ─────────────────────────────────────────────────────────────────────

  /** Every running job is advanced and every stopping one released; one pass at a time. */
  async tick(): Promise<void> {
    while (this.ticking) await this.ticking.catch(() => {});
    if (this.closed || !this.machine) return;
    this.ticking = (async () => {
      const failed = swallowed(this.issues, 'jobs.machine');
      for (const job of await this.workflows.open(JOB_WORKFLOW, null))
        if (job.state === 'running' || job.state === 'stopping')
          await this.drive(job).catch(failed);
    })().finally(() => (this.ticking = undefined));
    await this.ticking;
  }

  private async drive(job: WorkflowSnapshot) {
    const machine = this.machine!;
    const read = view(job);
    const run = read.run!;
    const service = await this.scope.serviceActor('jobs', job.projectId);
    if (job.state === 'stopping') {
      if (!(await machine.release(service, job.id))) return;
      await this.code.gitRemote.revokeRun(job.projectId, job.id);
      return await this.machineMove(service, job, 'released', {
        run: { ...run, state: 'cancelled', machineReleased: true },
      });
    }
    let progress: MachineProgress;
    try {
      progress = await machine.advance(
        service,
        {
          jobId: job.id,
          attempt: run.attempt,
          gpu: read.gpu,
          minutes: read.minutes,
          command: read.command,
          maxCostUsd: read.estimateUsd * MAX_COST_FACTOR,
          ref: read.code!.ref,
          commit: read.code!.commit,
        },
        () => this.grant(service, job.id),
      );
    } catch (error) {
      // A refusal (no compute, a price over the cap) ends the run; an outage is tried again.
      if (!(error instanceof MervError) || error.status >= 500) throw error;
      progress = {
        state: 'failed',
        workflowId: run.workflowId ?? '',
        costUsd: null,
        captureArtifactId: null,
        final: null,
        error: `The machine could not start: ${error.message}`,
      };
    }
    if (progress.state === 'running') return;
    // The record says released only once every machine of the job is.
    if (!(await machine.release(service, job.id))) return;
    await this.code.gitRemote.revokeRun(job.projectId, job.id);
    await this.machineMove(service, job, 'finish_run', {
      run: { ...run, ...progress, workflowId: progress.workflowId || null, machineReleased: true },
    });
  }

  private async grant(service: Caller, jobId: string) {
    const origin = this.origin();
    check(origin, 'job_origin_unknown', 'Merv does not know its public address', 503);
    const issued = await this.code.gitRemote.issueRun(service, { jobId, seconds: GRANT_SECONDS });
    return { url: new URL(issued.url, origin).toString(), token: issued.token };
  }

  private async machineMove(service: Caller, job: WorkflowSnapshot, action: string, data: Data) {
    await this.state.transaction((tx) =>
      this.open().transition(
        service,
        {
          instanceId: job.id,
          expectedRevision: job.revision,
          action,
          requestId: `job:${job.id}:${job.revision}:${action}`,
          data,
        },
        tx,
      ),
    );
  }
}

const Config = z
  .object({ intervalMs: z.number().int().min(100).default(5000) })
  .strict()
  .default({});

export const jobsPlugin = {
  name: 'merv-jobs',
  inject: ['state', 'scope', 'workflows', 'sessions', 'code'],
  Config,
  async apply(ctx: Context, config: z.output<typeof Config> = Config.parse({})) {
    await ctx.effect(async function* () {
      const service = await createService(
        new JobsService(
          ctx.state,
          ctx.scope,
          ctx.workflows,
          ctx.sessions,
          ctx.code,
          () => ctx.get('api')?.publicOrigin,
        ),
      );
      service.issues = reporter(ctx);
      yield () => service.close();
      // A run's spend is admitted under Autoresearch's cap, and its machine rented on Sandboxes,
      // wherever they are loaded.
      ctx.inject(['autoresearch'], (ctx) => {
        ctx.effect(() => {
          service.room = (projectId, tx) => ctx.autoresearch.room(projectId, tx);
          return () => void (service.room = undefined);
        });
      });
      ctx.inject(
        ['sbxMerv', 'sbxPipelines', 'sbxJobs', 'sbxRegistry', 'sbxObjects', 'artifacts'],
        (ctx) => {
          ctx.effect(() => {
            service.machine = new SandboxesMachine(ctx);
            return () => void (service.machine = undefined);
          });
        },
      );
      service.start(config.intervalMs);
      yield ctx.provide('jobs', service);
    });
  },
};
export default jobsPlugin;

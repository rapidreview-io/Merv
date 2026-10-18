import type { Context } from 'cordis';
import type { State } from '@merv/contracts';
import type {
  ComputeStates,
  ComputeTarget,
  ComputeTargetState,
  ComputeWaiter,
} from '@merv/sessions/types';
import type {} from '@sandboxes/composition';
import { isTerminalJobState, type SbxJobs } from '@sandboxes/jobs';
import { isLive, NotFoundError } from '@sandboxes/kernel';
import type { SbxMerv } from '@sandboxes/merv-host/types';
import type { SbxPipelines } from '@sandboxes/pipelines';
import { workflowTerminal } from '@sandboxes/pipelines/graph';
import type { SandboxEvidence } from './sandbox-evidence.js';

/** How long a project's link is taken as read: every listing of a visit's tools asks it. */
const LINK_MS = 60_000;

/**
 * Where a waiting visit's jobs and workflows stand, for Sessions' `session.await_compute`, read
 * for that visit's own work and compute attempt, which its run intent holds rather than anything
 * the worker named: id reads are namespace-wide, so another work's or attempt's is unknown here.
 * Every read is outside Merv's transactions.
 */
export class SandboxComputeWaits implements ComputeWaiter {
  private readonly links = new Map<string, { linked: boolean; at: number }>();
  constructor(
    private readonly state: State,
    private readonly merv: Pick<SbxMerv, 'linked'>,
    private readonly jobs: Pick<SbxJobs, 'find'>,
    private readonly pipelines: Pick<SbxPipelines, 'get'>,
    private readonly registry: Pick<Context['sbxRegistry'], 'list'>,
    private readonly evidence: Pick<SandboxEvidence, 'workflowSettled'>,
    private readonly clock: () => number = Date.now,
  ) {}

  async offers(projectId: string): Promise<boolean> {
    const known = this.links.get(projectId);
    if (known && this.clock() - known.at < LINK_MS) return known.linked;
    const linked = (await this.merv.linked(projectId)) !== null;
    if (this.links.size >= 1000) this.links.clear();
    this.links.set(projectId, { linked, at: this.clock() });
    return linked;
  }

  async states(input: {
    projectId: string;
    instanceId: string;
    sessionId: string;
    targets: readonly ComputeTarget[];
  }): Promise<ComputeStates> {
    const unknown = (target: ComputeTarget): ComputeTargetState => ({
      ...target,
      status: 'unknown',
    });
    const run = await this.state.read((sql) =>
      sql.get<{ namespace: string; attempt_ref: string }>(
        'SELECT namespace,attempt_ref FROM sandbox_run_intents WHERE run_ref=? AND project_id=? AND work_ref=?',
        input.sessionId,
        input.projectId,
        input.instanceId,
      ),
    );
    if (!run) return { targets: input.targets.map(unknown), idle: [] };
    const ours = (record: {
      namespace: string;
      work_ref: string | null;
      attempt_ref: string | null;
    }) =>
      record.namespace === run.namespace &&
      record.work_ref === input.instanceId &&
      record.attempt_ref === run.attempt_ref;
    const targets: ComputeTargetState[] = [];
    /** Machines what is named keeps busy (never idle), and those whose lease bounds the wait. */
    const used = new Set<string>();
    const leased = new Set<string>();
    const deadlines: { target: ComputeTarget; at: number | null }[] = [];
    for (const target of input.targets) {
      if (target.kind === 'job') {
        const job = await this.jobs.find(target.id);
        if (!job || !ours(job)) targets.push(unknown(target));
        else if (isTerminalJobState(job.state))
          targets.push({
            ...target,
            status: job.state === 'succeeded' ? 'succeeded' : 'failed',
            state: job.state,
            ...(job.exit_code !== null && { exitCode: job.exit_code }),
          });
        else {
          targets.push({ ...target, status: 'running', state: job.state });
          used.add(job.sandbox_id);
          // A workflow's job runs within that workflow's deadline, on that workflow's machines.
          if (!job.request.workflow_id) leased.add(job.sandbox_id);
          const timeout = job.request.timeout_seconds;
          deadlines.push({
            target,
            at:
              job.started_at && timeout ? job.started_at.toDate().getTime() + timeout * 1000 : null,
          });
        }
        continue;
      }
      const workflow = await this.pipelines.get(run.namespace, target.id).catch((error) => {
        if (error instanceof NotFoundError) return null;
        throw error;
      });
      if (!workflow || !ours(workflow)) {
        targets.push(unknown(target));
        continue;
      }
      const finished = workflowTerminal(workflow.state);
      const settled = await this.evidence.workflowSettled(input.projectId, workflow);
      // Its own machines are its to delete; one it adopted is busy only while it runs.
      for (const node of workflow.request.nodes) {
        const machine: unknown = workflow.nodes[node.id]?.result?.sandbox_id;
        if (typeof machine !== 'string') continue;
        if (node.kind === 'provision') used.add(machine);
        if (node.kind === 'use_vm' && !finished) {
          used.add(machine);
          leased.add(machine);
        }
      }
      if (!settled) {
        targets.push({
          ...target,
          status: 'running',
          state: finished ? 'registering_captures' : workflow.state,
        });
        // It fails at its capture deadline; one that finished waits on its captures alone.
        deadlines.push({
          target,
          at: finished ? null : workflow.capture_deadline_at.toDate().getTime(),
        });
      } else
        targets.push({
          ...target,
          status:
            workflow.state === 'completed' && settled === 'registered' ? 'succeeded' : 'failed',
          state:
            workflow.state === 'completed' && settled === 'refused'
              ? 'capture_refused'
              : workflow.state,
        });
    }
    if (!targets.some((target) => target.status === 'running')) return { targets, idle: [] };
    const machines = (
      await this.registry.list(run.namespace, { workRef: input.instanceId })
    ).filter((machine) => isLive(machine.state));
    const lease = machines
      .filter((machine) => leased.has(machine.id) && machine.lease_expires_at)
      .map((machine) => ({
        machine: machine.id,
        endsAt: machine.lease_expires_at!.toDate().toISOString(),
      }))
      .reduce<ComputeStates['lease']>(
        (first, next) => (!first || next.endsAt < first.endsAt ? next : first),
        undefined,
      );
    // Only where every unfinished target has a deadline is there a time by which all have ended.
    const last = deadlines.every((deadline) => deadline.at !== null)
      ? deadlines.reduce<(typeof deadlines)[number] | undefined>(
          (latest, next) => (!latest || next.at! > latest.at! ? next : latest),
          undefined,
        )
      : undefined;
    return {
      targets,
      ...(lease && { lease }),
      ...(last && { deadline: { target: last.target, at: new Date(last.at!).toISOString() } }),
      idle: machines
        .filter((machine) => machine.attempt_ref === run.attempt_ref && !used.has(machine.id))
        .map((machine) => machine.id),
    };
  }
}

import { clip, MervError, type Caller } from '@merv/contracts';
import { captureCollection } from '@merv/sandboxes/sandbox-evidence';
import type { Context } from 'cordis';
import { mervRefusals } from '@sandboxes/merv-host/errors';
import type {} from '@sandboxes/merv-host/types';
import { shellQuote } from '@sandboxes/jobs';
import { workflowRequest, workflowTerminal, type WorkflowRecord } from '@sandboxes/pipelines';
import type {} from '@sandboxes/registry';
import type {} from '@sandboxes/storage';

const refusals = mervRefusals(MervError);
/** Where the commit is checked out on the machine; outputs/ under it is captured. */
const ROOT = '/tmp/merv-job';
/** Room before the command's own clock for renting and fetching, and after it for capture. */
const SETUP_SECONDS = 300;
const CAPTURE_SECONDS = 120;
const OUTPUT_BYTES = 1 << 30;
const TAIL_BYTES = 64 << 10;
/** The exit of a run whose branch no longer points at the job's commit. */
const CODE_CHANGED = 97;

/** One pass of a job through running, as Merv rents its machine. */
export interface MachineRun {
  jobId: string;
  attempt: number;
  gpu: string;
  minutes: number;
  command: string;
  maxCostUsd: number;
  ref: string;
  commit: string;
}
export interface MachineProgress {
  state: 'running' | 'succeeded' | 'failed' | 'cancelled';
  workflowId: string;
  costUsd: number | null;
  captureArtifactId: string | null;
  final: Record<string, number> | null;
  error: string | null;
}
/** The machine step's compute, which a test replaces with its own. */
export interface JobMachine {
  /** Whether the project has compute to rent at all. */
  linked(projectId: string): Promise<boolean>;
  /** Starts the attempt's run once, minting its Git read only then, and says where it stands. */
  advance(
    caller: Caller,
    run: MachineRun,
    grant: () => Promise<{ url: string; token: string }>,
  ): Promise<MachineProgress>;
  /** The latest METRIC readings of a running attempt, or null. */
  live(caller: Caller, jobId: string, attempt: number): Promise<Record<string, number> | null>;
  /** Cancels all of the job's remote work; true once its machines are released. */
  release(caller: Caller, jobId: string): Promise<boolean>;
}

/** The last value of each field of the `METRIC {json}` lines in `text`. */
export function metrics(text: string): Record<string, number> | null {
  let found: Record<string, number> | null = null;
  for (const line of text.split('\n')) {
    if (!line.startsWith('METRIC ')) continue;
    try {
      const value = JSON.parse(line.slice(7)) as unknown;
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      for (const [key, number] of Object.entries(value))
        if (typeof number === 'number' && Number.isFinite(number)) (found ??= {})[key] = number;
    } catch {
      // Ordinary output may start with METRIC too.
    }
  }
  return found;
}

/**
 * The script the machine runs: fetch exactly the pinned commit with the read grant from the
 * environment (never the command line), stop with "code changed" if the branch moved, then run
 * the job's command at the repository root.
 */
export function runScript(command: string, root = ROOT): string {
  return [
    'set -eu',
    `mkdir -p ${root} && cd ${root} && git init -q .`,
    'git -c http.extraHeader="Authorization: Bearer $MERV_GIT_TOKEN" fetch -q --depth 1 "$MERV_GIT_URL" "refs/heads/$MERV_GIT_REF"',
    'unset MERV_GIT_TOKEN',
    `test "$(git rev-parse FETCH_HEAD)" = "$MERV_GIT_COMMIT" || { echo "code changed" >&2; exit ${CODE_CHANGED}; }`,
    'git checkout -q --detach FETCH_HEAD && mkdir -p outputs',
    `exec sh -c ${shellQuote(command)}`,
  ].join('\n');
}

type Sbx = Pick<
  Context,
  'sbxMerv' | 'sbxPipelines' | 'sbxJobs' | 'sbxRegistry' | 'sbxObjects' | 'artifacts'
>;

/** The machine step on Sandboxes: one pipeline per attempt, scoped to the job as its work. */
export class SandboxesMachine implements JobMachine {
  constructor(private readonly sbx: Sbx) {}

  async linked(projectId: string) {
    return !!(await this.sbx.sbxMerv.linked(projectId));
  }

  private find(caller: Caller, jobId: string, attempt: number) {
    return refusals.call(async () => {
      const principal = await this.sbx.sbxMerv.principal(caller, 'write', {
        workRef: jobId,
        attemptRef: `a${attempt}`,
      });
      const page = await this.sbx.sbxPipelines.list(principal.namespace, { workRef: jobId });
      const record = page.workflows.find((item) => item.attempt_ref === `a${attempt}`);
      return { principal, record };
    });
  }

  async advance(
    caller: Caller,
    run: MachineRun,
    grant: () => Promise<{ url: string; token: string }>,
  ): Promise<MachineProgress> {
    let { principal, record } = await this.find(caller, run.jobId, run.attempt);
    if (!record) {
      const git = await grant();
      const seconds = run.minutes * 60;
      const request = workflowRequest({
        name: `job-${run.jobId}`.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 63),
        idempotency_key: `job:${run.jobId}:${run.attempt}`,
        timeout_seconds: seconds + SETUP_SECONDS,
        capture_grace_seconds: CAPTURE_SECONDS,
        max_cost: run.maxCostUsd.toFixed(2),
        nodes: [
          {
            id: 'machine',
            kind: 'provision',
            cleanup: 'always',
            request: { requirements: { gpu: run.gpu, gpu_count: 1 } },
          },
          {
            id: 'run',
            kind: 'run',
            vm: 'machine',
            depends_on: ['machine'],
            job: {
              command: runScript(run.command),
              timeout_seconds: seconds + SETUP_SECONDS,
              env: {
                MERV_GIT_URL: git.url,
                MERV_GIT_TOKEN: git.token,
                MERV_GIT_REF: run.ref,
                MERV_GIT_COMMIT: run.commit,
              },
            },
          },
          {
            id: 'outputs',
            kind: 'capture',
            vm: 'machine',
            depends_on: ['run'],
            when: 'always',
            output_bytes: OUTPUT_BYTES,
            outputs: [{ name: 'outputs', path: `${ROOT}/outputs`, required: false }],
          },
          { id: 'release', kind: 'release', vm: 'machine', depends_on: ['outputs'] },
        ],
      });
      record = await refusals.call(() =>
        this.sbx.sbxPipelines.submit({ namespace: principal.namespace, request, principal }),
      );
    }
    return await this.progress(caller, principal.namespace, principal.account_id, run, record);
  }

  private async progress(
    caller: Caller,
    namespace: string,
    accountId: string,
    run: MachineRun,
    record: WorkflowRecord,
  ): Promise<MachineProgress> {
    const base = { workflowId: record.id, error: null, final: null, captureArtifactId: null };
    if (!workflowTerminal(record.state)) return { ...base, state: 'running', costUsd: null };
    const jobId = record.nodes.run?.result.job_id as string | undefined;
    const sandboxId = record.nodes.machine?.result.sandbox_id as string | undefined;
    const [output, sandbox] = await Promise.all([
      jobId ? this.tail(namespace, jobId) : { text: '', exit: null },
      sandboxId ? refusals.call(() => this.sbx.sbxRegistry.get(namespace, sandboxId)) : null,
    ]);
    const cost = sandbox?.cost_so_far;
    return {
      ...base,
      state:
        record.state === 'completed'
          ? 'succeeded'
          : record.state === 'cancelled'
            ? 'cancelled'
            : 'failed',
      costUsd: cost && cost.currency === 'USD' ? Number(cost.amount.toString()) : null,
      final: metrics(output.text),
      error:
        output.exit === CODE_CHANGED
          ? 'code changed: the branch no longer points at the job’s commit'
          : record.error
            ? clip(JSON.stringify(record.error), 500)
            : null,
      captureArtifactId: await this.capture(caller, { namespace, accountId }, run, record),
    };
  }

  /** The run's outputs as one Merv artifact, kept once per attempt. */
  private async capture(
    caller: Caller,
    link: { namespace: string; accountId: string },
    run: MachineRun,
    record: WorkflowRecord,
  ) {
    const { captures } = await refusals.call(() =>
      this.sbx.sbxPipelines.captures(link.namespace, record.id, { limit: 1 }),
    );
    if (!captures[0]) return null;
    const work = { namespace: link.namespace, account_id: link.accountId, work_ref: run.jobId };
    const sbx = { pipelines: this.sbx.sbxPipelines, objects: this.sbx.sbxObjects };
    const input = await captureCollection(sbx, work, record, captures[0]);
    const artifact = await this.sbx.artifacts.createCollection(caller, {
      ...input,
      metadata: { ...input.metadata, jobId: run.jobId, commit: run.commit, ref: run.ref },
    });
    return artifact.id;
  }

  /** The end of the command's standard output, and how it exited. */
  private async tail(namespace: string, jobId: string) {
    return await refusals.call(async () => {
      const status = await this.sbx.sbxJobs.status({ namespace, jobId });
      const exit = status.exit_code;
      const extent = status.outputs.find((item) => item.stream === 'stdout');
      if (!extent) return { text: '', exit };
      const start = Math.max(extent.available_start, extent.total_length - TAIL_BYTES);
      const read = await this.sbx.sbxJobs.read({
        namespace,
        jobId,
        stream: extent.stream,
        ranges: [{ start, end: extent.total_length }],
        maxBytes: TAIL_BYTES,
      });
      return { text: read.data.toString('utf8'), exit };
    });
  }

  async live(caller: Caller, jobId: string, attempt: number) {
    const { principal, record } = await this.find(caller, jobId, attempt);
    const job = record?.nodes.run?.result.job_id as string | undefined;
    return job ? metrics((await this.tail(principal.namespace, job)).text) : null;
  }

  async release(caller: Caller, jobId: string) {
    const link = await this.sbx.sbxMerv.linked(caller.projectId);
    if (!link) return true;
    return await this.sbx.sbxMerv.releaseWork(caller, {
      namespace: link.namespace,
      accountId: link.account_id,
      workRef: jobId,
    });
  }
}

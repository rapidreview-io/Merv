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
/** The most of an ended run's output read for its curve: Sandboxes' largest read. */
const ENDED_BYTES = 4 << 20;
/** The most points a curve has; more are thinned evenly. */
export const MOST_POINTS = 500;
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
  /** Whether the command has begun on the machine (its run node left pending). */
  started: boolean;
  workflowId: string;
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
  /** The end of an attempt's standard output (more of it once the run has `ended`), or null
   *  when there is none; as `caller`, who only reads. */
  output(caller: Caller, jobId: string, attempt: number, ended: boolean): Promise<string | null>;
  /** Cancels all of the job's remote work. Null until every machine of it has stopped; then
   *  what the attempt's machines cost (costUsd null: not known). */
  release(
    caller: Caller,
    jobId: string,
    attempt: number,
  ): Promise<{ costUsd: number | null } | null>;
}

/** One reading of a curve: its step, and each metric's value there. */
export interface MetricPoint {
  step: number;
  values: Record<string, number>;
}

/** The numbers of each `METRIC {json}` line in `text`, in order. */
function readings(text: string): Record<string, number>[] {
  const found: Record<string, number>[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('METRIC ')) continue;
    try {
      const value = JSON.parse(line.slice(7)) as unknown;
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const numbers: Record<string, number> = {};
      for (const [key, number] of Object.entries(value))
        if (typeof number === 'number' && Number.isFinite(number)) numbers[key] = number;
      if (Object.keys(numbers).length) found.push(numbers);
    } catch {
      // Ordinary output may start with METRIC too.
    }
  }
  return found;
}

/** The last value of each field of the `METRIC {json}` lines in `text`. */
export function metrics(text: string): Record<string, number> | null {
  const all = readings(text);
  return all.length ? Object.assign({}, ...all) : null;
}

/**
 * Every `METRIC {json}` line in `text` as a point: its `step` field (else its place among the
 * lines, from 1) and its other numbers. At most `most`, thinned evenly, the first and last kept.
 */
export function curve(text: string, most = MOST_POINTS): MetricPoint[] {
  const points = readings(text)
    .map(({ step, ...values }, at) => ({ step: step ?? at + 1, values }))
    .filter((point) => Object.keys(point.values).length);
  if (points.length <= most) return points;
  return Array.from(
    { length: most },
    (_, i) => points[Math.round((i * (points.length - 1)) / (most - 1))]!,
  );
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

  private find(caller: Caller, jobId: string, attempt: number, need: 'read' | 'write' = 'write') {
    return refusals.call(async () => {
      const principal = await this.sbx.sbxMerv.principal(caller, need, {
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
    const base = {
      workflowId: record.id,
      started: (record.nodes.run?.state ?? 'pending') !== 'pending',
      error: null,
      final: null,
      captureArtifactId: null,
    };
    if (!workflowTerminal(record.state)) return { ...base, state: 'running' };
    const jobId = record.nodes.run?.result.job_id as string | undefined;
    const output = jobId ? await this.tail(namespace, jobId) : { text: '', exit: null };
    return {
      ...base,
      state:
        record.state === 'completed'
          ? 'succeeded'
          : record.state === 'cancelled'
            ? 'cancelled'
            : 'failed',
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

  /** The end of the command's standard output, `bytes` of it at most, and how it exited. */
  private async tail(namespace: string, jobId: string, bytes = TAIL_BYTES) {
    return await refusals.call(async () => {
      const status = await this.sbx.sbxJobs.status({ namespace, jobId });
      const exit = status.exit_code;
      const extent = status.outputs.find((item) => item.stream === 'stdout');
      if (!extent) return { text: '', exit };
      const start = Math.max(extent.available_start, extent.total_length - bytes);
      const read = await this.sbx.sbxJobs.read({
        namespace,
        jobId,
        stream: extent.stream,
        ranges: [{ start, end: extent.total_length }],
        maxBytes: bytes,
      });
      return { text: read.data.toString('utf8'), exit };
    });
  }

  async output(caller: Caller, jobId: string, attempt: number, ended: boolean) {
    const { principal, record } = await this.find(caller, jobId, attempt, 'read');
    const job = record?.nodes.run?.result.job_id as string | undefined;
    const bytes = ended ? ENDED_BYTES : TAIL_BYTES;
    return job ? (await this.tail(principal.namespace, job, bytes)).text : null;
  }

  async release(caller: Caller, jobId: string, attempt: number) {
    const link = await this.sbx.sbxMerv.linked(caller.projectId);
    if (!link) return { costUsd: null };
    const work = { namespace: link.namespace, accountId: link.account_id, workRef: jobId };
    if (!(await this.sbx.sbxMerv.releaseWork(caller, work))) return null;
    // Released once each machine has stopped, so its cost no longer grows; none rented costs 0.
    const machines = (
      await refusals.call(() =>
        this.sbx.sbxRegistry.list(link.namespace, { workRef: jobId, includeStopped: true }),
      )
    ).filter((machine) => machine.attempt_ref === `a${attempt}`);
    if (machines.some((machine) => machine.state !== 'stopped' && machine.state !== 'failed'))
      return null;
    const costs = machines.map((machine) => machine.cost_so_far);
    return {
      costUsd: costs.every((cost) => cost?.currency === 'USD')
        ? costs.reduce((sum, cost) => sum + Number(cost!.amount.toString()), 0)
        : null,
    };
  }
}

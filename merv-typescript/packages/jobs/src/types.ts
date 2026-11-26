import type { JobsService } from './index.js';
import type {} from 'cordis';

export type JobState =
  'proposed' | 'writing' | 'running' | 'reviewing' | 'stopping' | 'done' | 'stopped';
/** Where a step runs: the person's own Mac, or a rented machine Merv drives. */
export type JobPlace = 'mac' | 'machine';
/** What a job is for and what its machine step runs, as the person approved it. */
export interface JobPlan {
  title: string;
  goal: string;
  doneMeans: string;
  /** Run at the job's commit, from the repository root. */
  command: string;
  gpu: string;
  minutes: number;
  /** The whole machine lease, which the run may cost at most 1.5 times. */
  estimateUsd: number;
}
export interface JobRun {
  /** One per pass through running: the revision it entered running at. */
  attempt: number;
  state: 'starting' | 'running' | 'succeeded' | 'failed' | 'cancelling' | 'cancelled';
  workflowId: string | null;
  costUsd: number | null;
  captureArtifactId: string | null;
  /** The last value of each METRIC field the command printed. */
  final: Record<string, number> | null;
  error: string | null;
  /** True once every machine the run rented is released. */
  machineReleased: boolean;
}
export interface JobResult {
  verdict: 'accept' | 'revise';
  /** The commit the reviewer read; a later commit makes this verdict stale. */
  commitRead: string;
  summary: string;
  nextJobId: string | null;
}
/** A job as job.read answers it: its record, and when its moves were made. */
export interface JobRead extends Omit<JobView, 'run'> {
  /** When the person pressed Run (null for a job never run). */
  runRequestedAt: string | null;
  run:
    | (JobRun & {
        /** When the attempt's command began on the machine, and when its run finished or was
         *  stopped; null until then, or when it was never seen. */
        startedAt: string | null;
        endedAt: string | null;
        /** job.read get only, while it runs and Sandboxes says (else null): what the attempt's
         *  machines cost so far, and their hourly rate. */
        costSoFarUsd?: number | null;
        hourlyUsd?: number | null;
      })
    | null;
}
export interface JobView extends JobPlan {
  id: string;
  state: JobState;
  revision: number;
  steps: { state: 'writing' | 'running' | 'reviewing'; place: JobPlace }[];
  code: { ref: string; commit: string } | null;
  run: JobRun | null;
  result: JobResult | null;
  /** Reviews that may still send the code back. */
  revisionsLeft: number;
  previousJobId: string | null;
  createdAt: string;
  updatedAt: string;
}
/** The project's cap, what Sandboxes says is spent plus every running job's estimate, and the rest. */
export interface JobAllowance {
  capUsd: number;
  /** Already spent: Sandboxes' report, never less than the costs finished jobs recorded. */
  spentUsd: number;
  /** Held: the estimates of jobs (and Autoresearch runs) running or stopping. */
  heldUsd: number;
  /** spentUsd + heldUsd. */
  committedUsd: number;
  leftUsd: number;
}
export interface JobMove {
  jobId: string;
  expectedRevision: number;
  requestId: string;
}
declare module 'cordis' {
  interface Context {
    jobs: JobsService;
  }
}

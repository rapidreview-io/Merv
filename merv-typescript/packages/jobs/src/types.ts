import type { Caller } from '@merv/contracts';
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
export interface Jobs {
  propose(caller: Caller, input: JobPlan & { requestId: string }): Promise<JobView>;
  run(caller: Caller, input: JobMove): Promise<JobView>;
  stop(caller: Caller, input: JobMove & { reason?: string }): Promise<JobView>;
  list(caller: Caller): Promise<{ jobs: JobView[] }>;
  get(
    caller: Caller,
    input: { jobId: string },
  ): Promise<{ job: JobView; live: Record<string, number> | null }>;
  submitCode(caller: Caller, input: JobMove & { ref: string; commit: string }): Promise<JobView>;
  review(
    caller: Caller,
    input: JobMove & {
      verdict: 'accept' | 'revise';
      commitRead: string;
      summary: string;
      next?: JobPlan;
    },
  ): Promise<JobView>;
}
export interface JobMove {
  jobId: string;
  expectedRevision: number;
  requestId: string;
}
declare module 'cordis' {
  interface Context {
    jobs: Jobs;
  }
}

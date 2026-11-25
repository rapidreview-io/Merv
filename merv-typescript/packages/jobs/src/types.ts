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

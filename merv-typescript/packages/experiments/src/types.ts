import type {
  Caller,
  CodeUnit,
  ProcessGraph,
  ReviewApplication,
  RunningNode,
  RunningPanelPart,
  Transaction,
} from '@merv/contracts';
import type {} from 'cordis';
import type { SandboxCompute } from '@merv/sandboxes/types';
import type {
  Experiment,
  ExperimentAttach,
  ExperimentCreate,
  ExperimentEvidence,
  ExperimentExhibit,
  ExperimentOccupancy,
  ExperimentTransition,
} from './models.js';
export type * from './models.js';

export interface ComputeInput {
  experimentId: string;
  attemptIndex: number;
  key: string;
  provider: string;
  offerId: string;
  command: string;
  minutes: number;
  maxUsd: number;
  commandId?: string;
  inputs?: { artifactId: string; path: string }[];
}

export interface Experiments {
  bindCompute(adapter: SandboxCompute): () => void;
  computeOffers(caller: Caller): Promise<import('@merv/contracts').Data>;
  computeRun(caller: Caller, input: ComputeInput): Promise<unknown>;
  computeCancel(caller: Caller, experimentId: string, runId: string): Promise<unknown>;
  computeTick(): Promise<void>;
  create(caller: Caller, input: ExperimentCreate, tx?: Transaction): Promise<Experiment>;
  get(caller: Caller, experimentId: string, tx?: Transaction): Promise<Experiment>;
  list(caller: Caller, tx?: Transaction): Promise<Experiment[]>;
  /** Every experiment's name, lowercased, and how many are not yet complete, abandoned or failed. */
  occupancy(caller: Caller, tx?: Transaction): Promise<ExperimentOccupancy>;
  attach(caller: Caller, input: ExperimentAttach, tx?: Transaction): Promise<ExperimentEvidence>;
  transition(caller: Caller, input: ExperimentTransition, tx?: Transaction): Promise<Experiment>;
  exhibit(caller: Caller, experimentId: string, tx?: Transaction): Promise<ExperimentExhibit>;
  /** The derived process graph, so a record page reads its gate with the record. */
  process(caller: Caller, experimentId: string): Promise<ProcessGraph>;
  /**
   * The Running page's cards: open experiments, any `work:<id>` key in `include`, an ended
   * one a GPU run still holds, and each live GPU run as `compute:<digest>`. No gate is evaluated.
   */
  running(caller: Caller, include?: ReadonlySet<string>): Promise<RunningNode[]>;
  /** The sidebar of `work:<experimentId>` or `compute:<digest>`; null for any other key. */
  runningPanel(caller: Caller, key: string): Promise<RunningPanelPart | null>;
  /** What the optional Code plugin holds for a Git experiment; null without it. */
  codeUnit(caller: Caller, experimentId: string): Promise<CodeUnit | null>;
  submitReview(caller: Caller, input: ReviewApplication, tx?: Transaction): Promise<Experiment>;
  /** Withdraw generic review routing before the provider's dependent consumers drain. */
  withdrawReviewOwner(): void;
  close(): void;
}
declare module 'cordis' {
  interface Context {
    experiments: Experiments;
  }
}

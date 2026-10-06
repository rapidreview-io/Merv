import type {
  Caller,
  ProcessGraph,
  ReviewApplication,
  RunningNode,
  RunningPanelPart,
  Transaction,
  WorkRoute,
} from '@merv/contracts';
import type {} from 'cordis';
import type { Sandboxes } from '@merv/sandboxes/types';
import type { PaperChanges } from '@merv/paper/types';
import type {
  Experiment,
  ExperimentAttach,
  ExperimentCreate,
  ExperimentEvidence,
  ExperimentExhibit,
  ExperimentOccupancy,
  ExperimentTransition,
} from './models.js';
import type { CodeUnit } from '@merv/code-work/models';
export type * from './models.js';

/** An experiment verdict, with the reviewer's own Methods/Results edits. */
export interface ExperimentReview extends ReviewApplication {
  paperChanges?: PaperChanges;
}

export interface Experiments {
  bindSandboxes(service: Pick<Sandboxes, 'captures'>): () => void;
  create(caller: Caller, input: ExperimentCreate, tx?: Transaction): Promise<Experiment>;
  get(caller: Caller, experimentId: string, tx?: Transaction): Promise<Experiment>;
  list(caller: Caller, tx?: Transaction): Promise<Experiment[]>;
  /** Each experiment's name, intent, owner and workflow, in list order, read for all at once. */
  summaries(
    caller: Caller,
  ): Promise<Pick<Experiment, 'id' | 'name' | 'intent' | 'ownerId' | 'workflow'>[]>;
  /** Every experiment's name, lowercased, and how many are not yet complete, abandoned or failed. */
  occupancy(caller: Caller, tx?: Transaction): Promise<ExperimentOccupancy>;
  /**
   * Refuses creating experiments of these names as creating each would: a name an experiment
   * already uses (experiment_name_conflict), or more active experiments than a project may have
   * (experiment_limit). Reads only.
   */
  admits(caller: Caller, names: readonly string[], tx?: Transaction): Promise<void>;
  attach(caller: Caller, input: ExperimentAttach, tx?: Transaction): Promise<ExperimentEvidence>;
  transition(caller: Caller, input: ExperimentTransition, tx?: Transaction): Promise<Experiment>;
  exhibit(caller: Caller, experimentId: string, tx?: Transaction): Promise<ExperimentExhibit>;
  /** The derived process graph, so a record page reads its gate with the record. */
  process(caller: Caller, experimentId: string): Promise<ProcessGraph>;
  /**
   * The Running page's cards: open experiments and any `work:<id>` key in `include`. No gate
   * is evaluated.
   */
  running(caller: Caller, include?: ReadonlySet<string>): Promise<RunningNode[]>;
  /** The sidebar of `work:<experimentId>`; null for any other key. */
  runningPanel(caller: Caller, key: string, route?: WorkRoute): Promise<RunningPanelPart | null>;
  /** What the optional Code plugin holds for a Git experiment; null without it. */
  codeUnit(caller: Caller, experimentId: string): Promise<CodeUnit | null>;
  submitReview(caller: Caller, input: ExperimentReview, tx?: Transaction): Promise<Experiment>;
  /** Withdraw generic review routing before the provider's dependent consumers drain. */
  withdrawReviewOwner(): void;
  close(): void;
}
declare module 'cordis' {
  interface Context {
    experiments: Experiments;
  }
}

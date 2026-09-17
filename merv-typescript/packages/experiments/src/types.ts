import type { Caller, ProcessGraph, ReviewApplication, Transaction } from '@merv/contracts';
import type {} from 'cordis';
import type {
  Experiment,
  ExperimentAttach,
  ExperimentCreate,
  ExperimentEvidence,
  ExperimentExhibit,
  ExperimentTransition,
} from './models.js';
export type * from './models.js';

export interface Experiments {
  create(caller: Caller, input: ExperimentCreate, tx?: Transaction): Promise<Experiment>;
  get(caller: Caller, experimentId: string, tx?: Transaction): Promise<Experiment>;
  list(caller: Caller, tx?: Transaction): Promise<Experiment[]>;
  attach(caller: Caller, input: ExperimentAttach, tx?: Transaction): Promise<ExperimentEvidence>;
  transition(caller: Caller, input: ExperimentTransition, tx?: Transaction): Promise<Experiment>;
  exhibit(caller: Caller, experimentId: string, tx?: Transaction): Promise<ExperimentExhibit>;
  /** The derived process graph, so a record page reads its gate with the record. */
  process(caller: Caller, experimentId: string): Promise<ProcessGraph>;
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

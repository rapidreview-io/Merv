import type { Caller, Transaction } from '@merv/contracts';
import type {} from 'cordis';
import type {
  AutoresearchConfigure,
  AutoresearchDecide,
  AutoresearchSpend,
  AutoresearchStatus,
} from './models.js';
export type * from './models.js';

export interface Autoresearch {
  /** Where the project's autoresearch stands: settings, spend, runs and the manager's lines. */
  status(caller: Caller): Promise<AutoresearchStatus>;
  /** A project admin's settings; `enabled: true` starts the manager's first round. */
  configure(caller: Caller, input: AutoresearchConfigure): Promise<AutoresearchStatus>;
  /** A person's pause, resume, new round or end of the round. */
  control(
    caller: Caller,
    action: 'pause' | 'resume' | 'start_round' | 'end_round',
    input: { requestId: string; goal?: string; summary?: string },
  ): Promise<AutoresearchStatus>;
  /** The leased manager's decision at the end of a visit. */
  decide(
    caller: Caller,
    input: AutoresearchDecide,
  ): Promise<{ decided: 'wait' | 'end'; state: string; next: string }>;
  /** The project's cap and its spend since `since` (its round's start; null: ever) that another
   *  program's run is admitted against; `fresh` false lets a page's read be up to 15 s old. */
  room(
    projectId: string,
    tx: Transaction,
    fresh?: boolean,
  ): Promise<AutoresearchSpend & { since: string | null }>;
  close(): void;
}
declare module 'cordis' {
  interface Context {
    autoresearch: Autoresearch;
  }
}

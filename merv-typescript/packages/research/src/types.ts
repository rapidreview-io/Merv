import type { Caller, Transaction } from '@merv/contracts';
import type {} from 'cordis';
import type {
  ResearchCreate,
  ResearchAdvance,
  ResearchEnd,
  ResearchLineage,
  ResearchRecord,
  ResearchReplan,
} from './models.js';
export type * from './models.js';

export interface Research {
  create(caller: Caller, input: ResearchCreate, tx?: Transaction): Promise<ResearchRecord>;
  get(caller: Caller, id: string, tx?: Transaction): Promise<ResearchRecord>;
  list(caller: Caller, tx?: Transaction): Promise<ResearchRecord[]>;
  /** What Home and the rail poll: every open cycle and the newest that ended, oldest first. */
  home(caller: Caller): Promise<ResearchRecord[]>;
  active(caller: Caller): Promise<number>;
  /** The cycles this one follows, oldest first, each with its digest, and the one that follows it. */
  lineage(caller: Caller, id: string, tx?: Transaction): Promise<ResearchLineage>;
  advance(caller: Caller, input: ResearchAdvance, tx?: Transaction): Promise<ResearchRecord>;
  end(caller: Caller, input: ResearchEnd, tx?: Transaction): Promise<ResearchRecord>;
  replan(caller: Caller, input: ResearchReplan, tx?: Transaction): Promise<ResearchRecord>;
  close(): void;
}
declare module 'cordis' {
  interface Context {
    research: Research;
  }
}

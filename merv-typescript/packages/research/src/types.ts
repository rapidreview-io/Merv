import type { Caller, Transaction } from '@merv/contracts';
import type {} from 'cordis';
import type { Reflection, ReflectionCreate } from '@merv/reflections/types';
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
  startReflection(caller: Caller, input: ReflectionCreate, tx?: Transaction): Promise<Reflection>;
  create(caller: Caller, input: ResearchCreate, tx?: Transaction): Promise<ResearchRecord>;
  get(caller: Caller, id: string, tx?: Transaction): Promise<ResearchRecord>;
  list(caller: Caller, tx?: Transaction): Promise<ResearchRecord[]>;
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

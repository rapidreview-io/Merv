import type { Caller, Transaction } from '@merv/contracts';
import type {} from 'cordis';
import type { Reflection, ReflectionCreate } from '@merv/reflections/types';
import type { ResearchCreate, ResearchAdvance, ResearchRecord } from './models.js';
export type * from './models.js';

export interface Research {
  startReflection(caller: Caller, input: ReflectionCreate, tx?: Transaction): Promise<Reflection>;
  create(caller: Caller, input: ResearchCreate, tx?: Transaction): Promise<ResearchRecord>;
  get(caller: Caller, id: string, tx?: Transaction): Promise<ResearchRecord>;
  list(caller: Caller, tx?: Transaction): Promise<ResearchRecord[]>;
  advance(caller: Caller, input: ResearchAdvance, tx?: Transaction): Promise<ResearchRecord>;
  close(): void;
}
declare module 'cordis' {
  interface Context {
    research: Research;
  }
}

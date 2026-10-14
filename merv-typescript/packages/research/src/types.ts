import type { Caller, Transaction } from '@merv/contracts';
import type {} from 'cordis';
import type { ProcessGraph } from '@merv/workflows/models';
import type { z } from 'zod';
import type { advanceSchema, createSchema, endSchema, replanSchema } from './input.js';
import type { ResearchLineage, ResearchRecord } from './models.js';
export type * from './models.js';
/** Each command's input as its schema in input.ts takes it, before defaults. */
export type ResearchCreate = z.input<typeof createSchema>;
/** The owner's answer to a plan that continues rides on the advance that completes the cycle. */
export type ResearchAdvance = z.input<typeof advanceSchema>;
/** Ending a cycle that cannot reach an answer. Terminal; the reason is recorded. */
export type ResearchEnd = z.input<typeof endSchema>;
/** The cycle's selected work, reselected whole: what is missing is added, what is left out is dropped. */
export type ResearchReplan = z.input<typeof replanSchema>;

export interface Research {
  create(caller: Caller, input: ResearchCreate, tx?: Transaction): Promise<ResearchRecord>;
  get(caller: Caller, id: string, tx?: Transaction): Promise<ResearchRecord>;
  /**
   * What a cycle's page polls: the cycle, and the stage it stands at read without running an
   * action's check (its page draws no action; its move reads its own gate).
   */
  page(caller: Caller, id: string): Promise<{ record: ResearchRecord; process: ProcessGraph }>;
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

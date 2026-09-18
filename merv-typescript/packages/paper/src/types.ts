import type { Caller, Transaction } from '@merv/contracts';
import type {} from 'cordis';
import type {
  PaperWorkspace,
  PaperKind,
  PaperRevision,
  PaperPatch,
  PaperCite,
  PaperCitation,
  PaperPropose,
  PaperProposal,
  PaperAccept,
  PaperPublication,
} from './models.js';
export type * from './models.js';
export interface Paper {
  read(caller: Caller, tx?: Transaction): Promise<PaperWorkspace>;
  history(caller: Caller, kind: PaperKind, tx?: Transaction): Promise<PaperRevision[]>;
  patch(caller: Caller, input: PaperPatch, tx?: Transaction): Promise<PaperRevision>;
  cite(caller: Caller, input: PaperCite, tx?: Transaction): Promise<PaperCitation>;
  /** Trusted scientific owner integration; not exposed as an independently callable tool. */
  propose(caller: Caller, input: PaperPropose, tx: Transaction): Promise<PaperProposal>;
  /** Parse a change artifact against the current paper without proposing it. */
  validate(caller: Caller, artifactId: string, tx: Transaction): Promise<unknown>;
  /** The owning workflow checks and submits its exact review in the same transaction. */
  accept(caller: Caller, input: PaperAccept, tx: Transaction): Promise<PaperPublication[]>;
  /** The checks accept() makes before it writes; a preflight that names what a pass would hit. */
  checkAccept(caller: Caller, input: PaperAccept, tx: Transaction): Promise<unknown>;
  close(): void;
}
declare module 'cordis' {
  interface Context {
    paper: Paper;
  }
}

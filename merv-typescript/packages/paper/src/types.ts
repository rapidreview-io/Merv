import type { Caller, Transaction } from '@merv/contracts';
import type {} from 'cordis';
import type {
  PaperWorkspace,
  PaperKind,
  PaperRevision,
  PaperPatch,
  PaperCite,
  PaperCitation,
  PaperReview,
  PaperPublication,
} from './models.js';
export type * from './models.js';
export interface Paper {
  read(caller: Caller, tx?: Transaction): Promise<PaperWorkspace>;
  history(caller: Caller, kind: PaperKind, tx?: Transaction): Promise<PaperRevision[]>;
  patch(caller: Caller, input: PaperPatch, tx?: Transaction): Promise<PaperRevision>;
  cite(caller: Caller, input: PaperCite, tx?: Transaction): Promise<PaperCitation>;
  /** The owner verifies the review; paper edits and verdict commit or roll back together. */
  applyReview(caller: Caller, input: PaperReview, tx: Transaction): Promise<PaperPublication[]>;
  /** Validate reviewer edits against the current paper without writing. */
  checkReview(caller: Caller, input: PaperReview, tx: Transaction): Promise<unknown>;
  close(): void;
}
declare module 'cordis' {
  interface Context {
    paper: Paper;
  }
}

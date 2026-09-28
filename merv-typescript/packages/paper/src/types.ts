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
/** One section of one paper revision, whole, as a context item needs it. */
export interface PaperContextSection {
  kind: PaperKind;
  status: 'current' | 'published';
  revision: number;
  /** Distinct across the list: `paper:{kind}:{status}:{revision}:{index}:{section id}`. */
  id: string;
  /** `{kind} {status}: {section title}`. */
  title: string;
  /** The section's content, whole. */
  text: string;
  /** Provenance: the document, status and section, when it was updated, and its publication. */
  note: string;
  /** Where the section is read again. */
  refs: { tool: string; input: Record<string, string | number | boolean | null> }[];
}
export interface Paper {
  read(caller: Caller, tx?: Transaction): Promise<PaperWorkspace>;
  history(caller: Caller, kind: PaperKind, tx?: Transaction): Promise<PaperRevision[]>;
  patch(caller: Caller, input: PaperPatch, tx?: Transaction): Promise<PaperRevision>;
  cite(caller: Caller, input: PaperCite, tx?: Transaction): Promise<PaperCitation>;
  /** The owner verifies the review; paper edits and verdict commit or roll back together. */
  applyReview(caller: Caller, input: PaperReview, tx: Transaction): Promise<PaperPublication[]>;
  /** Validate reviewer edits against the current paper without writing. */
  checkReview(caller: Caller, input: PaperReview, tx: Transaction): Promise<unknown>;
  /**
   * The documents `read` returned, as whole sections in the paper's order, for a context that
   * budgets them item by item. Reads nothing.
   */
  contextSections(documents: PaperWorkspace['documents']): PaperContextSection[];
  close(): void;
}
declare module 'cordis' {
  interface Context {
    paper: Paper;
  }
}

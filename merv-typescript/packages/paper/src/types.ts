import type { Caller, ContextInput, Transaction } from '@merv/contracts';
import type {} from 'cordis';
import type { z } from 'zod';
import type { changesSchema, citeSchema, patchSchema, reviewSchema } from './input.js';
import type {
  PaperWorkspace,
  PaperDocument,
  PaperKind,
  PaperRevision,
  PaperRevisionSummary,
  PaperCitation,
  PaperPublication,
} from './models.js';
export type * from './models.js';
/** Each command's input as its schema in input.ts takes it, before defaults. */
export type PaperPatch = z.input<typeof patchSchema>;
export type PaperChanges = z.input<typeof changesSchema>;
/** One document's edits in a reviewer's paper changes. */
export type PaperEdit = PaperChanges['documents'][number];
export type PaperCite = z.input<typeof citeSchema>;
/** Trusted owner input: the owner verifies the live, independent review in the same transaction. */
export type PaperReview = z.input<typeof reviewSchema>;
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
  /**
   * Its context priority, which each consumer ranks its own items around: the problem's current
   * sections 850, the other current sections 600, the problem's published sections 450 and the
   * other published sections 250.
   */
  priority: number;
  /** Provenance: the document, status and section, when it was updated, and its publication. */
  note: string;
  /** Where the section is read again. */
  refs: { tool: string; input: Record<string, string | number | boolean | null> }[];
}
export interface Paper {
  read(caller: Caller, tx?: Transaction): Promise<PaperWorkspace>;
  /** Only `read`'s documents, in one query: what a context reads of the paper. */
  documents(caller: Caller, tx?: Transaction): Promise<PaperWorkspace['documents']>;
  /** One of `documents`, read alone. */
  document(caller: Caller, kind: PaperKind, tx?: Transaction): Promise<PaperDocument>;
  /** Every retained revision of a document, without its section bodies; `revision` has them. */
  history(caller: Caller, kind: PaperKind, tx?: Transaction): Promise<PaperRevisionSummary[]>;
  /** One retained revision of a document, or null where it has none of that number. */
  revision(
    caller: Caller,
    kind: PaperKind,
    revision: number,
    tx?: Transaction,
  ): Promise<PaperRevision | null>;
  patch(caller: Caller, input: PaperPatch, tx?: Transaction): Promise<PaperRevision>;
  cite(caller: Caller, input: PaperCite, tx?: Transaction): Promise<PaperCitation>;
  /** The owner verifies the review; paper edits and verdict commit or roll back together. */
  applyReview(caller: Caller, input: PaperReview, tx: Transaction): Promise<PaperPublication[]>;
  /** Reviewer paper changes as a review submission carries them, parsed (invalid_input). */
  parseChanges(value: unknown): PaperChanges;
  /** Validate reviewer edits against the current paper without writing. */
  checkReview(caller: Caller, input: PaperReview, tx: Transaction): Promise<unknown>;
  /**
   * The paper as one context section's items, for a recipe of `maxChars`: its written sections
   * whole, highest priority first, while they could still be embedded, then one item naming the
   * rest. At most 384 KiB of JSON, so a lease may freeze it.
   */
  contextInput(caller: Caller, maxChars: number, tx: Transaction): Promise<ContextInput>;
  close(): void;
}
declare module 'cordis' {
  interface Context {
    paper: Paper;
  }
}

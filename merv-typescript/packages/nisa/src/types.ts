import type {} from 'cordis';
import type { Caller } from '@merv/contracts';
import type { z } from 'zod';
import type * as input from './input.js';

/** Each input as its schema in input.ts takes it, before defaults; the schema describes it. */
export type NisaConfig = z.input<typeof input.nisaConfig>;
export type NisaSearchInput = z.input<typeof input.searchInput>;
export type NisaSemanticSearchInput = z.input<typeof input.semanticInput>;
export type NisaPaperInput = z.input<typeof input.paperInput>;
export type NisaExcerptsInput = z.input<typeof input.excerptsInput>;
export type NisaRelatedInput = z.input<typeof input.relatedInput>;

/** One paper as every Nisa tool answers it: only these fields, whatever Nisa sent. identifier,
 * title, authors, year and url name it as a citation does. */
export interface NisaPaper {
  /** arxiv:<arxiv_id>. */
  identifier: string;
  /** Unversioned; an old-style ID in its slash form. */
  arxiv_id: string;
  title: string;
  /** At most 12 in a list, with more_authors saying how many are left out; 100 from nisa.paper. */
  authors: string[];
  more_authors?: number;
  /** As Nisa gives it, or else the year the arXiv ID was submitted in. */
  year: number | null;
  /** The paper's arXiv abstract page. */
  url: string;
  citation_count: number | null;
  /** The search's own score: BM25 for nisa.search, similarity for the others; null for nisa.paper. */
  score: number | null;
  /** Passages that matched a keyword search; empty for every other tool. */
  snippets: string[];
  /** The abstract: its start in a semantic or related list, whole (to 10,000 characters) from
   * nisa.paper. */
  abstract?: string;
  /** arXiv categories, from nisa.paper. */
  categories?: string[];
}
export interface NisaPaperList {
  papers: NisaPaper[];
  count: number;
  offset: number;
  /** More papers match than this page holds; ask again with offset = next_offset, which is
   * absent past the furthest offset Nisa pages to (500, or 200 by meaning). */
  truncated: boolean;
  next_offset?: number;
  /** The newest month (YYYYMM) in Nisa's keyword index: a later window finds nothing yet. */
  index_latest_pub_month?: number;
  /** Set when snippets or abstracts were shortened so the answer fits an agent's context, or when
   * the next page lies past the furthest offset. */
  note?: string;
}
export interface NisaRelated {
  /** The seed paper. */
  arxiv_id: string;
  papers: NisaPaper[];
  count: number;
  note?: string;
}
export interface NisaExcerpts {
  identifier: string;
  arxiv_id: string;
  url: string;
  excerpts: string[];
  count: number;
  /** Nisa found more matching passages than it returned. */
  truncated: boolean;
  /** Whether Nisa holds the paper at all, and its full text: no excerpts means no match only when
   * both are true. */
  doc_found?: boolean;
  full_text_indexed?: boolean;
  matched_terms?: string[];
  missing_terms?: string[];
  note?: string;
}

/**
 * Nisa's literature search over its public API, with the deployment's one key. Every call
 * validates its input, is bounded in time and bytes, takes its turn among its project's calls,
 * and answers only the allowlisted fields above; each failure is a nisa_* error that repeats
 * nothing Nisa said. Authorization belongs to the tools that call it: any project reader may
 * search.
 */
export interface Nisa {
  research(
    caller: Caller,
    input: import('./research.js').ResearchInput,
  ): Promise<ReturnType<typeof import('./research.js').researchResult>>;
  search(caller: Caller, input: NisaSearchInput): Promise<NisaPaperList>;
  semanticSearch(caller: Caller, input: NisaSemanticSearchInput): Promise<NisaPaperList>;
  paper(caller: Caller, input: NisaPaperInput): Promise<NisaPaper>;
  excerpts(caller: Caller, input: NisaExcerptsInput): Promise<NisaExcerpts>;
  related(caller: Caller, input: NisaRelatedInput): Promise<NisaRelated>;
  close(): void;
}

declare module 'cordis' {
  interface Context {
    nisa: Nisa;
  }
}

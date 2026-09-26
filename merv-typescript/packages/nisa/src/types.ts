import type {} from 'cordis';

/** Configuration names the key's environment variable and never carries the key. */
export interface NisaConfig {
  /** Nisa's API origin: https, or loopback http for tests. https://api.rapidreview.io by default. */
  origin?: string;
  /** Environment variable holding the deployment's rr_sk_ key, read on every call. */
  keyEnv?: string;
  /** Deadline for a paper, excerpts or related call, headers and body together. */
  timeoutMs?: number;
  /** Deadline for a keyword or semantic search. */
  searchTimeoutMs?: number;
  /** A larger answer is refused, whatever its Content-Length says. */
  maxResponseBytes?: number;
  /** Calls this process has in flight to Nisa at once; the next waits its turn. */
  maxInFlight?: number;
  /** How long a call waits for its turn before it is refused with nisa_busy. */
  queueMs?: number;
}

/** An arXiv ID in either form: 2303.08774, or hep-th/9901001 (hep-th_9901001 as Nisa's index
 * writes it). A version suffix or an arxiv: prefix is dropped. */
export type NisaArxivId = string;

export interface NisaSearchInput {
  /** One plain keyword query, or up to 8 phrasings searched together. */
  query: string | string[];
  max_results?: number;
  offset?: number;
  author?: string;
  /** YYYY, YYYY-MM or YYYY-MM-DD; Nisa's index keeps months, so a day narrows nothing. */
  date_from?: string;
  date_to?: string;
}
export interface NisaSemanticSearchInput {
  /** One natural-language query, or up to 4 paraphrases. */
  query: string | string[];
  max_results?: number;
  offset?: number;
  author?: string;
  year_min?: number;
  year_max?: number;
}
export interface NisaPaperInput {
  arxiv_id: NisaArxivId;
}
export interface NisaExcerptsInput {
  arxiv_id: NisaArxivId;
  query: string;
  max_excerpts?: number;
}
export interface NisaRelatedInput {
  arxiv_id: NisaArxivId;
  max_results?: number;
}

/** One paper as every Nisa tool answers it: only these fields, whatever Nisa sent. identifier,
 * title, authors, year and url are what paper.cite takes. */
export interface NisaPaper {
  /** arxiv:<arxiv_id>. */
  identifier: string;
  /** Unversioned; an old-style ID in its slash form. */
  arxiv_id: string;
  title: string;
  /** At most 12 in a list, with more_authors saying how many are left out; 100 from nisa.paper. */
  authors: string[];
  more_authors?: number;
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
  /** More papers match than this page holds; ask again with offset = next_offset. */
  truncated: boolean;
  next_offset?: number;
  /** The newest month (YYYYMM) in Nisa's keyword index: a later window finds nothing yet. */
  index_latest_pub_month?: number;
  /** Set when snippets or abstracts were shortened so the answer fits an agent's context. */
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
 * validates its input, is bounded in time and bytes, and answers only the allowlisted fields
 * above; each failure is a nisa_* error that repeats nothing Nisa said. Authorization belongs to
 * the tools that call it: any project reader may search.
 */
export interface Nisa {
  search(input: NisaSearchInput): Promise<NisaPaperList>;
  semanticSearch(input: NisaSemanticSearchInput): Promise<NisaPaperList>;
  paper(input: NisaPaperInput): Promise<NisaPaper>;
  excerpts(input: NisaExcerptsInput): Promise<NisaExcerpts>;
  related(input: NisaRelatedInput): Promise<NisaRelated>;
  close(): void;
}

declare module 'cordis' {
  interface Context {
    nisa: Nisa;
  }
}

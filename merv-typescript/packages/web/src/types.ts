import type { Caller } from '@merv/contracts';
import type {} from 'cordis';

/** Configuration names each key's environment variable and never carries a key. */
export interface WebConfig {
  /** Environment variable holding the Tavily key, read on every call. MERV_TAVILY_API_KEY. */
  keyEnv?: string;
  /** Tavily's API origin: https, or loopback http for tests. */
  origin?: string;
  /** OpenAI's hosted web search, used when Tavily has no key or refuses it (Nisa's fallback). */
  fallback?: {
    keyEnv: string;
    /** A Responses model that can use the hosted web_search tool. */
    model?: string;
    origin?: string;
    timeoutMs?: number;
  };
  /** Deadline for one Tavily call, its retries included. */
  timeoutMs?: number;
  /** A larger answer is refused, whatever its Content-Length says. */
  maxResponseBytes?: number;
  /** Calls this process has in flight at once; one more is refused with web_busy. */
  maxInFlight?: number;
  /** Calls one project may make per UTC day; the next is refused with web_budget_exhausted. */
  dailyCallsPerProject?: number;
}

export type WebProvider = 'tavily' | 'openai_web_search';

/** Input as the model gives it: Nisa's web_search arguments, normalized rather than refused. */
export interface WebSearchInput {
  /** One query, or up to 4 phrasings combined with OR into one request. */
  query: string | string[];
  max_results?: number | null;
  search_depth?: string | null;
  topic?: string | null;
  time_range?: string | null;
}
export interface WebExtractInput {
  url: string;
  extract_depth?: string | null;
  start_text?: string | null;
  end_text?: string | null;
}

/** One result, and only these fields, whatever the provider sent. */
export interface WebResult {
  title: string;
  /** Always an http(s) address. */
  url: string;
  /** Tavily's excerpt; empty for the fallback, whose text is the answer. */
  content: string;
  score: number;
}
export interface WebSearch {
  query: string;
  /** Absent when no provider was asked (status needs_query_terms). */
  provider?: WebProvider;
  results: WebResult[];
  result_count: number;
  /** The fallback's synthesized answer; its sources are the results. */
  answer?: string;
  status?: 'needs_query_terms';
  fallback_hint?: string;
  /** Each fix-up made to the input, and which provider answered when it was not Tavily. */
  normalization_note?: string;
  content_truncated?: true;
  content_budget_chars?: number;
}
export interface WebPage {
  url: string;
  content: string;
  /** Whether only the text between start_text and end_text was kept. */
  section: boolean;
  status: 'success' | 'error' | 'needs_valid_url';
  provider?: 'tavily';
  error?: string;
  fallback_hint?: string;
  normalization_note?: string;
}

/**
 * Internet search as Nisa's agents do it: Tavily, then OpenAI's hosted web search when Tavily
 * cannot serve. Pages are read only through Tavily, never fetched from Merv's own network. Every
 * call is bounded in time and bytes, answers only the fields above, and counts against its
 * project's daily budget. Authorization belongs to the tools that call it: any reader may search.
 */
export interface Web {
  /** Whether a page can be read: only Tavily reads pages. */
  readonly reads: boolean;
  search(caller: Caller, input: WebSearchInput): Promise<WebSearch>;
  extract(caller: Caller, input: WebExtractInput): Promise<WebPage>;
  close(): void;
}

declare module 'cordis' {
  interface Context {
    web: Web;
  }
}

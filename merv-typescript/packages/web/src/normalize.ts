/**
 * Nisa's web_search and web_extract (project/backend/agents/tools/web_search.py), ported: the
 * input fix-ups it reports in normalization_note, its caps, and its section markers. Everything
 * a provider sends is read defensively and only allowlisted fields leave.
 */
import { cleanText, clip, record } from '@merv/contracts';
import type { WebExtractInput, WebPage, WebResult, WebSearch, WebSearchInput } from './types.js';

const MAX_RESULT_CHARS = 6_000;
export const MAX_TOTAL_CHARS = 24_000;
export const MAX_EXTRACT_CHARS = 20_000;
/** Tavily refuses a longer query. */
const MAX_QUERY_CHARS = 400;
const TIME_RANGES: Record<string, string> = {
  d: 'day',
  day: 'day',
  w: 'week',
  week: 'week',
  m: 'month',
  month: 'month',
  y: 'year',
  year: 'year',
};

/** The most queries one call runs, each its own search. */
export const MAX_QUERIES = 4;

/** The searches Tavily can take, or the answer that no request should be made. */
type SearchPlan =
  | {
      /** Each runs as its own search, in this order. */
      queries: string[];
      max_results: number;
      search_depth: 'basic' | 'advanced';
      topic: 'general' | 'news' | 'finance';
      time_range?: string;
      notes: string[];
    }
  | { answer: WebSearch };

/**
 * A query as Tavily takes it, or the hint to give instead. A bare site: operator is no query:
 * an exact page's path becomes its terms, anything else is answered with what to add instead of
 * a request Tavily would refuse.
 */
function searchable(query: string, notes: string[]): { query: string } | { hint: string } {
  const terms = query.split(/\s+/).filter(Boolean);
  if (!terms.every((term) => term.toLowerCase().startsWith('site:'))) return { query };
  const target = terms[0].slice(5).replace(/^\/+|\/+$/g, '');
  const slash = target.indexOf('/');
  const host = slash < 0 ? target : target.slice(0, slash);
  const path =
    slash < 0
      ? ''
      : target
          .slice(slash + 1)
          .split(/[^A-Za-z0-9.]+/)
          .filter(Boolean)
          .join(' ');
  if (!host || !path)
    return {
      hint: `A site: filter needs descriptive search terms, for example ${query} transformer benchmark.`,
    };
  notes.push(`expanded exact site target ${JSON.stringify(query)} into searchable path terms`);
  return { query: `site:${host} ${path}`.slice(0, MAX_QUERY_CHARS) };
}

export function planSearch(input: WebSearchInput): SearchPlan {
  const notes: string[] = [];
  const given = [
    ...new Set((Array.isArray(input.query) ? input.query : [input.query]).map((q) => q.trim())),
  ].filter(Boolean);
  // Agents list unrelated queries far more often than phrasings of one, and one request that
  // ORs them answers none of them well: each runs as its own search.
  const asked = given.slice(0, MAX_QUERIES);
  const queries: string[] = [];
  let hint: string | undefined;
  for (const query of asked) {
    const plan = searchable(query, notes);
    if ('query' in plan) queries.push(plan.query);
    else if (asked.length > 1) notes.push(`skipped ${JSON.stringify(query)}: ${plan.hint}`);
    else hint = plan.hint;
  }
  if (given.length > asked.length)
    notes.unshift(`ran only the first ${asked.length} of the ${given.length} queries given`);
  if (queries.length > 1)
    notes.unshift(
      `ran ${queries.length} queries as separate searches, each result naming its query`,
    );
  if (!queries.length)
    return {
      answer: {
        query: asked.length === 1 ? asked[0]! : '',
        results: [],
        result_count: 0,
        status: 'needs_query_terms',
        fallback_hint: hint ?? 'Provide at least one descriptive search term.',
      },
    };

  let max = input.max_results ?? 5;
  if (!Number.isFinite(max)) {
    notes.push(`invalid max_results=${max} replaced with 5`);
    max = 5;
  }
  const clamped = Math.max(1, Math.min(Math.trunc(max), 20));
  if (clamped !== max) notes.push(`max_results=${max} replaced with ${clamped}`);
  const depth = (input.search_depth ?? 'basic').trim().toLowerCase() || 'basic';
  if (depth !== 'basic' && depth !== 'advanced')
    notes.push(`search_depth=${JSON.stringify(depth)} replaced with 'basic'`);
  const topic = (input.topic ?? 'general').trim().toLowerCase() || 'general';
  if (topic !== 'general' && topic !== 'news' && topic !== 'finance')
    notes.push(`topic=${JSON.stringify(topic)} replaced with 'general'`);
  // Models often send "" for an optional field; Tavily refuses an empty time_range.
  const range = (input.time_range ?? '').trim().toLowerCase();
  const time_range = Object.hasOwn(TIME_RANGES, range) ? TIME_RANGES[range] : undefined;
  if (range && !time_range) notes.push(`unsupported time_range=${JSON.stringify(range)} omitted`);
  return {
    queries,
    max_results: clamped,
    search_depth: depth === 'advanced' ? 'advanced' : 'basic',
    topic: topic === 'news' || topic === 'finance' ? topic : 'general',
    ...(time_range && { time_range }),
    notes,
  };
}

/** An http(s) address a person may follow, or undefined. */
function webUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const url = new URL(value.trim());
    return (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.hostname &&
      !url.username &&
      !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
const score = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0;

/** Tavily's results within Nisa's caps: 6,000 characters each and `total` (24,000) in all. */
export function tavilyResults(
  results: unknown[],
  max: number,
  total = MAX_TOTAL_CHARS,
): { results: WebResult[]; truncated: boolean } {
  const kept: WebResult[] = [];
  let remaining = total;
  let truncated = false;
  for (const entry of results) {
    const result = record(entry);
    const url = webUrl(result?.url);
    if (!result || !url) continue;
    let content = cleanText(result.content, Number.MAX_SAFE_INTEGER);
    const limit = Math.min(MAX_RESULT_CHARS, Math.max(0, remaining));
    if (content.length > limit) {
      const suffix = '\n... [truncated]';
      content = limit >= suffix.length ? clip(content, limit - suffix.length) + suffix : '';
      truncated = true;
    }
    remaining -= content.length;
    kept.push({ title: cleanText(result.title, 500), url, content, score: score(result.score) });
    if (kept.length === max) break;
  }
  return { results: kept, truncated };
}

const cited = (value: unknown) => ({
  title: cleanText(record(value)?.title, 500),
  url: String(record(value)?.url),
});

/** The fallback's answer text and its distinct sources, in the order the response gives them:
 * the searches' own sources, then the answer's citations. */
function openaiAnswer(response: Record<string, unknown>): {
  answer: string;
  sources: { title: string; url: string }[];
} {
  const found: { title: string; url: string }[] = [];
  const texts: string[] = [];
  for (const entry of Array.isArray(response.output) ? response.output : []) {
    const item = record(entry);
    if (item?.type === 'web_search_call') {
      const sources = record(item.action)?.sources;
      for (const source of Array.isArray(sources) ? sources : []) found.push(cited(source));
    }
    if (item?.type === 'message')
      for (const part of Array.isArray(item.content) ? item.content : []) {
        const content = record(part);
        if (content?.type !== 'output_text') continue;
        if (typeof content.text === 'string') texts.push(content.text);
        for (const note of Array.isArray(content.annotations) ? content.annotations : [])
          if (record(note)?.url) found.push(cited(note));
      }
  }
  const seen = new Set<string>();
  const sources: { title: string; url: string }[] = [];
  for (const source of found) {
    const url = webUrl(source.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    sources.push({ title: source.title.trim() || new URL(url).host, url });
  }
  return { answer: cleanText(texts.join(''), Number.MAX_SAFE_INTEGER).trim(), sources };
}

/** The fallback's result: its answer (at most `total`, 24,000, characters) and its sources as
 * results. */
export function fallbackSearch(
  max: number,
  response: Record<string, unknown>,
  total = MAX_TOTAL_CHARS,
): Pick<WebSearch, 'answer' | 'results' | 'result_count'> {
  const { answer: whole, sources } = openaiAnswer(response);
  const answer =
    whole.length > total ? clip(whole, total) + '\n... [OpenAI web answer truncated]' : whole;
  const results = sources.slice(0, max).map((source, index) => ({
    ...source,
    content: '',
    score: Math.round(1000 / (index + 1)) / 1000,
  }));
  return { answer, results, result_count: results.length };
}

/** The fallback's instruction for one search, as Nisa words it. */
export function fallbackPrompt(
  plan: Exclude<SearchPlan, { answer: WebSearch }>,
  query: string,
): string {
  const constraints = [
    ...(plan.topic === 'general' ? [] : [`Prioritize ${plan.topic} sources.`]),
    ...(plan.time_range ? [`Prioritize results from the last ${plan.time_range}.`] : []),
  ];
  return (
    'Search the web for the query below. Give a concise, factual synthesis with inline ' +
    'citations and use authoritative primary sources when possible. ' +
    `Return no more than ${plan.max_results} distinct sources. ` +
    constraints.join(' ') +
    `\n\nQuery: ${query}`
  );
}

/** A page to read, or the answer that it cannot be. */
type ExtractPlan =
  | {
      url: string;
      extract_depth: 'basic' | 'advanced';
      start: string;
      end: string;
      /** Characters of the page, or of its section, skipped before the text returned. */
      offset: number;
      notes: string[];
    }
  | { answer: WebPage };

export function planExtract(input: WebExtractInput): ExtractPlan {
  const given = input.url.trim();
  const url = webUrl(given);
  if (!url || !/^https?:\/\//i.test(given))
    return {
      answer: {
        url: given,
        content: '',
        section: false,
        status: 'needs_valid_url',
        error: 'url must be an absolute http or https address without credentials',
      },
    };
  const notes: string[] = [];
  const depth = (input.extract_depth ?? 'basic').trim().toLowerCase() || 'basic';
  if (depth !== 'basic' && depth !== 'advanced')
    notes.push(`unsupported extract_depth=${JSON.stringify(depth)} replaced with 'basic'`);
  const start = (input.start_text ?? '').trim();
  const end = (input.end_text ?? '').trim();
  let offset = input.offset ?? 0;
  if (!Number.isFinite(offset) || offset < 0) {
    notes.push(`invalid offset=${offset} replaced with 0`);
    offset = 0;
  }
  return {
    url,
    extract_depth: depth === 'advanced' ? 'advanced' : 'basic',
    start,
    end,
    offset: Math.trunc(offset),
    notes,
  };
}

/** ASCII punctuation, which Markdown may escape with a backslash, and such an escape. */
const PUNCTUATION = /[!-/:-@[-`{-~]/;
const ESCAPED = new RegExp(`\\\\(${PUNCTUATION.source})`, 'g');
/** A run of white space; a run of backslashes and the mark after it; any other mark. */
const PIECE = new RegExp(`\\s+|(\\\\+)(${PUNCTUATION.source})?|${PUNCTUATION.source}`, 'gu');

/**
 * Where `marker` first occurs in `content` at or after `from`, and how long it is there. Tavily
 * answers in Markdown, which escapes punctuation (def soft\_ce\_loss) and reflows white space,
 * while a marker is copied from source code or an excerpt: so a punctuation mark matches with
 * or without its backslash, on either side, and any run of white space matches any other.
 * A run of k backslashes and the mark after it are one piece, k to 2k+1 backslashes then the
 * mark: two pieces that could each take the same backslash backtrack exponentially on a miss.
 */
function find(content: string, marker: string, from: number) {
  const quote = (mark: string) => mark.replace(/[$()*+./?[\\\]^{|}]/, '\\$&');
  const source = marker
    .replace(ESCAPED, '$1')
    .replace(PIECE, (piece, run?: string, mark?: string) =>
      /^\s/u.test(piece)
        ? '\\s+'
        : run
          ? `\\\\{${run.length},${2 * run.length + (mark ? 1 : 0)}}${quote(mark ?? '')}`
          : `\\\\?${quote(piece)}`,
    );
  const pattern = new RegExp(source, 'gu');
  pattern.lastIndex = from;
  const match = pattern.exec(content);
  return match ? { at: match.index, length: match[0].length } : undefined;
}

/**
 * The page's text from the start marker to the end marker with 200 characters either side;
 * with one marker alone, the page from the start marker on or up to the end marker. A marker
 * that is not found leaves the rest whole, and `section` says whether every marker given was
 * found. Each miss is a note, never text appended to the page, where the cap would cut it off.
 * A cut never leaves half a character at either end.
 */
export function pageSection(
  raw: unknown,
  start: string,
  end: string,
): { text: string; section: boolean; notes: string[] } {
  const content = cleanText(raw, Number.MAX_SAFE_INTEGER);
  if (!start && !end) return { text: content, section: false, notes: [] };
  const trim = (text: string) => text.replace(/^\p{Surrogate}|\p{Surrogate}$/gu, '');
  const missed = (field: 'start_text' | 'end_text', marker: string, rest: string) =>
    `${field} ${JSON.stringify(clip(marker, 50))} not found on the page, even ignoring Markdown escapes and spacing: ${rest}`;
  const from = start ? find(content, start, 0) : { at: 0, length: 0 };
  if (!from)
    return {
      text: content,
      section: false,
      notes: [missed('start_text', start, 'returned the page from its beginning')],
    };
  const head = start ? Math.max(0, from.at - 200) : 0;
  if (!end) return { text: trim(content.slice(head)), section: true, notes: [] };
  const to = find(content, end, from.at + from.length);
  if (!to)
    return {
      text: trim(content.slice(head)),
      section: false,
      notes: [
        missed(
          'end_text',
          end,
          `returned the page from ${start ? 'start_text' : 'its beginning'} to its end`,
        ),
      ],
    };
  return { text: trim(content.slice(head, to.at + to.length + 200)), section: true, notes: [] };
}

/**
 * At most `limit` (20,000) characters of `text` from `offset` on: a marker that misses must not
 * put the whole page into the model's context, and next_offset reads on past the cut.
 */
export function pageWindow(
  text: string,
  offset: number,
  limit = MAX_EXTRACT_CHARS,
): { content: string; next_offset?: number } {
  // An offset inside a character starts after it.
  const skipped = text.length - text.slice(offset).replace(/^\p{Surrogate}/u, '').length;
  const rest = text.slice(skipped);
  if (rest.length <= limit) return { content: rest };
  const shown = clip(rest, limit);
  const next = skipped + shown.length;
  const more = (text.length - next).toLocaleString('en-US');
  return {
    content: `${shown}\n\n... [truncated at ${limit.toLocaleString('en-US')} characters, ${more} more: offset ${next} reads on]`,
    next_offset: next,
  };
}

/** Tavily's reason a page failed, as short plain text. */
export const pageError = (value: unknown) => cleanText(value, 300).trim() || 'No content returned';

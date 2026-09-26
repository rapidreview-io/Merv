/**
 * Nisa's web_search and web_extract (project/backend/agents/tools/web_search.py), ported: the
 * input fix-ups it reports in normalization_note, its caps, and its section markers. Everything
 * a provider sends is read defensively and only allowlisted fields leave.
 */
import type { WebExtractInput, WebPage, WebResult, WebSearch, WebSearchInput } from './types.js';

export const MAX_RESULT_CHARS = 6_000;
export const MAX_TOTAL_CHARS = 24_000;
export const MAX_EXTRACT_CHARS = 20_000;
/** What Pi shows the model of one result, at most (packages/pi/src/fit.ts), less room for the
 * envelope a transport adds. Nisa's caps count characters; an answer within them that escapes
 * or takes several bytes a character would pass this and reach the model cut, or as an index. */
export const MAX_ANSWER_BYTES = 28_000;
export const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
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

/** A search Tavily can take, or the answer that no request should be made. */
export type SearchPlan =
  | {
      query: string;
      max_results: number;
      search_depth: 'basic' | 'advanced';
      topic: 'general' | 'news' | 'finance';
      time_range?: string;
      notes: string[];
    }
  | { answer: WebSearch };

export function planSearch(input: WebSearchInput): SearchPlan {
  const notes: string[] = [];
  let query: string;
  if (Array.isArray(input.query)) {
    const given = input.query.map((item) => item.trim()).filter(Boolean);
    const parts = given.slice(0, 4);
    // Every phrasing in parentheses, joined with OR, as long as Tavily takes it.
    const joined = (count: number) =>
      count === 1
        ? parts[0]
        : parts
            .slice(0, count)
            .map((part) => `(${part})`)
            .join(' OR ');
    let count = parts.length;
    while (count > 1 && joined(count).length > MAX_QUERY_CHARS) count--;
    query = count ? joined(count) : '';
    if (count)
      notes.push(
        `combined ${count} query variant${count === 1 ? '' : 's'} into one web request` +
          (count < given.length ? ` (of ${given.length} given)` : ''),
      );
  } else query = input.query.trim();
  if (!query)
    return {
      answer: {
        query: '',
        results: [],
        result_count: 0,
        status: 'needs_query_terms',
        fallback_hint: 'Provide at least one descriptive search term.',
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

  // A bare site: operator is no query: an exact page's path becomes its terms, anything else
  // is answered with what to add instead of a request Tavily would refuse.
  const terms = query.split(/\s+/).filter(Boolean);
  if (terms.every((term) => term.toLowerCase().startsWith('site:'))) {
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
        answer: {
          query,
          results: [],
          result_count: 0,
          status: 'needs_query_terms',
          fallback_hint: `A site: filter needs descriptive search terms, for example ${query} transformer benchmark.`,
        },
      };
    notes.push(`expanded exact site target ${JSON.stringify(query)} into searchable path terms`);
    query = `site:${host} ${path}`.slice(0, MAX_QUERY_CHARS);
  }
  return {
    query,
    max_results: clamped,
    search_depth: depth === 'advanced' ? 'advanced' : 'basic',
    topic: topic === 'news' || topic === 'finance' ? topic : 'general',
    ...(time_range && { time_range }),
    notes,
  };
}

export const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
/** The first `max` characters, never half of one. */
const cut = (value: string, max: number) =>
  value.length <= max
    ? value
    : value.slice(0, /[\uD800-\uDBFF]/.test(value[max - 1] ?? '') ? max - 1 : max);
/** Text as a provider sent it, without control characters other than line breaks and tabs. */
const text = (value: unknown, max: number): string =>
  typeof value === 'string'
    ? cut(value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ''), max)
    : '';
/** An http(s) address a person may follow, or undefined. */
export function webUrl(value: unknown): string | undefined {
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

/**
 * The fullest `make(chars)`, chars from `whole` down, whose JSON fits MAX_ANSWER_BYTES: UTF-8
 * bytes are what an agent is shown, so text that escapes or takes several bytes a character
 * is cut sooner than Nisa's character caps alone would cut it.
 */
export function sized<T>(whole: number, make: (chars: number) => T): { value: T; chars: number } {
  const fits = (value: T) => jsonBytes(value) <= MAX_ANSWER_BYTES;
  const full = make(whole);
  if (fits(full)) return { value: full, chars: whole };
  let [low, high] = [0, whole - 1];
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(make(middle))) low = middle;
    else high = middle - 1;
  }
  return { value: make(low), chars: low };
}

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
    let content = text(result.content, Number.MAX_SAFE_INTEGER);
    const limit = Math.min(MAX_RESULT_CHARS, Math.max(0, remaining));
    if (content.length > limit) {
      const suffix = '\n... [truncated]';
      content = limit >= suffix.length ? cut(content, limit - suffix.length) + suffix : '';
      truncated = true;
    }
    remaining -= content.length;
    kept.push({ title: text(result.title, 500), url, content, score: score(result.score) });
    if (kept.length === max) break;
  }
  return { results: kept, truncated };
}

/** The fallback's answer text and its distinct sources, in the order the response gives them:
 * the searches' own sources, then the answer's citations. */
export function openaiAnswer(response: Record<string, unknown>): {
  answer: string;
  sources: { title: string; url: string }[];
} {
  const found: { title: string; url: string }[] = [];
  const texts: string[] = [];
  for (const entry of Array.isArray(response.output) ? response.output : []) {
    const item = record(entry);
    if (item?.type === 'web_search_call') {
      const sources = record(item.action)?.sources;
      for (const source of Array.isArray(sources) ? sources : [])
        found.push({ title: text(record(source)?.title, 500), url: String(record(source)?.url) });
    }
    if (item?.type === 'message')
      for (const part of Array.isArray(item.content) ? item.content : []) {
        const content = record(part);
        if (content?.type !== 'output_text') continue;
        if (typeof content.text === 'string') texts.push(content.text);
        for (const note of Array.isArray(content.annotations) ? content.annotations : [])
          if (record(note)?.url)
            found.push({ title: text(record(note)?.title, 500), url: String(record(note)?.url) });
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
  return { answer: text(texts.join(''), Number.MAX_SAFE_INTEGER).trim(), sources };
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
    whole.length > total ? cut(whole, total) + '\n... [OpenAI web answer truncated]' : whole;
  const results = sources.slice(0, max).map((source, index) => ({
    ...source,
    content: '',
    score: Math.round(1000 / (index + 1)) / 1000,
  }));
  return { answer, results, result_count: results.length };
}

/** The fallback's instruction for one search, as Nisa words it. */
export function fallbackPrompt(plan: Exclude<SearchPlan, { answer: WebSearch }>): string {
  const constraints = [
    ...(plan.topic === 'general' ? [] : [`Prioritize ${plan.topic} sources.`]),
    ...(plan.time_range ? [`Prioritize results from the last ${plan.time_range}.`] : []),
  ];
  return (
    'Search the web for the query below. Give a concise, factual synthesis with inline ' +
    'citations and use authoritative primary sources when possible. ' +
    `Return no more than ${plan.max_results} distinct sources. ` +
    constraints.join(' ') +
    `\n\nQuery: ${plan.query}`
  );
}

/** A page to read, or the answer that it cannot be. */
export type ExtractPlan =
  | {
      url: string;
      extract_depth: 'basic' | 'advanced';
      start: string;
      end: string;
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
  if (!start !== !end) notes.push('start_text and end_text select a section only together');
  return {
    url,
    extract_depth: depth === 'advanced' ? 'advanced' : 'basic',
    start,
    end,
    notes,
  };
}

/** The text between the markers with 200 characters either side, or the whole page with a
 * warning when a marker is missing. */
function section(content: string, start: string, end: string): string {
  const from = content.indexOf(start);
  if (from < 0)
    return `${content}\n\n[WARNING: start marker "${start.slice(0, 50)}" not found — returning full content]`;
  const to = content.indexOf(end, from + start.length);
  if (to < 0)
    return `${content.slice(Math.max(0, from - 200))}\n\n[WARNING: end marker "${end.slice(0, 50)}" not found — returning from start marker to end]`;
  return content.slice(Math.max(0, from - 200), Math.min(content.length, to + end.length + 200));
}

/** The page's text, cut to its section when both markers are given, and always capped at `limit`
 * (20,000) characters: a marker that misses must not put the whole page into the model's context. */
export function pageText(
  raw: unknown,
  start: string,
  end: string,
  limit = MAX_EXTRACT_CHARS,
): { content: string; section: boolean } {
  let content = text(raw, Number.MAX_SAFE_INTEGER);
  let applied = false;
  if (start && end) {
    const from = content.indexOf(start);
    applied = from >= 0 && content.indexOf(end, from + start.length) >= 0;
    content = section(content, start, end);
  }
  if (content.length > limit)
    content = `${cut(content, limit)}\n\n... [truncated at ${limit.toLocaleString('en-US')} characters]`;
  return { content, section: applied };
}

/** Tavily's reason a page failed, as short plain text. */
export const pageError = (value: unknown) => text(value, 300).trim() || 'No content returned';

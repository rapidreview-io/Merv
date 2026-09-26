import type { Context } from 'cordis';
import type { z } from 'zod';
import { check, MervError } from '@merv/contracts';
import { NisaHttpError, request, Slots } from './client.js';
import {
  excerptsInput,
  nisaConfig,
  paperInput,
  relatedInput,
  routeId,
  searchInput,
  semanticInput,
  type NisaSettings,
} from './input.js';
import {
  citation,
  jsonBytes,
  LIST_ABSTRACT_CHARS,
  MAX_ABSTRACT_CHARS,
  MAX_ANSWER_BYTES,
  MAX_EXCERPT_CHARS,
  MAX_SNIPPET_CHARS,
  paper,
  papers,
  sized,
  text,
  type Kind,
} from './normalize.js';
import type {
  Nisa,
  NisaConfig,
  NisaExcerpts,
  NisaExcerptsInput,
  NisaPaper,
  NisaPaperInput,
  NisaPaperList,
  NisaRelated,
  NisaRelatedInput,
  NisaSearchInput,
  NisaSemanticSearchInput,
} from './types.js';

export type * from './types.js';

const shortened = 'Passages are shortened to fit; read one paper with nisa.paper or nisa.excerpts';

/** Nisa's literature search for agents; see Nisa. Holds no state beyond its calls in flight. */
export class NisaService implements Nisa {
  readonly config: NisaSettings;
  private readonly stopping = new AbortController();
  private readonly slots: Slots;

  constructor(config: NisaConfig = {}) {
    const parsed = nisaConfig.safeParse(config);
    check(parsed.success, 'invalid_nisa_config', 'The Nisa configuration is invalid');
    this.config = parsed.data;
    this.slots = new Slots(this.config.maxInFlight);
  }

  /** Whether the deployment's key is set. */
  get configured(): boolean {
    return !!process.env[this.config.keyEnv]?.trim();
  }

  async search(input: NisaSearchInput): Promise<NisaPaperList> {
    const value = parse(searchInput, input);
    const data = await this.call('/api/sdk/search', this.config.searchTimeoutMs, {
      query: value.query,
      max_results: value.max_results,
      offset: value.offset,
      ...(value.author !== undefined && { author: value.author }),
      ...(value.date_from !== undefined && { date_from: value.date_from }),
      ...(value.date_to !== undefined && { date_to: value.date_to }),
      // Enrichment starts one of Nisa's research agents; this plugin only ever looks papers up.
      enrich: false,
    });
    return list(data, 'search', value.max_results, value.offset, MAX_SNIPPET_CHARS);
  }

  async semanticSearch(input: NisaSemanticSearchInput): Promise<NisaPaperList> {
    const value = parse(semanticInput, input);
    const data = await this.call('/api/sdk/semantic_search', this.config.searchTimeoutMs, {
      query: value.query,
      max_results: value.max_results,
      offset: value.offset,
      ...(value.author !== undefined && { author: value.author }),
      ...(value.year_min !== undefined && { year_min: value.year_min }),
      ...(value.year_max !== undefined && { year_max: value.year_max }),
    });
    return list(data, 'semantic', value.max_results, value.offset, LIST_ABSTRACT_CHARS);
  }

  async paper(input: NisaPaperInput): Promise<NisaPaper> {
    const { arxiv_id } = parse(paperInput, input);
    const data = await this.call(
      `/api/sdk/paper/${encodeURIComponent(routeId(arxiv_id))}`,
      this.config.timeoutMs,
    );
    // A record of another paper, or of none, is no answer to this question.
    const found = paper(data, 'paper', 0);
    if (found?.arxiv_id !== arxiv_id)
      throw new MervError('nisa_invalid_response', 'Nisa answered with another paper', 502);
    return sized(MAX_ABSTRACT_CHARS, (chars) => paper(data, 'paper', chars) ?? found).value;
  }

  async excerpts(input: NisaExcerptsInput): Promise<NisaExcerpts> {
    const value = parse(excerptsInput, input);
    const query = new URLSearchParams({ q: value.query, max: String(value.max_excerpts) });
    const data = await this.call(
      `/api/sdk/paper/${encodeURIComponent(routeId(value.arxiv_id))}/excerpts?${query}`,
      this.config.timeoutMs,
    );
    const flag = (key: string) =>
      typeof data[key] === 'boolean' ? { [key]: data[key] as boolean } : {};
    const terms = (key: string) =>
      Array.isArray(data[key])
        ? {
            [key]: (data[key] as unknown[])
              .map((term) => text(term, 100))
              .filter(Boolean)
              .slice(0, 50),
          }
        : {};
    const found = Array.isArray(data.excerpts) ? data.excerpts.slice(0, value.max_excerpts) : [];
    return sized(MAX_EXCERPT_CHARS, (chars): NisaExcerpts => {
      const excerpts = found.map((excerpt) => text(excerpt, chars)).filter(Boolean);
      return {
        ...citation(value.arxiv_id),
        excerpts,
        count: excerpts.length,
        truncated: data.truncated === true,
        ...flag('doc_found'),
        ...flag('full_text_indexed'),
        ...terms('matched_terms'),
        ...terms('missing_terms'),
        ...(chars < MAX_EXCERPT_CHARS &&
          found.some((excerpt) => typeof excerpt === 'string' && excerpt.length > chars) && {
            note: 'Passages are shortened to fit; ask for fewer to read more of each',
          }),
      };
    }).value;
  }

  async related(input: NisaRelatedInput): Promise<NisaRelated> {
    const value = parse(relatedInput, input);
    const data = await this.call(
      `/api/sdk/paper/${encodeURIComponent(routeId(value.arxiv_id))}/related?n=${value.max_results}`,
      this.config.timeoutMs,
    );
    const { value: answer } = sized(LIST_ABSTRACT_CHARS, (chars): NisaRelated => {
      const found = papers(data.papers, 'related', value.max_results, chars);
      return {
        arxiv_id: value.arxiv_id,
        papers: found,
        count: found.length,
        ...(chars < LIST_ABSTRACT_CHARS && { note: shortened }),
      };
    });
    return fitted(answer, (count) => ({
      ...answer,
      papers: answer.papers.slice(0, count),
      count,
    }));
  }

  close(): void {
    this.stopping.abort();
  }

  /** One call to Nisa, bounded and in turn: a GET, or a POST of `body`. */
  private async call(
    path: string,
    timeoutMs: number,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    check(!this.stopping.signal.aborted, 'nisa_stopped', 'Nisa is stopping', 503);
    const key = process.env[this.config.keyEnv]?.trim();
    check(key, 'nisa_unavailable', 'Nisa has no key in this deployment', 503);
    let release: (() => void) | undefined;
    try {
      release = await this.slots.acquire(
        this.config.queueMs,
        this.stopping.signal,
        () =>
          new MervError(
            'nisa_busy',
            `Merv already has ${this.config.maxInFlight} calls to Nisa in flight; try again shortly`,
            429,
          ),
      );
      return await request(`${this.config.origin}${path}`, key, {
        body,
        timeoutMs,
        maxBytes: this.config.maxResponseBytes,
        signal: this.stopping.signal,
      });
    } catch (error) {
      throw this.failure(error);
    } finally {
      release?.();
    }
  }

  /** Nisa's failure as the caller sees it: its HTTP status at most, never its words. A refused
   * key is never 401 or 403, which a transport would read as the caller's own. */
  private failure(error: unknown): MervError {
    if (this.stopping.signal.aborted) return new MervError('nisa_stopped', 'Nisa is stopping', 503);
    if (error instanceof MervError) return error;
    if (error instanceof DOMException && error.name === 'TimeoutError')
      return new MervError('nisa_timeout', 'Nisa did not answer in time', 504);
    const failure = error instanceof NisaHttpError ? error.failure : { kind: 'network' as const };
    if (failure.kind === 'too_large')
      return new MervError(
        'nisa_response_too_large',
        'Nisa answered more than the configured byte limit',
        502,
      );
    if (failure.kind === 'invalid')
      return new MervError(
        'nisa_invalid_response',
        'Nisa answered something other than a result',
        502,
      );
    if (failure.kind === 'network')
      return new MervError('nisa_upstream_error', 'Nisa is unreachable', 502);
    const { status } = failure;
    if (status === 400)
      return new MervError('nisa_request_refused', 'Nisa refused this request (HTTP 400)', 422);
    if (status === 401 || status === 403)
      return new MervError(
        'nisa_key_refused',
        `Nisa refused this deployment's key (HTTP ${status})`,
        503,
      );
    if (status === 404) return new MervError('nisa_not_found', 'Nisa has no such paper', 404);
    if (status === 429)
      return new MervError('nisa_rate_limited', 'Nisa is limiting requests (HTTP 429)', 429);
    if (status === 503 || status === 504)
      return new MervError(
        'nisa_index_unavailable',
        `Nisa's index is unavailable (HTTP ${status}); try again later`,
        503,
      );
    return new MervError('nisa_upstream_error', `Nisa failed (HTTP ${status})`, 502);
  }
}

function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const parsed = schema.safeParse(input);
  check(parsed.success, 'invalid_input', 'Nisa arguments are invalid');
  return parsed.data;
}

/** A keyword or semantic page: the papers Nisa found, sized to fit, and where the next page starts. */
function list(
  data: Record<string, unknown>,
  kind: Kind,
  max: number,
  offset: number,
  whole: number,
): NisaPaperList {
  const given = Array.isArray(data.papers) ? data.papers.length : 0;
  const latest = data.index_latest_pub_month;
  const { value } = sized(whole, (chars): NisaPaperList => {
    const found = papers(data.papers, kind, max, chars);
    return {
      papers: found,
      count: found.length,
      offset,
      truncated: data.truncated === true,
      ...(data.truncated === true && { next_offset: offset + Math.min(given, max) }),
      ...(typeof latest === 'number' &&
        Number.isSafeInteger(latest) &&
        latest >= 190001 &&
        latest <= 999912 && { index_latest_pub_month: latest }),
      ...(chars < whole && { note: shortened }),
    };
  });
  // Titles and authors alone rarely pass the limit; when they do, the page ends sooner.
  return fitted(value, (count) => ({
    ...value,
    papers: value.papers.slice(0, count),
    count,
    ...(count < value.papers.length && { truncated: true, next_offset: offset + count }),
  }));
}

/** `answer` with as many of its papers as fit MAX_ANSWER_BYTES. */
function fitted<T extends { papers: unknown[] }>(answer: T, keep: (count: number) => T): T {
  let count = answer.papers.length;
  let value = answer;
  while (count > 0 && jsonBytes(value) > MAX_ANSWER_BYTES) value = keep(--count);
  return value;
}

export const nisaPlugin = {
  name: 'merv-nisa',
  Config: nisaConfig.default({}),
  apply(ctx: Context, config: NisaConfig) {
    const nisa = new NisaService(config);
    check(
      nisa.configured,
      'nisa_configuration',
      `Nisa has no key: ${nisa.config.keyEnv} is unset`,
      503,
    );
    ctx.effect(() => () => nisa.close());
    ctx.provide('nisa', nisa);
  },
};
export default nisaPlugin;

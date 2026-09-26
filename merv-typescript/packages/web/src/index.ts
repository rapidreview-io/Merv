import type { Context } from 'cordis';
import { check, MervError, type Caller } from '@merv/contracts';
import { webConfig, type WebSettings } from './input.js';
import {
  fallbackPrompt,
  fallbackSearch,
  MAX_TOTAL_CHARS,
  pageError,
  pageText,
  planExtract,
  planSearch,
  record,
  tavilyResults,
} from './normalize.js';
import { post, ProviderError } from './providers.js';
import type {
  Web,
  WebConfig,
  WebExtractInput,
  WebPage,
  WebSearch,
  WebSearchInput,
} from './types.js';

export type * from './types.js';

/** Tavily's answers that mean it will not serve this key now, whatever the request: Nisa falls
 * back on exactly these (a missing, invalid or forbidden key, or a used-up plan). */
const REFUSED = new Set([401, 403, 429, 432, 433]);
const refused = (error: unknown) =>
  error instanceof ProviderError &&
  error.failure.kind === 'status' &&
  REFUSED.has(error.failure.status);

/** Internet search for agents; see Web. Counters live in memory: a restart forgets them. */
export class WebService implements Web {
  readonly config: WebSettings;
  private readonly stopping = new AbortController();
  private readonly calls = new Map<string, number>();
  private day = '';
  private inFlight = 0;

  constructor(
    config: WebConfig = {},
    private readonly clock: () => number = Date.now,
  ) {
    const parsed = webConfig.safeParse(config);
    check(parsed.success, 'invalid_web_config', 'The web search configuration is invalid');
    this.config = parsed.data;
  }

  private key(name: string | undefined): string | undefined {
    return (name && process.env[name]?.trim()) || undefined;
  }
  private get tavilyKey() {
    return this.key(this.config.keyEnv);
  }
  private get fallbackKey() {
    return this.key(this.config.fallback?.keyEnv);
  }
  get reads(): boolean {
    return !!this.tavilyKey;
  }
  /** Whether any provider has its key. */
  get configured(): boolean {
    return !!(this.tavilyKey || this.fallbackKey);
  }

  async search(caller: Caller, input: WebSearchInput): Promise<WebSearch> {
    const plan = planSearch(input);
    if ('answer' in plan) return plan.answer;
    const tavily = this.tavilyKey;
    check(
      tavily || this.fallbackKey,
      'web_unavailable',
      'Web search has no provider key in this deployment',
      503,
    );
    return await this.admit(caller, async () => {
      const notes = plan.notes;
      const { query, max_results, search_depth, topic, time_range } = plan;
      let refusal: MervError | undefined;
      if (tavily) {
        try {
          const data = await post(
            `${this.config.origin}/search`,
            tavily,
            { query, max_results, search_depth, topic, ...(time_range && { time_range }) },
            this.bounds(this.config.timeoutMs),
          );
          const { results, truncated } = tavilyResults(
            Array.isArray(data.results) ? data.results : [],
            max_results,
          );
          return {
            query,
            provider: 'tavily',
            results,
            result_count: results.length,
            ...(notes.length > 0 && { normalization_note: notes.join('; ') }),
            ...(truncated && {
              content_truncated: true as const,
              content_budget_chars: MAX_TOTAL_CHARS,
            }),
          };
        } catch (error) {
          refusal = this.failure(error, 'Tavily');
          if (!refused(error) || !this.fallbackKey) throw refusal;
        }
      }
      const fallback = this.config.fallback!;
      let response: Record<string, unknown>;
      try {
        // A grounded model call, as Nisa's: it answers with a synthesis and its sources.
        response = await post(
          `${fallback.origin}/v1/responses`,
          this.fallbackKey!,
          {
            model: fallback.model,
            input: fallbackPrompt(plan),
            tools: [{ type: 'web_search' }],
            include: ['web_search_call.action.sources'],
            reasoning: { effort: 'low' },
            max_output_tokens: search_depth === 'advanced' ? 4096 : 2048,
            store: false,
          },
          this.bounds(fallback.timeoutMs),
        );
      } catch (error) {
        const failure = this.failure(error, 'OpenAI web search');
        throw refusal
          ? new MervError(
              failure.code,
              `Web search failed through both Tavily and OpenAI: ${refusal.message}; ${failure.message}`,
              failure.status,
            )
          : failure;
      }
      notes.push(
        tavily
          ? 'Tavily unavailable; used OpenAI web search'
          : 'Tavily is not configured; used OpenAI web search',
      );
      return {
        query,
        provider: 'openai_web_search',
        ...fallbackSearch(query, max_results, response),
        normalization_note: notes.join('; '),
      };
    });
  }

  async extract(caller: Caller, input: WebExtractInput): Promise<WebPage> {
    const plan = planExtract(input);
    if ('answer' in plan) return plan.answer;
    // Only Tavily reads a page: Merv never fetches one from its own network, which reaches
    // services no caller may address.
    const tavily = this.tavilyKey;
    check(
      tavily,
      'web_unavailable',
      'Reading a page needs Tavily, which has no key in this deployment; use web.search',
      503,
    );
    return await this.admit(caller, async () => {
      let data: Record<string, unknown>;
      try {
        data = await post(
          `${this.config.origin}/extract`,
          tavily,
          { urls: [plan.url], extract_depth: plan.extract_depth },
          this.bounds(this.config.timeoutMs),
        );
      } catch (error) {
        throw this.failure(error, 'Tavily');
      }
      const note = plan.notes.length > 0 ? { normalization_note: plan.notes.join('; ') } : {};
      const page = record(Array.isArray(data.results) ? data.results[0] : undefined);
      if (!page) {
        const failed = Array.isArray(data.failed_results) ? data.failed_results : [];
        return {
          url: plan.url,
          content: '',
          section: false,
          status: 'error',
          provider: 'tavily',
          error: pageError(record(failed[0])?.error),
          fallback_hint:
            'This page could not be read. Use web.search with its title or address to find indexed excerpts, or try the publisher’s HTML page.',
          ...note,
        };
      }
      const { content, section } = pageText(page.raw_content || page.content, plan.start, plan.end);
      return { url: plan.url, content, section, status: 'success', provider: 'tavily', ...note };
    });
  }

  close(): void {
    this.stopping.abort();
  }

  /** Charges the project's day and holds one of the process's slots while `run` runs. */
  private async admit<T>(caller: Caller, run: () => Promise<T>): Promise<T> {
    check(!this.stopping.signal.aborted, 'web_stopped', 'Web search is stopping', 503);
    const day = new Date(this.clock()).toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.calls.clear();
    }
    const used = this.calls.get(caller.projectId) ?? 0;
    const limit = this.config.dailyCallsPerProject;
    check(
      used < limit,
      'web_budget_exhausted',
      `This project has made its ${limit} web calls for today; more are allowed after 00:00 UTC`,
      429,
    );
    const slots = this.config.maxInFlight;
    check(
      this.inFlight < slots,
      'web_busy',
      `Merv is already making ${slots} web calls; try again shortly`,
      429,
    );
    this.calls.set(caller.projectId, used + 1);
    this.inFlight++;
    try {
      return await run();
    } finally {
      this.inFlight--;
    }
  }

  private bounds(timeoutMs: number) {
    return { timeoutMs, maxBytes: this.config.maxResponseBytes, signal: this.stopping.signal };
  }

  /** A provider's failure as the caller sees it: its HTTP status at most, never its words. A
   * refusal is never 401 or 403, which a transport would read as the caller's own. */
  private failure(error: unknown, provider: string): MervError {
    if (this.stopping.signal.aborted)
      return new MervError('web_stopped', 'Web search is stopping', 503);
    if (error instanceof DOMException && error.name === 'TimeoutError')
      return new MervError('web_timeout', `${provider} did not answer in time`, 504);
    const failure = error instanceof ProviderError ? error.failure : { kind: 'network' as const };
    if (failure.kind === 'too_large')
      return new MervError(
        'web_response_too_large',
        `${provider} answered more than the configured byte limit`,
        502,
      );
    if (failure.kind === 'invalid')
      return new MervError('web_invalid_response', `${provider} answered invalid JSON`, 502);
    if (failure.kind === 'network')
      return new MervError('web_upstream_error', `${provider} is unreachable`, 502);
    const { status } = failure;
    if (status === 401 || status === 403)
      return new MervError(
        'web_provider_refused',
        `${provider} refused this deployment's key (HTTP ${status})`,
        503,
      );
    if (status === 429 || status === 432 || status === 433)
      return new MervError(
        'web_quota_exhausted',
        `${provider}'s usage limit is reached (HTTP ${status})`,
        503,
      );
    if (status === 400)
      return new MervError(
        'web_request_refused',
        `${provider} refused this request (HTTP 400)`,
        422,
      );
    return new MervError('web_upstream_error', `${provider} failed (HTTP ${status})`, 502);
  }
}

export const webPlugin = {
  name: 'merv-web',
  Config: webConfig.default({}),
  apply(ctx: Context, config: WebConfig) {
    const web = new WebService(config);
    const { keyEnv, fallback } = web.config;
    check(
      web.configured,
      'web_configuration',
      `Web search has no key: ${keyEnv}${fallback ? ` and ${fallback.keyEnv} are` : ' is'} unset`,
      503,
    );
    ctx.effect(() => () => web.close());
    ctx.provide('web', web);
  },
};
export default webPlugin;

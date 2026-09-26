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
import { piTool } from '../packages/pi/src/relay-schema.js';
import { piModelToolName } from '../packages/pi/src/tool-names.js';
import { WebService } from '../packages/web/src/index.js';
import { webTools } from '../packages/web/src/tools.js';
import { webConfig } from '../packages/web/src/input.js';
import { USER_AGENT } from '../packages/web/src/providers.js';
import type { WebPage, WebSearch } from '../packages/web/src/types.js';
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
  const web = new WebService(config);
  const refusal = (status: number): Reply => ({
    status,
    body: { detail: { error: 'upstream words never repeated' } },
  });
  const input = { query: 'q', search_depth: 'advanced', topic: 'news', time_range: 'month' };
  // A missing, invalid or forbidden key, or a used-up plan; 429 only once its retries are spent.
  for (const status of [401, 403, 432, 433, 429]) {
    tavilyReply = refusal(status);
    const [tried, grounding] = [tavily.seen.length, openai.seen.length];
    const result = await web.search(caller, input);
    assert.equal(tavily.seen.length - tried, status === 429 ? 3 : 1, `${status}`);
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

  // Anything else is Tavily's failure, retried when it may pass, and never falls back.
  for (const [status, tries, code, http] of [
    [500, 3, 'web_upstream_error', 502],
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
  const alone = new WebService({ ...config, keyEnv: 'MERV_WEB_TEST_UNSET_KEY' });
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

test('a project’s day and the process’s in-flight calls are bounded, refused before any request', async (t) => {
  let gate: Promise<void> | undefined;
  const tavily = await provider(t, async () => {
    await gate;
    return { body: tavilyResults(1) };
  });
  let now = Date.parse('2026-09-26T23:59:00Z');
  const web = new WebService(
    {
      keyEnv: keyEnv(t, 'tvly-fixture'),
      origin: tavily.origin,
      dailyCallsPerProject: 2,
      maxInFlight: 2,
    },
    () => now,
  );
  const project = (projectId: string): Caller => ({ ...caller, projectId });
  await web.search(caller, { query: 'one' });
  // Answers that need no provider cost nothing.
  await web.search(caller, { query: '' });
  await web.extract(caller, { url: 'not an address' });
  await web.extract(caller, { url: 'https://example.com/two' });
  for (const call of [
    () => web.search(caller, { query: 'three' }),
    () => web.extract(caller, { url: 'https://example.com/three' }),
  ])
    await assert.rejects(call(), {
      code: 'web_budget_exhausted',
      status: 429,
      message: 'This project has made its 2 web calls for today; more are allowed after 00:00 UTC',
    });
  assert.equal(tavily.seen.length, 2);
  // Another project has its own day, and the next UTC day starts afresh.
  await web.search(project('project-b'), { query: 'elsewhere' });
  now = Date.parse('2026-09-27T00:00:01Z');
  await web.search(caller, { query: 'tomorrow' });

  const release = deferred();
  gate = release.promise;
  const held = [
    web.search(project('project-c'), { query: 'held' }),
    web.search(project('project-d'), { query: 'held' }),
  ];
  const deadline = Date.now() + 5000;
  while (tavily.seen.length < 6 && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  await assert.rejects(web.search(project('project-e'), { query: 'third' }), {
    code: 'web_busy',
    status: 429,
  });
  assert.equal(tavily.seen.length, 6);
  release.resolve();
  await Promise.all(held);
  // The refusal took nothing from project-e's day.
  gate = undefined;
  await web.search(project('project-e'), { query: 'third' });
  await web.search(project('project-e'), { query: 'fourth' });
  await assert.rejects(web.search(project('project-e'), { query: 'fifth' }), {
    code: 'web_budget_exhausted',
  });
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
  }
  assert.equal(tavily.seen.length, 2);
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
    maxInFlight: 4,
    dailyCallsPerProject: 200,
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

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Actor, Caller } from '@merv/contracts';
import { ToolRegistry, conversationUse, describeTool } from '../packages/api/src/registry.js';
import { USER_AGENT } from '../packages/nisa/src/client.js';
import { NisaService } from '../packages/nisa/src/index.js';
import { nisaConfig } from '../packages/nisa/src/input.js';
import { jsonBytes, MAX_ANSWER_BYTES } from '../packages/nisa/src/normalize.js';
import { nisaTools } from '../packages/nisa/src/tools.js';
import type {
  NisaExcerpts,
  NisaPaper,
  NisaPaperList,
  NisaRelated,
} from '../packages/nisa/src/types.js';
import { fit } from '../packages/pi/src/fit.js';
import { piTool } from '../packages/pi/src/relay-schema.js';
import { piModelToolName } from '../packages/pi/src/tool-names.js';
import { loadConfiguration } from '../src/config.js';
import { createApp } from './fixtures/app.js';
import { deferred } from './fixtures/deferred.js';
import { fixture as piFixture } from './fixtures/pi.js';
// Nisa is faked with the same recording loopback server as the web search providers.
import { keyEnv, provider, type Reply, type Seen } from './fixtures/web.js';

const caller: Caller = { actorId: 'alice', projectId: 'project-a', credentialId: 'key-alice' };
const open = { require: async () => ({}) as Actor };
const key = `rr_sk_${'k'.repeat(43)}`;

/** Nisa answering as main 3489d7d does; `reply` overrides a route. */
async function nisa(t: TestContext, reply?: (seen: Seen) => Reply | undefined) {
  return await provider(t, (seen) => reply?.(seen) ?? { body: answers(seen) });
}
function answers({ path }: Seen): unknown {
  const route = new URL(path, 'http://nisa').pathname;
  if (route === '/api/sdk/search') return search;
  if (route === '/api/sdk/semantic_search') return semantic;
  if (route.endsWith('/excerpts')) return excerpts;
  if (route.endsWith('/related')) return related;
  return paperRecord;
}
const search = {
  query: 'attention',
  count: 4,
  offset: 10,
  limit: 3,
  truncated: true,
  pagination_hint: 'Showing papers 11-14; call again with offset=14 for more',
  clamp_note: 'nothing was clamped',
  index_latest_pub_month: 202609,
  session_id: 'sdk-never-asked-for',
  token: 'upstream-secret',
  papers: [
    {
      arxiv_id: '1706.03762',
      title: 'Attention Is All You Need',
      year: 2017,
      authors: 'Ashish Vaswani, Noam Shazeer, Niki Parmar',
      citation_count: 123_456,
      score: 12.345678,
      snippets: ['multi-head attention', 'x'.repeat(2000), 'third', 'fourth'],
      url: 'https://arxiv.org/abs/1706.03762',
      source: 'search',
      why: 'multi-head attention',
      token: 'upstream-secret',
    },
    // Nisa's full-text index writes an old-style ID with an underscore.
    {
      arxiv_id: 'hep-th_9901001',
      title: 'Old Style',
      year: '1999',
      authors: 'A. Physicist',
      citation_count: 7,
      score: 3,
      snippets: [],
    },
    { arxiv_id: 'not-an-id', title: 'Dropped', score: 2, snippets: [] },
    { arxiv_id: '1706.03762v2', title: 'Duplicate', score: 1, snippets: [] },
  ],
};
const semantic = {
  query: 'q',
  count: 1,
  offset: 0,
  limit: 10,
  truncated: false,
  papers: [
    {
      paper_id: '2303.08774',
      arxiv_id: '2303.08774',
      title: 'GPT-4 Technical Report',
      abstract: 'a'.repeat(5000),
      authors: 'OpenAI',
      year: 2023,
      citation_count: 900,
      similarity: 0.87654,
      embedding: [0.1, 0.2],
    },
  ],
};
const paperRecord = {
  arxiv_id: '2303.08774',
  title: 'GPT-4 Technical Report',
  authors: Array.from({ length: 150 }, (_, index) => `Author ${index}`).join(', '),
  abstract: 'We report the development of GPT-4.',
  year: 2023,
  citation_count: 900,
  url: 'https://arxiv.org/abs/2303.08774',
  categories: 'cs.CL cs.AI',
  cluster: 4,
  pagerank: 0.001,
};
const excerpts = {
  arxiv_id: '2303.08774',
  query: 'scaling',
  count: 2,
  excerpts: ['predictable scaling', 'y'.repeat(3000)],
  truncated: true,
  doc_found: true,
  full_text_indexed: true,
  matched_terms: ['scaling'],
  missing_terms: [],
  token: 'upstream-secret',
};
const related = {
  arxiv_id: '2303.08774',
  count: 1,
  papers: [
    {
      arxiv_id: '2005.14165',
      title: 'Language Models are Few-Shot Learners',
      authors: 'Tom B. Brown',
      abstract: 'GPT-3.',
      year: 2020,
      citation_count: 30000,
      similarity_score: 0.91,
    },
  ],
};

function registry(t: TestContext, service: NisaService) {
  const tools = new ToolRegistry(open);
  for (const tool of nisaTools(service)) tools.register(tool);
  t.after(() => tools.close());
  return tools;
}

test('a keyword search reaches Nisa as its CLI sends it, never enriched, and answers what paper.cite takes', async (t) => {
  const fake = await nisa(t);
  const service = new NisaService({ keyEnv: keyEnv(t, key), origin: fake.origin });
  const tools = registry(t, service);
  const result = (await tools.call('nisa.search', caller, {
    query: [' attention ', 'transformer'],
    max_results: 3,
    offset: 10,
    author: 'Vaswani',
    date_from: '2017-06-12',
    date_to: '2018',
  })) as NisaPaperList;
  assert.deepEqual(
    fake.seen.map(({ method, path, body }) => [method, path, body]),
    [
      [
        'POST',
        '/api/sdk/search',
        {
          query: ['attention', 'transformer'],
          max_results: 3,
          offset: 10,
          author: 'Vaswani',
          date_from: '2017-06-12',
          date_to: '2018',
          enrich: false,
        },
      ],
    ],
  );
  const { headers } = fake.seen[0];
  assert.equal(headers.authorization, `Bearer ${key}`);
  assert.equal(headers['user-agent'], USER_AGENT);
  assert.doesNotMatch(USER_AGENT, /^python-httpx\//);
  assert.deepEqual(result, {
    papers: [
      {
        identifier: 'arxiv:1706.03762',
        arxiv_id: '1706.03762',
        url: 'https://arxiv.org/abs/1706.03762',
        title: 'Attention Is All You Need',
        authors: ['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar'],
        year: 2017,
        citation_count: 123_456,
        score: 12.346,
        snippets: ['multi-head attention', 'x'.repeat(800) + '…', 'third'],
      },
      {
        identifier: 'arxiv:hep-th/9901001',
        arxiv_id: 'hep-th/9901001',
        url: 'https://arxiv.org/abs/hep-th/9901001',
        title: 'Old Style',
        authors: ['A. Physicist'],
        year: 1999,
        citation_count: 7,
        score: 3,
        snippets: [],
      },
    ],
    count: 2,
    offset: 10,
    truncated: true,
    // Nisa returned three papers on this page (of the four, one twice): the next starts after.
    next_offset: 13,
    index_latest_pub_month: 202609,
  });
  assert.doesNotMatch(JSON.stringify(result), /token|upstream-secret|session_id|why|source/);

  // Refused before any request: what Nisa would silently coerce, or cannot address.
  for (const input of [
    { query: '' },
    { query: '   ' },
    { query: Array.from({ length: 9 }, (_, index) => `q${index}`) },
    { query: 'x'.repeat(1001) },
    { query: 'q', max_results: 21 },
    { query: 'q', max_results: 0 },
    { query: 'q', offset: 501 },
    { query: 'q', author: 'a'.repeat(201) },
    { query: 'q', date_from: '2024-02-30' },
    { query: 'q', date_from: '06/2024' },
    { query: 'q', date_from: '2024-07', date_to: '2024-06' },
    { query: 'q', enrich: true },
  ])
    await assert.rejects(tools.call('nisa.search', caller, input), { code: 'invalid_input' });
  for (const input of [{ arxiv_id: 'hep-th/99010' }, { arxiv_id: '2303.877' }, {}])
    await assert.rejects(tools.call('nisa.paper', caller, input), { code: 'invalid_input' });
  assert.equal(fake.seen.length, 1);
});

test('semantic search, a paper, its passages and related papers each call their route and answer only their fields', async (t) => {
  let paperReply: unknown = paperRecord;
  const fake = await nisa(t, ({ path }) =>
    /^\/api\/sdk\/paper\/[^/]+$/.test(path) ? { body: paperReply } : undefined,
  );
  const service = new NisaService({ keyEnv: keyEnv(t, key), origin: fake.origin });
  const tools = registry(t, service);

  const found = (await tools.call('nisa.semantic_search', caller, {
    query: 'models that predict their own scaling',
    year_min: 2020,
    year_max: 2024,
  })) as NisaPaperList;
  assert.deepEqual(fake.seen.at(-1)!.body, {
    query: 'models that predict their own scaling',
    max_results: 10,
    offset: 0,
    year_min: 2020,
    year_max: 2024,
  });
  assert.deepEqual(found, {
    papers: [
      {
        identifier: 'arxiv:2303.08774',
        arxiv_id: '2303.08774',
        url: 'https://arxiv.org/abs/2303.08774',
        title: 'GPT-4 Technical Report',
        authors: ['OpenAI'],
        year: 2023,
        citation_count: 900,
        score: 0.877,
        snippets: [],
        // A list shows where each abstract starts; nisa.paper reads it whole.
        abstract: 'a'.repeat(600) + '…',
      },
    ],
    count: 1,
    offset: 0,
    truncated: false,
  });
  await assert.rejects(
    tools.call('nisa.semantic_search', caller, { query: ['a', 'b', 'c', 'd', 'e'] }),
    { code: 'invalid_input' },
  );
  await assert.rejects(
    tools.call('nisa.semantic_search', caller, { query: 'q', year_min: 2024, year_max: 2020 }),
    { code: 'invalid_input' },
  );

  const record = (await tools.call('nisa.paper', caller, {
    arxiv_id: 'arXiv:2303.08774v3',
  })) as NisaPaper;
  assert.deepEqual(
    [fake.seen.at(-1)!.method, fake.seen.at(-1)!.path, fake.seen.at(-1)!.headers.authorization],
    ['GET', '/api/sdk/paper/2303.08774', `Bearer ${key}`],
  );
  // A record names up to 100 authors, which paper.cite takes, and says how many are left out.
  assert.equal(record.authors.length, 100);
  assert.equal(record.more_authors, 50);
  assert.deepEqual(
    { ...record, authors: record.authors.slice(0, 2) },
    {
      identifier: 'arxiv:2303.08774',
      arxiv_id: '2303.08774',
      url: 'https://arxiv.org/abs/2303.08774',
      title: 'GPT-4 Technical Report',
      authors: ['Author 0', 'Author 1'],
      more_authors: 50,
      year: 2023,
      citation_count: 900,
      score: null,
      snippets: [],
      abstract: 'We report the development of GPT-4.',
      categories: ['cs.CL', 'cs.AI'],
    },
  );
  // An old-style ID reaches Nisa's route in the form its index keys, and comes back with its slash.
  paperReply = { ...paperRecord, arxiv_id: 'hep-th/9901001' };
  const old = (await tools.call('nisa.paper', caller, {
    arxiv_id: 'hep-th/9901001v2',
  })) as NisaPaper;
  assert.equal(fake.seen.at(-1)!.path, '/api/sdk/paper/hep-th_9901001');
  assert.equal(old.url, 'https://arxiv.org/abs/hep-th/9901001');
  // A record of another paper is no answer to the question asked.
  await assert.rejects(tools.call('nisa.paper', caller, { arxiv_id: '1706.03762' }), {
    code: 'nisa_invalid_response',
    status: 502,
  });

  const passages = (await tools.call('nisa.excerpts', caller, {
    arxiv_id: '2303.08774',
    query: 'predictable scaling & loss',
    max_excerpts: 2,
  })) as NisaExcerpts;
  const asked = new URL(fake.seen.at(-1)!.path, 'http://nisa');
  assert.equal(asked.pathname, '/api/sdk/paper/2303.08774/excerpts');
  assert.deepEqual(Object.fromEntries(asked.searchParams), {
    q: 'predictable scaling & loss',
    max: '2',
  });
  assert.deepEqual(passages, {
    identifier: 'arxiv:2303.08774',
    arxiv_id: '2303.08774',
    url: 'https://arxiv.org/abs/2303.08774',
    excerpts: ['predictable scaling', 'y'.repeat(2000) + '…'],
    count: 2,
    truncated: true,
    doc_found: true,
    full_text_indexed: true,
    matched_terms: ['scaling'],
    missing_terms: [],
  });

  const similar = (await tools.call('nisa.related', caller, {
    arxiv_id: '2303.08774',
    max_results: 5,
  })) as NisaRelated;
  assert.equal(fake.seen.at(-1)!.path, '/api/sdk/paper/2303.08774/related?n=5');
  assert.deepEqual(similar, {
    arxiv_id: '2303.08774',
    papers: [
      {
        identifier: 'arxiv:2005.14165',
        arxiv_id: '2005.14165',
        url: 'https://arxiv.org/abs/2005.14165',
        title: 'Language Models are Few-Shot Learners',
        authors: ['Tom B. Brown'],
        year: 2020,
        citation_count: 30000,
        score: 0.91,
        snippets: [],
        abstract: 'GPT-3.',
      },
    ],
    count: 1,
  });
  for (const answer of [found, record, passages, similar])
    assert.doesNotMatch(JSON.stringify(answer), /token|upstream-secret|embedding|pagerank|cluster/);
});

test('Nisa is held to its deadline, bytes and JSON, never followed elsewhere, and its failures repeat nothing it said', async (t) => {
  const elsewhere = await provider(t);
  let reply: () => Reply | Promise<Reply> = () => ({ body: search });
  const fake = await provider(t, () => reply());
  const service = new NisaService({
    keyEnv: keyEnv(t, key),
    origin: fake.origin,
    searchTimeoutMs: 1000,
    maxResponseBytes: 4096,
  });
  const find = () => service.search({ query: 'q' });
  const words = { error: 'search failed: upstream words and upstream-secret' };
  for (const [status, code, http] of [
    [400, 'nisa_request_refused', 422],
    [401, 'nisa_key_refused', 503],
    [403, 'nisa_key_refused', 503],
    [404, 'nisa_not_found', 404],
    [429, 'nisa_rate_limited', 429],
    [500, 'nisa_upstream_error', 502],
    [503, 'nisa_index_unavailable', 503],
    [504, 'nisa_index_unavailable', 503],
  ] as const) {
    reply = () => ({ status, body: words });
    const tried = fake.seen.length;
    await assert.rejects(find(), (error: any) => {
      assert.equal(error.code, code, `${status}`);
      assert.equal(error.status, http);
      assert.doesNotMatch(error.message, /upstream|search failed/);
      return true;
    });
    // Nisa retries its own index; Merv asks once.
    assert.equal(fake.seen.length - tried, 1);
  }
  reply = () => ({ status: 302, headers: { location: `${elsewhere.origin}/collect` } });
  await assert.rejects(find(), { code: 'nisa_upstream_error', status: 502 });
  assert.equal(elsewhere.seen.length, 0, 'a redirect was followed with the key');
  reply = () => ({ body: { ...search, padding: 'p'.repeat(8000) } });
  await assert.rejects(find(), { code: 'nisa_response_too_large', status: 502 });
  reply = () => ({ raw: '<html>maintenance</html>', headers: { 'content-type': 'text/html' } });
  await assert.rejects(find(), { code: 'nisa_invalid_response', status: 502 });
  // A success that carries an error is not one.
  reply = () => ({ body: words });
  await assert.rejects(find(), { code: 'nisa_invalid_response' });
  reply = () => ({ raw: '{"papers": [' });
  await assert.rejects(find(), { code: 'nisa_invalid_response' });
  const started = Date.now();
  reply = () => new Promise<Reply>(() => {});
  await assert.rejects(find(), { code: 'nisa_timeout', status: 504 });
  assert.ok(Date.now() - started < 4000);
  // Closing ends a call in flight at once, and refuses the next.
  const asked = fake.seen.length;
  const pending = find();
  while (fake.seen.length === asked) await new Promise((resolve) => setTimeout(resolve, 10));
  const closing = Date.now();
  service.close();
  await assert.rejects(pending, { code: 'nisa_stopped', status: 503 });
  assert.ok(Date.now() - closing < 500);
  await assert.rejects(find(), { code: 'nisa_stopped' });
  // Without its key there is nothing to call with.
  const keyless = new NisaService({ keyEnv: 'MERV_NISA_TEST_UNSET_KEY', origin: fake.origin });
  assert.equal(keyless.configured, false);
  await assert.rejects(keyless.search({ query: 'q' }), { code: 'nisa_unavailable', status: 503 });
  // Its origin is https, or loopback only for a test.
  for (const origin of ['http://api.rapidreview.io', 'https://api.rapidreview.io/api', 'ftp://x'])
    assert.equal(nisaConfig.safeParse({ origin }).success, false, origin);
});

test('calls to Nisa wait their turn, and one past the wait is refused before any request', async (t) => {
  let gate = deferred();
  t.after(() => gate.resolve());
  const fake = await provider(t, async () => {
    await gate.promise;
    return { body: search };
  });
  const service = new NisaService({
    keyEnv: keyEnv(t, key),
    origin: fake.origin,
    maxInFlight: 1,
    queueMs: 1000,
  });
  const asked = () => fake.seen.length;
  // Nisa has one call at a time from this process; the others run as it ends, in order.
  const calls = ['one', 'two', 'three'].map((query) => service.search({ query }));
  while (asked() === 0) await new Promise((resolve) => setTimeout(resolve, 10));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(asked(), 1);
  gate.resolve();
  await Promise.all(calls);
  assert.deepEqual(
    fake.seen.map(({ body }) => body.query),
    ['one', 'two', 'three'],
  );
  // One that waits past queueMs is refused, and Nisa never hears of it.
  gate = deferred();
  const held = service.search({ query: 'held' });
  while (asked() === 3) await new Promise((resolve) => setTimeout(resolve, 10));
  const started = Date.now();
  await assert.rejects(service.search({ query: 'refused' }), {
    code: 'nisa_busy',
    status: 429,
    message: 'Merv already has 1 calls to Nisa in flight; try again shortly',
  });
  assert.ok(Date.now() - started >= 900, 'it waited its turn first');
  gate.resolve();
  await held;
  assert.equal(asked(), 4);
});

test('an answer fits what Pi shows of one result, whatever the papers’ text', async (t) => {
  const cjk = '注意力机制的高效实现'.repeat(200);
  const many = Array.from({ length: 40 }, (_, index) => `作者 ${index}`).join(', ');
  const fake = await nisa(t, ({ path }) =>
    new URL(path, 'http://nisa').pathname === '/api/sdk/search'
      ? {
          body: {
            ...search,
            truncated: false,
            papers: Array.from({ length: 20 }, (_, index) => ({
              arxiv_id: `2303.${String(10000 + index)}`,
              title: `Efficient attention ${cjk.slice(0, 40)}`,
              authors: many,
              year: 2023,
              citation_count: index,
              score: 20 - index,
              snippets: [cjk, cjk, cjk],
            })),
          },
        }
      : new URL(path, 'http://nisa').pathname.endsWith('/excerpts')
        ? { body: { ...excerpts, excerpts: Array.from({ length: 20 }, () => cjk) } }
        : { body: { ...paperRecord, abstract: cjk.repeat(10) } },
  );
  const service = new NisaService({ keyEnv: keyEnv(t, key), origin: fake.origin });
  const list = await service.search({ query: 'q', max_results: 20 });
  const record = await service.paper({ arxiv_id: '2303.08774' });
  const passages = await service.excerpts({ arxiv_id: '2303.08774', query: 'q', max_excerpts: 20 });
  for (const [name, answer] of [
    ['nisa.search', list],
    ['nisa.paper', record],
    ['nisa.excerpts', passages],
  ] as const) {
    assert.ok(jsonBytes(answer) <= MAX_ANSWER_BYTES, `${name} ${jsonBytes(answer)}`);
    // Pi shows it whole, never an index of 300-character fields.
    assert.deepEqual(fit(name, answer), answer);
  }
  // Every paper stays, each with twelve authors and its shortened snippets.
  assert.equal(list.count, 20);
  assert.equal(list.papers[0].authors.length, 12);
  assert.equal(list.papers[0].more_authors, 28);
  assert.ok(
    list.papers.every(({ snippets }) => snippets.length === 3 && snippets[0].length > 50),
    JSON.stringify(list.papers[0].snippets),
  );
  assert.match(list.note!, /shortened/);
  assert.match(passages.note!, /shortened/);
  assert.equal(passages.count, 20);
  assert.ok(record.abstract!.endsWith('…'), 'the abstract is shortened');
});

test('nisa tools are open-world reads, taken by the relay, run without a snapshot, and tell a model when to use them', async (t) => {
  const fake = await nisa(t);
  const service = new NisaService({ keyEnv: keyEnv(t, key), origin: fake.origin });
  let snapshots = 0;
  const tools = new ToolRegistry(open, undefined, async (run) => {
    snapshots++;
    return await run();
  });
  t.after(() => tools.close());
  for (const tool of nisaTools(service)) tools.register(tool);
  await tools.call('nisa.search', caller, { query: 'q' });
  await tools.call('nisa.related', caller, { arxiv_id: '2303.08774' });
  assert.equal(snapshots, 0);
  const definitions = nisaTools(service);
  assert.deepEqual(
    definitions.map(({ name }) => piModelToolName(name)),
    ['nisa_search', 'nisa_semantic_search', 'nisa_paper', 'nisa_excerpts', 'nisa_related'],
  );
  for (const definition of definitions) {
    const description = describeTool(definition);
    assert.deepEqual(description.annotations, { readOnlyHint: true, openWorldHint: true });
    // The agent runs it directly, and the relay takes its schema, which names no address.
    assert.equal(conversationUse(definition, {}), undefined);
    assert.ok(piTool(description, definition.conversation), definition.name);
    assert.doesNotMatch(JSON.stringify(description), /https?:\/\/(?!json-schema\.org)/);
    assert.match(definition.description, /untrusted source material/);
  }
  // A model picks by description: papers here, not through a web search.
  for (const name of ['nisa.search', 'nisa.semantic_search'])
    assert.match(
      definitions.find((tool) => tool.name === name)!.description,
      /^Search scholarly papers \(arXiv\).*Use this, not a web search, for literature.*paper\.cite/,
    );
});

test('a Pi turn is offered Nisa and runs it as its person, a reader included', async (t) => {
  const fake = await nisa(t);
  const f = await piFixture(t);
  const service = new NisaService({ keyEnv: keyEnv(t, key), origin: fake.origin });
  for (const tool of nisaTools(service)) f.tools.register(tool);
  const issued = await f.scope.issueActor(f.operator, { name: 'Reader', role: 'reader' });
  const reader: Caller = {
    projectId: f.operator.projectId,
    actorId: issued.actor.id,
    credentialId: issued.credential.id,
  };
  for (const person of [f.operator, reader]) {
    const { token, work, input } = await f.begun(person);
    for (const tool of definitionsOf(service))
      assert.equal(
        work.tools.find(({ name }) => name === tool)?.readOnly,
        true,
        `${person.actorId} ${tool}`,
      );
    const grant = await f.pi.authorizeModel(work.modelToken);
    assert.ok(grant.toolNames.includes('nisa_search'));
    const result = (await f.pi.tool(token, {
      ...input,
      name: 'nisa.search',
      input: { query: 'attention' },
    })) as NisaPaperList;
    assert.deepEqual(
      result.papers.map(({ identifier }) => identifier),
      ['arxiv:1706.03762', 'arxiv:hep-th/9901001'],
    );
  }
  assert.equal(fake.seen.length, 2);
});
const definitionsOf = (service: NisaService) => nisaTools(service).map(({ name }) => name);

test('the render composes Nisa into Main, where MCP clients list and call it', async (t) => {
  const fake = await nisa(t);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'merv-nisa-render-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'deploy'));
  mkdirSync(join(root, 'dist/config'), { recursive: true });
  for (const name of ['render-config.mjs', 'schema.mjs'])
    copyFileSync(new URL(`../deploy/${name}`, import.meta.url), join(root, 'deploy', name));
  copyFileSync(
    new URL('../config/default.json', import.meta.url),
    join(root, 'dist/config/default.json'),
  );
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
        MERV_NISA_API_KEY: key,
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
  ).filter(({ id }) => id === 'nisa' || id === 'nisa-tools');
  assert.deepEqual(
    entries.map(({ id, name }) => [id, name]),
    [
      ['nisa-tools', '@merv/nisa/tools'],
      ['nisa', '@merv/nisa'],
    ],
  );
  // Main reads the rendered entry exactly as the plugin's own schema does; only the origin
  // moves to the fake.
  const entry = entries.find(({ id }) => id === 'nisa')!;
  assert.deepEqual(nisaConfig.parse(entry.config), {
    origin: 'https://api.rapidreview.io',
    keyEnv: 'MERV_NISA_API_KEY',
    timeoutMs: 15_000,
    searchTimeoutMs: 40_000,
    maxResponseBytes: 2 * 1024 * 1024,
    maxInFlight: 4,
    queueMs: 15_000,
  });
  entry.config = { ...entry.config, origin: fake.origin };

  const previous = process.env.MERV_NISA_API_KEY;
  process.env.MERV_NISA_API_KEY = key;
  const directory = mkdtempSync(join(tmpdir(), 'merv-nisa-app-'));
  const composition = loadConfiguration({ directory, api: true, port: 0 }).entries;
  const app = await createApp({ directory, config: { plugins: [...composition, ...entries] } });
  let mcp: Client | undefined;
  t.after(async () => {
    await mcp?.close();
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
    if (previous === undefined) delete process.env.MERV_NISA_API_KEY;
    else process.env.MERV_NISA_API_KEY = previous;
  });
  const boot = await app.ctx.scope.bootstrap({ projectName: 'Nisa', actorName: 'Owner' });
  const owner = { actorId: boot.actor.id, projectId: boot.project.id };
  const issued = await app.ctx.scope.issueActor(owner, { name: 'Reader', role: 'reader' });
  mcp = new Client({ name: 'merv-nisa-test', version: '1.0.0' });
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(app.ctx.api.url! + '/mcp'), {
      requestInit: { headers: { Authorization: `Bearer ${issued.token}` } },
    }),
  );
  const catalog = (await mcp.listTools()).tools;
  // The default composition's 94 tools, and these five.
  assert.equal(catalog.length, 99);
  for (const name of definitionsOf(new NisaService()))
    assert.deepEqual(catalog.find((tool) => tool.name === name)?.annotations, {
      readOnlyHint: true,
      openWorldHint: true,
    });
  const called = await mcp.callTool({ name: 'nisa.paper', arguments: { arxiv_id: '2303.08774' } });
  assert.equal(called.isError, undefined, JSON.stringify(called.content));
  const result = JSON.parse((called.content as { text: string }[])[0].text) as NisaPaper;
  assert.equal(result.identifier, 'arxiv:2303.08774');
  assert.equal(fake.seen[0].headers.authorization, `Bearer ${key}`);
});

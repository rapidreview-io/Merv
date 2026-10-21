import {
  MervError,
  type Actor,
  type AuthenticatedActor,
  type Caller,
  type Principal,
  type Scope,
} from '@merv/contracts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { ApiServer } from '../packages/api/src/http.js';
import { ToolRegistry } from '../packages/api/src/registry.js';
import type { ToolDefinition } from '../packages/api/src/types.js';

const alice: Actor = {
  id: 'alice',
  projectId: 'project-a',
  name: 'Alice',
  role: 'producer',
  active: true,
};
const bob: Actor = {
  id: 'bob',
  projectId: 'project-b',
  name: 'Bob',
  role: 'reviewer',
  active: true,
};
const caller: Caller = {
  actorId: alice.id,
  projectId: alice.projectId,
  credentialId: 'credential-alice',
};

function fixture() {
  const actors = [alice, bob].map((actor) => ({ ...actor }));
  const scope = {
    authenticate(token: string): AuthenticatedActor {
      const actor = actors.find(
        (candidate) => `${candidate.id}-token` === token && candidate.active,
      );
      if (!actor) throw new MervError('unauthorized', 'Invalid token', 401);
      return {
        ...actor,
        credential: {
          id: `credential-${actor.id}`,
          actorId: actor.id,
          projectId: actor.projectId,
          kind: 'actor',
          createdAt: '2026-09-14T00:00:00.000Z',
          expiresAt: null,
          revokedAt: null,
          previousId: null,
        },
      };
    },
    async caller(principal: Principal, projectId?: string): Promise<Caller> {
      assert.equal(principal.kind, 'actor');
      if (principal.kind !== 'actor') throw new Error('Fixture expects an actor credential');
      const resolved = {
        actorId: principal.actor.id,
        projectId: projectId ?? principal.actor.projectId,
        credentialId: principal.actor.credential.id,
      };
      await scope.require(resolved, 'read');
      return resolved;
    },
    async require(caller: Caller) {
      const actor = actors.find((candidate) => candidate.id === caller.actorId && candidate.active);
      if (!actor || caller.projectId !== actor.projectId)
        throw new MervError('forbidden', 'Project access denied', 403);
      return actor;
    },
  } as unknown as Scope;
  const tools = new ToolRegistry(scope);
  tools.register({
    name: 'echo',
    description: 'Echo a validated message with trusted identity',
    inputSchema: z.object({ message: z.string().min(1) }).strict(),
    readOnly: true,
    handler: (caller, input) => ({ ...input, caller }),
  });
  return { scope, tools, actors };
}

test('registry enforces unique registration, input validation, scope and awaited disposal', async () => {
  const { tools } = fixture();
  await assert.rejects(
    async () => tools.register((await tools.list())[0] as ToolDefinition),
    /already registered/,
  );
  await assert.rejects(
    tools.call('echo', caller, { message: 7 }),
    (error: unknown) => error instanceof MervError && error.code === 'invalid_input',
  );
  await assert.rejects(
    tools.call('echo', caller, { message: 'hi', actorId: 'bob' }),
    /failed validation/,
  );
  await assert.rejects(
    tools.call('echo', { ...caller, projectId: 'project-b' }, { message: 'hi' }),
    /Project access denied/,
  );
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const dispose = tools.register({
    name: 'slow',
    description: 'A draining handler',
    inputSchema: z.object({}).strict(),
    handler: async () => {
      entered();
      await wait;
      return 'finished';
    },
  });
  const operation = tools.call('slow', caller, {});
  await started;
  let disposed = false;
  const disposing = dispose().then(() => {
    disposed = true;
  });
  await Promise.resolve();
  assert.equal(disposed, false);
  await assert.rejects(tools.call('slow', caller, {}), /Unknown tool/);
  // A name sent in a 3 MB body is not echoed back whole.
  await assert.rejects(tools.call('x'.repeat(100_000), caller, {}), {
    code: 'unknown_tool',
    message: `Unknown tool: ${'x'.repeat(199)}…`,
  });
  release();
  assert.equal(await operation, 'finished');
  await disposing;
  assert.equal(disposed, true);
  await tools.close();
  await assert.rejects(tools.call('echo', caller, { message: 'hi' }), /stopping/);
});

test('queued tool invocation keeps the original caller identity', async (t) => {
  const { tools } = fixture();
  t.after(() => tools.close());
  const admitted = { ...caller };
  const running = tools.call('echo', admitted, { message: 'original' });
  admitted.projectId = bob.projectId;
  assert.deepEqual(await running, { message: 'original', caller });
  const denied = { ...caller, projectId: bob.projectId };
  const refused = tools.invoke('echo', denied, { message: 'wrong project' });
  denied.projectId = caller.projectId;
  await assert.rejects(refused, { code: 'forbidden' });
});

test('changing a native definition cannot turn a mutation into an unrestricted session read', async (t) => {
  const { scope } = fixture();
  const sessionCaller = { ...caller, session: { id: 'session_readonly' } };
  const tools = new ToolRegistry(scope, {
    granted: async () => () => false,
    require: async () => {},
  });
  tools.registerSessionPolicy({
    allowsTool: async (_caller, _name, read) => !!read,
    prepare: async (caller, tool, input, read) => {
      if (!read) throw new MervError('tool_forbidden', 'Session only permits reads', 403);
      return { caller, tool, input };
    },
    validate: async () => {},
    run: async (prepared, dispatch) => dispatch(prepared.caller, prepared.input),
    cancel: async () => {},
  });
  t.after(() => tools.close());
  let calls = 0;
  const definition: ToolDefinition = {
    name: 'private.write',
    description: 'A mutation',
    readOnly: false,
    inputSchema: z.object({}).strict(),
    handler: () => {
      calls++;
      return {};
    },
  };
  tools.register(definition);
  definition.readOnly = true;
  const listed: Caller = structuredClone(sessionCaller);
  const listing = tools.describe(listed);
  delete listed.session;
  assert.deepEqual(await listing, []);
  const source: Caller = structuredClone(sessionCaller);
  const invoking = tools.call(definition.name, source, {});
  delete source.session;
  await assert.rejects(invoking, { code: 'tool_forbidden' });
  assert.equal(calls, 0);
});

test('HTTP uses bearer identity, validates caller project, input, request size and origins', async (t) => {
  const { scope, tools, actors } = fixture();
  const server = new ApiServer(scope, tools, { maxBodyBytes: 512 });
  const url = await server.start();
  t.after(async () => {
    await server.stop();
    await tools.close();
  });
  const post = (body: unknown, token = 'alice-token') =>
    fetch(`${url}/tools/echo`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  assert.equal((await fetch(`${url}/health`)).status, 200);
  assert.equal((await fetch(`${url}/tools`)).status, 401);
  assert.equal((await post({ message: 'hi' }, 'invalid')).status, 401);
  const success = await post({ message: 'hi', projectId: 'project-a' });
  assert.equal(success.status, 200);
  assert.deepEqual(await success.json(), { result: { message: 'hi', caller } });
  assert.equal((await post({ message: 'hi', projectId: 'project-b' })).status, 403);
  assert.equal((await post({ message: 'hi', actorId: 'bob' })).status, 400);
  const invalid = await post({ message: 3 });
  assert.equal(invalid.status, 400);
  assert.deepEqual(((await invalid.json()) as { error: { details: unknown } }).error.details, [
    { path: ['message'], message: 'Expected string, received number', code: 'invalid_type' },
  ]);
  assert.equal((await post({ message: 'x'.repeat(600) })).status, 413);
  const malformed = await fetch(`${url}/tools/echo`, {
    method: 'POST',
    headers: { authorization: 'Bearer alice-token', 'content-type': 'application/json' },
    body: '{broken',
  });
  assert.equal(malformed.status, 400);
  const origin = await fetch(`${url}/tools`, {
    headers: { authorization: 'Bearer alice-token', origin: 'https://untrusted.example' },
  });
  assert.equal(origin.status, 403);
  const list = await fetch(`${url}/tools`, { headers: { authorization: 'Bearer alice-token' } });
  const manifest = (await list.json()) as {
    tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[];
  };
  assert.equal(manifest.tools[0]!.name, 'echo');
  assert.ok(manifest.tools[0]!.inputSchema.properties.projectId);
  actors[0]!.active = false;
  assert.equal((await post({ message: 'after revocation' })).status, 401);
});

test('official MCP client initializes, lists tools and calls with isolated authenticated scope', async (t) => {
  const { scope, tools, actors } = fixture();
  const server = new ApiServer(scope, tools);
  const url = await server.start();
  const client = new Client({ name: 'merv-integration-test', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
    requestInit: { headers: { authorization: 'Bearer alice-token' } },
  });
  t.after(async () => {
    await client.close();
    await server.stop();
    await tools.close();
  });
  await client.connect(transport);
  const listed = await client.listTools();
  assert.equal(listed.tools[0]!.name, 'echo');
  const result = await client.callTool({ name: 'echo', arguments: { message: 'through mcp' } });
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse((result.content as { type: string; text: string }[])[0]!.text), {
    message: 'through mcp',
    caller,
  });
  const foreign = await client.callTool({
    name: 'echo',
    arguments: { message: 'through mcp', projectId: 'project-b' },
  });
  assert.equal(foreign.isError, true);
  const spoof = await client.callTool({
    name: 'echo',
    arguments: { message: 'through mcp', actorId: 'bob' },
  });
  assert.equal(spoof.isError, true);
  actors[0]!.active = false;
  await assert.rejects(client.listTools());
});

test('HTTP shutdown drains admitted operations before resolving', async () => {
  const { scope, tools } = fixture();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  tools.register({
    name: 'slow',
    description: 'A draining handler',
    inputSchema: z.object({}).strict(),
    handler: async () => {
      entered();
      await wait;
      return 'finished';
    },
  });
  const server = new ApiServer(scope, tools);
  const url = await server.start();
  const response = fetch(`${url}/tools/slow`, {
    method: 'POST',
    headers: { authorization: 'Bearer alice-token', 'content-type': 'application/json' },
    body: '{}',
  });
  await started;
  let stopped = false;
  const stopping = server.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  assert.equal(stopped, false);
  release();
  assert.deepEqual(await (await response).json(), { result: 'finished' });
  await stopping;
  assert.equal(stopped, true);
  await tools.close();
});

test('MCP shutdown drains a handler even after its client disconnects', async () => {
  const { scope, tools } = fixture();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  tools.register({
    name: 'slow',
    description: 'A durable operation continues after disconnection',
    inputSchema: z.object({}).strict(),
    handler: async () => {
      entered();
      await wait;
      return 'finished';
    },
  });
  const server = new ApiServer(scope, tools);
  const url = await server.start();
  const abort = new AbortController();
  const response = fetch(`${url}/mcp`, {
    method: 'POST',
    signal: abort.signal,
    headers: {
      authorization: 'Bearer alice-token',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'slow', arguments: {} },
    }),
  });
  await started;
  abort.abort();
  await assert.rejects(
    response,
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
  );
  let stopped = false;
  const stopping = server.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  assert.equal(stopped, false);
  release();
  await stopping;
  assert.equal(stopped, true);
  await tools.close();
});

for (const endpoint of ['http', 'mcp'] as const) {
  test(`${endpoint} rejects malformed UTF-8 before dispatching a mutation`, async (t) => {
    const { scope, tools } = fixture();
    const saved: string[] = [];
    tools.register({
      name: 'record',
      description: 'Record the supplied text',
      inputSchema: z.object({ message: z.string() }).strict(),
      handler: (_caller, input) => {
        saved.push(input.message as string);
        return input;
      },
    });
    const server = new ApiServer(scope, tools);
    const url = await server.start();
    t.after(async () => {
      await server.stop();
      await tools.close();
    });
    const envelope =
      endpoint === 'http'
        ? ['{"message":"', '"}']
        : [
            '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"record","arguments":{"message":"',
            '"}}}',
          ];
    const post = (bytes: Buffer) =>
      fetch(`${url}/${endpoint === 'http' ? 'tools/record' : 'mcp'}`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer alice-token',
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: Buffer.concat([Buffer.from(envelope[0]!), bytes, Buffer.from(envelope[1]!)]),
      });
    for (const [name, bytes] of [
      ['overlong encoding', [0xc0, 0xaf]],
      ['encoded surrogate', [0xed, 0xa0, 0x80]],
      ['incomplete sequence', [0xe2, 0x82]],
    ] as const) {
      await t.test(name, async () => {
        const before = saved.length;
        const response = await post(Buffer.from(bytes));
        assert.equal(response.status, 400);
        assert.equal((await response.json()).error.code, 'invalid_json');
        assert.equal(saved.length, before, 'invalid bytes must not reach the mutation');
      });
    }
    await t.test(
      'valid multibyte text including a literal replacement character is retained',
      async () => {
        const message = 'Evidence: café 🌍 �';
        const response = await post(Buffer.from(message));
        assert.equal(response.status, 200);
        const payload = await response.json();
        const result =
          endpoint === 'http' ? payload.result : JSON.parse(payload.result.content[0].text);
        assert.equal(result.message, message);
        assert.equal(saved.at(-1), message);
      },
    );
  });
}

/** Stops `api` or reports that it hung, so a regression cannot hang the runner. */
async function stopWithin(api: ApiServer, ms: number): Promise<number> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      api.stop().then(() => 'stopped'),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve('hung'), ms);
      }),
    ]);
    assert.equal(result, 'stopped', `stop() must finish within ${ms} ms`);
  } finally {
    clearTimeout(timer);
  }
  return Date.now() - started;
}

/** Captures the API's stderr lines while `fn` runs. */
async function stderrOf(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(...String(chunk).split('\n').filter(Boolean));
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = write;
  }
  return lines.filter((line) => line.includes('"api_error"'));
}

test('a response that fails after its head resets the connection', async () => {
  const { scope, tools } = fixture();
  const api = new ApiServer(scope, tools);
  api.mount(
    '/partial',
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('started');
      throw new Error('failed mid-response');
    },
    { public: true },
  );
  const url = await api.start();
  const logged = await stderrOf(async () => {
    const response = await fetch(`${url}/partial`, { signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, 200);
    await assert.rejects(response.text(), (error: Error) => error.name !== 'TimeoutError');
  });
  assert.equal(logged.length, 1);
  await stopWithin(api, 1000);
  await tools.close();
});

test('a 401 names its Bearer scheme, and JSON bodies accept any media-type case', async (t) => {
  const { scope, tools } = fixture();
  const api = new ApiServer(scope, tools);
  const url = await api.start();
  t.after(async () => {
    await api.stop();
    await tools.close();
  });
  const refused = await fetch(`${url}/tools`);
  assert.equal(refused.status, 401);
  assert.equal(refused.headers.get('www-authenticate'), 'Bearer');
  assert.equal((await refused.json()).connect, undefined);
  // An agent refused at /mcp is told where a person makes it a key, or, once agent sign-in has
  // mounted /connect, that page; /auth/config says where to point it.
  const agent = () =>
    fetch(`${url}/mcp`, { method: 'POST', headers: { authorization: 'Bearer stale' } }).then(
      (response) => response.json(),
    );
  const config = () => fetch(`${url}/auth/config`).then((response) => response.json());
  assert.deepEqual(await agent(), {
    error: { code: 'unauthorized', message: 'Invalid token' },
    connect: '/ui/settings/keys',
  });
  assert.deepEqual(await config(), { enabled: false, mcpUrl: `${url}/mcp` });
  const unmount = api.mount('/connect', () => ({}), { public: true });
  assert.equal((await agent()).connect, '/connect');
  assert.deepEqual(await config(), {
    enabled: false,
    mcpUrl: `${url}/mcp`,
    connectUrl: `${url}/connect`,
  });
  unmount();
  assert.equal((await agent()).connect, '/ui/settings/keys');
  assert.equal((await fetch(`${url}/health`)).headers.get('www-authenticate'), null);
  const accepted = await fetch(`${url}/tools/echo`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer alice-token',
      'content-type': 'Application/JSON; charset=utf-8',
    },
    body: JSON.stringify({ message: 'hi' }),
  });
  assert.equal(accepted.status, 200);
});

test('mount prefixes are single segments with public paths inside them, and withdrawal answers 503', async (t) => {
  const { scope, tools } = fixture();
  const api = new ApiServer(scope, tools);
  for (const [prefix, options] of [
    ['/tools/x', {}],
    ['/Upper', {}],
    ['/open', { public: ['/other'] }],
    ['/open', { public: ['/open/'] }],
    ['/open', { public: ['/openly'] }],
  ] as const)
    assert.throws(() => api.mount(prefix, () => ({}), options), { code: 'invalid_mount' }, prefix);
  for (const prefix of ['/tools', '/mcp', '/health', '/auth'])
    assert.throws(() => api.mount(prefix, () => ({})), { code: 'mount_conflict' }, prefix);
  const withdraw = api.mount('/open', (_req, _res, r) => ({ principal: r.principal ?? null }), {
    public: ['/open/door'],
  });
  assert.throws(() => api.mount('/open', () => ({})), { code: 'mount_conflict' });
  const url = await api.start();
  t.after(async () => {
    await api.stop();
    await tools.close();
  });
  assert.deepEqual(await (await fetch(`${url}/open/door/in`)).json(), { principal: null });
  assert.equal((await fetch(`${url}/open/doorway`)).status, 401);
  assert.equal((await fetch(`${url}/nowhere`)).status, 404);
  withdraw();
  withdraw();
  const withdrawn = await fetch(`${url}/open/door`);
  assert.deepEqual([withdrawn.status, (await withdrawn.json()).error.code], [503, 'unavailable']);
  // Mounted again, the prefix serves again.
  api.mount('/open', () => ({ again: true }), { public: true });
  assert.deepEqual(await (await fetch(`${url}/open`)).json(), { again: true });
});

test('a mount withdrawn while its caller is authenticated answers 503 and its handler never runs', async (t) => {
  const { scope, tools } = fixture();
  const api = new ApiServer(scope, tools);
  let handled = 0;
  let entered!: () => void;
  const authenticating = new Promise<void>((resolve) => (entered = resolve));
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  api.credential('pb_', {
    kind: 'probe',
    forbidden: new MervError('probe_forbidden', 'Probe credentials may only read /probe', 403),
    routes: (method, path) => method === 'GET' && path === '/probe',
    authenticate: async () => {
      entered();
      await released;
      return { actorId: alice.id, projectId: alice.projectId };
    },
  });
  const withdraw = api.mount('/probe', () => ({ handled: ++handled }));
  const url = await api.start();
  t.after(async () => {
    await api.stop();
    await tools.close();
  });
  const response = fetch(`${url}/probe`, { headers: { authorization: 'Bearer pb_secret' } });
  await authenticating;
  withdraw();
  release();
  const answered = await response;
  assert.deepEqual([answered.status, (await answered.json()).error.code], [503, 'unavailable']);
  assert.equal(handled, 0);
});

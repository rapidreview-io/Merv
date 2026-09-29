import { fixtureAccess } from './fixtures/access.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { Context } from 'cordis';
import { request as httpRequest, type Server as HttpServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  MervError,
  type Actor,
  type AuthenticatedActor,
  type Caller,
  type Principal,
  type Scope,
} from '@merv/contracts';
import { ApiServer } from '../packages/api/src/http.js';
import { ToolRegistry } from '../packages/api/src/registry.js';
import { toolsPlugin } from '../packages/api/src/index.js';
import type { ToolDefinition, ToolDescription } from '../packages/api/src/types.js';

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

test('native registration keeps validation paired with its description when the definition schema is replaced', async () => {
  const { tools } = fixture();
  const definition = (await tools.list())[0]! as ToolDefinition;
  const description = await tools.describe(caller);
  definition.inputSchema = z.object({ message: z.number() }).strict();
  definition.handler = (_caller, input) => ({ message: input.message, handler: 'replacement' });
  assert.deepEqual(await tools.describe(caller), description);
  assert.deepEqual(await tools.call('echo', caller, { message: 'registered string' }), {
    message: 'registered string',
    handler: 'replacement',
  });
  await assert.rejects(tools.call('echo', caller, { message: 7 }), /failed validation/);
  await tools.close();
});

test('native read protection stays paired with published metadata despite definition mutation', async (t) => {
  const { scope, actors } = fixture();
  let snapshots = 0;
  const tools = new ToolRegistry(scope, undefined, async (run) => {
    snapshots++;
    return run();
  });
  t.after(() => tools.close());
  const definition: ToolDefinition = {
    name: 'private.read',
    description: 'A protected read',
    readOnly: true,
    inputSchema: z.object({}).strict(),
    handler: () => {
      // Mutable native handlers are supported, but metadata changes must require registration.
      definition.readOnly = false;
      actors[0].active = false;
      return { private: 'must not be returned after revocation' };
    },
  };
  tools.register(definition);
  definition.readOnly = false;
  assert.equal((await tools.describe(caller))[0].annotations?.readOnlyHint, true);
  await assert.rejects(tools.call(definition.name, caller, {}), { code: 'forbidden' });
  assert.equal(snapshots, 1, 'the registered read must still execute in the read scope');
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

test('Cordis dependency disposal drains a feature tool before closing its scope provider', async () => {
  const { scope } = fixture();
  const ctx = new Context();
  let scopeClosed = false;
  const provider = await ctx.plugin({
    name: 'test-scope',
    apply(ctx: Context) {
      ctx.effect(function* () {
        yield () => {
          scopeClosed = true;
        };
        yield ctx.provide('scope', scope);
      });
    },
  });
  await ctx.plugin(toolsPlugin);
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  await ctx.plugin({
    name: 'test-tool',
    inject: ['scope', 'tools'],
    apply(ctx: Context) {
      ctx.effect(() =>
        ctx.tools.register({
          name: 'slow',
          description: 'Uses a live provider',
          inputSchema: z.object({}).strict(),
          handler: async () => {
            entered();
            await wait;
            assert.equal(scopeClosed, false);
            return 'finished';
          },
        }),
      );
    },
  });
  const operation = ctx.tools.call('slow', caller, {});
  await started;
  let disposed = false;
  const disposing = provider.dispose().then(() => {
    disposed = true;
  });
  await Promise.resolve();
  assert.equal(scopeClosed, false);
  assert.equal(disposed, false);
  release();
  assert.equal(await operation, 'finished');
  await disposing;
  assert.equal(scopeClosed, true);
  assert.equal(ctx.get('tools'), undefined);
  await ctx.fiber.dispose();
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

test('a refusal whose details JSON cannot carry is answered without them', async (t) => {
  const { scope, tools } = fixture();
  const api = new ApiServer(scope, tools);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  api.mount(
    '/bigint',
    () => {
      throw new MervError('odd_input', 'Odd input', 422, { count: 1n });
    },
    { public: true },
  );
  api.mount(
    '/cycle',
    () => {
      throw new MervError('odd_input', 'Odd input', 422, cycle);
    },
    { public: true },
  );
  const url = await api.start();
  t.after(async () => {
    await api.stop();
    await tools.close();
  });
  for (const path of ['/bigint', '/cycle']) {
    const response = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(5_000) });
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), {
      error: { code: 'odd_input', message: 'Odd input' },
    });
  }
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

test('HTTP and MCP consume the registry public description projection without rebuilding definitions', async (t) => {
  const { scope, tools: native } = fixture();
  const tools = new ToolRegistry(scope, fixtureAccess);
  tools.register((await native.list())[0] as ToolDefinition);
  await native.close();
  tools.register({
    name: 'unlisted',
    description: 'A definition excluded from this test projection',
    inputSchema: z.object({}).strict(),
    handler: () => null,
  });
  tools.createCatalog('remote').replace([
    {
      kind: 'mcp',
      name: 'echo',
      description: 'Preserve the upstream project argument',
      title: 'Upstream echo',
      inputSchema: {
        type: 'object',
        properties: { projectId: { type: 'integer', minimum: 1 } },
        required: ['projectId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: { upstream: { extension: ['retained'] } },
      handler: async (_caller, input) => ({
        content: [{ type: 'text', text: JSON.stringify(input) }],
      }),
    },
  ]);
  const canonical = tools.describe.bind(tools);
  const original = await canonical(caller);
  const projectSchema = original.find((tool) => tool.name === 'echo')!.inputSchema.properties!
    .projectId;
  assert.deepEqual(projectSchema, {
    type: 'string',
    minLength: 1,
    description:
      'Project scope. Human sessions and account machine keys must select a project; actor tokens and project machine keys default to their fixed project. Access is checked by the server.',
  });
  // Returned metadata is detached from both handler schemas and future descriptions.
  original.find((tool) => tool.name === 'echo')!.inputSchema.properties!.projectId = {
    type: 'boolean',
  };
  assert.deepEqual(
    (await canonical(caller)).find((tool) => tool.name === 'echo')!.inputSchema.properties!
      .projectId,
    projectSchema,
  );
  const project = (descriptions: ToolDescription[]) =>
    descriptions
      .filter((tool) => tool.name !== 'unlisted')
      .map((tool) => ({ ...tool, description: `Projected: ${tool.description}` }));
  const expected = project(await canonical(caller));
  const seen: Caller[] = [];
  tools.describe = async (authenticated) => {
    assert.ok(authenticated, 'Transport must pass authenticated caller authority');
    seen.push(authenticated);
    return project(await canonical(authenticated));
  };
  tools.list = async () => {
    throw new Error('Transport must not rebuild descriptions from raw definitions');
  };
  const server = new ApiServer(scope, tools);
  const url = await server.start();
  const client = new Client({ name: 'description-projection-test', version: '1' });
  t.after(async () => {
    await client.close();
    await server.stop();
    await tools.close();
  });
  const headers = { authorization: 'Bearer alice-token', 'content-type': 'application/json' };
  const response = await fetch(`${url}/tools`, { headers });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { tools: expected });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers } }),
  );
  assert.deepEqual((await client.listTools()).tools, expected);
  assert.deepEqual(seen, [caller, caller]);
  const nativeCall = await fetch(`${url}/tools/echo`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ message: 'unchanged', projectId: alice.projectId }),
  });
  assert.deepEqual(await nativeCall.json(), { result: { message: 'unchanged', caller } });
  const remoteCall = await client.callTool({ name: '_remote.echo', arguments: { projectId: 7 } });
  assert.deepEqual(remoteCall.content, [{ type: 'text', text: '{"projectId":7}' }]);
  const invalidRemote = await client.callTool({
    name: '_remote.echo',
    arguments: { projectId: '7' },
  });
  assert.equal(invalidRemote.isError, true, 'Remote schema validation still forbids coercion');
  await assert.rejects(
    tools.call('echo', caller, { message: 'unchanged', projectId: alice.projectId }),
    /failed validation/,
    'The public project envelope must not widen the native handler schema',
  );
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

test('an MCP client that disconnects before its reply cannot hold API shutdown', async (t) => {
  const { scope, tools } = fixture();
  let entered!: () => void, release!: () => void, closed!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const disconnected = new Promise<void>((resolve) => {
    closed = resolve;
  });
  tools.register({
    name: 'slow',
    description: 'Finishes only after its client has gone',
    inputSchema: z.object({}).strict(),
    handler: async () => {
      entered();
      await wait;
      return 'finished';
    },
  });
  const api = new ApiServer(scope, tools);
  const url = await api.start();
  // The server must see the connection close while the call is pending: that closes the
  // stateless MCP transport, which then never settles the reply it was holding.
  (api as unknown as { server: HttpServer }).server.on('request', (_request, response) => {
    response.once('close', closed);
  });
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'slow', arguments: {} },
  });
  const request = httpRequest(`${url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer alice-token',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'content-length': String(Buffer.byteLength(body)),
    },
  });
  request.on('error', () => {});
  let stopping: Promise<void> | undefined;
  t.after(async () => {
    request.destroy();
    release();
    // A failing regression must not hang the whole runner on the very promise under test.
    stopping ??= api.stop();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        stopping,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 500);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    await tools.close();
  });
  request.end(body);
  await started;
  request.destroy();
  await disconnected;
  release();
  stopping = api.stop();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      stopping.then(() => 'stopped'),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve('hung'), 2000);
      }),
    ]);
    assert.equal(result, 'stopped', 'an MCP reply with no connection must not block shutdown');
  } finally {
    clearTimeout(timer);
  }
});

test('disconnect during authentication cannot strand the later body reader or shutdown', async (t) => {
  const { scope, tools } = fixture();
  let entered!: () => void, release!: () => void, aborted!: () => void;
  const authenticating = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const authentication = new Promise<void>((resolve) => {
    release = resolve;
  });
  const disconnected = new Promise<void>((resolve) => {
    aborted = resolve;
  });
  const original = scope.authenticate.bind(scope);
  t.mock.method(scope, 'authenticate', async (token: string) => {
    entered();
    await authentication;
    return original(token);
  });
  const api = new ApiServer(scope, tools);
  const url = await api.start();
  // Observe the server-side abort, not just the client socket closing: the race requires
  // IncomingMessage's abort event to occur before authentication releases the body reader.
  (api as unknown as { server: HttpServer }).server.on('request', (request) => {
    request.once('aborted', aborted);
  });
  const request = httpRequest(`${url}/tools/echo`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer alice-token',
      'content-type': 'application/json',
      'content-length': '100',
    },
  });
  request.on('error', () => {});
  let stopping: Promise<void> | undefined;
  t.after(async () => {
    request.destroy();
    release();
    // A failing regression must not hang the whole runner on the very promise under test.
    stopping ??= api.stop();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        stopping,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 500);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    await tools.close();
  });
  request.write('{');
  await authenticating;
  request.destroy();
  await disconnected;
  release();
  stopping = api.stop();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      stopping.then(() => 'stopped'),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve('hung'), 500);
      }),
    ]);
    assert.equal(
      result,
      'stopped',
      'an already-aborted request must not wait for another abort event',
    );
  } finally {
    clearTimeout(timer);
  }
});

test('concurrent API stops share one shutdown and allow a later restart', async () => {
  const { scope, tools } = fixture();
  const api = new ApiServer(scope, tools);
  await api.start();
  try {
    const stopped = await Promise.allSettled([api.stop(), api.stop(), api.stop()]);
    assert.deepEqual(
      stopped.map((result) => result.status),
      ['fulfilled', 'fulfilled', 'fulfilled'],
    );
    const url = await api.start();
    assert.equal((await fetch(`${url}/health`)).status, 200);
  } finally {
    await api.stop();
    await tools.close();
  }
});

test('API stop during startup waits for listening and then closes the listener', async () => {
  const { scope, tools } = fixture();
  const api = new ApiServer(scope, tools);
  try {
    const starting = api.start();
    const stopping = api.stop();
    const results = await Promise.allSettled([starting, stopping]);
    assert.deepEqual(
      results.map((result) => result.status),
      ['fulfilled', 'fulfilled'],
    );
    await assert.rejects(fetch(`${await starting}/health`));
  } finally {
    await api.stop();
    await tools.close();
  }
});

test('API shutdown tolerates failed startup and the same instance can retry', async () => {
  const { scope, tools } = fixture();
  const blocker = new ApiServer(scope, tools);
  const occupied = await blocker.start();
  const api = new ApiServer(scope, tools, { port: Number(new URL(occupied).port) });
  try {
    const starting = api.start();
    const stopping = api.stop();
    await assert.rejects(starting, { code: 'EADDRINUSE' });
    await stopping;
    await blocker.stop();
    const url = await api.start();
    assert.equal((await fetch(`${url}/health`)).status, 200);
  } finally {
    await Promise.all([blocker.stop(), api.stop()]);
    await tools.close();
  }
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

test('a result that cannot be serialized answers 500 once, logs no message, and never hangs shutdown', async () => {
  const { scope, tools } = fixture();
  tools.register({
    name: 'big',
    description: 'Returns a value JSON cannot hold',
    inputSchema: z.object({}).strict(),
    handler: () => ({ n: 1n }),
  });
  tools.register({
    name: 'broken',
    description: 'Fails with a database-shaped cause',
    inputSchema: z.object({}).strict(),
    handler: () => {
      throw Object.assign(new Error('password=hunter2'), {
        cause: { sqlstate: 1n, table: 'secrets', constraint: { toString: () => 'pk' } },
      });
    },
  });
  const api = new ApiServer(scope, tools);
  const url = await api.start();
  const post = (name: string) =>
    fetch(`${url}/tools/${name}`, {
      method: 'POST',
      headers: { authorization: 'Bearer alice-token', 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(2000),
    });
  let responses: Response[] = [];
  const logged = await stderrOf(async () => {
    responses = [await post('big'), await post('broken')];
  });
  for (const response of responses) {
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: { code: 'internal_error', message: 'Internal server error' },
    });
  }
  assert.equal(logged.length, 2);
  assert.ok(logged.every((line) => !line.includes('password')));
  const failure = JSON.parse(logged[1]!);
  assert.equal(failure.where, 'POST /tools/broken');
  assert.deepEqual(
    [failure.status, failure.code, failure.name, failure.sqlstate, failure.table],
    [500, 'internal_error', 'Error', '1', 'secrets'],
  );
  assert.equal(failure.constraint, 'pk');
  assert.ok(failure.at.length > 0 && failure.at.length <= 3);
  await stopWithin(api, 1000);
  await tools.close();
});

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

test('stop() lets a written response reach a slow reader whole', async () => {
  const { scope, tools } = fixture();
  const api = new ApiServer(scope, tools);
  const payload = Buffer.alloc(4 * 1024 * 1024, 7);
  let returned!: () => void;
  const handled = new Promise<void>((resolve) => {
    returned = resolve;
  });
  api.mount(
    '/large',
    (_req, res) => {
      res.writeHead(200, { 'content-length': payload.length });
      res.end(payload);
      returned();
    },
    { public: true },
  );
  const url = await api.start();
  const received = new Promise<number>((resolve, reject) => {
    httpRequest(`${url}/large`, (response) => {
      response.pause();
      let size = 0;
      // Start reading only once shutdown has begun, well after the handler returned.
      setTimeout(() => {
        response.on('data', (chunk: Buffer) => (size += chunk.length));
        response.once('end', () => resolve(size));
        response.once('error', reject);
        response.resume();
      }, 200);
    })
      .on('error', reject)
      .end();
  });
  await handled;
  const stopping = stopWithin(api, 5000);
  assert.equal(await received, payload.length);
  await stopping;
  await tools.close();
});

test('stop() cuts a response that never ends after drainMs', async () => {
  const { scope, tools } = fixture();
  const api = new ApiServer(scope, tools, { drainMs: 200 });
  let opened!: () => void;
  const streaming = new Promise<void>((resolve) => {
    opened = resolve;
  });
  let ended = false;
  api.mount(
    '/stream',
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: open\n\n');
      opened();
      // A stream ends when its response closes, as the relay and conversation streams do.
      return new Promise<void>((resolve) =>
        res.once('close', () => {
          ended = true;
          resolve();
        }),
      );
    },
    { public: true },
  );
  const url = await api.start();
  const response = await fetch(`${url}/stream`);
  await streaming;
  const elapsed = await stopWithin(api, 2000);
  assert.ok(elapsed < 1000, `stop() took ${elapsed} ms`);
  assert.equal(ended, true);
  await assert.rejects(response.text());
  await tools.close();
});

test('stop() closes a keep-alive connection as soon as its request completes', async () => {
  const { scope, tools } = fixture();
  const api = new ApiServer(scope, tools);
  let started!: () => void;
  const inFlight = new Promise<void>((resolve) => {
    started = resolve;
  });
  api.mount(
    '/slow',
    async (_req, res) => {
      started();
      await new Promise((resolve) => setTimeout(resolve, 300));
      res.end('done');
    },
    { public: true },
  );
  const url = await api.start();
  // Open the keep-alive connection with one request first, then reuse it.
  await (await fetch(`${url}/health`)).text();
  const response = fetch(`${url}/slow`).then(async (answer) => {
    const text = await answer.text();
    return { text, at: Date.now() };
  });
  await inFlight;
  const stopping = api.stop().then(() => Date.now());
  const { text, at } = await response;
  assert.equal(text, 'done');
  const stoppedAt = await stopping;
  assert.ok(stoppedAt - at < 1000, `stop() finished ${stoppedAt - at} ms after the response`);
  await tools.close();
});

test('MCP tools/list failures are JSON-RPC errors without internal text', async (t) => {
  const { scope, tools } = fixture();
  const api = new ApiServer(scope, tools);
  const url = await api.start();
  t.after(async () => {
    await api.stop();
    await tools.close();
  });
  const list = async () =>
    (
      await fetch(`${url}/mcp`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer alice-token',
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      })
    ).json() as Promise<{ error: { code: number; message: string; data?: unknown } }>;
  const describe = t.mock.method(tools, 'describe', async () => {
    throw new Error('connect ECONNREFUSED password=x');
  });
  let internal!: Awaited<ReturnType<typeof list>>;
  const logged = await stderrOf(async () => {
    internal = await list();
  });
  assert.equal(internal.error.code, -32603);
  assert.equal(internal.error.message, 'Internal server error');
  assert.equal(logged.length, 1);
  assert.ok(!logged[0]!.includes('password'));
  assert.equal(JSON.parse(logged[0]!).where, 'mcp');
  describe.mock.mockImplementation(async () => {
    throw new MervError('forbidden', 'Project access denied', 403);
  });
  const forbidden = await list();
  assert.equal(forbidden.error.code, -32600);
  assert.deepEqual(forbidden.error.data, { code: 'forbidden', message: 'Project access denied' });
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

test('mounted GETs run outside the read snapshot', async (t) => {
  const { scope, tools } = fixture();
  let snapshots = 0;
  const api = new ApiServer(scope, tools, {
    snapshot: (fn) => {
      snapshots++;
      return fn();
    },
  });
  api.mount('/static', (_req, res) => void res.end('asset'), { public: true });
  const url = await api.start();
  t.after(async () => {
    await api.stop();
    await tools.close();
  });
  assert.equal(await (await fetch(`${url}/static/app.js`)).text(), 'asset');
  assert.equal(snapshots, 0);
  const listed = await fetch(`${url}/tools`, { headers: { authorization: 'Bearer alice-token' } });
  assert.equal(listed.status, 200);
  assert.equal(snapshots, 1);
});

test('a mount returns JSON or octets, and its caller is one decision in the selected project', async (t) => {
  const { scope, tools } = fixture();
  let decisions = 0;
  const decide = scope.caller.bind(scope);
  scope.caller = async (principal, projectId) => {
    decisions++;
    return await decide(principal, projectId);
  };
  const api = new ApiServer(scope, tools);
  api.mount('/value', async (req, _res, r) =>
    req.method === 'PUT'
      ? Buffer.from(await r.bytes(16, 'application/octet-stream'))
      : { caller: await r.caller(r.url.searchParams.get('project') ?? undefined) },
  );
  const url = await api.start();
  t.after(async () => {
    await api.stop();
    await tools.close();
  });
  const get = (query = '', headers: Record<string, string> = {}) =>
    fetch(`${url}/value${query}`, { headers: { authorization: 'Bearer alice-token', ...headers } });
  const selected = await get('', { 'x-merv-project-id': alice.projectId });
  assert.equal(selected.status, 200);
  assert.equal((await selected.json()).caller.projectId, alice.projectId);
  assert.equal(decisions, 1);
  const conflict = await get('?project=project-a', { 'x-merv-project-id': 'project-b' });
  assert.deepEqual([conflict.status, (await conflict.json()).error.code], [400, 'invalid_input']);
  assert.equal(decisions, 1);
  assert.equal((await get('', { 'x-merv-project-id': bob.projectId })).status, 403);
  const octets = await fetch(`${url}/value`, {
    method: 'PUT',
    headers: { authorization: 'Bearer alice-token', 'content-type': 'application/octet-stream' },
    body: 'bytes',
  });
  assert.equal(octets.headers.get('content-type'), 'application/octet-stream');
  assert.equal(await octets.text(), 'bytes');
  assert.equal((await fetch(`${url}/value`)).status, 401);
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
  for (const prefix of ['/tools', '/mcp', '/health', '/auth', '/sessions', '/code', '/account'])
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

test('a mount withdrawn while its body is read answers 503 and its handler never sees the body', async (t) => {
  const { scope, tools } = fixture();
  const api = new ApiServer(scope, tools);
  let bodies = 0;
  let startedReading!: () => void;
  const reading = new Promise<void>((resolve) => (startedReading = resolve));
  const withdraw = api.mount(
    '/upload',
    async (_req, _res, r) => {
      startedReading();
      await r.json();
      bodies++;
      return {};
    },
    { public: true },
  );
  const url = await api.start();
  t.after(async () => {
    await api.stop();
    await tools.close();
  });
  const body = new TransformStream<Uint8Array, Uint8Array>();
  const writer = body.writable.getWriter();
  const response = fetch(`${url}/upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body.readable,
    duplex: 'half',
  } as RequestInit);
  await writer.write(new TextEncoder().encode('{"a":'));
  await reading;
  withdraw();
  await writer.write(new TextEncoder().encode('1}'));
  await writer.close();
  const answered = await response;
  assert.deepEqual([answered.status, (await answered.json()).error.code], [503, 'unavailable']);
  assert.equal(bodies, 0);
});

test('a namespace owner authenticates its bearers on the routes it allows, and nothing else does', async (t) => {
  const { scope, tools } = fixture();
  const keys: string[] = [];
  Object.assign(scope, {
    authenticateKey: async (token: string) => {
      keys.push(token);
      throw new MervError('unauthorized', 'Invalid key', 401);
    },
  });
  let verified = 0;
  const api = new ApiServer(scope, tools, {}, {
    verify: async () => {
      verified++;
      throw new MervError('unauthorized', 'Invalid token', 401);
    },
    configuration: () => ({ enabled: true }),
  } as never);
  const authenticated: string[] = [];
  const forbidden = new MervError('probe_forbidden', 'Probe credentials may only read /probe', 403);
  for (const [namespace, kind] of [
    ['mk_', 'probe'],
    ['m-_', 'probe'],
    ['ab', 'probe'],
    ['ab_', 'user'],
    ['ab_', 'actor'],
  ] as const)
    assert.throws(
      () => api.credential(namespace, { kind, forbidden, routes: () => true }),
      { code: 'invalid_credential' },
      `${namespace} ${kind}`,
    );
  const withdraw = api.credential('pb_', {
    kind: 'probe',
    forbidden,
    routes: (method, path, query) => method === 'GET' && path === '/probe' && !query,
    authenticate: async (token) => {
      authenticated.push(token);
      return { actorId: alice.id, projectId: alice.projectId };
    },
  });
  assert.throws(() => api.credential('pb_', { kind: 'probe', forbidden, routes: () => true }), {
    code: 'credential_conflict',
  });
  api.mount('/probe', (_req, _res, r) => ({ kind: r.principal?.kind }));
  const url = await api.start();
  t.after(async () => {
    await api.stop();
    await tools.close();
  });
  const get = async (path: string, token: string) => {
    const response = await fetch(`${url}${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return [response.status, (await response.json()).error?.code] as const;
  };
  const probe = await fetch(`${url}/probe`, { headers: { authorization: 'Bearer pb_secret' } });
  assert.deepEqual(await probe.json(), { kind: 'probe' });
  assert.deepEqual(authenticated, ['pb_secret']);
  // Refused by the owner's allow-list before it authenticates anything.
  assert.equal((await get('/probe?x=1', 'pb_secret'))[1], 'probe_forbidden');
  assert.equal((await get('/tools', 'pb_secret'))[1], 'probe_forbidden');
  assert.deepEqual(authenticated, ['pb_secret']);
  // A namespace no owner claims never reaches Scope or JWT verification.
  withdraw();
  assert.deepEqual(await get('/probe', 'pb_secret'), [503, 'credential_unavailable']);
  assert.deepEqual(await get('/tools', 'zz_bad.jwt.token'), [503, 'credential_unavailable']);
  assert.equal(verified, 0);
  // User keys and 43-character legacy actor tokens stay Scope's.
  assert.deepEqual(await get('/tools', `mk_${'a'.repeat(43)}`), [401, 'unauthorized']);
  assert.deepEqual(keys, [`mk_${'a'.repeat(43)}`]);
  assert.equal((await get('/tools', `pb_${'a'.repeat(40)}`))[0], 401);
  assert.equal(verified, 0);
});

import { fixtureAccess } from './fixtures/access.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { Context } from 'cordis';
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
  await assert.rejects(async () => tools.register((await tools.list())[0]!), /already registered/);
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
  assert.equal((await post({ message: 3 })).status, 400);
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

test('HTTP and MCP consume the registry public description projection without rebuilding definitions', async (t) => {
  const { scope, tools: native } = fixture();
  const tools = new ToolRegistry(scope, fixtureAccess);
  tools.register((await native.list())[0]!);
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

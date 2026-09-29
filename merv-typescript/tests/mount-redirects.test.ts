import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { ToolRegistry } from '../packages/api/src/registry.js';
import { MountRuntime } from '../packages/mounts/src/runtime.js';
import { Invocations } from '../packages/mounts/src/upstream.js';
import type { Bindings } from '../packages/mounts/src/credentials.js';
import { fixtureAccess } from './fixtures/access.js';

const caller = { projectId: 'project_redirect', actorId: 'actor_redirect' };
const credentials: Pick<Bindings, 'select' | 'headers'> = {
  select: async () => ({ id: 'fixture', ...caller, mountId: 'fixture', secretRef: 'env:X' }),
  headers: async () => ({
    authorization: 'Bearer synthetic_upstream_token',
    'x-project': caller.projectId,
  }),
};
/** An invocation pool for the fixture mount; the caller is never a session. */
const invocations = (url: string) =>
  new Invocations({ id: 'fixture', url, timeoutMs: 1000 }, credentials, fixtureAccess, {
    validateSession: async () => {},
  });
/** Admits the fixture caller: redirects, not authorization, are under test. */
const scope = {
  require: async () => ({
    ...caller,
    id: caller.actorId,
    name: 'Fixture',
    role: 'operator' as const,
    active: true,
  }),
  toolPolicy: fixtureAccess,
};
const tool = { name: 'inspect', inputSchema: { type: 'object' as const } };
/** The fixture mount's discovery; the caller doubles as its discovery actor. */
const discovery = (registry: ToolRegistry, url: string) =>
  new MountRuntime(registry, credentials, scope, {
    id: 'fixture',
    url,
    tools: ['inspect'],
    discovery: caller,
    timeoutMs: 1000,
    reconnectMs: 60_000,
  });

async function body(request: IncomingMessage) {
  let text = '';
  for await (const part of request) text += part.toString();
  return text ? JSON.parse(text) : {};
}

function answer(response: ServerResponse, message: { id?: number; method?: string }) {
  if (message.id === undefined) {
    response.writeHead(202).end();
    return;
  }
  const result =
    message.method === 'initialize'
      ? {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'fixture', version: '1' },
        }
      : message.method === 'tools/list'
        ? { tools: [tool] }
        : { content: [{ type: 'text', text: 'Accepted' }] };
  response.writeHead(200, {
    'content-type': 'application/json',
    'mcp-session-id': 'fixture_session_id',
  });
  response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
}

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function fixture(t: TestContext, redirectMethod: string) {
  const received: { method?: string; session?: string; message: unknown }[] = [];
  const destination = createServer((request, response) => {
    void body(request).then((message) => {
      received.push({
        method: request.method,
        session: request.headers['mcp-session-id'] as string | undefined,
        message,
      });
      answer(response, message);
    });
  });
  const foreignOrigin = await listen(destination);
  const endpoint = createServer((request, response) => {
    void body(request).then((message) => {
      if (
        message.method === redirectMethod ||
        (request.method === 'GET' && redirectMethod === 'GET')
      ) {
        response.writeHead(307, { location: `${foreignOrigin}/outside-configured-mount` }).end();
      } else if (request.method !== 'POST') response.writeHead(405).end();
      else answer(response, message);
    });
  });
  const url = `${await listen(endpoint)}/mcp`;
  t.after(async () => {
    for (const server of [endpoint, destination]) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  return { url, received };
}

for (const mode of ['invocation', 'discovery']) {
  test(`${mode} notification GET refuses cross-origin redirects`, { timeout: 5000 }, async (t) => {
    const { url, received } = await fixture(t, 'GET');
    const nativeFetch = globalThis.fetch;
    let gets = 0;
    let settled!: () => void;
    const notification = new Promise<void>((resolve) => {
      settled = resolve;
    });
    t.mock.method(
      globalThis,
      'fetch',
      async (address: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (init?.method === 'GET') gets++;
        try {
          return await nativeFetch(address, init);
        } finally {
          if (init?.method === 'GET') settled();
        }
      },
    );
    const registry = new ToolRegistry(scope, fixtureAccess);
    const runtime = discovery(registry, url);
    const pool = invocations(url);
    try {
      if (mode === 'invocation') {
        await pool.handler('inspect')(caller, {});
        assert.equal(gets, 0, 'invocation connections never open a notification stream');
      } else {
        void runtime.refresh().catch(() => undefined);
        await notification;
      }
      assert.deepEqual(received, [], 'notification headers must not reach a redirect destination');
    } finally {
      await pool.close();
      await runtime.stop();
      await registry.close();
    }
  });
}

for (const redirectMethod of ['initialize', 'tools/call']) {
  test(`invocation refuses a cross-origin redirect during ${redirectMethod}`, async (t) => {
    const { url, received } = await fixture(t, redirectMethod);
    const pool = invocations(url);
    try {
      const result = await Promise.resolve(
        pool.handler('inspect')(caller, { privateInput: 'project-confidential-fixture' }),
      ).then(
        () => 'succeeded',
        () => 'refused',
      );
      assert.deepEqual(
        received,
        [],
        'no MCP body or session header may reach the unconfigured origin',
      );
      assert.equal(result, 'refused');
    } finally {
      await pool.close();
    }
  });
}

for (const redirectMethod of ['initialize', 'tools/list']) {
  test(`discovery refuses a cross-origin redirect during ${redirectMethod}`, async (t) => {
    const { url, received } = await fixture(t, redirectMethod);
    const registry = new ToolRegistry(scope, fixtureAccess);
    const runtime = discovery(registry, url);
    try {
      await runtime.refresh().catch(() => undefined);
      assert.deepEqual(received, [], 'discovery must stay on its configured endpoint');
      assert.deepEqual(await registry.describe(), []);
      assert.equal(runtime.status().state, 'failed');
    } finally {
      await runtime.stop();
      await registry.close();
    }
  });
}

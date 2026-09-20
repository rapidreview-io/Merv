import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { ToolRegistry } from '../packages/api/src/registry.js';
import { MountManager } from '../packages/mounts/src/index.js';
import { ScopedRemoteClients } from '../packages/mounts/src/credential-client.js';
import { fixtureAccess } from './fixtures/access.js';
import type { CredentialProvider } from '../packages/mounts/src/types.js';

const caller = { projectId: 'project_redirect', actorId: 'actor_redirect' };
const credentials: CredentialProvider = {
  replace: () => {},
  resolve: async () => ({
    identityKey: 'fixture_identity',
    headers: () => ({
      authorization: 'Bearer synthetic_upstream_token',
      'x-project': caller.projectId,
    }),
  }),
};
const tool = { name: 'inspect', inputSchema: { type: 'object' as const } };

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
    let settled!: () => void;
    const notification = new Promise<void>((resolve) => {
      settled = resolve;
    });
    t.mock.method(
      globalThis,
      'fetch',
      async (address: Parameters<typeof fetch>[0], init?: RequestInit) => {
        try {
          return await nativeFetch(address, init);
        } finally {
          if (init?.method === 'GET') settled();
        }
      },
    );
    const registry = new ToolRegistry(
      {
        require: async () => ({
          ...caller,
          id: caller.actorId,
          name: 'Fixture',
          role: 'operator',
          active: true,
        }),
      },
      fixtureAccess,
    );
    const manager = new MountManager(registry, credentials, fixtureAccess, {
      mounts: [
        {
          id: 'fixture',
          url,
          tools: ['inspect'],
          discovery: caller,
          timeoutMs: 1000,
          reconnectMs: 60_000,
        },
      ],
    });
    const pool = new ScopedRemoteClients(credentials, fixtureAccess, {
      mounts: { fixture: { url } },
      timeoutMs: 1000,
    });
    try {
      if (mode === 'invocation') await pool.call(caller, 'fixture', 'inspect', {});
      else await manager.start();
      await notification;
      assert.deepEqual(received, [], 'notification headers must not reach a redirect destination');
    } finally {
      await pool.close();
      await manager.close();
      await registry.close();
    }
  });
}

for (const redirectMethod of ['initialize', 'tools/call']) {
  test(`invocation refuses a cross-origin redirect during ${redirectMethod}`, async (t) => {
    const { url, received } = await fixture(t, redirectMethod);
    const pool = new ScopedRemoteClients(credentials, fixtureAccess, {
      mounts: { fixture: { url } },
      timeoutMs: 1000,
    });
    try {
      const result = await pool
        .call(caller, 'fixture', 'inspect', { privateInput: 'project-confidential-fixture' })
        .then(
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
    const registry = new ToolRegistry(
      {
        require: async () => ({
          ...caller,
          id: caller.actorId,
          name: 'Fixture',
          role: 'operator',
          active: true,
        }),
      },
      fixtureAccess,
    );
    const manager = new MountManager(registry, credentials, fixtureAccess, {
      mounts: [
        {
          id: 'fixture',
          url,
          tools: ['inspect'],
          discovery: caller,
          timeoutMs: 1000,
          reconnectMs: 60_000,
        },
      ],
    });
    try {
      await manager.start();
      assert.deepEqual(received, [], 'discovery must stay on its configured endpoint');
      assert.deepEqual(await registry.describe(), []);
      assert.equal(manager.status()[0].state, 'failed');
    } finally {
      await manager.close();
      await registry.close();
    }
  });
}

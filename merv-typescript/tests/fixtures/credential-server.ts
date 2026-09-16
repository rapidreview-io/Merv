import { mapAsync } from '@merv/contracts';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server as HttpServer,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';

export interface UpstreamIdentity {
  id: string;
  token: string;
  namespace: string;
  subject: string;
}

function barrier() {
  let enter!: () => void, release!: () => void;
  return {
    entered: new Promise<void>((resolve) => {
      enter = resolve;
    }),
    wait: new Promise<void>((resolve) => {
      release = resolve;
    }),
    enter: () => enter(),
    release: () => release(),
  };
}
type Barrier = Awaited<ReturnType<typeof barrier>>;
interface Session {
  identity: UpstreamIdentity;
  connectionId: number;
  server: Server;
  transport: StreamableHTTPServerTransport;
}

/** Independent authenticated MCP server. Public evidence contains no credential values. */
export class CredentialServer {
  url!: string;
  readonly connections: { identity: string; connectionId: number }[] = [];
  readonly calls: { identity: string; connectionId: number; tool: string }[] = [];
  rejected = 0;
  initializeAttempts = 0;
  callAttempts = 0;
  private http?: HttpServer;
  private readonly identities = new Map<string, UpstreamIdentity>();
  private readonly sessions = new Map<string, Session>();
  private readonly barriers = new Set<Barrier>();
  private readonly callHolds: Barrier[] = [];
  private readonly initializeHolds: Barrier[] = [];
  private readonly initializeFailures: string[] = [];
  private readonly callFailures: string[] = [];
  private nextConnection = 1;

  constructor(identities: UpstreamIdentity[]) {
    for (const identity of identities) this.identities.set(identity.token, { ...identity });
  }
  holdNextCall() {
    return this.hold(this.callHolds);
  }
  holdNextInitialize() {
    return this.hold(this.initializeHolds);
  }
  failNextInitialize(message: string) {
    this.initializeFailures.push(message);
  }
  failNextCall(message: string) {
    this.callFailures.push(message);
  }
  revoke(token: string) {
    this.identities.delete(token);
  }

  private hold(queue: Barrier[]): Pick<Barrier, 'entered' | 'release'> {
    const held = barrier();
    this.barriers.add(held);
    queue.push(held);
    return held;
  }
  private async pause(queue: Barrier[]) {
    const held = queue.shift();
    if (!held) return;
    held.enter();
    await held.wait;
    this.barriers.delete(held);
  }
  async start(): Promise<string> {
    const server = createServer((req, res) => {
      void this.handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        if (!res.writableEnded) res.end('Credential fixture failure');
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.http = server;
    return (this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
  }
  async close(): Promise<void> {
    for (const held of this.barriers) held.release();
    await Promise.allSettled([...this.sessions.values()].map(({ server }) => server.close()));
    const http = this.http;
    this.http = undefined;
    if (http)
      await new Promise<void>((resolve, reject) => {
        http.close((error) => (error ? reject(error) : resolve()));
        http.closeAllConnections();
      });
  }
  private session(identity: UpstreamIdentity): Session {
    const connectionId = this.nextConnection++;
    const server = new Server(
      { name: 'credential-fixture', version: '1' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: ['inspect', 'mutate'].map((name) => ({
        name,
        inputSchema: { type: 'object' as const, additionalProperties: false },
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      this.calls.push({ identity: identity.id, connectionId, tool: request.params.name });
      await this.pause(this.callHolds);
      return {
        content: [{ type: 'text', text: 'Scoped upstream result.', _meta: { retained: true } }],
        structuredContent: {
          identity: identity.id,
          namespace: identity.namespace,
          subject: identity.subject,
          connectionId,
        },
        _meta: { fixture: 'retained' },
      };
    });
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
      onsessioninitialized: (id): void => {
        this.sessions.set(id, value);
      },
    });
    const value: Session = { identity, connectionId, server, transport };
    this.connections.push({ identity: identity.id, connectionId });
    return value;
  }
  private async handle(req: IncomingMessage, res: ServerResponse) {
    if (req.url !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    const authorization = req.headers.authorization;
    const identity =
      typeof authorization === 'string' && authorization.startsWith('Bearer ')
        ? this.identities.get(authorization.slice(7))
        : undefined;
    if (
      !identity ||
      req.headers['x-sandbox-namespace'] !== identity.namespace ||
      req.headers['x-sandbox-subject'] !== identity.subject
    ) {
      this.rejected++;
      res.writeHead(403).end('Upstream authorization denied');
      return;
    }
    const id = req.headers['mcp-session-id'];
    let session = typeof id === 'string' ? this.sessions.get(id) : undefined;
    if (session && session.identity.token !== identity.token) {
      this.rejected++;
      res.writeHead(403).end('Upstream session identity mismatch');
      return;
    }
    if (req.method === 'GET' || req.method === 'DELETE') {
      if (!session) {
        res.writeHead(400).end();
        return;
      }
      await session.transport.handleRequest(req, res);
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (isInitializeRequest(body)) {
      this.initializeAttempts++;
      await this.pause(this.initializeHolds);
      if (res.destroyed) return;
      const failure = this.initializeFailures.shift();
      if (failure) {
        res.writeHead(500).end(failure);
        return;
      }
      session = this.session(identity);
      await session.server.connect(session.transport);
    }
    if (!session) {
      res.writeHead(400).end();
      return;
    }
    if (body.method === 'tools/call') {
      this.callAttempts++;
      const failure = this.callFailures.shift();
      if (failure) {
        res.writeHead(500).end(failure);
        return;
      }
    }
    await session.transport.handleRequest(req, res, body);
  }
}

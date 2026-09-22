import { mapAsync } from '@merv/contracts';
import {
  createServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
  type CallToolResult,
  type ListToolsResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { RemoteToolDefinition } from '@merv/api/types';

/** Calls one shared client directly; mounts instead route each call through its scoped pool. */
export const callable = (client: Pick<Client, 'request'>, tools: Tool[]): RemoteToolDefinition[] =>
  tools.map((tool) => ({
    ...tool,
    kind: 'mcp',
    handler: (_caller, input) =>
      client.request(
        { method: 'tools/call', params: { name: tool.name, arguments: input } },
        // Validate without the SDK's parsed copy, which can strip extension metadata.
        z.custom<CallToolResult>((value) => CallToolResultSchema.safeParse(value).success),
      ),
  }));

export interface RemoteRequestLog {
  method: 'tools/list' | 'tools/call';
  cursor?: string;
  name?: string;
  argumentKeys?: string[];
}
export interface Barrier {
  entered: Promise<void>;
  release(): void;
}
interface InternalBarrier extends Barrier {
  enter(): void;
  wait: Promise<void>;
}
function barrier(): InternalBarrier {
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
export type RemoteResult =
  CallToolResult | ((input: Record<string, unknown>) => CallToolResult | Promise<CallToolResult>);
export interface RemoteFixtureOptions {
  tools?: Tool[];
  results?: Record<string, RemoteResult>;
  pageSize?: number;
  page?: (cursor: string | undefined) => ListToolsResult | Promise<ListToolsResult>;
}

export const representativeTools: Tool[] = [
  {
    name: 'inspect',
    title: 'Remote inspection',
    description: 'Inspect a remote project with nested options.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['projectId', 'options'],
      properties: { projectId: { type: 'string' }, options: { $ref: '#/$defs/options' } },
      $defs: {
        options: {
          type: 'object',
          required: ['label'],
          additionalProperties: false,
          properties: {
            label: { type: 'string', minLength: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 5 },
          },
        },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['ok'],
      additionalProperties: false,
      properties: { ok: { type: 'boolean' }, projectId: { type: 'string' } },
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    icons: [{ src: 'data:image/png;base64,iVBORw0KGgo=', mimeType: 'image/png', sizes: ['1x1'] }],
    execution: { taskSupport: 'forbidden' },
    _meta: { 'fixture/catalog': { version: 1 } },
  },
  {
    name: 'media',
    description: 'Return representative MCP content.',
    inputSchema: { type: 'object', additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'failure',
    title: 'Domain failure',
    inputSchema: { type: 'object', additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
];
export const representativeResult: CallToolResult = {
  content: [
    {
      type: 'text',
      text: 'Inspected successfully.',
      annotations: { audience: ['assistant'], priority: 0.9 },
      _meta: { 'fixture/text': true },
    },
    {
      type: 'image',
      mimeType: 'image/png',
      data: 'iVBORw0KGgo=',
      annotations: { audience: ['user'], priority: 0.4 },
      _meta: { 'fixture/image': 'retained' },
    },
    {
      type: 'audio',
      mimeType: 'audio/wav',
      data: 'UklGRg==',
      annotations: { audience: ['user'], priority: 0.3 },
    },
    {
      type: 'resource',
      resource: {
        uri: 'fixture://evidence/text',
        mimeType: 'text/plain',
        text: 'Retained evidence.',
        _meta: { source: 'fixture' },
      },
      annotations: { audience: ['assistant'] },
    },
    {
      type: 'resource_link',
      uri: 'fixture://evidence/file',
      name: 'evidence.txt',
      title: 'Evidence',
      mimeType: 'text/plain',
      size: 18,
      annotations: { audience: ['user'], priority: 0.5 },
      _meta: { 'fixture/link': { retained: true } },
    },
  ],
  structuredContent: { ok: true },
  isError: false,
  _meta: { 'fixture/result': { retained: [1, 2, 3] } },
};

/** Independent sessionful upstream with a real HTTP/SSE boundary; never records argument values or credentials. */
export class RemoteFixture {
  readonly requests: RemoteRequestLog[] = [];
  url!: string;
  private http?: HttpServer;
  private tools: Tool[];
  private results: Record<string, RemoteResult>;
  private readonly sessions = new Map<
    string,
    { server: Server; transport: StreamableHTTPServerTransport }
  >();
  private readonly barriers = new Set<InternalBarrier>();
  private readonly callBarriers = new Map<string, InternalBarrier[]>();
  private readonly listBarriers: InternalBarrier[] = [];
  private streamReady = barrier();

  constructor(private readonly options: RemoteFixtureOptions = {}) {
    this.tools = structuredClone(options.tools ?? representativeTools);
    this.results = {
      inspect: (input) => ({
        ...structuredClone(representativeResult),
        structuredContent: { ok: true, projectId: input.projectId },
      }),
      media: structuredClone(representativeResult),
      failure: {
        content: [{ type: 'text', text: 'Remote operation declined.' }],
        isError: true,
        _meta: { 'fixture/error': 'retained' },
      },
      ...options.results,
    };
  }
  setTools(tools: Tool[]): void {
    this.tools = structuredClone(tools);
  }
  setResult(name: string, result: RemoteResult): void {
    this.results[name] = result;
  }
  holdNextCall(name: string): Barrier {
    const held = barrier();
    this.barriers.add(held);
    this.callBarriers.set(name, [...(this.callBarriers.get(name) ?? []), held]);
    return held;
  }
  holdNextList(): Barrier {
    const held = barrier();
    this.barriers.add(held);
    this.listBarriers.push(held);
    return held;
  }
  async waitForNotificationStream(): Promise<void> {
    await this.streamReady.entered;
  }
  async notifyToolsChanged(): Promise<void> {
    await this.waitForNotificationStream();
    await Promise.all(
      [...this.sessions.values()].map(({ server }) =>
        server.notification({ method: 'notifications/tools/list_changed' }),
      ),
    );
  }
  async start(): Promise<string> {
    if (this.http) throw new Error('Remote fixture is already running');
    const http = createServer((req, res) => {
      void this.handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        if (!res.writableEnded) res.end(JSON.stringify({ error: 'Fixture request failed' }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(0, '127.0.0.1', () => {
        http.removeListener('error', reject);
        resolve();
      });
    });
    this.http = http;
    this.url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
    return this.url;
  }
  async close(): Promise<void> {
    for (const held of this.barriers) held.release();
    this.barriers.clear();
    await Promise.allSettled([...this.sessions.values()].map(({ server }) => server.close()));
    this.sessions.clear();
    const http = this.http;
    if (http) {
      this.http = undefined;
      await new Promise<void>((resolve, reject) => {
        http.close((error) => (error ? reject(error) : resolve()));
        http.closeAllConnections();
      });
    }
  }
  private async pause(held: InternalBarrier | undefined): Promise<void> {
    if (!held) return;
    held.enter();
    await held.wait;
    this.barriers.delete(held);
  }
  private createSession(): { server: Server; transport: StreamableHTTPServerTransport } {
    const server = new Server(
      { name: 'merv-independent-remote-fixture', version: '1' },
      { capabilities: { tools: { listChanged: true } } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async (request) => {
      const cursor = request.params?.cursor;
      this.requests.push({ method: 'tools/list', ...(cursor === undefined ? {} : { cursor }) });
      await this.pause(this.listBarriers.shift());
      if (this.options.page) return this.options.page(cursor);
      const start = cursor === undefined ? 0 : Number(cursor),
        pageSize = this.options.pageSize ?? 2;
      if (
        !Number.isSafeInteger(start) ||
        start < 0 ||
        !Number.isSafeInteger(pageSize) ||
        pageSize < 1
      )
        throw new Error('Invalid fixture pagination');
      const tools = structuredClone(this.tools.slice(start, start + pageSize));
      const nextCursor =
        start + pageSize < this.tools.length ? String(start + pageSize) : undefined;
      return { tools, ...(nextCursor === undefined ? {} : { nextCursor }) };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const input = request.params.arguments ?? {};
      this.requests.push({
        method: 'tools/call',
        name: request.params.name,
        argumentKeys: Object.keys(input).sort(),
      });
      const result = this.results[request.params.name];
      await this.pause(this.callBarriers.get(request.params.name)?.shift());
      if (!result)
        return { content: [{ type: 'text', text: 'Unknown fixture tool' }], isError: true };
      return typeof result === 'function' ? result(input) : structuredClone(result);
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
      onsessioninitialized: (sessionId) => {
        this.sessions.set(sessionId, { server, transport });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) this.sessions.delete(transport.sessionId);
    };
    return { server, transport };
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.url !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    const sessionId =
      typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : undefined;
    if (req.method === 'GET' || req.method === 'DELETE') {
      const session = sessionId ? this.sessions.get(sessionId) : undefined;
      if (!session) {
        res.writeHead(400).end();
        return;
      }
      if (req.method === 'GET') this.streamReady.enter();
      await session.transport.handleRequest(req, res);
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 1_000_000) {
        res.writeHead(413).end();
        return;
      }
      chunks.push(bytes);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    let session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session && !sessionId && isInitializeRequest(body)) {
      session = this.createSession();
      await session.server.connect(session.transport);
    }
    if (!session) {
      res.writeHead(400).end();
      return;
    }
    await session.transport.handleRequest(req, res, body);
  }
}

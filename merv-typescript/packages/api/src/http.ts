import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server as HttpServer,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { MervError, type Caller, type Scope } from '@merv/contracts';
import type { Tools, AnyToolDefinition, ToolInvocation } from './types.js';
import { ApiError, isRemoteTool, type ToolDescription } from './registry.js';
import { protocolError } from './protocol.js';

export interface HttpOptions {
  host?: string;
  port?: number;
  maxBodyBytes?: number;
  allowedOrigins?: string[];
}

export function describeTool(tool: AnyToolDefinition): ToolDescription {
  if (isRemoteTool(tool)) {
    const { handler: _handler, kind: _kind, ...description } = tool;
    return structuredClone(description);
  }
  const schema = zodToJsonSchema(tool.inputSchema, { $refStrategy: 'none', target: 'jsonSchema7' });
  if (!('type' in schema) || schema.type !== 'object')
    throw new ApiError('invalid_tool', 'Tool input must be an object');
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: {
      ...schema,
      type: 'object',
      properties: {
        ...('properties' in schema ? schema.properties : {}),
        projectId: {
          type: 'string',
          minLength: 1,
          description:
            "Optional project scope. Defaults to the authenticated actor's project; access is checked by the server.",
        },
      },
    },
    annotations: { readOnlyHint: tool.readOnly ?? false, openWorldHint: false },
  };
}

function errorBody(error: unknown): {
  error: { code: string; message: string; details?: unknown };
  status: number;
} {
  if (error instanceof MervError)
    return {
      status: error.status,
      error: {
        code: error.code,
        message: error.message,
        ...(error instanceof ApiError && error.details ? { details: error.details } : {}),
      },
    };
  return { status: 500, error: { code: 'internal_error', message: 'Internal server error' } };
}

function json(res: ServerResponse, status: number, value: unknown): void {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(value));
}

function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const mediaType = req.headers['content-type']?.split(';')[0]?.trim();
  if (mediaType !== 'application/json') {
    req.resume();
    throw new ApiError('unsupported_media_type', 'Content-Type must be application/json', 415);
  }
  const length = Number(req.headers['content-length']);
  if (Number.isFinite(length) && length > maxBytes) {
    req.resume();
    throw new ApiError('body_too_large', 'Request body exceeds the configured limit', 413);
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let rejected = false;
    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        rejected = true;
        chunks.length = 0;
        reject(new ApiError('body_too_large', 'Request body exceeds the configured limit', 413));
      } else chunks.push(chunk);
    });
    req.once('end', () => {
      if (rejected) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new ApiError('invalid_json', 'Request body must contain valid JSON'));
      }
    });
    req.once('error', reject);
    req.once('aborted', () => reject(new ApiError('request_aborted', 'Request was aborted')));
  });
}

/** One stateless MCP transport per HTTP request; authentication is checked afresh each time. */
export class ApiServer {
  private server?: HttpServer;
  private stopping = false;
  private readonly requests = new Set<Promise<void>>();
  private readonly calls = new Set<Promise<unknown>>();
  private readonly mcpServers = new Set<McpServer>();
  private readonly maxBodyBytes: number;
  url?: string;

  constructor(
    private readonly scope: Scope,
    private readonly tools: Tools,
    private readonly options: HttpOptions = {},
  ) {
    // Covers a 2,000,000-byte artifact encoded as base64, plus the JSON/MCP envelope.
    this.maxBodyBytes = options.maxBodyBytes ?? 3 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxBodyBytes) || this.maxBodyBytes < 1)
      throw new ApiError('invalid_config', 'maxBodyBytes must be a positive integer');
  }

  async start(): Promise<string> {
    if (this.server) throw new ApiError('already_started', 'API server is already started', 409);
    this.stopping = false;
    const server = createServer((req, res) => {
      const request = this.handle(req, res).catch((error: unknown) => {
        const body = errorBody(error);
        json(res, body.status, { error: body.error });
      });
      this.requests.add(request);
      void request.finally(() => this.requests.delete(request));
    });
    server.requestTimeout = 30_000;
    server.headersTimeout = 15_000;
    server.keepAliveTimeout = 5_000;
    const host = this.options.host ?? '127.0.0.1';
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.options.port ?? 0, host, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
    } catch (error) {
      this.server = undefined;
      throw error;
    }
    const address = server.address() as AddressInfo;
    const publicHost =
      host === '0.0.0.0'
        ? '127.0.0.1'
        : host === '::'
          ? '[::1]'
          : host.includes(':')
            ? `[${host}]`
            : host;
    this.url = `http://${publicHost}:${address.port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.stopping = true;
    const server = this.server;
    // Stop admission before waiting. Existing responses and handlers retain their providers.
    const closed = new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    server.closeIdleConnections();
    await Promise.allSettled([...this.requests]);
    await Promise.allSettled([...this.calls]);
    await closed;
    await Promise.allSettled([...this.mcpServers].map((instance) => instance.close()));
    this.mcpServers.clear();
    this.server = undefined;
  }

  private authenticate(req: IncomingMessage): ReturnType<Scope['authenticate']> {
    const authorization = req.headers.authorization;
    if (!authorization || !/^Bearer [^\s]+$/i.test(authorization))
      throw new ApiError('unauthorized', 'A bearer token is required', 401);
    return this.scope.authenticate(authorization.slice(7));
  }

  private async call(name: string, caller: Caller, input: unknown): Promise<ToolInvocation> {
    const operation = this.tools.invoke(name, caller, input);
    this.calls.add(operation);
    try {
      return await operation;
    } finally {
      this.calls.delete(operation);
    }
  }

  private caller(
    actor: ReturnType<Scope['authenticate']>,
    input: unknown,
    name: string,
    selectedProject?: unknown,
  ): { caller: Caller; input: Record<string, unknown> } {
    if (input === null || typeof input !== 'object' || Array.isArray(input))
      throw new ApiError('invalid_input', 'Tool arguments must be an object');
    const argumentsObject = input as Record<string, unknown>;
    // The reserved namespace determines routing even while a catalog is being withdrawn.
    const remote = name.startsWith('mount__');
    const { projectId: argumentProject, ...nativeArguments } = argumentsObject;
    if (
      !remote &&
      selectedProject !== undefined &&
      argumentProject !== undefined &&
      selectedProject !== argumentProject
    )
      throw new ApiError('invalid_input', 'Conflicting Merv project selections');
    const projectId =
      selectedProject !== undefined ? selectedProject : remote ? undefined : argumentProject;
    if (projectId !== undefined && (typeof projectId !== 'string' || !projectId))
      throw new ApiError('invalid_input', 'projectId must be a non-empty string');
    // actorId and other caller-shaped fields are ordinary arguments: strict feature schemas reject them.
    const caller = {
      actorId: actor.id,
      projectId: (projectId as string | undefined) ?? actor.projectId,
    };
    this.scope.require(caller, 'read');
    return { caller, input: remote ? argumentsObject : nativeArguments };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.stopping) {
      json(res, 503, { error: { code: 'unavailable', message: 'Server is stopping' } });
      return;
    }
    const origin = req.headers.origin;
    if (origin && !this.options.allowedOrigins?.includes(origin))
      throw new ApiError('forbidden_origin', 'Origin is not allowed', 403);
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path === '/health' && req.method === 'GET') {
      json(res, 200, { status: 'ok' });
      return;
    }
    const actor = this.authenticate(req);
    if (path === '/tools' && req.method === 'GET') {
      this.scope.require({ actorId: actor.id, projectId: actor.projectId }, 'read');
      json(res, 200, { tools: this.tools.list().map(describeTool) });
      return;
    }
    if (path.startsWith('/tools/') && req.method === 'POST') {
      let name: string;
      try {
        name = decodeURIComponent(path.slice('/tools/'.length));
      } catch {
        throw new ApiError('invalid_tool', 'Malformed tool name');
      }
      const request = this.caller(
        actor,
        await readJson(req, this.maxBodyBytes),
        name,
        req.headers['x-merv-project-id'],
      );
      const result = await this.call(name, request.caller, request.input);
      json(res, 200, { result: result.value ?? null });
      return;
    }
    if (path === '/mcp') {
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST');
        json(res, 405, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32000, message: 'This stateless MCP endpoint supports POST only' },
        });
        return;
      }
      const body = await readJson(req, this.maxBodyBytes);
      const incompatible = protocolError(req.headers['mcp-protocol-version'], body);
      if (incompatible) {
        json(res, 400, incompatible);
        return;
      }
      const instance = new McpServer(
        { name: 'merv', version: '0.1.0' },
        {
          capabilities: { tools: {} },
          instructions:
            'Merv is a durable task and independent review system. Use actor.whoami and project.get to inspect your identity and project. Each tool is scoped to the bearer identity. Request IDs make supported mutations retryable; supply the current expectedRevision for transitions.',
        },
      );
      instance.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: this.tools.list().map(describeTool),
      }));
      instance.setRequestHandler(CallToolRequestSchema, async (request) => {
        try {
          const call = this.caller(
            actor,
            request.params.arguments ?? {},
            request.params.name,
            request.params._meta?.['merv/projectId'],
          );
          const result = await this.call(request.params.name, call.caller, call.input);
          return result.format === 'mcp'
            ? (result.value as CallToolResult)
            : { content: [{ type: 'text' as const, text: JSON.stringify(result.value ?? null) }] };
        } catch (error) {
          const body = errorBody(error);
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify({ error: body.error }) }],
          };
        }
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      this.mcpServers.add(instance);
      let closing = false;
      const close = () => {
        if (closing) return;
        closing = true;
        this.mcpServers.delete(instance);
        void instance.close().catch(() => {});
      };
      res.once('close', close);
      try {
        await instance.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (error) {
        close();
        throw error;
      }
      return;
    }
    json(res, 404, { error: { code: 'not_found', message: 'Unknown endpoint' } });
  }
}

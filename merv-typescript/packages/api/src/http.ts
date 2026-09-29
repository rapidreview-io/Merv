import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server as HttpServer,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { isUtf8 } from 'node:buffer';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import { MervError, mainAgentGuide, plain, type Caller, type Scope } from '@merv/contracts';
import type { IdentityProvider } from '@merv/identity/types';
import type {
  ApiCredential,
  ApiPrincipal,
  ApiRequest,
  Tools,
  ToolInvocation,
  MountHandler,
  MountOptions,
} from './types.js';
import { isMountedToolName } from './registry.js';
import { protocolError } from './protocol.js';

export { describeTool } from './registry.js';

export interface HttpOptions {
  host?: string;
  port?: number;
  maxBodyBytes?: number;
  allowedOrigins?: string[];
  /** Runs GET /tools in a snapshot scope: no writer lock, writes refused. Owners' routes open
   *  their own. */
  snapshot?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** How long stop() lets in-flight responses finish before it cuts their sockets (default 45 s,
   *  below the deployment's 60 s stop grace period). */
  drainMs?: number;
}

function errorBody(error: unknown) {
  if (error instanceof MervError)
    return {
      status: error.status,
      error: {
        code: error.code,
        message: error.message,
        ...(error.details && serializable(error.details) ? { details: error.details } : {}),
      },
    };
  return { status: 500, error: { code: 'internal_error', message: 'Internal server error' } };
}

/** Details that JSON cannot carry (a BigInt, a cycle) are dropped, so the refusal still reaches
 *  its caller instead of failing while it is written. */
function serializable(details: unknown): boolean {
  try {
    JSON.stringify(details);
    return true;
  } catch {
    return false;
  }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  // Serialize first: a value that cannot be written fails while a 500 can still be sent.
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(value));
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, {
    'content-type': type,
    ...(typeof body !== 'string' && { 'content-length': body.length }),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...(status === 401 && { 'www-authenticate': 'Bearer' }),
  });
  res.end(body);
}

/** The one log point for server failures: primitive fields only, never the error's message,
 *  which may carry request values or connection details. */
function logFailure(error: unknown, status: number, code: string, where: string): void {
  if (status < 500) return;
  const failure = (error ?? {}) as {
    name?: unknown;
    stack?: unknown;
    cause?: Record<string, unknown>;
  };
  const cause = failure.cause ?? {};
  process.stderr.write(
    `${JSON.stringify({
      event: 'api_error',
      where,
      status,
      code,
      name: String(failure.name),
      at: String(failure.stack)
        .split('\n')
        .filter((line) => /^\s+at /.test(line))
        .slice(0, 3)
        .map((line) => line.trim()),
      sqlstate: String(cause.sqlstate ?? ''),
      table: String(cause.table ?? ''),
      constraint: String(cause.constraint ?? ''),
    })}\n`,
  );
}

/** A JSON-RPC error that carries a MervError's code and status, and nothing internal. */
function rpcError(error: unknown): Error {
  const { status, error: body } = errorBody(error);
  logFailure(error, status, body.code, 'mcp');
  return Object.assign(new Error(body.message), {
    code: status >= 500 ? -32603 : -32600,
    data: body,
  });
}

/** The request's path without its query, which a log must never carry. */
const pathOf = (req: IncomingMessage) => new URL(req.url ?? '/', 'http://localhost').pathname;

/** One bounded body of `mediaType`: 415 for any other type, 413 past `maxBytes`. */
function readBody(req: IncomingMessage, maxBytes: number, mediaType: string): Promise<Buffer> {
  // Authentication may have yielded while the client disconnected. Its abort/end
  // events will not fire again for listeners attached after the stream was destroyed.
  if (req.destroyed) throw new MervError('request_aborted', 'Request was aborted');
  if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== mediaType) {
    req.resume();
    throw new MervError('unsupported_media_type', `Content-Type must be ${mediaType}`, 415);
  }
  const length = Number(req.headers['content-length']);
  if (Number.isFinite(length) && length > maxBytes) {
    req.resume();
    throw new MervError('body_too_large', 'Request body exceeds the configured limit', 413);
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > maxBytes) {
        rejected = true;
        chunks.length = 0;
        reject(new MervError('body_too_large', 'Request body exceeds the configured limit', 413));
      } else chunks.push(chunk);
    });
    req.once('end', () => {
      if (!rejected) resolve(Buffer.concat(chunks));
    });
    req.once('error', reject);
    req.once('aborted', () => reject(new MervError('request_aborted', 'Request was aborted')));
  });
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const body = await readBody(req, maxBytes, 'application/json');
  if (!isUtf8(body))
    throw new MervError('invalid_json', 'Request body must contain valid UTF-8 JSON');
  try {
    return plain(JSON.parse(body.toString('utf8')));
  } catch (error) {
    if (error instanceof MervError) throw error;
    throw new MervError('invalid_json', 'Request body must contain valid JSON');
  }
}

/** A namespaced bearer (`ms_…`, `mr_…`), which only its namespace's registered owner may
 *  authenticate. User keys (`mk_`) are Scope's, and a legacy random actor token is exactly 43
 *  characters even when it looks namespaced. */
const namespaced = (token: string) =>
  /^[a-z]+_/.test(token) && !token.startsWith('mk_') && !/^[A-Za-z0-9_-]{43}$/.test(token);
const unknownEndpoint = () => new MervError('not_found', 'Unknown endpoint', 404);

interface Mounted {
  handler: MountHandler;
  public?: true | readonly string[];
}
const open = (mounted: Mounted, path: string) =>
  mounted.public === true ||
  !!mounted.public?.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

function bearer(req: IncomingMessage): string {
  const authorization = req.headers.authorization;
  if (!authorization || !/^Bearer [^\s]+$/i.test(authorization))
    throw new MervError('unauthorized', 'A bearer token is required', 401);
  return authorization.slice(7);
}

function parseInput<T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw new MervError(
      'invalid_input',
      'Request body failed validation',
      400,
      parsed.error.issues.map(({ path, message, code }) => ({ path, message, code })),
    );
  return parsed.data;
}

function projectSelection(...selections: unknown[]): string | undefined {
  const supplied = selections.filter((selection) => selection !== undefined);
  for (const selection of supplied)
    if (typeof selection !== 'string' || !selection.trim())
      throw new MervError('invalid_input', 'projectId must be a non-empty string');
  if (supplied.some((selection) => selection !== supplied[0]))
    throw new MervError('invalid_input', 'Conflicting Merv project selections');
  return supplied[0] as string | undefined;
}

/**
 * One listener. Each request's first path segment names its mount: the built-ins or an owner's.
 * A public route authenticates itself; every other one is authenticated here first, by Scope or
 * by the owner of its bearer's namespace. One stateless MCP transport serves each MCP request.
 */
export class ApiServer {
  private server?: HttpServer;
  private stopping = false;
  private starting?: Promise<string>;
  private closing?: Promise<void>;
  private readonly requests = new Set<Promise<unknown>>();
  private readonly calls = new Set<Promise<unknown>>();
  /** By prefix; null marks a withdrawn one, which answers 503. */
  private readonly mounts = new Map<string, Mounted | null>();
  private readonly credentials = new Map<string, { credential: ApiCredential }>();
  private readonly maxBodyBytes: number;
  private readonly drainMs: number;
  url?: string;

  constructor(
    private readonly scope: Scope,
    private readonly tools: Tools,
    private readonly options: HttpOptions = {},
    private readonly identity?: IdentityProvider,
  ) {
    // Covers a 2,000,000-byte artifact encoded as base64, plus the JSON/MCP envelope.
    this.maxBodyBytes = options.maxBodyBytes ?? 3 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxBodyBytes) || this.maxBodyBytes < 1)
      throw new MervError('invalid_config', 'maxBodyBytes must be a positive integer');
    this.drainMs = options.drainMs ?? 45_000;
    this.mount(
      '/health',
      (req, _res, r) => {
        if (req.method !== 'GET' || r.url.pathname !== '/health') throw unknownEndpoint();
        return { status: 'ok' };
      },
      { public: true },
    );
    this.mount(
      '/auth',
      (req, _res, r) => {
        if (req.method !== 'GET' || r.url.pathname !== '/auth/config') throw unknownEndpoint();
        return this.identity?.configuration() ?? { enabled: false };
      },
      { public: true },
    );
    this.mount('/tools', (req, _res, r) => this.toolsRoute(req, r));
    this.mount('/mcp', (req, res, r) => this.mcpRoute(req, res, r));
  }

  start(): Promise<string> {
    if (this.server || this.starting || this.closing)
      return Promise.reject(new MervError('already_started', 'API server is already started', 409));
    this.stopping = false;
    const starting = (this.starting = this.listen());
    const settled = () => void (this.starting = undefined);
    void starting.then(settled, settled);
    return starting;
  }

  private async listen(): Promise<string> {
    const server = createServer((req, res) => {
      // A request is done when its response is flushed or its connection is gone: a handler
      // settles at res.end(), before the bytes leave, and shutdown must not cut them off.
      const request = Promise.all([
        this.handle(req, res).catch((error: unknown) => {
          const { status, error: body } = errorBody(error);
          if (!res.headersSent) json(res, status, { error: body });
          // A response that failed part-way cannot be completed; end it rather than hang.
          else if (!res.writableEnded) res.destroy();
          logFailure(error, status, body.code, `${req.method} ${pathOf(req)}`);
        }),
        new Promise((closed) => res.once('close', closed)),
      ]);
      this.requests.add(request);
      void request.then(
        () => this.requests.delete(request),
        () => this.requests.delete(request),
      );
    });
    server.requestTimeout = 30_000;
    server.headersTimeout = 15_000;
    // Above the reverse proxy's two-minute idle timeout, so the proxy closes idle connections
    // first and never reuses one this server is closing.
    server.keepAliveTimeout = 125_000;
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
    const local = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
    const { port } = server.address() as AddressInfo;
    return (this.url = `http://${local.includes(':') ? `[${local}]` : local}:${port}`);
  }

  stop(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopping = true;
    const closing = (this.closing = this.shutdown(this.starting));
    const settled = () => void (this.closing = undefined);
    void closing.then(settled, settled);
    return closing;
  }

  private async shutdown(starting?: Promise<string>): Promise<void> {
    // Closing a not-yet-listening Node server can prevent its listen callback from ever
    // firing. Finish (or fail) startup before closing, while admission stays withdrawn.
    if (starting) await starting.catch(() => undefined);
    if (!this.server) return;
    const server = this.server;
    // Admission is already withdrawn: every new request is answered 503. Responses get drainMs
    // to finish; cutting their sockets then ends every stream still open, since each one ends
    // when its response closes. Existing responses and handlers retain their providers.
    const cut = setTimeout(() => server.closeAllConnections(), this.drainMs);
    await Promise.allSettled([...this.requests]);
    clearTimeout(cut);
    // Only now: close() also ends every connection whose response has ended, even while its
    // bytes are still reaching a slow reader.
    const closed = new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await Promise.allSettled([...this.calls]);
    // Only idle keep-alive connections remain.
    server.closeAllConnections();
    await closed;
    this.server = undefined;
  }

  /** Serves one lowercase path segment; the disposer withdraws it, and it then answers 503. */
  mount(prefix: string, handler: MountHandler, options: MountOptions = {}): () => void {
    if (!/^\/[a-z][a-z0-9-]*$/.test(prefix))
      throw new MervError('invalid_mount', 'Mount prefix must be one lowercase segment');
    const paths = options.public;
    const within = (path: string) =>
      /^(\/[^/?#]+)+$/.test(path) && `${path}/`.startsWith(`${prefix}/`);
    if (Array.isArray(paths) && !paths.every(within))
      throw new MervError('invalid_mount', 'Public paths must lie within their mount');
    if (this.mounts.get(prefix))
      throw new MervError('mount_conflict', `Path prefix is already mounted: ${prefix}`, 409);
    const mounted: Mounted = { handler, public: paths === true ? true : paths && [...paths] };
    this.mounts.set(prefix, mounted);
    return () => {
      if (this.mounts.get(prefix) === mounted) this.mounts.set(prefix, null);
    };
  }

  /** Authenticates the bearers of one namespace on authenticated routes; the disposer removes it. */
  credential(namespace: string, credential: ApiCredential): () => void {
    if (
      !/^[a-z]+_$/.test(namespace) ||
      namespace === 'mk_' ||
      ['user', 'key', 'actor'].includes(credential.kind)
    )
      throw new MervError('invalid_credential', 'Credential namespace or kind is reserved');
    if (this.credentials.has(namespace))
      throw new MervError(
        'credential_conflict',
        `Credential namespace is already registered: ${namespace}`,
        409,
      );
    const registered = { credential };
    this.credentials.set(namespace, registered);
    return () => {
      if (this.credentials.get(namespace) === registered) this.credentials.delete(namespace);
    };
  }

  /** A request's one read decision, made before any body is read. Every effect then authorizes
   *  itself in its own transaction, so nothing here re-checks after the body. */
  private async selectedCaller(principal: ApiPrincipal, projectId?: string): Promise<Caller> {
    if (!('caller' in principal)) return await this.scope.caller(principal, projectId);
    projectSelection(principal.caller.projectId, projectId);
    // A credential owner's liveness rules (a session's is Sessions' guard) are part of this read
    // decision.
    await this.scope.require(principal.caller, 'read');
    return principal.caller;
  }

  private async authenticate(req: IncomingMessage, url: URL): Promise<ApiPrincipal> {
    const token = bearer(req);
    if (namespaced(token)) {
      // Never Scope's or JWT verification: only the namespace's owner knows its bearers.
      const registered = this.credentials.get(/^[a-z]+_/.exec(token)![0]);
      if (!registered)
        throw new MervError('credential_unavailable', 'This credential is unavailable', 503);
      const { credential } = registered;
      // The owner's allow-list, before any I/O.
      if (
        !credential.authenticate ||
        !credential.routes(req.method ?? '', url.pathname, !!url.search)
      )
        throw credential.forbidden;
      const caller = await credential.authenticate(token);
      projectSelection(caller.projectId, req.headers['x-merv-project-id']);
      return { kind: credential.kind, caller };
    }
    // Local credentials are opaque. Never retry revoked or expired credentials upstream.
    // Legacy actor tokens are 43 random base64url characters and may happen to
    // start with mk_. User keys add that prefix to a full 43-character secret.
    if (token.startsWith('mk_') && !/^[A-Za-z0-9_-]{43}$/.test(token))
      return { kind: 'key', key: await this.scope.authenticateKey(token) };
    if (!token.includes('.')) return { kind: 'actor', actor: await this.scope.authenticate(token) };
    if (!this.identity)
      throw new MervError('unauthorized', 'Human authentication is unavailable', 401);
    const verified = await this.identity.verify(token);
    return await this.scope.acceptVerifiedIdentity(verified);
  }

  /** One tool call. A native tool's `projectId` argument selects its project; a mounted tool's
   *  arguments are all its own (the reserved namespace routes even while a catalog is withdrawn).
   *  actorId and other caller-shaped fields are ordinary arguments that strict schemas reject. */
  private async call(
    principal: ApiPrincipal,
    name: string,
    input: unknown,
    selectedProject: unknown,
    agent = false,
  ): Promise<ToolInvocation> {
    if (input === null || typeof input !== 'object' || Array.isArray(input))
      throw new MervError('invalid_input', 'Tool arguments must be an object');
    const remote = isMountedToolName(name);
    const { projectId, ...native } = input as Record<string, unknown>;
    const caller = await this.selectedCaller(
      principal,
      projectSelection(selectedProject, remote ? undefined : projectId),
    );
    const operation = this.tools.invoke(name, caller, remote ? input : native, agent);
    this.calls.add(operation);
    try {
      return await operation;
    } finally {
      this.calls.delete(operation);
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.stopping) {
      json(res, 503, { error: { code: 'unavailable', message: 'Server is stopping' } });
      return;
    }
    const origin = req.headers.origin;
    // Browsers send Origin on same-origin POSTs; this server speaks plain HTTP, so self is http://<host>.
    if (
      origin &&
      origin !== `http://${req.headers.host}` &&
      !this.options.allowedOrigins?.includes(origin)
    )
      throw new MervError('forbidden_origin', 'Origin is not allowed', 403);
    const url = new URL(req.url ?? '/', 'http://localhost');
    const prefix = `/${url.pathname.split('/')[1]}`;
    const mounted = this.mounts.get(prefix);
    if (!mounted) {
      // A runner treats 401, 403 and 404 as final, so a withdrawn route, or any credential's
      // route whose owner has not mounted yet (as at boot), answers 503.
      if (mounted === null || req.headers.authorization)
        throw new MervError('unavailable', 'This route is unavailable', 503);
      throw unknownEndpoint();
    }
    const principal = open(mounted, url.pathname) ? undefined : await this.authenticate(req, url);
    const value = await mounted.handler(
      req,
      res,
      this.request(req, url, prefix, mounted, principal),
    );
    if (value === undefined) return;
    if (Buffer.isBuffer(value)) send(res, 200, 'application/octet-stream', value);
    else json(res, 200, value);
  }

  private request(
    req: IncomingMessage,
    url: URL,
    prefix: string,
    mounted: Mounted,
    principal?: ApiPrincipal,
  ): ApiRequest {
    // A body read while its route was withdrawn reaches no handler.
    const current = <T>(value: T): T => {
      if (this.mounts.get(prefix) !== mounted)
        throw new MervError('unavailable', 'This route was withdrawn', 503);
      return value;
    };
    return {
      url,
      principal,
      bearer: () => bearer(req),
      caller: async (projectId) => {
        if (!principal) throw new MervError('unauthorized', 'A bearer token is required', 401);
        return await this.selectedCaller(
          principal,
          projectSelection(req.headers['x-merv-project-id'], projectId),
        );
      },
      json: async (schema, maxBytes = this.maxBodyBytes) => {
        const body = current(await readJson(req, maxBytes));
        return schema ? parseInput(schema, body) : (body as never);
      },
      bytes: async (maxBytes, mediaType) => current(await readBody(req, maxBytes, mediaType)),
    };
  }

  private async toolsRoute(req: IncomingMessage, r: ApiRequest): Promise<unknown> {
    const path = r.url.pathname;
    // A verified user's first request records that user, which is a write, so the caller is
    // authenticated before the read-only scope opens.
    if (path === '/tools' && req.method === 'GET') {
      const describe = async () => ({ tools: await this.tools.describe(await r.caller()) });
      return this.options.snapshot ? await this.options.snapshot(describe) : await describe();
    }
    if (!path.startsWith('/tools/') || req.method !== 'POST') throw unknownEndpoint();
    let name: string;
    try {
      name = decodeURIComponent(path.slice('/tools/'.length));
    } catch {
      throw new MervError('invalid_tool', 'Malformed tool name');
    }
    const body = await r.json();
    const result = await this.call(r.principal!, name, body, req.headers['x-merv-project-id']);
    return { result: result.value ?? null };
  }

  private async mcpRoute(req: IncomingMessage, res: ServerResponse, r: ApiRequest): Promise<void> {
    const principal = r.principal!;
    if (r.url.pathname !== '/mcp') throw unknownEndpoint();
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      json(res, 405, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: 'This stateless MCP endpoint supports POST only' },
      });
      return;
    }
    const body = await r.json();
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
          principal.kind === 'session'
            ? 'You are a leased Merv worker in one fixed project and workflow revision. Use the available tools for your current assignment. Tool arguments are bound by the server; omitted fixed identifiers are supplied automatically. Follow workflow.assignment and its handoff guidance. This session credential is valid only on this MCP endpoint.'
            : `${mainAgentGuide}\n\nHuman sessions and account machine keys must explicitly select a project using X-Merv-Project-Id or request _meta["merv/projectId"]. Actor tokens and project machine keys default to their fixed project. Use actor.whoami and project.get to inspect the selected identity and project.`,
      },
    );
    const selected = (meta?: Record<string, unknown>) =>
      projectSelection(req.headers['x-merv-project-id'], meta?.['merv/projectId']);
    instance.setRequestHandler(ListToolsRequestSchema, async (request) => {
      try {
        const caller = await this.selectedCaller(principal, selected(request.params?._meta));
        // MCP curates what a person's agent is offered; Merv's pages call /tools.
        return { tools: await this.tools.describe(caller, true) };
      } catch (error) {
        throw rpcError(error);
      }
    });
    instance.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const { name, arguments: input = {}, _meta } = request.params;
        const result = await this.call(principal, name, input, selected(_meta), true);
        return result.format === 'mcp'
          ? (result.value as CallToolResult)
          : { content: [{ type: 'text' as const, text: JSON.stringify(result.value ?? null) }] };
      } catch (error) {
        const { status, error: body } = errorBody(error);
        logFailure(error, status, body.code, 'mcp');
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify({ error: body }) }],
        };
      }
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    let closing = false;
    const close = () => {
      if (closing) return;
      closing = true;
      void instance.close().catch(() => {});
    };
    // In JSON-response mode the SDK transport's close() discards a reply that is still
    // pending without settling handleRequest. A client that disconnects during a call
    // closes the transport, so the request ends with the connection; otherwise it stays
    // pending forever and API shutdown waits on it. The tool call itself is still drained
    // through `calls`.
    const disconnected = new Promise<void>((resolve) => res.once('close', resolve));
    res.once('close', close);
    try {
      await instance.connect(transport);
      await Promise.race([transport.handleRequest(req, res, body), disconnected]);
    } catch (error) {
      close();
      throw error;
    }
  }
}

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
import { z } from 'zod';
import {
  MervError,
  codeCommandCompletionSchema,
  codeCommandControlSchema,
  codeTransportInputSchema,
  CODE_PART_MAX_BYTES,
  mainAgentGuide,
  pathSegment,
  plain,
  type Caller,
  type Scope,
} from '@merv/contracts';
import type { IdentityProvider } from '@merv/identity/types';
import type {
  ApiCredential,
  ApiPrincipal,
  ApiRequest,
  Tools,
  ToolInvocation,
  MountHandler,
  MountOptions,
  SessionApiProvider,
  CodeApiProvider,
} from './types.js';
import { isMountedToolName } from './registry.js';
import { protocolError } from './protocol.js';
import { githubCallback, githubRequest } from './code-github.js';
import { publicationRequest } from './code-publications.js';

export { describeTool } from './registry.js';

export interface HttpOptions {
  host?: string;
  port?: number;
  maxBodyBytes?: number;
  allowedOrigins?: string[];
  /** Runs a read-only GET route in a snapshot scope: no writer lock, writes refused. */
  snapshot?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** How long stop() lets in-flight responses finish before it cuts their sockets (default 45 s,
   *  below the deployment's 60 s stop grace period). */
  drainMs?: number;
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
  if (res.headersSent || res.destroyed) return;
  // Serialize first: a value that cannot be written fails while a 500 can still be sent.
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
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

function octets(res: ServerResponse, value: Buffer): void {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': value.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(value);
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

const nonblank = z.string().trim().min(1).max(512);
// Sessions parses every other session body. These two unwrap the one field a method takes, and
// a project halt refuses a body sessionId, which would halt one session and leave dispatch on.
const agentReleaseInput = z.object({ executionId: nonblank }).strict();
const agentResetInput = z.object({ reason: nonblank }).strict();
const haltInput = z.object({ reason: z.string().min(1).max(200).optional() }).strict();

/** Managed supervisor bearers have no general project, tool or administration transport. */
const managedRoute = (method: string, path: string): boolean =>
  (method === 'POST' &&
    [
      '/sessions/runners/heartbeat',
      '/sessions/lease',
      '/code/commands/next',
      '/code/commands/complete',
    ].includes(path)) ||
  (method === 'GET' && /^\/sessions\/session_[A-Za-z0-9_]+$/.test(path)) ||
  (method === 'POST' &&
    /^\/sessions\/session_[A-Za-z0-9_]+\/(attach|heartbeat|release|workspace-result)$/.test(
      path,
    )) ||
  (method === 'POST' && /^\/code\/v2\/[A-Za-z0-9_/-]+$/.test(path)) ||
  (method === 'PUT' &&
    /^\/code\/v2\/uploads\/[A-Za-z0-9_]{1,80}\/parts\/(0|[1-9][0-9]{0,14})$/.test(path));
/** An agent's own routes, which authenticate its key themselves. */
const agentSelfPath = (path: string) =>
  path === '/sessions/self' || path.startsWith('/sessions/self/');
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

/** Sessions parses its own bodies; the path's identifier is bound over the body's. */
function bound(body: unknown, key: string, value: string): unknown {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return body;
  if (Object.hasOwn(body, key)) throw new MervError('invalid_input', `${key} is bound by the path`);
  return { ...body, [key]: value };
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

/** One optional provider: a second registration conflicts and only its own disposer withdraws it. */
function slot<T>(code: string, label: string, unavailableMessage: string) {
  let current: T | undefined;
  return {
    register(provider: T): () => void {
      if (current)
        throw new MervError(
          `${code}_provider_conflict`,
          `${label} HTTP provider is already registered`,
          409,
        );
      current = provider;
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        if (current === provider) current = undefined;
      };
    },
    get(): T {
      if (!current) throw new MervError(`${code}_unavailable`, unavailableMessage, 503);
      return current;
    },
  };
}

/**
 * One listener. Each request's first path segment names its mount: the built-ins, the owners'
 * mounts and, until their owners register them, the Sessions and Code routes. A
 * public route authenticates itself; every other one is authenticated here first. One stateless
 * MCP transport serves each MCP request.
 */
export class ApiServer {
  private server?: HttpServer;
  private readonly sessions = slot<SessionApiProvider>(
    'session',
    'Session',
    'Sessions are unavailable',
  );
  private readonly code = slot<CodeApiProvider>('code', 'Code', 'Code controls are unavailable');
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
    // Until their owners register them, the routes and credentials the API serves for Sessions
    // and Code.
    this.mount('/sessions', (req, res, r) => this.sessionsRoute(req, res, r), {
      public: ['/sessions/self', '/sessions/runners/enroll'],
    });
    this.mount('/code', (req, res, r) => this.codeRoute(req, res, r), {
      public: ['/code/github/callback'],
    });
    this.credential('ms_', {
      kind: 'session',
      forbidden: new MervError(
        'session_transport_forbidden',
        'Session credentials may only use POST /mcp',
        403,
      ),
      routes: (method, path) => method === 'POST' && path === '/mcp',
      authenticate: (token) => this.sessions.get().authenticate(token),
    });
    this.credential('mr_', {
      kind: 'managed',
      forbidden: new MervError(
        'managed_runner_forbidden',
        'Managed runner route is not allowed',
        403,
      ),
      routes: (method, path, query) => !query && managedRoute(method, path),
      authenticate: (token) => {
        const provider = this.sessions.get();
        if (!provider.authenticateManaged)
          throw new MervError(
            'managed_runner_unavailable',
            'Managed runner authentication is unavailable',
            503,
          );
        return provider.authenticateManaged(token);
      },
    });
    this.credential('me_', {
      kind: 'enrollment',
      forbidden: new MervError(
        'managed_runner_forbidden',
        'Enrollment credentials may only enroll a runner',
        403,
      ),
      routes: () => false,
    });
  }

  start(): Promise<string> {
    if (this.server || this.starting || this.closing)
      return Promise.reject(new MervError('already_started', 'API server is already started', 409));
    this.stopping = false;
    const starting = this.listen();
    this.starting = starting;
    const settled = () => {
      this.starting = undefined;
    };
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

  stop(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopping = true;
    const closing = this.shutdown(this.starting);
    this.closing = closing;
    const settled = () => {
      this.closing = undefined;
    };
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

  registerSessions(provider: SessionApiProvider): () => void {
    return this.sessions.register(provider);
  }
  registerCode(provider: CodeApiProvider): () => void {
    return this.code.register(provider);
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

  private async call(
    name: string,
    caller: Caller,
    input: unknown,
    agent = false,
  ): Promise<ToolInvocation> {
    const operation = this.tools.invoke(name, caller, input, agent);
    this.calls.add(operation);
    try {
      return await operation;
    } finally {
      this.calls.delete(operation);
    }
  }

  private async caller(
    principal: ApiPrincipal,
    input: unknown,
    name: string,
    selectedProject?: unknown,
  ): Promise<{ caller: Caller; input: Record<string, unknown> }> {
    if (input === null || typeof input !== 'object' || Array.isArray(input))
      throw new MervError('invalid_input', 'Tool arguments must be an object');
    const argumentsObject = input as Record<string, unknown>;
    // The reserved namespace determines routing even while a catalog is being withdrawn.
    const remote = isMountedToolName(name);
    const { projectId: argumentProject, ...nativeArguments } = argumentsObject;
    const projectId = projectSelection(selectedProject, remote ? undefined : argumentProject);
    // actorId and other caller-shaped fields are ordinary arguments: strict feature schemas reject them.
    const caller = await this.selectedCaller(principal, projectId);
    return { caller, input: remote ? argumentsObject : nativeArguments };
  }

  /** Runs a read in a snapshot scope when the server has one: no writer lock, writes refused. */
  private read<T>(fn: () => Promise<T>): Promise<T> {
    return this.options.snapshot ? this.options.snapshot(fn) : fn();
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
      // A runner treats 401, 403 and 404 as final, so a withdrawn route, or a route a namespaced
      // bearer's owner has not mounted yet, answers 503.
      const presented = req.headers.authorization?.match(/^Bearer ([^\s]+)$/i)?.[1];
      if (mounted === null || (presented && namespaced(presented)))
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
    if (Buffer.isBuffer(value)) octets(res, value);
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
    if (path === '/tools' && req.method === 'GET')
      return await this.read(async () => ({ tools: await this.tools.describe(await r.caller()) }));
    if (!path.startsWith('/tools/') || req.method !== 'POST') throw unknownEndpoint();
    let name: string;
    try {
      name = decodeURIComponent(path.slice('/tools/'.length));
    } catch {
      throw new MervError('invalid_tool', 'Malformed tool name');
    }
    const request = await this.caller(
      r.principal!,
      await r.json(),
      name,
      req.headers['x-merv-project-id'],
    );
    const result = await this.call(name, request.caller, request.input);
    return { result: result.value ?? null };
  }

  private async codeRoute(req: IncomingMessage, res: ServerResponse, r: ApiRequest): Promise<void> {
    const url = r.url;
    const path = url.pathname;
    const principal = r.principal;
    if (!principal) {
      // GitHub's callback, which carries no Merv credential.
      if (path !== '/code/github/callback' || req.method !== 'GET') throw unknownEndpoint();
      const github = this.code.get().github;
      if (!github) throw new MervError('github_unavailable', 'GitHub is unavailable', 503);
      res.setHeader('referrer-policy', 'no-referrer');
      await githubCallback(req, res, github);
      return;
    }
    if (path === '/code/publications' || path.startsWith('/code/publications/')) {
      const caller = await r.caller();
      const body = req.method === 'POST' ? await r.json(undefined, 8192) : undefined;
      json(
        res,
        200,
        await publicationRequest(req, caller, this.code.get(), () => Promise.resolve(body)),
      );
      return;
    }
    if (path === '/code/github' || path.startsWith('/code/github/')) {
      const caller = await r.caller();
      const body = req.method === 'POST' ? await r.json(undefined, 8192) : undefined;
      const github = this.code.get().github;
      if (!github) throw new MervError('github_unavailable', 'GitHub is unavailable', 503);
      json(res, 200, await githubRequest(req, res, caller, github, () => Promise.resolve(body)));
      return;
    }
    if (principal.kind === 'session') throw unknownEndpoint();
    if (path === '/code/transport/grant' || path === '/code/transport/verify') {
      if (req.method !== 'POST' || url.search)
        throw new MervError('invalid_input', 'Use POST without query parameters');
      const caller = await r.caller();
      const input = await r.json(codeTransportInputSchema, 8192);
      const provider = this.code.get();
      if (!provider.transportGrant || !provider.verifyTransport)
        throw new MervError('github_unavailable', 'Git transport is unavailable', 503);
      json(
        res,
        200,
        path.endsWith('/grant')
          ? await provider.transportGrant(caller, input)
          : await provider.verifyTransport(caller, input),
      );
      return;
    }
    if (path.startsWith('/code/v2/')) {
      if (url.search)
        throw new MervError('invalid_input', 'Code routes do not accept query parameters');
      const caller = await r.caller();
      const route = path.slice('/code/v2/'.length);
      const part = /^uploads\/([A-Za-z0-9_]{1,80})\/parts\/(0|[1-9][0-9]{0,14})$/.exec(route);
      const read = /^downloads\/([A-Za-z0-9_]{1,80})\/read$/.exec(route);
      if (req.method !== (part ? 'PUT' : 'POST')) {
        res.setHeader('allow', part ? 'PUT' : 'POST');
        json(res, 405, {
          error: { code: 'method_not_allowed', message: 'Use PUT for a part and POST otherwise' },
        });
        return;
      }
      const body = part
        ? await r.bytes(CODE_PART_MAX_BYTES, 'application/octet-stream')
        : await r.json(undefined, 65536);
      const v2 = this.code.get().v2;
      if (!v2)
        throw new MervError(
          'code_store_unavailable',
          'This server keeps no Code repositories',
          503,
        );
      if (part) json(res, 200, await v2.putPart(caller, part[1]!, Number(part[2]), body as Buffer));
      else if (read && v2.readPart) octets(res, await v2.readPart(caller, read[1]!, body));
      else json(res, 200, await v2.call(caller, route, body));
      return;
    }
    if (path === '/code/commands/next' || path === '/code/commands/complete') {
      if ([...url.searchParams].length)
        throw new MervError('invalid_input', 'Code routes do not accept query parameters');
      const sourceCaller = await r.caller();
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST');
        json(res, 405, {
          error: { code: 'method_not_allowed', message: 'Use POST for Code controls' },
        });
        return;
      }
      const body = await r.json();
      const input = path.endsWith('/next')
        ? parseInput(codeCommandControlSchema, body)
        : parseInput(codeCommandCompletionSchema, body);
      // Lookup the current provider only after parsing; its methods are synchronous.
      const provider = this.code.get();
      if (path.endsWith('/next'))
        json(res, 200, { command: await provider.nextCommand(sourceCaller, input) });
      else
        json(res, 200, {
          operation: await provider.completeCommand(
            sourceCaller,
            input as z.infer<typeof codeCommandCompletionSchema>,
          ),
        });
      return;
    }
    throw unknownEndpoint();
  }

  private async sessionsRoute(
    req: IncomingMessage,
    res: ServerResponse,
    r: ApiRequest,
  ): Promise<unknown> {
    const path = r.url.pathname;
    if (!r.principal) {
      // A continuing agent credential controls only itself. Assignment tools still enter through MCP.
      if (agentSelfPath(path)) return await this.agentSelf(req, res, r);
      // Sessions authenticates the enrollment bearer itself.
      if (path !== '/sessions/runners/enroll' || req.method !== 'POST' || r.url.search)
        throw unknownEndpoint();
      const token = r.bearer();
      const provider = this.sessions.get();
      if (!provider.enrollManaged)
        throw new MervError(
          'managed_runner_unavailable',
          'Managed runner enrollment is unavailable',
          503,
        );
      const enrolled = await provider.enrollManaged(token, await r.json(undefined, 4096));
      projectSelection(enrolled.caller.projectId, req.headers['x-merv-project-id']);
      return { controlToken: enrolled.controlToken };
    }
    if (r.principal.kind === 'session') throw unknownEndpoint();
    if ([...r.url.searchParams].length)
      throw new MervError('invalid_input', 'Session routes do not accept query parameters');
    return req.method === 'GET'
      ? await this.read(() => this.sessionRoutes(req, res, r))
      : await this.sessionRoutes(req, res, r);
  }

  private async agentSelf(req: IncomingMessage, res: ServerResponse, r: ApiRequest) {
    if ([...r.url.searchParams].length)
      throw new MervError('invalid_input', 'Agent routes do not accept query parameters');
    // The route is matched first: an unknown one costs no authentication.
    const action = r.url.pathname.slice('/sessions/self'.length);
    if (
      req.method === 'GET'
        ? action !== ''
        : req.method !== 'POST' || !['/assignment', '/release', '/context-reset'].includes(action)
    )
      throw new MervError('not_found', 'Unknown agent control route', 404);
    const token = r.bearer();
    const provider = this.sessions.get();
    // The key is checked before any body is read, so a bad one never buffers a body.
    const self = await provider.agentSelf(token);
    if (req.method === 'GET') {
      json(res, 200, self);
      return;
    }
    if (action === '/assignment')
      json(res, 200, { execution: await provider.assignAgent(token, await r.json()) });
    else if (action === '/release')
      json(res, 200, {
        execution: await provider.releaseAgentAssignment(
          token,
          (await r.json(agentReleaseInput)).executionId,
        ),
      });
    else
      json(res, 200, {
        agent: await provider.resetAgentContext(token, (await r.json(agentResetInput)).reason),
      });
  }

  private async sessionRoutes(req: IncomingMessage, res: ServerResponse, r: ApiRequest) {
    const path = r.url.pathname;
    const sourceCaller = await r.caller();
    if (path === '/sessions/agents') {
      if (req.method === 'GET') {
        json(res, 200, { agents: await this.sessions.get().agents(sourceCaller) });
        return;
      }
      if (req.method === 'POST') {
        const input = await r.json();
        json(res, 200, {
          agent: await this.sessions.get().registerAgent(sourceCaller, input),
        });
        return;
      }
    }
    const observationRoute = /^\/sessions\/agents\/([^/]+)\/observation$/.exec(path);
    if (observationRoute && req.method === 'GET') {
      json(
        res,
        200,
        await this.sessions.get().agentObservation(sourceCaller, pathSegment(observationRoute[1]!)),
      );
      return;
    }
    const rotateAgentRoute = /^\/sessions\/agents\/([^/]+)\/rotate$/.exec(path);
    if (rotateAgentRoute && req.method === 'POST') {
      json(
        res,
        200,
        await this.sessions.get().rotateAgent(sourceCaller, pathSegment(rotateAgentRoute[1]!)),
      );
      return;
    }
    const agentRoute = /^\/sessions\/agents\/([^/]+)$/.exec(path);
    if (agentRoute) {
      const agentId = pathSegment(agentRoute[1]!);
      if (req.method === 'GET') {
        json(res, 200, await this.sessions.get().agent(sourceCaller, agentId));
        return;
      }
      if (req.method === 'DELETE') {
        json(res, 200, {
          agent: await this.sessions.get().retireAgent(sourceCaller, agentId),
        });
        return;
      }
    }
    if (path === '/sessions/status' && req.method === 'GET') {
      json(res, 200, await this.sessions.get().projectStatus(sourceCaller));
      return;
    }
    // Sessions parses each body and requires admin where it commits.
    if (path === '/sessions/dispatch' && req.method === 'PUT') {
      const input = await r.json();
      json(res, 200, {
        dispatch: await this.sessions.get().setDispatch(sourceCaller, input),
      });
      return;
    }
    if (path === '/sessions/halt' && req.method === 'POST') {
      const input = await r.json(haltInput);
      json(res, 200, await this.sessions.get().halt(sourceCaller, input));
      return;
    }
    if (path === '/sessions/lease' && req.method === 'POST') {
      const input = await r.json();
      json(res, 200, await this.sessions.get().lease(sourceCaller, input));
      return;
    }
    if (path === '/sessions/runners/heartbeat' && req.method === 'POST') {
      const input = await r.json();
      json(res, 200, {
        runner: await this.sessions.get().heartbeatRunner(sourceCaller, input),
      });
      return;
    }
    const settingsRoute = /^\/sessions\/runners\/([^/]+)\/settings$/.exec(path);
    if (settingsRoute && req.method === 'PUT') {
      const body = await r.json();
      json(res, 200, {
        runner: await this.sessions
          .get()
          .setRunnerSettings(sourceCaller, bound(body, 'runnerId', pathSegment(settingsRoute[1]!))),
      });
      return;
    }
    if (path === '/sessions' && req.method === 'GET') {
      json(res, 200, { sessions: await this.sessions.get().list(sourceCaller) });
      return;
    }
    if (path === '/sessions/offer' && req.method === 'POST') {
      const input = await r.json();
      json(res, 200, { session: await this.sessions.get().offer(sourceCaller, input) });
      return;
    }
    const route =
      /^\/sessions\/(session_[^/]+)(?:\/(attach|heartbeat|release|halt|workspace-result))?$/.exec(
        path,
      );
    if (route) {
      const sessionId = pathSegment(route[1]!);
      if (!route[2] && req.method === 'GET') {
        json(res, 200, { session: await this.sessions.get().get(sourceCaller, sessionId) });
        return;
      }
      if (req.method === 'POST' && route[2] === 'halt') {
        const input = await r.json(haltInput);
        json(res, 200, await this.sessions.get().halt(sourceCaller, { ...input, sessionId }));
        return;
      }
      if (req.method === 'POST' && route[2]) {
        const input = bound(await r.json(), 'sessionId', sessionId);
        const provider = this.sessions.get();
        const session =
          route[2] === 'attach'
            ? await provider.attach(sourceCaller, input)
            : route[2] === 'workspace-result'
              ? await provider.workspaceResult(sourceCaller, input)
              : route[2] === 'heartbeat'
                ? await provider.heartbeat(sourceCaller, input)
                : await provider.release(sourceCaller, input);
        json(res, 200, { session });
        return;
      }
    }
    throw unknownEndpoint();
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
    instance.setRequestHandler(ListToolsRequestSchema, async (request) => {
      try {
        const caller = await this.selectedCaller(
          principal,
          projectSelection(
            req.headers['x-merv-project-id'],
            request.params?._meta?.['merv/projectId'],
          ),
        );
        // MCP curates what a person's agent is offered; Merv's pages call /tools.
        return { tools: await this.tools.describe(caller, true) };
      } catch (error) {
        throw rpcError(error);
      }
    });
    instance.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const call = await this.caller(
          principal,
          request.params.arguments ?? {},
          request.params.name,
          projectSelection(
            req.headers['x-merv-project-id'],
            request.params._meta?.['merv/projectId'],
          ),
        );
        const result = await this.call(request.params.name, call.caller, call.input, true);
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

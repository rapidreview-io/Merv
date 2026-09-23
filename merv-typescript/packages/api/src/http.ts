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
  plain,
  type Caller,
  type Principal,
  type Scope,
} from '@merv/contracts';
import type { IdentityProvider } from '@merv/identity/types';
import type {
  Tools,
  ToolInvocation,
  MountHandler,
  SessionApiProvider,
  CodeApiProvider,
} from './types.js';
import { ApiError, isMountedToolName } from './registry.js';
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

/** One bounded body of opaque bytes, under the same two caps as a JSON body. */
function readBytes(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  if (req.destroyed) throw new ApiError('request_aborted', 'Request was aborted');
  if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/octet-stream') {
    req.resume();
    throw new ApiError(
      'unsupported_media_type',
      'Content-Type must be application/octet-stream',
      415,
    );
  }
  const length = Number(req.headers['content-length']);
  if (Number.isFinite(length) && length > maxBytes) {
    req.resume();
    throw new ApiError('body_too_large', 'Request body exceeds the configured limit', 413);
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
        reject(new ApiError('body_too_large', 'Request body exceeds the configured limit', 413));
      } else chunks.push(chunk);
    });
    req.once('end', () => {
      if (!rejected) resolve(Buffer.concat(chunks));
    });
    req.once('error', reject);
    req.once('aborted', () => reject(new ApiError('request_aborted', 'Request was aborted')));
  });
}

function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  // Authentication may have yielded while the client disconnected. Its abort/end
  // events will not fire again for listeners attached after the stream was destroyed.
  if (req.destroyed) throw new ApiError('request_aborted', 'Request was aborted');
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
        const body = Buffer.concat(chunks);
        if (!isUtf8(body))
          throw new ApiError('invalid_json', 'Request body must contain valid UTF-8 JSON');
        resolve(plain(JSON.parse(body.toString('utf8'))));
      } catch (error) {
        if (error instanceof MervError) reject(error);
        else reject(new ApiError('invalid_json', 'Request body must contain valid JSON'));
      }
    });
    req.once('error', reject);
    req.once('aborted', () => reject(new ApiError('request_aborted', 'Request was aborted')));
  });
}

const nonblank = z.string().trim().min(1).max(512);
const role = z.enum(['operator', 'producer', 'reviewer', 'reader']);
const createProjectInput = z.object({ name: nonblank, requestId: nonblank }).strict();
const addMemberInput = z.object({ subject: nonblank, role }).strict();
const changeMemberInput = z.object({ role }).strict();
const keyExpiry = z.string().datetime({ precision: 3 }).nullable().optional();
const keyProject = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value && !value.includes('\0'));
const createKeyInput = z
  .object({
    projectId: keyProject,
    grantScope: z.enum(['project', 'account']).optional(),
    label: z.string().max(120).nullable().optional(),
    expiresAt: keyExpiry,
  })
  .strict();
const rotateKeyInput = z.object({ expiresAt: keyExpiry }).strict();

// Sessions parses every other session body. These two unwrap the one field a method takes, and
// a project halt refuses a body sessionId, which would halt one session and leave dispatch on.
const agentReleaseInput = z.object({ executionId: nonblank }).strict();
const agentResetInput = z.object({ reason: nonblank }).strict();
const haltInput = z.object({ reason: z.string().min(1).max(200).optional() }).strict();

type ApiPrincipal = Principal | { kind: 'session'; caller: Caller };
// A legacy random actor token is exactly 43 characters even if it starts with ms_.
const sessionNamespace = (token: string) =>
  token.startsWith('ms_') && !/^[A-Za-z0-9_-]{43}$/.test(token);

function keyQuery(params: URLSearchParams, allowProject = false): string | undefined {
  if (
    [...params.keys()].some((key) => !allowProject || key !== 'projectId') ||
    params.getAll('projectId').length > 1
  )
    throw new ApiError('invalid_input', 'Unsupported or repeated key query parameter');
  const projectId = params.get('projectId');
  if (projectId === null) return undefined;
  return parseInput(keyProject, projectId);
}

/** Sessions parses its own bodies; the path's identifier is bound over the body's. */
function bound(body: unknown, key: string, value: string): unknown {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return body;
  if (Object.hasOwn(body, key)) throw new ApiError('invalid_input', `${key} is bound by the path`);
  return { ...body, [key]: value };
}

function parseInput<T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw new ApiError(
      'invalid_input',
      'Request body failed validation',
      400,
      parsed.error.issues.map(({ path, message }) => ({ path, message })),
    );
  return parsed.data;
}

function projectSelection(...selections: unknown[]): string | undefined {
  const supplied = selections.filter((selection) => selection !== undefined);
  for (const selection of supplied)
    if (typeof selection !== 'string' || !selection.trim())
      throw new ApiError('invalid_input', 'projectId must be a non-empty string');
  if (supplied.some((selection) => selection !== supplied[0]))
    throw new ApiError('invalid_input', 'Conflicting Merv project selections');
  return supplied[0] as string | undefined;
}

function pathSegment(value: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded.trim() || decoded.includes('/') || decoded.includes('\0')) throw new Error();
    return decoded;
  } catch {
    throw new ApiError('invalid_input', 'Malformed resource identifier');
  }
}

/** One stateless MCP transport per HTTP request; authentication is checked afresh each time. */
export class ApiServer {
  private server?: HttpServer;
  private sessions?: SessionApiProvider;
  private code?: CodeApiProvider;
  private stopping = false;
  private starting?: Promise<string>;
  private closing?: Promise<void>;
  private readonly requests = new Set<Promise<void>>();
  private readonly calls = new Set<Promise<unknown>>();
  private readonly mcpServers = new Set<McpServer>();
  private readonly mounts = new Map<string, MountHandler>();
  private readonly maxBodyBytes: number;
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
      throw new ApiError('invalid_config', 'maxBodyBytes must be a positive integer');
  }

  start(): Promise<string> {
    if (this.server || this.starting || this.closing)
      return Promise.reject(new ApiError('already_started', 'API server is already started', 409));
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
      const request = this.handle(req, res).catch((error: unknown) => {
        const body = errorBody(error);
        json(res, body.status, { error: body.error });
      });
      this.requests.add(request);
      void request.then(
        () => this.requests.delete(request),
        () => this.requests.delete(request),
      );
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

  /** Serve a plugin-owned path prefix without bearer authentication; the disposer withdraws it. */
  mount(prefix: string, handler: MountHandler): () => void {
    if (
      !/^\/[a-z][a-z0-9-]*$/.test(prefix) ||
      [
        '/health',
        '/tools',
        '/mcp',
        '/auth',
        '/account',
        '/projects',
        '/sessions',
        '/code',
      ].includes(prefix)
    )
      throw new ApiError('invalid_mount', 'Mount prefix must be one unreserved lowercase segment');
    if (this.mounts.has(prefix))
      throw new ApiError('mount_conflict', `Path prefix is already mounted: ${prefix}`, 409);
    if (typeof handler !== 'function')
      throw new ApiError('invalid_mount', 'Mount handler is required');
    this.mounts.set(prefix, handler);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.mounts.get(prefix) === handler) this.mounts.delete(prefix);
    };
  }

  registerSessions(provider: SessionApiProvider): () => void {
    if (this.sessions)
      throw new ApiError(
        'session_provider_conflict',
        'Session HTTP provider is already registered',
        409,
      );
    this.sessions = provider;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.sessions === provider) this.sessions = undefined;
    };
  }

  private sessionProvider(): SessionApiProvider {
    if (!this.sessions) throw new ApiError('session_unavailable', 'Sessions are unavailable', 503);
    return this.sessions;
  }

  registerCode(provider: CodeApiProvider): () => void {
    if (this.code)
      throw new ApiError('code_provider_conflict', 'Code HTTP provider is already registered', 409);
    this.code = provider;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.code === provider) this.code = undefined;
    };
  }

  private codeProvider(): CodeApiProvider {
    if (!this.code) throw new ApiError('code_unavailable', 'Code controls are unavailable', 503);
    return this.code;
  }

  private async selectedCaller(principal: ApiPrincipal, projectId?: string): Promise<Caller> {
    if (principal.kind !== 'session') return await this.scope.caller(principal, projectId);
    projectSelection(principal.caller.projectId, projectId);
    await this.sessionProvider().describe(principal.caller);
    await this.scope.require(principal.caller, 'read');
    return principal.caller;
  }

  private async authenticate(req: IncomingMessage): Promise<ApiPrincipal> {
    const authorization = req.headers.authorization;
    if (!authorization || !/^Bearer [^\s]+$/i.test(authorization))
      throw new ApiError('unauthorized', 'A bearer token is required', 401);
    const token = authorization.slice(7);
    if (sessionNamespace(token)) {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (path !== '/mcp' || req.method !== 'POST')
        throw new ApiError(
          'session_transport_forbidden',
          'Session credentials may only use POST /mcp',
          403,
        );
      const caller = await this.sessionProvider().authenticate(token);
      projectSelection(caller.projectId, req.headers['x-merv-project-id']);
      return { kind: 'session', caller };
    }
    // Local credentials are opaque. Never retry revoked or expired credentials upstream.
    // Legacy actor tokens are 43 random base64url characters and may happen to
    // start with mk_. User keys add that prefix to a full 43-character secret.
    if (token.startsWith('mk_') && !/^[A-Za-z0-9_-]{43}$/.test(token))
      return { kind: 'key', key: await this.scope.authenticateKey(token) };
    if (!token.includes('.')) return { kind: 'actor', actor: await this.scope.authenticate(token) };
    if (!this.identity)
      throw new ApiError('unauthorized', 'Human authentication is unavailable', 401);
    const verified = await this.identity.verify(token);
    return await this.scope.acceptVerifiedIdentity(verified);
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

  private async caller(
    principal: ApiPrincipal,
    input: unknown,
    name: string,
    selectedProject?: unknown,
  ): Promise<{ caller: Caller; input: Record<string, unknown> }> {
    if (input === null || typeof input !== 'object' || Array.isArray(input))
      throw new ApiError('invalid_input', 'Tool arguments must be an object');
    const argumentsObject = input as Record<string, unknown>;
    // The reserved namespace determines routing even while a catalog is being withdrawn.
    const remote = isMountedToolName(name);
    const { projectId: argumentProject, ...nativeArguments } = argumentsObject;
    const projectId = projectSelection(selectedProject, remote ? undefined : argumentProject);
    // actorId and other caller-shaped fields are ordinary arguments: strict feature schemas reject them.
    const caller = await this.selectedCaller(principal, projectId);
    await this.scope.require(caller, 'read');
    return { caller, input: remote ? argumentsObject : nativeArguments };
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
      throw new ApiError('forbidden_origin', 'Origin is not allowed', 403);
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    if (path === '/code/github/callback' && req.method === 'GET') {
      const github = this.codeProvider().github;
      if (!github) throw new ApiError('github_unavailable', 'GitHub is unavailable', 503);
      res.setHeader('referrer-policy', 'no-referrer');
      await githubCallback(req, res, github);
      return;
    }
    if (path === '/health' && req.method === 'GET') {
      json(res, 200, { status: 'ok' });
      return;
    }
    if (path === '/auth/config' && req.method === 'GET') {
      json(res, 200, this.identity?.configuration() ?? { enabled: false });
      return;
    }
    // Every other GET is a read, so it runs in a snapshot scope. Two families are not:
    // an agent's own routes may activate its lease, and Code's GitHub routes sweep expired
    // OAuth flows, claim token refreshes and complete the callback.
    if (
      req.method === 'GET' &&
      this.options.snapshot &&
      !path.startsWith('/sessions/self') &&
      !path.startsWith('/code/')
    ) {
      // A verified user's first request records that user, which is a write, so the caller
      // is authenticated before the read-only scope opens. Mounted handlers authenticate
      // themselves.
      const principal = this.mounted(path) ? undefined : await this.authenticate(req);
      return await this.options.snapshot(() => this.route(req, res, url, path, principal));
    }
    return await this.route(req, res, url, path);
  }

  private mounted(path: string): MountHandler | undefined {
    for (const [prefix, handler] of this.mounts)
      if (path === prefix || path.startsWith(`${prefix}/`)) return handler;
    return undefined;
  }

  private async route(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    path: string,
    authenticated?: ApiPrincipal,
  ): Promise<void> {
    const mounted = this.mounted(path);
    if (mounted) {
      await mounted(req, res);
      return;
    }
    // A continuing agent credential controls only itself. Assignment tools still enter through MCP.
    if (path === '/sessions/self' || path.startsWith('/sessions/self/')) {
      if ([...url.searchParams].length)
        throw new ApiError('invalid_input', 'Agent routes do not accept query parameters');
      const authorization = req.headers.authorization;
      if (!authorization || !/^Bearer [^\s]+$/i.test(authorization))
        throw new ApiError('unauthorized', 'A bearer token is required', 401);
      const token = authorization.slice(7),
        provider = this.sessionProvider();
      const self = await provider.agentSelf(token);
      if (path === '/sessions/self' && req.method === 'GET') {
        json(res, 200, self);
        return;
      }
      if (req.method === 'POST') {
        const body = await readJson(req, this.maxBodyBytes);
        if (path === '/sessions/self/assignment') {
          json(res, 200, { execution: await provider.assignAgent(token, body) });
          return;
        }
        if (path === '/sessions/self/release') {
          json(res, 200, {
            execution: await provider.releaseAgentAssignment(
              token,
              parseInput(agentReleaseInput, body).executionId,
            ),
          });
          return;
        }
        if (path === '/sessions/self/context-reset') {
          json(res, 200, {
            agent: await provider.resetAgentContext(
              token,
              parseInput(agentResetInput, body).reason,
            ),
          });
          return;
        }
      }
      throw new ApiError('not_found', 'Unknown agent control route', 404);
    }
    const principal = authenticated ?? (await this.authenticate(req));
    if (path === '/code/publications' || path.startsWith('/code/publications/')) {
      const caller = await this.selectedCaller(
        principal,
        projectSelection(req.headers['x-merv-project-id']),
      );
      await this.scope.require(caller, 'read');
      const body = req.method === 'POST' ? await readJson(req, 8192) : undefined;
      await this.scope.require(caller, 'read');
      json(
        res,
        200,
        await publicationRequest(req, caller, this.codeProvider(), () => Promise.resolve(body)),
      );
      return;
    }
    if (path === '/code/github' || path.startsWith('/code/github/')) {
      const caller = await this.selectedCaller(
        principal,
        projectSelection(req.headers['x-merv-project-id']),
      );
      await this.scope.require(caller, 'read');
      const body = req.method === 'POST' ? await readJson(req, 8192) : undefined;
      await this.scope.require(caller, 'read');
      const github = this.codeProvider().github;
      if (!github) throw new ApiError('github_unavailable', 'GitHub is unavailable', 503);
      json(res, 200, await githubRequest(req, res, caller, github, () => Promise.resolve(body)));
      return;
    }
    if (principal.kind !== 'session') {
      if (path === '/code/transport/grant' || path === '/code/transport/verify') {
        if (req.method !== 'POST' || url.search)
          throw new ApiError('invalid_input', 'Use POST without query parameters');
        const caller = await this.scope.caller(
          principal,
          projectSelection(req.headers['x-merv-project-id']),
        );
        await this.scope.require(caller, 'read');
        const input = parseInput(codeTransportInputSchema, await readJson(req, 8192));
        await this.scope.require(caller, 'read');
        const provider = this.codeProvider();
        if (!provider.transportGrant || !provider.verifyTransport)
          throw new ApiError('github_unavailable', 'Git transport is unavailable', 503);
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
          throw new ApiError('invalid_input', 'Code routes do not accept query parameters');
        const caller = await this.scope.caller(
          principal,
          projectSelection(req.headers['x-merv-project-id']),
        );
        await this.scope.require(caller, 'read');
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
        const body = part ? await readBytes(req, CODE_PART_MAX_BYTES) : await readJson(req, 65536);
        // Body streaming may outlive credential authority or the optional adapter.
        await this.scope.require(caller, 'read');
        const v2 = this.codeProvider().v2;
        if (!v2)
          throw new ApiError(
            'code_store_unavailable',
            'This server keeps no Code repositories',
            503,
          );
        if (part)
          json(res, 200, await v2.putPart(caller, part[1], Number(part[2]), body as Buffer));
        else if (read && v2.readPart) octets(res, await v2.readPart(caller, read[1], body));
        else json(res, 200, await v2.call(caller, route, body));
        return;
      }
      if (path === '/code/commands/next' || path === '/code/commands/complete') {
        if ([...url.searchParams].length)
          throw new ApiError('invalid_input', 'Code routes do not accept query parameters');
        const sourceCaller = await this.scope.caller(
          principal,
          projectSelection(req.headers['x-merv-project-id']),
        );
        await this.scope.require(sourceCaller, 'read');
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST');
          json(res, 405, {
            error: { code: 'method_not_allowed', message: 'Use POST for Code controls' },
          });
          return;
        }
        const body = await readJson(req, this.maxBodyBytes);
        const input = path.endsWith('/next')
          ? parseInput(codeCommandControlSchema, body)
          : parseInput(codeCommandCompletionSchema, body);
        // Body streaming may outlive credential authority or the optional adapter.
        // Lookup the current provider only after parsing; its methods are synchronous.
        await this.scope.require(sourceCaller, 'read');
        const provider = this.codeProvider();
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
      if (path === '/account' && req.method === 'GET') {
        json(res, 200, {
          ...(principal.kind === 'user'
            ? { kind: 'user', user: principal.user }
            : principal.kind === 'key'
              ? { kind: 'key', key: principal.key }
              : { kind: 'actor', actor: principal.actor }),
          projects: await this.scope.projects(principal),
        });
        return;
      }
      if (path === '/account/keys') {
        const projectId = keyQuery(url.searchParams, req.method === 'GET');
        if (req.method === 'GET') {
          json(res, 200, { keys: await this.scope.keys(principal, projectId) });
          return;
        }
        if (req.method === 'POST') {
          const input = parseInput(createKeyInput, await readJson(req, this.maxBodyBytes));
          json(res, 200, await this.scope.createKey(principal, input));
          return;
        }
      }
      const keyRoute = /^\/account\/keys\/([^/]+)(\/rotate)?$/.exec(path);
      if (keyRoute) {
        keyQuery(url.searchParams);
        const keyId = pathSegment(keyRoute[1]!);
        if (keyRoute[2] && req.method === 'POST') {
          const input = parseInput(rotateKeyInput, await readJson(req, this.maxBodyBytes));
          json(res, 200, await this.scope.rotateKey(principal, { keyId, ...input }));
          return;
        }
        if (!keyRoute[2] && req.method === 'DELETE') {
          await this.scope.revokeKey(principal, keyId);
          json(res, 200, { revoked: true });
          return;
        }
      }
      if (path === '/projects' && req.method === 'GET') {
        json(res, 200, { projects: await this.scope.projects(principal) });
        return;
      }
      if (path === '/projects' && req.method === 'POST') {
        const input = parseInput(createProjectInput, await readJson(req, this.maxBodyBytes));
        json(res, 200, { project: await this.scope.createProject(principal, input) });
        return;
      }
      const memberRoute = /^\/projects\/([^/]+)\/members(?:\/([^/]+))?$/.exec(path);
      if (memberRoute) {
        const projectId = pathSegment(memberRoute[1]!);
        const subject = memberRoute[2] === undefined ? undefined : pathSegment(memberRoute[2]);
        projectSelection(projectId, req.headers['x-merv-project-id']);
        if (subject === undefined && req.method === 'GET') {
          json(res, 200, { memberships: await this.scope.memberships(principal, projectId) });
          return;
        }
        if (subject === undefined && req.method === 'POST') {
          const input = parseInput(addMemberInput, await readJson(req, this.maxBodyBytes));
          json(res, 200, { membership: await this.scope.addMember(principal, projectId, input) });
          return;
        }
        if (subject !== undefined && req.method === 'PATCH') {
          const input = parseInput(changeMemberInput, await readJson(req, this.maxBodyBytes));
          json(res, 200, {
            membership: await this.scope.changeMemberRole(principal, projectId, {
              subject,
              ...input,
            }),
          });
          return;
        }
        if (subject !== undefined && req.method === 'DELETE') {
          await this.scope.removeMember(principal, projectId, subject);
          json(res, 200, { removed: true });
          return;
        }
      }
      if (path === '/sessions' || path.startsWith('/sessions/')) {
        if ([...url.searchParams].length)
          throw new ApiError('invalid_input', 'Session routes do not accept query parameters');
        const sourceCaller = await this.scope.caller(
          principal,
          projectSelection(req.headers['x-merv-project-id']),
        );
        await this.scope.require(sourceCaller, 'read');
        if (path === '/sessions/agents') {
          if (req.method === 'GET') {
            json(res, 200, { agents: await this.sessionProvider().agents(sourceCaller) });
            return;
          }
          if (req.method === 'POST') {
            const input = await readJson(req, this.maxBodyBytes);
            json(res, 200, {
              agent: await this.sessionProvider().registerAgent(sourceCaller, input),
            });
            return;
          }
        }
        const observationRoute = /^\/sessions\/agents\/([^/]+)\/observation$/.exec(path);
        if (observationRoute && req.method === 'GET') {
          json(
            res,
            200,
            await this.sessionProvider().agentObservation(
              sourceCaller,
              pathSegment(observationRoute[1]!),
            ),
          );
          return;
        }
        const agentRoute = /^\/sessions\/agents\/([^/]+)$/.exec(path);
        if (agentRoute) {
          const agentId = pathSegment(agentRoute[1]!);
          if (req.method === 'GET') {
            json(res, 200, await this.sessionProvider().agent(sourceCaller, agentId));
            return;
          }
          if (req.method === 'DELETE') {
            json(res, 200, {
              agent: await this.sessionProvider().retireAgent(sourceCaller, agentId),
            });
            return;
          }
        }
        if (path === '/sessions/status' && req.method === 'GET') {
          json(res, 200, await this.sessionProvider().projectStatus(sourceCaller));
          return;
        }
        // Sessions parses each body and requires admin where it commits.
        if (path === '/sessions/dispatch' && req.method === 'PUT') {
          const input = await readJson(req, this.maxBodyBytes);
          json(res, 200, {
            dispatch: await this.sessionProvider().setDispatch(sourceCaller, input),
          });
          return;
        }
        if (path === '/sessions/halt' && req.method === 'POST') {
          const input = parseInput(haltInput, await readJson(req, this.maxBodyBytes));
          json(res, 200, await this.sessionProvider().halt(sourceCaller, input));
          return;
        }
        if (path === '/sessions/lease' && req.method === 'POST') {
          const input = await readJson(req, this.maxBodyBytes);
          json(res, 200, await this.sessionProvider().lease(sourceCaller, input));
          return;
        }
        if (path === '/sessions/runners/heartbeat' && req.method === 'POST') {
          const input = await readJson(req, this.maxBodyBytes);
          json(res, 200, {
            runner: await this.sessionProvider().heartbeatRunner(sourceCaller, input),
          });
          return;
        }
        const settingsRoute = /^\/sessions\/runners\/([^/]+)\/settings$/.exec(path);
        if (settingsRoute && req.method === 'PUT') {
          const body = await readJson(req, this.maxBodyBytes);
          json(res, 200, {
            runner: await this.sessionProvider().setRunnerSettings(
              sourceCaller,
              bound(body, 'runnerId', pathSegment(settingsRoute[1]!)),
            ),
          });
          return;
        }
        if (path === '/sessions' && req.method === 'GET') {
          json(res, 200, { sessions: await this.sessionProvider().list(sourceCaller) });
          return;
        }
        if (path === '/sessions/offer' && req.method === 'POST') {
          const input = await readJson(req, this.maxBodyBytes);
          json(res, 200, { session: await this.sessionProvider().offer(sourceCaller, input) });
          return;
        }
        const route =
          /^\/sessions\/(session_[^/]+)(?:\/(attach|heartbeat|release|halt|workspace-result))?$/.exec(
            path,
          );
        if (route) {
          const sessionId = pathSegment(route[1]!);
          if (!route[2] && req.method === 'GET') {
            json(res, 200, { session: await this.sessionProvider().get(sourceCaller, sessionId) });
            return;
          }
          if (req.method === 'POST' && route[2] === 'halt') {
            const input = parseInput(haltInput, await readJson(req, this.maxBodyBytes));
            json(
              res,
              200,
              await this.sessionProvider().halt(sourceCaller, { ...input, sessionId }),
            );
            return;
          }
          if (req.method === 'POST' && route[2]) {
            const input = bound(await readJson(req, this.maxBodyBytes), 'sessionId', sessionId);
            const provider = this.sessionProvider();
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
      }
    }
    if (path === '/tools' && req.method === 'GET') {
      const caller = await this.selectedCaller(
        principal,
        projectSelection(req.headers['x-merv-project-id']),
      );
      await this.scope.require(caller, 'read');
      json(res, 200, {
        tools: await this.tools.describe(caller),
      });
      return;
    }
    if (path.startsWith('/tools/') && req.method === 'POST') {
      let name: string;
      try {
        name = decodeURIComponent(path.slice('/tools/'.length));
      } catch {
        throw new ApiError('invalid_tool', 'Malformed tool name');
      }
      const request = await this.caller(
        principal,
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
            principal.kind === 'session'
              ? 'You are a leased Merv worker in one fixed project and workflow revision. Use the available tools for your current assignment. Tool arguments are bound by the server; omitted fixed identifiers are supplied automatically. Follow workflow.assignment and its handoff guidance. This session credential is valid only on this MCP endpoint.'
              : 'Merv is a durable task and independent review system. Human sessions and account machine keys must explicitly select a project using X-Merv-Project-Id or request _meta["merv/projectId"]. Actor tokens and project machine keys default to their fixed project. Use actor.whoami and project.get to inspect the selected identity and project. Request IDs make supported mutations retryable; supply the current expectedRevision for transitions.',
        },
      );
      instance.setRequestHandler(ListToolsRequestSchema, async (request) => {
        const caller = await this.selectedCaller(
          principal,
          projectSelection(
            req.headers['x-merv-project-id'],
            request.params?._meta?.['merv/projectId'],
          ),
        );
        await this.scope.require(caller, 'read');
        return { tools: await this.tools.describe(caller) };
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

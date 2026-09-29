import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { MervError, type Caller, type Data } from '@merv/contracts';
import type { Tools } from '@merv/api/types';
import type { CredentialProvider, ResolvedCredential } from './types.js';
import type { ToolPolicy } from '@merv/contracts';

const END_MS = 1000; // cleanup is best effort: a DELETE never holds a retire, stop or unload longer
const isSignal = (signal: AbortSignal | null | undefined): signal is AbortSignal => !!signal;

/**
 * Bounds: the SDK request `timeout` (cleared on response) plus a fetch deadline on every non-GET.
 * Never a timer or long-lived signal on an SDK request: its abort listener outlives the request
 * and sends a stray notifications/cancelled.
 */
export async function connectUpstream(
  url: string,
  headers: Record<string, string> | undefined,
  timeoutMs: number,
  options: { signal?: AbortSignal; notifications?: (client: Client) => void } = {},
): Promise<Client> {
  const client = new Client({ name: 'merv-mount', version: '1' });
  options.notifications?.(client);
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    ...(headers && { requestInit: { headers } }),
    fetch: (address, init) => {
      const stream = init?.method === 'GET';
      // Invocation takes no server notifications. Decline only the standalone stream; resumptions
      // carry last-event-id.
      if (stream && !options.notifications && !new Headers(init?.headers).has('last-event-id'))
        return Promise.resolve(new Response(null, { status: 405 }));
      const deadline = init?.method === 'DELETE' ? Math.min(timeoutMs, END_MS) : timeoutMs;
      const timer = stream ? undefined : AbortSignal.timeout(deadline);
      // A binding authorizes this endpoint, never a redirect target. Even when fetch strips
      // Authorization, it forwards tool bodies and MCP headers. Node 22 can collect a timeout
      // signal held only by AbortSignal.any(), which then never fires: hold it until fetch settles.
      return fetch(address, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.any([init?.signal, timer].filter(isSignal)),
      }).finally(() => timer);
    },
  });
  // The signal is discovery's per-round stop; the SDK closes the client when initialize fails.
  await client.connect(transport, { timeout: timeoutMs, signal: options.signal });
  return client;
}

/** The MCP DELETE first (close() aborts the signal it uses), then the local close. Never rejects. */
export async function endUpstream(client: Client): Promise<void> {
  await (client.transport as StreamableHTTPClientTransport | undefined)
    ?.terminateSession()
    .catch(() => undefined);
  await client.close().catch(() => undefined);
}

/** One pool serves one mount endpoint. */
export interface ScopedRemoteClientOptions {
  mountId: string;
  url: string;
  /** Bounds each upstream request; a DELETE gets at most one second. */
  timeoutMs?: number;
  /** A connection without calls for this long ends (default five minutes). */
  idleMs?: number;
  /** Test seam in place of connectUpstream. */
  connect?: typeof connectUpstream;
}

interface Connection {
  key: string;
  lane: string;
  identityKey: string;
  ready: Promise<Client>;
  users: number;
  retired: boolean;
  idle?: NodeJS.Timeout;
  closing?: Promise<void>;
}

/**
 * The upstream answered over a healthy session. Limitation: upstream codes -32000 and -32001 equal
 * the SDK's local ConnectionClosed and RequestTimeout, so they count as transport faults.
 */
export const answered = (error: unknown) =>
  error instanceof McpError &&
  error.code !== ErrorCode.RequestTimeout &&
  error.code !== ErrorCode.ConnectionClosed;

/** Fixed codes and texts only: no upstream text, header or secret reaches a caller or a status. */
export function fault(error: unknown): MervError {
  if (error instanceof MervError) return error;
  if (answered(error))
    return new MervError(
      'remote_error',
      `Remote tool refused the request (${(error as McpError).code})`,
      502,
    );
  if (error instanceof StreamableHTTPError && (error.code === 401 || error.code === 403))
    return new MervError(
      'remote_credential_rejected',
      'The upstream service refused its configured credential',
      502,
    );
  if (
    (error instanceof McpError && error.code === ErrorCode.RequestTimeout) ||
    (error as Error)?.name === 'TimeoutError'
  )
    return new MervError('remote_timeout', 'Remote operation timed out', 504);
  return new MervError('remote_unavailable', 'Remote tool service is unavailable', 502);
}

/** Actor/project credentials are resolved per admission; only matching identities share a client. */
export class ScopedRemoteClients {
  private readonly connections = new Map<string, Connection>();
  private readonly current = new Map<string, Connection>();
  private readonly all = new Set<Connection>();
  private readonly running = new Set<Promise<CallToolResult>>();
  private readonly timeoutMs: number;
  private stopping = false;
  private closing?: Promise<void>;

  constructor(
    private readonly credentials: CredentialProvider,
    private readonly access: Pick<ToolPolicy, 'require'>,
    private readonly options: ScopedRemoteClientOptions,
    /** Re-admits a session's bound arguments; without it every session caller is refused. */
    private readonly sessions?: Pick<Tools, 'validateSession'>,
  ) {
    // The mounts Config validated the endpoint and timeout.
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  async call(
    caller: Caller,
    mountId: string,
    rawToolName: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    if (this.stopping)
      return Promise.reject(new MervError('remote_closed', 'Remote client pool is closed', 503));
    const operation = Promise.resolve().then(async () => {
      let connection: Connection;
      try {
        if (mountId !== this.options.mountId)
          throw new MervError('remote_mount_not_found', 'Remote mount is not configured', 404);
        const url = this.options.url;
        const lane = JSON.stringify([mountId, url, caller.actorId, caller.projectId]);
        await this.admit(caller, mountId, rawToolName, args);
        const credential = await this.credentials.resolve(caller, mountId);
        const key = JSON.stringify([
          mountId,
          url,
          caller.actorId,
          caller.projectId,
          credential.identityKey,
        ]);
        const previous = this.current.get(lane);
        if (previous && previous.key !== key) this.retire(previous);
        connection = this.connections.get(key) ?? this.createConnection(key, lane, url, credential);
      } catch (error) {
        // Admission and credential refusals concern this call; the connection stays.
        throw fault(error);
      }
      return await this.invoke(connection, caller, mountId, rawToolName, args);
    });
    this.running.add(operation);
    try {
      return await operation;
    } finally {
      this.running.delete(operation);
    }
  }

  private async admit(
    caller: Caller,
    mountId: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<void> {
    await this.access.require(caller, mountId, name);
    if (!caller.session) return;
    if (!this.sessions)
      throw new MervError('session_unavailable', 'Session policy is unavailable', 503);
    await this.sessions.validateSession(caller, `_${mountId}.${name}`, args as Data);
  }

  private createConnection(
    key: string,
    lane: string,
    url: string,
    credential: ResolvedCredential,
  ): Connection {
    const connect = this.options.connect ?? connectUpstream;
    const connection: Connection = {
      key,
      lane,
      identityKey: credential.identityKey,
      ready: connect(url, { ...credential.headers() }, this.timeoutMs),
      users: 0,
      retired: false,
    };
    this.connections.set(key, connection);
    this.current.set(lane, connection);
    this.all.add(connection);
    // A failed connect is never reused.
    connection.ready.catch(() => this.retire(connection));
    return connection;
  }

  private async invoke(
    connection: Connection,
    caller: Caller,
    mountId: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    connection.users++;
    clearTimeout(connection.idle);
    try {
      const client = await connection.ready;
      // Connection setup and credential resolution can yield. Rotation or revocation
      // during either wait must be observed before an operation crosses the upstream boundary.
      const currentCredential = await this.credentials.resolve(caller, mountId);
      if (currentCredential.identityKey !== connection.identityKey)
        throw new MervError(
          'credential_changed',
          'Upstream credential changed before dispatch',
          409,
        );
      await this.admit(caller, mountId, name, args);
      // Cast on purpose: the registry's complete() is the one result validator.
      return (await client.request(
        { method: 'tools/call', params: { name, arguments: args } },
        z.unknown(),
        { timeout: this.timeoutMs },
      )) as CallToolResult;
    } catch (error) {
      // Only a transport fault retires the shared connection; refusals and upstream answers keep it.
      if (!(error instanceof MervError) && !answered(error)) this.retire(connection);
      throw fault(error);
    } finally {
      // A retired connection ends after its last admitted call; an unused one ends when idle.
      if (--connection.users === 0) {
        if (connection.retired) void this.dispose(connection);
        else
          (connection.idle = setTimeout(
            () => this.retire(connection),
            this.options.idleMs ?? 300_000,
          )).unref();
      }
    }
  }

  private retire(connection: Connection): void {
    connection.retired = true;
    if (this.connections.get(connection.key) === connection)
      this.connections.delete(connection.key);
    if (this.current.get(connection.lane) === connection) this.current.delete(connection.lane);
    if (connection.users === 0) void this.dispose(connection);
  }

  /** Ends a connection once; never rejects. */
  private dispose(connection: Connection): Promise<void> {
    clearTimeout(connection.idle);
    return (connection.closing ??= connection.ready
      .then(endUpstream, () => undefined)
      .finally(() => this.all.delete(connection)));
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopping = true;
    this.closing = (async () => {
      await Promise.allSettled([...this.running]);
      await Promise.all([...this.all].map(async (connection) => this.dispose(connection)));
      this.connections.clear();
      this.current.clear();
    })();
    return this.closing;
  }
}

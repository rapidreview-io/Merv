import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { check, MervError, type Caller, type Data, type ToolPolicy } from '@merv/contracts';
import type { RemoteToolDefinition, Tools } from '@merv/api/types';
import type { Bindings } from './credentials.js';
import type { CredentialBinding } from './types.js';

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

interface Connection {
  binding: CredentialBinding;
  ready: Promise<Client>;
  /** Set once connected: a call that finds it set has not waited since the registry admitted it. */
  client?: Client;
  users: number;
  retired: boolean;
  idle?: NodeJS.Timeout;
  ended?: Promise<void>;
}

/** One connection per caller (project, actor) of one mount, carrying the binding selected for it. */
export class Invocations {
  readonly #open = new Map<string, Connection>();
  #closed = false;
  /** Every DELETE started; close() awaits it. */
  #ending: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly mount: { id: string; url: string; timeoutMs: number },
    private readonly bindings: Pick<Bindings, 'select' | 'headers'>,
    private readonly access: Pick<ToolPolicy, 'require'>,
    private readonly tools: Pick<Tools, 'validateSession'>,
    /** Test seams: the idle close (default five minutes) and a replacement for connectUpstream. */
    private readonly options: { idleMs?: number; connect?: typeof connectUpstream } = {},
  ) {}

  handler(name: string): RemoteToolDefinition['handler'] {
    return (caller, input) => this.call(caller, name, input as Data);
  }

  /**
   * The registry admitted this caller immediately before (its dispatch access.require). A lane's
   * binding is a pure function of (project, actor) for this load, so a warm call crosses at once.
   */
  private async call(caller: Caller, name: string, input: Data): Promise<CallToolResult> {
    const lane = JSON.stringify([caller.projectId, caller.actorId]);
    const known = this.#open.get(lane); // read before any await: see `cold`
    // Checked before and after the one wait here: a closed pool selects nothing and opens nothing.
    check(!this.#closed, 'remote_unavailable', 'Remote tool service is unavailable', 502);
    const binding = known?.binding ?? (await this.bindings.select(caller, this.mount.id));
    check(!this.#closed, 'remote_unavailable', 'Remote tool service is unavailable', 502);
    // Synchronous from here: concurrent first calls share one connection.
    const connection = this.#open.get(lane) ?? this.open(lane, binding);
    // Any wait since admission (select, connect) is followed by a re-check.
    const cold = !known?.client;
    connection.users++;
    clearTimeout(connection.idle);
    try {
      const client = await connection.ready;
      if (cold) {
        await this.access.require(caller, this.mount.id, name);
        if (caller.session)
          await this.tools.validateSession(caller, `_${this.mount.id}.${name}`, input);
      }
      // Cast on purpose: the registry's complete() is the one result validator.
      return (await client.request(
        { method: 'tools/call', params: { name, arguments: input } },
        z.unknown(),
        { timeout: this.mount.timeoutMs },
      )) as CallToolResult;
    } catch (error) {
      // Only a transport fault retires the connection; refusals and upstream answers keep it.
      if (!(error instanceof MervError) && !answered(error)) this.retire(lane, connection);
      throw fault(error);
    } finally {
      // A retired connection ends after its last call; an unused one ends when idle.
      if (--connection.users === 0) {
        if (connection.retired) void this.end(connection);
        else
          (connection.idle = setTimeout(
            () => this.retire(lane, connection),
            this.options.idleMs ?? 300_000,
          )).unref();
      }
    }
  }

  private open(lane: string, binding: CredentialBinding): Connection {
    const connection = { binding, users: 0, retired: false } as Connection;
    // The secret is read, and checked not to be a Merv credential, once per connection.
    connection.ready = this.bindings
      .headers(binding)
      .then((headers) =>
        (this.options.connect ?? connectUpstream)(this.mount.url, headers, this.mount.timeoutMs),
      )
      .then((client) => (connection.client = client));
    // A failed connect is never reused.
    connection.ready.catch(() => this.retire(lane, connection));
    this.#open.set(lane, connection);
    return connection;
  }

  private retire(lane: string, connection: Connection): void {
    connection.retired = true;
    if (this.#open.get(lane) === connection) this.#open.delete(lane);
    if (connection.users === 0) void this.end(connection);
  }

  /** Ends a connection once; never rejects. */
  private end(connection: Connection): Promise<void> {
    clearTimeout(connection.idle);
    if (!connection.ended) {
      const ended = (connection.ended = connection.ready.then(endUpstream, () => undefined));
      this.#ending = this.#ending.then(() => ended);
    }
    return connection.ended;
  }

  /**
   * Runs after the registry drained every admitted call: refuses new calls, retires every lane
   * and awaits every DELETE started. A straggler (only a handler taken from Tools.list()) keeps
   * its connection until it finishes, then ends it.
   */
  async close(): Promise<void> {
    this.#closed = true;
    for (const [lane, connection] of this.#open) this.retire(lane, connection);
    await this.#ending;
  }
}

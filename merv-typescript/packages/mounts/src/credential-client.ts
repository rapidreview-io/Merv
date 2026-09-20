import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CallToolResultSchema,
  ErrorCode,
  McpError,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { MervError, type Caller, type Data } from '@merv/contracts';
import type { CredentialProvider, ResolvedCredential } from './types.js';
import type { ToolPolicy } from '@merv/contracts';

const losslessResult = z.custom<CallToolResult>(
  (value) => CallToolResultSchema.safeParse(value).success,
  'Remote tool returned an invalid MCP result',
);

export interface ScopedRemoteClientOptions {
  mounts: Record<string, { url: string }>;
  /** Applies separately to connection, invocation, and connection cleanup. */
  timeoutMs?: number;
  /** Test seam; the helper always attaches its own authenticated SDK HTTP transport. */
  clientFactory?: () => Client;
}

interface Connection {
  key: string;
  lane: string;
  identityKey: string;
  client: Client;
  ready: Promise<void>;
  users: number;
  retired: boolean;
  credentialFailure?: MervError;
  closing?: Promise<void>;
}

function unavailable(): MervError {
  return new MervError('remote_unavailable', 'Remote tool service is unavailable', 502);
}

function deadline<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new MervError('remote_timeout', 'Remote tool operation timed out', 504)),
      milliseconds,
    );
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function transportError(error: unknown): MervError {
  if (error instanceof MervError && error.code === 'credential_changed')
    return new MervError('credential_changed', 'Upstream credential changed before dispatch', 409);
  if (
    (error instanceof MervError && error.code === 'remote_timeout') ||
    (error instanceof McpError && error.code === ErrorCode.RequestTimeout)
  )
    return new MervError('remote_timeout', 'Remote tool operation timed out', 504);
  return unavailable();
}

/** Actor/project credentials are resolved per admission; only matching identities share a client. */
export class ScopedRemoteClients {
  private readonly mounts = new Map<string, string>();
  private readonly connections = new Map<string, Connection>();
  private readonly current = new Map<string, Connection>();
  private readonly all = new Set<Connection>();
  private readonly running = new Set<Promise<CallToolResult>>();
  private readonly timeoutMs: number;
  private cleanupFailed = false;
  private stopping = false;
  private closing?: Promise<void>;

  constructor(
    private readonly credentials: CredentialProvider,
    private readonly access: ToolPolicy,
    private readonly options: ScopedRemoteClientOptions,
  ) {
    this.timeoutMs = options.timeoutMs ?? 5000;
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 2_147_483_647
    )
      throw new MervError(
        'invalid_remote_config',
        'timeoutMs must be a positive supported timeout',
      );
    for (const [mountId, mount] of Object.entries(options.mounts)) {
      let url: URL;
      try {
        url = new URL(mount.url);
      } catch {
        throw new MervError('invalid_remote_config', 'Mount endpoint must be an HTTP(S) URL');
      }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
        throw new MervError(
          'invalid_remote_config',
          'Mount endpoint must be an HTTP(S) URL without credentials or fragment',
        );
      this.mounts.set(mountId, url.href);
    }
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
      let lane: string | undefined;
      try {
        const url = this.mounts.get(mountId);
        if (!url)
          throw new MervError('remote_mount_not_found', 'Remote mount is not configured', 404);
        lane = JSON.stringify([mountId, url, caller.actorId, caller.projectId]);
        await this.access.require(caller, mountId, rawToolName);
        if (caller.session)
          await this.access.validate(caller, `_${mountId}.${rawToolName}`, args as Data);
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
        const previous = lane ? this.current.get(lane) : undefined;
        if (previous) this.retire(previous);
        throw error instanceof MervError ? error : unavailable();
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

  private createConnection(
    key: string,
    lane: string,
    url: string,
    credential: ResolvedCredential,
  ): Connection {
    const client =
      this.options.clientFactory?.() ?? new Client({ name: 'merv-scoped-client', version: '1' });
    const connection: Connection = {
      key,
      lane,
      identityKey: credential.identityKey,
      client,
      ready: Promise.resolve(),
      users: 0,
      retired: false,
    };
    this.connections.set(key, connection);
    this.current.set(lane, connection);
    this.all.add(connection);
    connection.ready = (async () => {
      try {
        const transport = new StreamableHTTPClientTransport(new URL(url), {
          requestInit: { headers: { ...credential.headers() } },
          fetch: (address, init) => {
            try {
              credential.assertCurrent?.();
            } catch {
              // The SDK can wrap a failed initialized notification as a protocol
              // error. Retain the local, sanitized cause through that boundary.
              connection.credentialFailure = new MervError(
                'credential_changed',
                'Upstream credential changed before dispatch',
                409,
              );
              throw connection.credentialFailure;
            }
            return fetch(address, {
              ...init,
              // The binding authorizes this endpoint, not a redirect destination. Even
              // when fetch strips Authorization, it forwards tool bodies and MCP headers.
              redirect: 'error',
              signal: AbortSignal.any([
                ...(init?.signal ? [init.signal] : []),
                AbortSignal.timeout(this.timeoutMs),
              ]),
            });
          },
        });
        await deadline(
          client.connect(transport, { timeout: this.timeoutMs, maxTotalTimeout: this.timeoutMs }),
          this.timeoutMs,
        );
      } catch (error) {
        this.retire(connection);
        throw connection.credentialFailure ?? transportError(error);
      }
    })();
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
    try {
      await connection.ready;
      // Connection setup can yield. Revocation or rotation during that wait must
      // be observed before an operation crosses the upstream boundary.
      await this.access.require(caller, mountId, name);
      if (caller.session) await this.access.validate(caller, `_${mountId}.${name}`, args as Data);
      const currentCredential = await this.credentials.resolve(caller, mountId);
      if (currentCredential.identityKey !== connection.identityKey)
        throw new MervError(
          'credential_changed',
          'Upstream credential changed before dispatch',
          409,
        );
      // Credential resolution can also yield after the connection is ready.
      await this.access.require(caller, mountId, name);
      if (caller.session) await this.access.validate(caller, `_${mountId}.${name}`, args as Data);
      currentCredential.assertCurrent?.();
      return await deadline(
        connection.client.request(
          { method: 'tools/call', params: { name, arguments: args } },
          losslessResult,
          { timeout: this.timeoutMs, maxTotalTimeout: this.timeoutMs },
        ),
        this.timeoutMs,
      );
    } catch (error) {
      this.retire(connection);
      throw (
        connection.credentialFailure ?? (error instanceof MervError ? error : transportError(error))
      );
    } finally {
      connection.users--;
      // A failed shared connection is withdrawn immediately; other admitted calls retain it.
      if (connection.retired && connection.users === 0)
        await this.dispose(connection).catch(() => undefined);
    }
  }

  private retire(connection: Connection): void {
    connection.retired = true;
    if (this.connections.get(connection.key) === connection)
      this.connections.delete(connection.key);
    if (this.current.get(connection.lane) === connection) this.current.delete(connection.lane);
    if (connection.users === 0) void this.dispose(connection).catch(() => undefined);
  }

  private dispose(connection: Connection): Promise<void> {
    return (connection.closing ??= deadline(connection.client.close(), this.timeoutMs)
      .catch((error: unknown) => {
        // Retirements can finish before shutdown snapshots the live clients.
        // Retain their cleanup outcome after removing the connection itself.
        this.cleanupFailed = true;
        throw transportError(error);
      })
      .finally(() => this.all.delete(connection)));
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopping = true;
    this.closing = (async () => {
      await Promise.allSettled([...this.running]);
      const results = await Promise.allSettled(
        [...this.all].map(async (connection) => this.dispose(connection)),
      );
      this.connections.clear();
      this.current.clear();
      if (this.cleanupFailed || results.some((result) => result.status === 'rejected'))
        throw unavailable();
    })();
    return this.closing;
  }
}

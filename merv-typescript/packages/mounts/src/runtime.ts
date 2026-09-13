import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { check, MervError } from '@merv/contracts';
import type { Tools, ToolCatalog, RemoteToolDefinition } from '@merv/api/types';
import type { CredentialProvider, ResolvedCredential } from '@merv/credentials/types';
import type { AccessPolicy } from '@merv/access/types';
import type { MountConfig, MountStatus } from './types.js';
import { collectRemoteCatalog } from './remote-catalog.js';
import { ScopedRemoteClients } from './credential-client.js';

const safeCodes = new Set([
  'forbidden',
  'tool_forbidden',
  'credential_forbidden',
  'credential_unavailable',
  'credential_changed',
  'invalid_schema',
  'invalid_tool',
  'unsupported_execution',
  'remote_catalog_limit',
  'remote_catalog_cursor',
  'remote_catalog_duplicate',
  'remote_catalog_timeout',
  'mount_missing_tool',
  'mount_disconnected',
  'mount_timeout',
  'mount_cleanup_failed',
]);
const safeCode = (error: unknown) =>
  error instanceof MervError && safeCodes.has(error.code) ? error.code : 'mount_unavailable';
function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new MervError('mount_timeout', 'Mount operation timed out', 504)),
      timeoutMs,
    );
    promise.then(
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

/** One dedicated discovery session; invocation connections are separately scoped by the pool. */
export class MountRuntime {
  private readonly catalog: ToolCatalog;
  private readonly pool: ScopedRemoteClients;
  private readonly timeoutMs: number;
  private readonly reconnectMs: number;
  private snapshot: MountStatus;
  private client?: Client;
  private discoveryIdentity?: string;
  private discoveryAbort?: AbortController;
  private current?: Promise<void>;
  private forceNext = false;
  private refreshAgain = false;
  private failures = 0;
  private cleanupFailed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly drains = new Set<Promise<void>>();
  private stopping = false;
  private closing?: Promise<void>;

  constructor(
    tools: Tools,
    private readonly credentials: CredentialProvider,
    private readonly access: AccessPolicy,
    private readonly config: MountConfig,
  ) {
    this.timeoutMs = config.timeoutMs ?? 5000;
    this.reconnectMs = config.reconnectMs ?? 1000;
    this.snapshot = {
      id: config.id,
      origin: new URL(config.url).origin,
      state: 'connecting',
      toolCount: 0,
    };
    this.pool = new ScopedRemoteClients(credentials, access, {
      mounts: { [config.id]: { url: config.url } },
      timeoutMs: this.timeoutMs,
    });
    this.catalog = tools.createCatalog(config.id);
  }

  status(): MountStatus {
    return { ...this.snapshot };
  }

  refresh(force = false): Promise<void> {
    if (this.stopping)
      return Promise.reject(new MervError('mounts_stopped', 'Mounts are stopped', 503));
    if (force && this.current)
      return this.current.catch(() => undefined).then(() => this.refresh(true));
    this.clearTimer();
    if (force) this.forceNext = true;
    else this.refreshAgain = true;
    if (this.current) return this.current;
    const operation = Promise.resolve()
      .then(async () => {
        let rounds = 0;
        do {
          rounds++;
          const reconnect = this.forceNext;
          this.forceNext = false;
          this.refreshAgain = false;
          if (reconnect) await this.resetDiscovery();
          await this.refreshOnce();
          // Continuous notifications cannot keep optional startup or one explicit refresh open forever.
        } while (!this.stopping && rounds < 2 && (this.forceNext || this.refreshAgain));
      })
      .catch((error: unknown) => {
        if (!this.stopping) this.failed(error);
        throw new MervError(safeCode(error), 'Mount catalog is unavailable', 503);
      })
      .finally(() => {
        this.current = undefined;
        this.schedule();
      });
    this.current = operation;
    return operation;
  }

  private credential(): ResolvedCredential | undefined {
    if (!this.config.discovery) return undefined;
    // Discovery has its own configured actor. Its grants and credential never authorize calls.
    for (const name of this.config.tools)
      this.access.require(this.config.discovery, this.config.id, name);
    return this.credentials.resolve(this.config.discovery, this.config.id);
  }

  private async refreshOnce(): Promise<void> {
    check(!this.stopping, 'mounts_stopped', 'Mounts are stopped', 503);
    const credential = this.credential();
    if (this.client && this.discoveryIdentity !== credential?.identityKey)
      await this.resetDiscovery();
    if (!this.client) await this.connect(credential);
    const client = this.client!;
    check(
      this.credential()?.identityKey === this.discoveryIdentity,
      'credential_changed',
      'Discovery credential changed before query',
      409,
    );
    const definitions = await collectRemoteCatalog(client, {
      timeoutMs: this.timeoutMs,
      signal: this.discoveryAbort!.signal,
    });
    check(
      !this.stopping && this.client === client,
      'mount_disconnected',
      'Discovery connection changed',
      503,
    );
    // Credentials can change while discovery yields; do not publish a catalog using revoked authority.
    check(
      this.credential()?.identityKey === this.discoveryIdentity,
      'credential_changed',
      'Discovery credential changed',
      409,
    );
    const available = new Map(definitions.map((definition) => [definition.name, definition]));
    const selected: RemoteToolDefinition[] = this.config.tools.map((name) => {
      const definition = available.get(name);
      check(definition, 'mount_missing_tool', 'A selected remote tool is missing', 502);
      return {
        ...definition,
        // The discovery handler is deliberately discarded; every call selects its own authority.
        handler: (caller, input) => this.pool.call(caller, this.config.id, name, input),
      };
    });
    // Registry compilation only sees the selected subset and swaps the entire generation atomically.
    await this.catalog.replace(selected);
    if (this.stopping || this.client !== client) return;
    this.snapshot = {
      id: this.config.id,
      origin: this.snapshot.origin,
      state: 'ready',
      toolCount: selected.length,
    };
    this.failures = 0;
  }

  private async connect(credential: ResolvedCredential | undefined): Promise<void> {
    check(!this.stopping, 'mounts_stopped', 'Mounts are stopped', 503);
    this.snapshot = { ...this.snapshot, state: 'connecting' };
    const client = new Client({ name: 'merv-mount-discovery', version: '1' });
    const controller = new AbortController();
    this.client = client;
    this.discoveryAbort = controller;
    this.discoveryIdentity = credential?.identityKey;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      if (!this.stopping && this.client === client) void this.refresh().catch(() => undefined);
    });
    client.onclose = () => {
      if (this.stopping || this.client !== client) return;
      this.client = undefined;
      controller.abort(new MervError('mount_disconnected', 'Discovery connection closed', 503));
      this.failed(new MervError('mount_disconnected', 'Discovery connection closed', 503));
      if (!this.current) this.schedule();
    };
    const transport = new StreamableHTTPClientTransport(new URL(this.config.url), {
      ...(credential ? { requestInit: { headers: { ...credential.headers() } } } : {}),
      fetch: async (address, init) => {
        const lifetime = [controller.signal, ...(init?.signal ? [init.signal] : [])];
        if (init?.method?.toUpperCase() !== 'GET')
          return fetch(address, {
            ...init,
            signal: AbortSignal.any([...lifetime, AbortSignal.timeout(this.timeoutMs)]),
          });
        // Bound opening the notification stream, not its lifetime. Timing out an
        // established SSE body creates gaps that can permanently lose notifications.
        const opening = new AbortController();
        const timer = setTimeout(() => opening.abort(), this.timeoutMs);
        try {
          return await fetch(address, {
            ...init,
            signal: AbortSignal.any([...lifetime, opening.signal]),
          });
        } finally {
          clearTimeout(timer);
        }
      },
    });
    try {
      await bounded(
        client.connect(transport, { timeout: this.timeoutMs, maxTotalTimeout: this.timeoutMs }),
        this.timeoutMs,
      );
      check(
        !this.stopping && this.client === client,
        'mount_disconnected',
        'Discovery connection changed',
        503,
      );
    } catch (error) {
      if (this.client === client) this.client = undefined;
      controller.abort();
      await this.closeClient(client).catch(() => undefined);
      throw error;
    }
  }

  private failed(error: unknown): void {
    this.failures++;
    this.snapshot = {
      ...this.snapshot,
      state:
        this.snapshot.state === 'ready' || this.snapshot.state === 'disconnected'
          ? 'disconnected'
          : 'failed',
      toolCount: 0,
      errorCode: safeCode(error),
    };
    // Withdrawal starts now. A held call must not delay status updates or reconnect scheduling.
    const drain = this.catalog.replace([]).catch(() => undefined);
    this.drains.add(drain);
    void drain.finally(() => this.drains.delete(drain));
    if (this.client) {
      const cleanup = this.resetDiscovery().catch(() => undefined);
      this.drains.add(cleanup);
      void cleanup.finally(() => this.drains.delete(cleanup));
    }
  }

  private async resetDiscovery(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.discoveryIdentity = undefined;
    this.discoveryAbort?.abort();
    this.discoveryAbort = undefined;
    if (client) await this.closeClient(client);
  }
  private async closeClient(client: Client): Promise<void> {
    try {
      await bounded(client.close(), this.timeoutMs);
    } catch {
      this.cleanupFailed = true;
      throw new MervError('mount_cleanup_failed', 'Discovery resource cleanup failed', 503);
    }
  }
  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
  private schedule(): void {
    this.clearTimer();
    if (this.stopping) return;
    const delay = Math.min(this.reconnectMs * 2 ** Math.min(this.failures, 6), 60000);
    this.timer = setTimeout(() => {
      void this.refresh().catch(() => undefined);
    }, delay);
    this.timer.unref();
  }

  stop(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopping = true;
    this.clearTimer();
    this.discoveryAbort?.abort(new MervError('mounts_stopped', 'Mounts are stopped', 503));
    this.snapshot = {
      id: this.config.id,
      origin: this.snapshot.origin,
      state: 'stopped',
      toolCount: 0,
    };
    const withdrawal = this.catalog.dispose();
    this.closing = (async () => {
      await Promise.allSettled([
        withdrawal,
        ...(this.current ? [this.current] : []),
        ...this.drains,
      ]);
      const results = await Promise.allSettled([this.pool.close(), this.resetDiscovery()]);
      if (this.cleanupFailed || results.some((result) => result.status === 'rejected')) {
        this.snapshot = { ...this.snapshot, state: 'failed', errorCode: 'mount_cleanup_failed' };
        throw new MervError('mount_cleanup_failed', 'Mount resource cleanup failed', 503);
      }
    })();
    return this.closing;
  }
}

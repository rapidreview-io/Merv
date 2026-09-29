import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { check, MervError } from '@merv/contracts';
import type { Tools, ToolCatalog, RemoteToolDefinition } from '@merv/api/types';
import type { CredentialProvider, ResolvedCredential } from './types.js';
import type { ToolPolicy } from '@merv/contracts';
import type { MountConfig, MountStatus } from './types.js';
import { collectRemoteCatalog } from './remote-catalog.js';
import { connectUpstream, endUpstream, ScopedRemoteClients } from './upstream.js';

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

/** One dedicated discovery session; invocation connections are separately scoped by the pool. */
export class MountRuntime {
  private readonly catalog: ToolCatalog;
  private readonly pool: ScopedRemoteClients;
  private readonly timeoutMs: number;
  private readonly reconnectMs: number;
  private snapshot: MountStatus;
  /** JSON of the descriptions now in the registry; a key-order change only republishes. */
  private published?: string;
  private client?: Client;
  private discoveryIdentity?: string;
  /** The running refresh's stop signal: only stop() aborts it, and only while that refresh runs. */
  private discoveryAbort?: AbortController;
  private current?: Promise<void>;
  private forceNext = false;
  private refreshAgain = false;
  private failures = 0;
  private timer?: Awaited<ReturnType<typeof setTimeout>>;
  private readonly drains = new Set<Promise<void>>();
  private stopping = false;
  private closing?: Promise<void>;

  constructor(
    tools: Tools,
    private readonly credentials: CredentialProvider,
    private readonly access: ToolPolicy,
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
    this.pool = new ScopedRemoteClients(
      credentials,
      access,
      { mountId: config.id, url: config.url, timeoutMs: this.timeoutMs },
      tools,
    );
    this.catalog = tools.createCatalog(config.id);
  }

  status(): MountStatus {
    return { ...this.snapshot };
  }

  refresh(force = false): Promise<void> {
    if (this.stopping)
      return Promise.reject(new MervError('mounts_stopped', 'Mounts are stopped', 503));
    if (force && this.current)
      return this.current.catch(() => undefined).then(async () => this.refresh(true));
    this.clearTimer();
    if (force) this.forceNext = true;
    else this.refreshAgain = true;
    if (this.current) return this.current;
    const round = new AbortController();
    this.discoveryAbort = round;
    const operation = Promise.resolve()
      .then(async () => {
        let rounds = 0;
        do {
          rounds++;
          const reconnect = this.forceNext;
          this.forceNext = false;
          this.refreshAgain = false;
          if (reconnect) await this.resetDiscovery();
          await this.refreshOnce(round.signal);
          // Continuous notifications cannot keep optional startup or one explicit refresh open forever.
        } while (!this.stopping && rounds < 2 && (this.forceNext || this.refreshAgain));
      })
      .catch((error: unknown) => {
        if (!this.stopping) this.failed(error);
        throw new MervError(safeCode(error), 'Mount catalog is unavailable', 503);
      })
      .finally(() => {
        this.current = undefined;
        this.discoveryAbort = undefined;
        this.schedule();
      });
    this.current = operation;
    return operation;
  }

  private async credential(): Promise<ResolvedCredential | undefined> {
    if (!this.config.discovery) return undefined;
    // Discovery has its own configured actor. Its grants and credential never authorize calls.
    for (const name of this.config.tools)
      await this.access.require(this.config.discovery, this.config.id, name);
    return await this.credentials.resolve(this.config.discovery, this.config.id);
  }

  private async refreshOnce(signal: AbortSignal): Promise<void> {
    check(!this.stopping, 'mounts_stopped', 'Mounts are stopped', 503);
    const credential = await this.credential();
    if (this.client && this.discoveryIdentity !== credential?.identityKey)
      await this.resetDiscovery();
    if (!this.client) await this.connect(credential, signal);
    const client = this.client!;
    const definitions = await collectRemoteCatalog(client, { timeoutMs: this.timeoutMs, signal });
    check(
      !this.stopping && this.client === client,
      'mount_disconnected',
      'Discovery connection changed',
      503,
    );
    // Credentials can change while discovery yields; do not publish a catalog using revoked authority.
    check(
      (await this.credential())?.identityKey === this.discoveryIdentity,
      'credential_changed',
      'Discovery credential changed',
      409,
    );
    check(
      !this.stopping && this.client === client,
      'mount_disconnected',
      'Discovery connection changed',
      503,
    );
    const available = new Map(definitions.map((definition) => [definition.name, definition]));
    const selected: RemoteToolDefinition[] = this.config.tools.map((name) => {
      const definition = available.get(name);
      check(definition, 'mount_missing_tool', 'A selected remote tool is missing', 502);
      return {
        ...definition,
        kind: 'mcp',
        // Every call selects its own authority; discovery's credential never invokes tools.
        handler: async (caller, input) => this.pool.call(caller, this.config.id, name, input),
      };
    });
    // Registry compilation only sees the selected subset and swaps the entire generation atomically.
    // An unchanged catalog is not replaced: no schema compile, and no drain of admitted calls.
    const next = JSON.stringify(selected); // handlers are functions: stringify drops them
    if (next !== this.published) {
      await this.catalog.replace(selected);
      this.published = next;
    }
    if (this.stopping || this.client !== client) return;
    this.snapshot = {
      id: this.config.id,
      origin: this.snapshot.origin,
      state: 'ready',
      toolCount: selected.length,
    };
    this.failures = 0;
  }

  private async connect(
    credential: ResolvedCredential | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    check(!this.stopping, 'mounts_stopped', 'Mounts are stopped', 503);
    this.snapshot = { ...this.snapshot, state: 'connecting' };
    const client = await connectUpstream(
      this.config.url,
      credential && { ...credential.headers() },
      this.timeoutMs,
      {
        signal,
        notifications: (discovery) =>
          discovery.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
            if (!this.stopping && this.client === discovery)
              void this.refresh().catch(() => undefined);
          }),
      },
    );
    if (this.stopping) {
      await endUpstream(client); // a connect that finished during stop still gets its DELETE
      throw new MervError('mounts_stopped', 'Mounts are stopped', 503);
    }
    this.client = client;
    this.discoveryIdentity = credential?.identityKey;
  }

  private failed(error: unknown): void {
    this.failures++;
    this.published = undefined; // the replace([]) below withdraws it
    this.snapshot = {
      ...this.snapshot,
      state: this.snapshot.state === 'ready' ? 'disconnected' : 'failed',
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
    // Ending the client rejects its in-flight requests; the refresh signal is stop()'s alone.
    if (client) await endUpstream(client);
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

  async stop(): Promise<void> {
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
      await Promise.all([this.pool.close(), this.resetDiscovery()]);
    })();
    return this.closing;
  }
}

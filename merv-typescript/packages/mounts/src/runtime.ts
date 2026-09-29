import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Scope } from '@merv/contracts';
import type { Tools, ToolCatalog, RemoteToolDefinition } from '@merv/api/types';
import type { Bindings } from './credentials.js';
import type { MountConfig, MountStatus } from './types.js';
import { collectRemoteCatalog } from './remote-catalog.js';
import { connectUpstream, endUpstream, fault, Invocations } from './upstream.js';

/** One dedicated discovery session; each caller's invocations use its own connection in the pool. */
export class MountRuntime {
  readonly #catalog: ToolCatalog;
  readonly #pool: Invocations;
  readonly #timeoutMs: number;
  #status: MountStatus;
  /** JSON of the descriptions now in the registry; a key-order change only republishes. */
  #published?: string;
  #client?: Client;
  #running?: Promise<void>;
  /** The running round's stop signal: only stop() aborts it, and only while that round runs. */
  #round?: AbortController;
  #again = false; // a trigger during a round reruns it once
  #stopped = false;
  #timer?: NodeJS.Timeout;
  #ending: Promise<unknown> = Promise.resolve(); // every discovery DELETE; stop() awaits it

  constructor(
    tools: Tools,
    private readonly bindings: Pick<Bindings, 'select' | 'headers'>,
    private readonly scope: Pick<Scope, 'require' | 'toolPolicy'>,
    private readonly config: MountConfig,
  ) {
    const timeoutMs = (this.#timeoutMs = config.timeoutMs ?? 5000);
    const origin = new URL(config.url).origin;
    this.#status = { id: config.id, origin, state: 'connecting', toolCount: 0 };
    this.#pool = new Invocations({ ...config, timeoutMs }, bindings, scope.toolPolicy, tools);
    this.#catalog = tools.createCatalog(config.id);
  }

  status(): MountStatus {
    return { ...this.#status };
  }

  /** Start, the timer and list_changed share one round at a time; status() reports its outcome. */
  refresh(): void {
    if (this.#stopped) return;
    if (this.#running) {
      this.#again = true;
      return;
    }
    clearTimeout(this.#timer);
    const round = (this.#round = new AbortController());
    this.#running = this.round(round.signal)
      .catch((error: unknown) => this.failed(error))
      .finally(() => {
        const again = this.#again;
        this.#running = this.#round = undefined;
        this.#again = false;
        if (again) this.refresh();
        else if (!this.#stopped)
          this.#timer = setTimeout(() => this.refresh(), this.config.reconnectMs ?? 60_000).unref();
      });
  }

  private async round(signal: AbortSignal): Promise<void> {
    // The discovery actor's credential is used only while that actor may read the project.
    if (this.config.discovery) await this.scope.require(this.config.discovery, 'read');
    this.#client ??= await this.connect(signal);
    const found = await collectRemoteCatalog(this.#client, new Set(this.config.tools), {
      signal,
      timeout: this.#timeoutMs,
    });
    // The selected tools the upstream offers now; a missing one is withdrawn alone.
    const selected: RemoteToolDefinition[] = this.config.tools.flatMap((name) => {
      const definition = found.get(name);
      return definition ? [{ ...definition, kind: 'mcp', handler: this.#pool.handler(name) }] : [];
    });
    // Registry compilation sees only the selected subset and swaps the whole generation atomically.
    // An unchanged catalog is not replaced: no schema compile, and no drain of admitted calls.
    const next = JSON.stringify(selected); // handlers are functions: stringify drops them
    if (next !== this.#published) {
      await this.#catalog.replace(selected);
      this.#published = next;
    }
    if (this.#stopped) return; // a round finishing after stop() never overwrites 'stopped'
    const missing = selected.length < this.config.tools.length;
    this.#set('ready', selected.length, missing ? 'mount_missing_tool' : undefined);
  }

  /** Discovery lists metadata only; its binding never carries a call (handlers use the pool). */
  private async connect(signal: AbortSignal): Promise<Client> {
    const { discovery } = this.config;
    const binding = discovery && (await this.bindings.select(discovery, this.config.id));
    const headers = binding && (await this.bindings.headers(binding));
    const notifications = (client: Client) =>
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => this.refresh());
    return connectUpstream(this.config.url, headers, this.#timeoutMs, { signal, notifications });
  }

  /** Published tools stay; each call reports its own failure. */
  private failed(error: unknown): void {
    if (this.#stopped) return;
    const state = this.#published === undefined ? 'failed' : 'disconnected';
    this.#set(state, this.#status.toolCount, fault(error).code);
    this.#end();
  }

  /** Ends the discovery session, if any; stop() awaits every such DELETE. */
  #end(): void {
    this.#ending = Promise.all([this.#ending, this.#client && endUpstream(this.#client)]);
    this.#client = undefined;
  }

  /** Never rejects. */
  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#set('stopped', 0);
    const withdrawn = this.#catalog.dispose(); // withdraws before its first await
    this.#round?.abort(); // cuts a connect or list short
    await this.#running; // never rejects; a pending replace() drains admitted calls, each bounded
    this.#end(); // a connect that finished during stop still gets its DELETE
    await Promise.all([withdrawn.then(() => this.#pool.close()), this.#ending]);
  }

  #set(state: MountStatus['state'], toolCount: number, errorCode?: string): void {
    const { id, origin } = this.#status;
    this.#status = { id, origin, state, toolCount, ...(errorCode && { errorCode }) };
  }
}

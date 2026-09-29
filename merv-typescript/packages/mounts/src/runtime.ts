import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { check, type Scope } from '@merv/contracts';
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
  readonly #reconnectMs: number;
  readonly #wanted: ReadonlySet<string>;
  #status: MountStatus;
  /** JSON of the descriptions now in the registry; a key-order change only republishes. */
  #published?: string;
  #client?: Client;
  #running?: Promise<void>;
  /** The running round's stop signal: only stop() aborts it, and only while that round runs. */
  #round?: AbortController;
  /** A trigger during a round reruns it once. */
  #again = false;
  #failures = 0;
  #stopped = false;
  #timer?: NodeJS.Timeout;
  /** Every withdrawal and discovery DELETE a failed round started; stop() awaits it. */
  #ending: Promise<unknown> = Promise.resolve();

  constructor(
    tools: Tools,
    private readonly bindings: Pick<Bindings, 'select' | 'headers'>,
    private readonly scope: Pick<Scope, 'require' | 'toolPolicy'>,
    private readonly config: MountConfig,
  ) {
    this.#timeoutMs = config.timeoutMs ?? 5000;
    this.#reconnectMs = config.reconnectMs ?? 1000;
    this.#wanted = new Set(config.tools);
    this.#status = {
      id: config.id,
      origin: new URL(config.url).origin,
      state: 'connecting',
      toolCount: 0,
    };
    this.#pool = new Invocations(
      { id: config.id, url: config.url, timeoutMs: this.#timeoutMs },
      bindings,
      scope.toolPolicy,
      tools,
    );
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
        this.#running = this.#round = undefined;
        if (this.#again) {
          this.#again = false;
          this.refresh();
        } else if (!this.#stopped) this.schedule();
      });
  }

  private async round(signal: AbortSignal): Promise<void> {
    // The discovery actor's credential is used only while that actor may read the project.
    if (this.config.discovery) await this.scope.require(this.config.discovery, 'read');
    this.#client ??= await this.connect(signal);
    const found = await collectRemoteCatalog(this.#client, this.#wanted, {
      signal,
      timeout: this.#timeoutMs,
    });
    const selected: RemoteToolDefinition[] = this.config.tools.map((name) => {
      const definition = found.get(name);
      check(definition, 'mount_missing_tool', 'A selected remote tool is missing', 502);
      return { ...definition, kind: 'mcp', handler: this.#pool.handler(name) };
    });
    // Registry compilation only sees the selected subset and swaps the entire generation atomically.
    // An unchanged catalog is not replaced: no schema compile, and no drain of admitted calls.
    const next = JSON.stringify(selected); // handlers are functions: stringify drops them
    if (next !== this.#published) {
      await this.#catalog.replace(selected);
      this.#published = next;
    }
    if (this.#stopped) return; // a round finishing after stop() never overwrites 'stopped'
    this.#failures = 0;
    this.#set('ready', selected.length);
  }

  /** Discovery lists metadata only; its binding never carries a call (handlers use the pool). */
  private async connect(signal: AbortSignal): Promise<Client> {
    const discovery = this.config.discovery;
    const headers =
      discovery &&
      (await this.bindings.headers(await this.bindings.select(discovery, this.config.id)));
    return await connectUpstream(this.config.url, headers, this.#timeoutMs, {
      signal,
      notifications: (client) =>
        client.setNotificationHandler(ToolListChangedNotificationSchema, async () =>
          this.refresh(),
        ),
    });
  }

  private failed(error: unknown): void {
    if (this.#stopped) return;
    this.#failures++;
    this.#published = undefined; // the replace([]) below withdraws it
    this.#set(this.#status.state === 'ready' ? 'disconnected' : 'failed', 0, fault(error).code);
    // Withdrawal starts now. A held call must not delay status updates or reconnect scheduling.
    const withdrawn = this.#catalog.replace([]).catch(() => undefined);
    const client = this.#client;
    this.#client = undefined;
    const ended = client && endUpstream(client);
    this.#ending = this.#ending.then(() => Promise.all([withdrawn, ended]));
  }

  private schedule(): void {
    const delay = Math.min(this.#reconnectMs * 2 ** Math.min(this.#failures, 6), 60000);
    (this.#timer = setTimeout(() => this.refresh(), delay)).unref();
  }

  /** Never rejects. */
  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#set('stopped', 0);
    const withdrawn = this.#catalog.dispose(); // withdraws before its first await
    this.#round?.abort(); // cuts a connect or list short
    // Never rejects. A pending replace() drain waits for admitted calls, each bounded by its own
    // requests.
    await this.#running;
    // A connect that finished during stop still gets its DELETE.
    const client = this.#client;
    this.#client = undefined;
    await Promise.all([
      withdrawn.then(() => this.#pool.close()),
      client && endUpstream(client),
      this.#ending,
    ]);
  }

  #set(state: MountStatus['state'], toolCount: number, errorCode?: string): void {
    this.#status = {
      id: this.config.id,
      origin: this.#status.origin,
      state,
      toolCount,
      ...(errorCode && { errorCode }),
    };
  }
}

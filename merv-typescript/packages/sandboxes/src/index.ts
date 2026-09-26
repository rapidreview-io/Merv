import { AsyncResource } from 'node:async_hooks';
import {
  check,
  digest,
  idSchema,
  type Caller,
  type Json,
  type UiManifestRow,
} from '@merv/contracts';
import type { Context } from 'cordis';
import { z } from 'zod';
import { SandboxClient, sandboxRoute } from './client.js';
import { parseManifest } from './manifest.js';
import { machinesRoute } from './running.js';
import { SandboxCheckRunner } from './checks.js';
import { runtimeOffer, SandboxRuntimeRunner } from './runtimes.js';
import type {
  Sandboxes,
  SandboxCheckHandle,
  SandboxChecks,
  SandboxCheckPlan,
  SandboxCheckSpec,
  SandboxCheckVerdict,
  SandboxConnection,
  SandboxesConfig,
  SandboxExtend,
  SandboxMachines,
  SandboxReadiness,
  SandboxRow,
  SandboxTarget,
  SandboxRuntimes,
  SandboxCompute,
} from './types.js';
import { SandboxComputeAdapter } from './compute.js';
import { SandboxArtifactStorage } from './artifact-storage.js';

export type {
  Sandboxes,
  SandboxCheckHandle,
  SandboxChecks,
  SandboxCheckPlan,
  SandboxCheckSpec,
  SandboxCheckVerdict,
  SandboxConnection,
  SandboxesConfig,
  SandboxExtend,
  SandboxMachines,
  SandboxReadiness,
  SandboxRow,
  SandboxTarget,
  SandboxRuntimeProfile,
  SandboxRuntimeProfileRef,
  SandboxRuntimeOffer,
  SandboxRuntimeState,
  SandboxRuntimeLaunch,
  SandboxRuntimeHandle,
  SandboxRuntimes,
} from './types.js';
export { checkScript } from './checks.js';
export { sandboxTools } from './manifest.js';

/** The service's own lifecycle routes, the only ones a tool ever calls. */
const sandboxRecord = '/v1/sandboxes/{id}';
const renewRoute = '/v1/sandboxes/{id}/renew';

/**
 * The machines cache's clocks. The list is read every 5 s while a machine or its job is
 * changing and every 30 s otherwise; a watched record every 8 s. A project stops being read
 * a minute after the last page that watched it, and the one timer checks all of it each second.
 */
const MACHINES_CHANGING_MS = 5000;
const MACHINES_SETTLED_MS = 30_000;
const MACHINE_RECORD_MS = 8000;
const MACHINES_DEMAND_MS = 60_000;
const MACHINES_TICK_MS = 1000;
/** Records read per project at once: the panels open on it, never an arbitrary set of ids. */
const MACHINE_RECORDS = 16;
const changingStates = new Set(['provisioning', 'deleting', 'unknown']);
const changingJobs = new Set(['running', 'starting']);
interface MachineRecord {
  watchedAt: number;
  attemptedAt: number;
  reading?: Promise<void>;
  value: Json | null;
}
interface MachineCache {
  watchedAt: number;
  attemptedAt: number;
  reading?: Promise<void>;
  observedAt: string | null;
  rows: Json[];
  failed: boolean;
  records: Map<string, MachineRecord>;
}
const field = (value: Json, name: string): unknown =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value[name] : undefined;
/** A machine or its job is on the move, so its row will say something new within seconds. */
const changing = (row: Json) =>
  changingStates.has(String(field(row, 'state'))) ||
  changingJobs.has(String(field(field(row, 'activity') as Json, 'verdict')));
/** A failed read is retried at the fast cadence; an answer sets the cadence by what it holds. */
const cadence = (cache: MachineCache) =>
  cache.failed || cache.rows.some(changing) ? MACHINES_CHANGING_MS : MACHINES_SETTLED_MS;
/** The list answers an array, or one object holding it under the collection's plural noun. */
function machineRows(value: Json): Json[] {
  const list = Array.isArray(value)
    ? value
    : value !== null && typeof value === 'object'
      ? Object.values(value).find(Array.isArray)
      : undefined;
  check(list, 'sandbox_unavailable', 'merv-sandboxes answered no machine list', 502);
  return list.filter((row) => typeof field(row, 'id') === 'string');
}

const connection = z
  .object({
    projectId: idSchema,
    namespace: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/),
    // Only the name of an environment variable: a secret never enters configuration.
    tokenEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
  })
  .strict();
const configuration = z
  .object({
    urlEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
    connections: z
      .array(connection)
      .min(1)
      .max(256)
      .refine(
        (entries) => new Set(entries.map((entry) => entry.projectId)).size === entries.length,
        'Each project has at most one sandbox connection',
      ),
    refreshMs: z.number().int().min(1000).max(3_600_000).default(300_000),
    timeoutMs: z.number().int().min(100).max(60_000).default(15_000),
    storageOrigins: z.array(z.string().min(1).max(512)).max(8).default([]),
    ml: z
      .object({
        namespace: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/),
        tokenEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
        since: z.string().datetime({ offset: true }),
        storageOrigins: z.array(z.string().url()).max(1),
      })
      .strict()
      .optional(),
    runtimes: z
      .array(
        z
          .object({
            key: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
            provider: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
            offerId: z.string().min(1).max(256),
            releaseId: z.string().regex(/^rt1_[0-9a-f]{64}$/),
            leaseSeconds: z.number().int().min(60).max(86_400),
            ttlSeconds: z.number().int().min(1).max(3600).default(300),
          })
          .strict(),
      )
      .min(1)
      .max(8)
      .refine((all) => new Set(all.map((p) => p.key)).size === all.length, 'Profile keys repeat')
      .optional(),
  })
  .strict();

const secretNames = new Set(['token', 'secret', 'authorization', 'credential']);
/** A hosted agent's machine belongs to Fleet: no project row lists it and no tool acts on it. */
const hosted = (value: Json) =>
  (value as { request?: { protected_runtime?: unknown } } | null)?.request?.protected_runtime ===
  true;
/** What a project may see of the service's JSON: nothing named like a credential, at any depth,
 * and no hosted agent's machine in any list. */
export function visible(value: Json, depth = 0): Json {
  if (depth > 64) return null;
  if (Array.isArray(value))
    return value.filter((entry) => !hosted(entry)).map((entry) => visible(entry, depth + 1));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !secretNames.has(key.toLowerCase()))
      .map(([key, entry]) => [key, visible(entry, depth + 1)]),
  );
}

const toRow = (row: UiManifestRow): SandboxRow => ({
  id: `sandboxes-${row.id}`,
  label: row.label,
  group: row.group,
  order: row.order,
  path: `/${row.id}`,
  view: {
    kind: 'collection',
    icon: row.icon ?? null,
    spec: row.collection as Json,
    record: (row.record ?? null) as Json,
  },
});

/**
 * Rows a service outside this process publishes. The manifest says what each row holds; this
 * registers those rows and proxies their reads with the caller's own project credentials.
 * Nothing is stored: the last accepted manifest is the whole state, and it survives an
 * unreachable service so the row degrades instead of disappearing. The one other thing held,
 * in memory only, is what the Running page draws: each watched project's machines and the
 * records its open panels ask for, read on this service's own timer, never inside a request.
 */
export class SandboxService implements Sandboxes {
  readonly #client: SandboxClient;
  readonly #connections: SandboxConnection[];
  readonly #refreshMs: number;
  readonly #listeners = new Set<() => void>();
  #specs = new Map<string, UiManifestRow>();
  #rows: SandboxRow[] = [];
  #digest = '';
  #reachable = false;
  #detail = 'The sandboxes manifest has not been read yet';
  #reading?: Promise<void>;
  #timer?: ReturnType<typeof setInterval>;
  #closed = false;
  #closing?: Promise<void>;
  readonly #running = new Set<Promise<unknown>>();
  readonly #offers = new Map<string, { at: number; value?: Json; reading?: Promise<Json> }>();
  readonly #machines = new Map<string, MachineCache>();
  #machinesTimer?: ReturnType<typeof setInterval>;
  /** The machines timer never inherits a caller's database scope: the first watch is a read's. */
  readonly #detached = AsyncResource.bind((fn: () => void) => fn());
  /**
   * Present only where the deployment named the bucket origins a check's source may be
   * uploaded to, so a project check is opt-in per deployment rather than per request.
   */
  readonly checks?: SandboxChecks;
  readonly runtimes?: SandboxRuntimes;
  readonly compute?: SandboxCompute;

  constructor(config: SandboxesConfig) {
    const parsed = configuration.safeParse(config);
    check(parsed.success, 'invalid_sandboxes_config', 'The sandboxes configuration is invalid');
    this.#connections = parsed.data.connections;
    this.#refreshMs = parsed.data.refreshMs;
    this.#client = new SandboxClient(
      process.env[parsed.data.urlEnv],
      parsed.data.timeoutMs,
      parsed.data.storageOrigins,
    );
    if (parsed.data.ml) {
      const adapter = new SandboxComputeAdapter(
        this.#client.origin,
        parsed.data.timeoutMs,
        parsed.data.refreshMs,
        parsed.data.ml,
      );
      this.compute = {
        since: adapter.since,
        offers: (projectId) => this.#run(projectId, (id) => adapter.offers(id)),
        allowance: (projectId) => this.#run(projectId, (id) => adapter.allowance(id)),
        submit: (projectId, spec) =>
          this.#run({ projectId, spec }, ({ projectId, spec }) => adapter.submit(projectId, spec)),
        get: (projectId, runId) =>
          this.#run({ projectId, runId }, ({ projectId, runId }) => adapter.get(projectId, runId)),
        cancel: (projectId, runId) =>
          this.#run({ projectId, runId }, ({ projectId, runId }) =>
            adapter.cancel(projectId, runId),
          ),
      };
    }
    if (parsed.data.storageOrigins.length) {
      const runner = new SandboxCheckRunner(this.#client, (projectId) =>
        this.#connectionFor(projectId),
      );
      // Every call joins the same drain as a tool's, so closing waits for a check's step
      // instead of abandoning a half-created machine.
      this.checks = {
        start: (projectId, spec) => this.#run(spec, (spec) => runner.start(projectId, spec)),
        step: (projectId, plan, handle) =>
          this.#run(handle, (handle) => runner.step(projectId, plan, handle)),
        follow: (projectId, handle) =>
          this.#run(handle, (handle) => runner.follow(projectId, handle)),
        release: (projectId, handle) =>
          this.#run(handle, (handle) => runner.release(projectId, handle)),
      };
    }
    if (parsed.data.runtimes) {
      const profiles = parsed.data.runtimes.map((profile) => ({
        profile,
        runner: new SandboxRuntimeRunner(
          this.#client,
          (projectId) => this.#connectionFor(projectId),
          profile,
        ),
      }));
      // Inspect, acknowledge and stop read the machine as it is; they need no profile.
      const { runner } = profiles[0];
      /** Provision, launch and renew speak for one profile; none named means the default. */
      const profiled = (profileId = runner.profileId) => {
        const found = profiles.find((entry) => entry.runner.profileId === profileId);
        check(
          found,
          'sandbox_runtime_profile_unknown',
          'The runtime profile is not configured',
          404,
        );
        return found.runner;
      };
      this.runtimes = {
        profiles: profiles.map((entry) => ({
          key: entry.profile.key,
          id: entry.runner.profileId,
          leaseSeconds: entry.profile.leaseSeconds,
        })),
        describe: async (projectId, key) => {
          const found = profiles.find((entry) => entry.profile.key === key);
          return found ? runtimeOffer(await this.#options(projectId), key, found.profile) : null;
        },
        connected: (projectId) =>
          this.#connections.some(
            (entry) => entry.projectId === projectId && this.#client.configured(entry),
          ),
        provision: (projectId, operationKey, profileId) =>
          this.#run(
            { projectId, operationKey, profileId },
            ({ projectId, operationKey, profileId }) =>
              profiled(profileId).provision(projectId, operationKey),
          ),
        inspect: (projectId, handle) =>
          this.#run({ projectId, handle }, ({ projectId, handle }) =>
            runner.inspect(projectId, handle),
          ),
        launch: (projectId, handle, operationKey, bootstrap, profileId) =>
          this.#run(
            { projectId, handle, operationKey, bootstrap, profileId },
            ({ projectId, handle, operationKey, bootstrap, profileId }) =>
              profiled(profileId).launch(projectId, handle, operationKey, bootstrap),
          ),
        acknowledge: (projectId, handle) =>
          this.#run({ projectId, handle }, ({ projectId, handle }) =>
            runner.acknowledge(projectId, handle),
          ),
        stop: (projectId, handle) =>
          this.#run({ projectId, handle }, ({ projectId, handle }) =>
            runner.stop(projectId, handle),
          ),
        renew: (projectId, handle, profileId) =>
          this.#run({ projectId, handle, profileId }, ({ projectId, handle, profileId }) =>
            profiled(profileId).renew(projectId, handle),
          ),
      };
    }
  }

  /** GET /v1/options at most once per refresh period for each project. Once a project has an
   * answer it is served at once while an older one refreshes behind it, since Pi describes
   * machines inside writer transactions. A failed read keeps the answer (none hides every machine)
   * and the next call reads again. */
  #options(projectId: string): Promise<Json> {
    const entry = this.#offers.get(projectId) ?? { at: 0 };
    this.#offers.set(projectId, entry);
    if (!entry.reading && Date.now() - entry.at >= this.#refreshMs)
      entry.reading = this.#run(projectId, (projectId) =>
        this.#client.read(this.#connectionFor(projectId), '/v1/options'),
      )
        .then((value) => Object.assign(entry, { at: Date.now(), value }).value)
        .catch(() => entry.value ?? null)
        .finally(() => (entry.reading = undefined));
    return 'value' in entry ? Promise.resolve(entry.value!) : entry.reading!;
  }

  /** Reads the manifest on a bounded cadence; disposal retires and drains this instance. */
  start(): () => Promise<void> {
    check(!this.#closed, 'sandboxes_closed', 'The sandboxes service is closed', 503);
    if (!this.#timer) {
      this.#timer = setInterval(() => void this.refresh().catch(() => undefined), this.#refreshMs);
      this.#timer.unref();
      void this.refresh().catch(() => undefined);
    }
    return () => this.close();
  }

  /** Stop admission immediately; let already admitted operations finish their full protocol. */
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    clearInterval(this.#timer);
    this.#timer = undefined;
    clearInterval(this.#machinesTimer);
    this.#machinesTimer = undefined;
    this.#machines.clear();
    this.#listeners.clear();
    this.#reachable = false;
    this.#detail = 'The sandboxes service is closed';
    this.#closing = (async () => {
      await Promise.allSettled([...this.#running]);
      this.#rows = [];
      this.#specs.clear();
    })();
    return this.#closing;
  }

  async #run<Input, T>(input: Input, operation: (input: Input) => Promise<T>): Promise<T> {
    check(!this.#closed, 'sandboxes_closed', 'The sandboxes service is closed', 503);
    const snapshot = structuredClone(input);
    const pending = Promise.resolve().then(() => operation(snapshot));
    this.#running.add(pending);
    try {
      return await pending;
    } finally {
      this.#running.delete(pending);
    }
  }

  rows(): SandboxRow[] {
    return this.#rows;
  }

  status(): SandboxReadiness {
    return this.#reachable ? { state: 'ready' } : { state: 'degraded', detail: this.#detail };
  }

  subscribe(listener: () => void): () => void {
    check(!this.#closed, 'sandboxes_closed', 'The sandboxes service is closed', 503);
    const registered = () => listener();
    this.#listeners.add(registered);
    return () => {
      this.#listeners.delete(registered);
    };
  }

  /** The cadence and an on-demand caller share one attempt rather than stampeding. */
  refresh(): Promise<void> {
    if (this.#closed) return this.#run(undefined, async () => {});
    this.#reading ??= this.#run(undefined, () => this.#read()).finally(
      () => (this.#reading = undefined),
    );
    return this.#reading;
  }

  async #read(): Promise<void> {
    const collected = new Map<string, UiManifestRow>();
    let reached = false;
    let detail = 'merv-sandboxes is unreachable';
    for (const entry of this.#connections) {
      if (this.#closed) return;
      try {
        const manifest = await this.#client.read(entry, '/v1/ui/manifest');
        // Every connection is the same service, so identical row ids describe one row.
        for (const row of parseManifest(manifest))
          if (!collected.has(row.id)) collected.set(row.id, row);
        reached = true;
      } catch (error) {
        detail = error instanceof Error ? error.message : detail;
      }
    }
    if (this.#closed) return;
    if (!reached) {
      // Keep the last manifest: the row reports degraded rather than vanishing.
      this.#reachable = false;
      this.#detail = detail;
      return;
    }
    this.#reachable = true;
    const rows = [...collected.values()].map(toRow);
    const fingerprint = digest(rows);
    if (fingerprint === this.#digest) return;
    this.#digest = fingerprint;
    this.#rows = rows;
    this.#specs = new Map([...collected].map(([id, row]) => [`sandboxes-${id}`, row]));
    for (const listener of this.#listeners) listener();
  }

  /**
   * The namespace follows the caller's own project; input never selects a connection.
   * Server-owned work has no caller, and still speaks only as the project it works for.
   */
  #connectionFor(projectId: string): SandboxConnection {
    const entry = this.#connections.find((candidate) => candidate.projectId === projectId);
    check(entry, 'sandbox_not_connected', 'This project has no sandbox connection', 403);
    return entry;
  }

  async #record(entry: SandboxConnection, path: string): Promise<Json> {
    const record = await this.#client.read(entry, path);
    check(!hosted(record), 'sandbox_protected', 'This machine belongs to a hosted agent', 403);
    return record;
  }

  async extend(caller: Caller, input: SandboxExtend): Promise<Json> {
    return this.#run({ caller, input }, async ({ caller, input }) => {
      const entry = this.#connectionFor(caller.projectId);
      // A renewal is a total, not an increment: the service sets the lease to now + lease_seconds.
      // Carry the remaining lifetime and its revision together: the service must refuse a
      // stale calculation rather than shortening a lease another client just extended.
      // The service publishes no maximum, so an over-long total is its refusal to give, not ours.
      const record = (await this.#record(entry, sandboxRoute(sandboxRecord, input.id))) as {
        lease_expires_at?: unknown;
        revision?: unknown;
      } | null;
      check(
        typeof record?.revision === 'number' &&
          Number.isSafeInteger(record.revision) &&
          record.revision >= 0,
        'sandbox_revision_unavailable',
        'The sandbox service must return a record revision for safe lease extension',
        502,
      );
      const expires = Date.parse(String(record?.lease_expires_at ?? ''));
      const left = Number.isNaN(expires)
        ? 0
        : Math.max(0, Math.ceil((expires - Date.now()) / 1000));
      return visible(
        await this.#client.write(entry, 'POST', sandboxRoute(renewRoute, input.id), {
          lease_seconds: left + input.seconds,
          expected_revision: record.revision,
        }),
      );
    });
  }

  async release(caller: Caller, input: SandboxTarget): Promise<Json> {
    return this.#run({ caller, input }, async ({ caller, input }) => {
      const entry = this.#connectionFor(caller.projectId);
      const path = sandboxRoute(sandboxRecord, input.id);
      // The guard the browser shows is the retention confirmation the legacy tool asked for in a
      // second call. Deleting an already-stopped sandbox deletes nothing twice, so the answer is
      // the record either way: releasing twice is the same as releasing once.
      await this.#record(entry, path);
      await this.#client.write(entry, 'DELETE', path, { confirm_retained: true });
      return visible(await this.#client.read(entry, path));
    });
  }

  async read(caller: Caller, rowId: string, params: Record<string, unknown> = {}): Promise<Json> {
    return this.#run({ caller, params }, async ({ caller, params }) => {
      const spec = this.#specs.get(rowId);
      check(spec, 'row_unreadable', 'That row is not published by this service', 404);
      const entry = this.#connectionFor(caller.projectId);
      // ui.read hands a row its `params`; tolerate a caller that passes the whole tool input.
      const id = params.id ?? (params.params as { id?: unknown } | undefined)?.id;
      if (id === undefined || id === null || id === '')
        return visible(await this.#client.read(entry, sandboxRoute(spec.collection.read)));
      check(typeof id === 'string', 'invalid_sandbox_id', 'A sandbox identifier must be a string');
      check(spec.record, 'sandbox_record_unavailable', 'This row publishes no record', 404);
      const record = visible(await this.#record(entry, sandboxRoute(spec.record.read, id)));
      // The manifest's console link may be a path on the service; say where that path lives.
      return record !== null && typeof record === 'object' && !Array.isArray(record)
        ? { ...record, console_origin: this.#client.origin }
        : record;
    });
  }

  machines(projectId: string): SandboxMachines | null {
    this.#connectionFor(projectId);
    const cache = this.#machines.get(projectId);
    if (!cache || (cache.observedAt === null && !cache.failed)) return null;
    return {
      observedAt: cache.observedAt,
      rows: cache.rows,
      failed: cache.failed,
      freshForMs: 2 * cadence(cache),
    };
  }

  machine(projectId: string, id: string): Json | null {
    this.#connectionFor(projectId);
    return this.#machines.get(projectId)?.records.get(id)?.value ?? null;
  }

  watch(projectId: string, id?: string): void {
    if (this.#closed || !this.#connections.some((entry) => entry.projectId === projectId)) return;
    const now = Date.now();
    if (!this.#machines.has(projectId))
      this.#machines.set(projectId, {
        watchedAt: now,
        attemptedAt: 0,
        observedAt: null,
        rows: [],
        failed: false,
        records: new Map(),
      });
    const cache = this.#machines.get(projectId)!;
    cache.watchedAt = now;
    // Only a machine the list holds gets its record read, or one a page kept watching as it
    // left the list: a caller never has this service read an id of its own choosing.
    if (id !== undefined) {
      const record = cache.records.get(id);
      if (record) record.watchedAt = now;
      else if (
        cache.records.size < MACHINE_RECORDS &&
        cache.rows.some((row) => field(row, 'id') === id)
      )
        cache.records.set(id, { watchedAt: now, attemptedAt: 0, value: null });
    }
    if (!this.#machinesTimer)
      this.#detached(
        () => (this.#machinesTimer = setInterval(() => this.#tick(), MACHINES_TICK_MS).unref()),
      );
  }

  /** One pass of the machines timer: forget what nobody watches, and start the reads now due. */
  #tick(): void {
    const now = Date.now();
    for (const [projectId, cache] of this.#machines) {
      if (now - cache.watchedAt >= MACHINES_DEMAND_MS) {
        this.#machines.delete(projectId);
        continue;
      }
      if (!cache.reading && now - cache.attemptedAt >= cadence(cache)) {
        cache.attemptedAt = now;
        cache.reading = this.#readMachines(projectId, cache).finally(
          () => (cache.reading = undefined),
        );
      }
      for (const [id, record] of cache.records) {
        if (now - record.watchedAt >= MACHINES_DEMAND_MS) cache.records.delete(id);
        else if (!record.reading && now - record.attemptedAt >= MACHINE_RECORD_MS) {
          record.attemptedAt = now;
          record.reading = this.#readMachine(projectId, id, record).finally(
            () => (record.reading = undefined),
          );
        }
      }
    }
    if (!this.#machines.size) {
      clearInterval(this.#machinesTimer);
      this.#machinesTimer = undefined;
    }
  }

  async #readMachines(projectId: string, cache: MachineCache): Promise<void> {
    try {
      const rows = await this.#run(projectId, async (projectId) =>
        machineRows(
          visible(await this.#client.read(this.#connectionFor(projectId), machinesRoute)),
        ),
      );
      Object.assign(cache, { observedAt: new Date().toISOString(), rows, failed: false });
    } catch {
      // The last rows stand, marked old: a service that did not answer is not an empty project.
      cache.failed = true;
    }
  }

  async #readMachine(projectId: string, id: string, record: MachineRecord): Promise<void> {
    try {
      record.value = visible(
        await this.#run(
          { projectId, id },
          async ({ projectId, id }) =>
            await this.#record(this.#connectionFor(projectId), sandboxRoute(sandboxRecord, id)),
        ),
      );
    } catch {
      // The last record stands; a hosted agent's machine is refused and never had one.
    }
  }
}

export const sandboxesPlugin = {
  name: 'merv-sandboxes',
  Config: configuration,
  apply(ctx: Context, config: SandboxesConfig) {
    const service = new SandboxService(config);
    if (config.ml?.storageOrigins.length) {
      ctx.inject(['artifacts'], (child) => {
        child.effect(() =>
          child.artifacts.bindLarge(
            new SandboxArtifactStorage(
              process.env[config.urlEnv]!,
              config.timeoutMs ?? 15_000,
              config.ml!,
            ),
          ),
        );
      });
    }
    ctx.effect(() => service.start());
    ctx.provide('sandboxes', service);
  },
};
export default sandboxesPlugin;

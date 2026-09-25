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
import { SandboxCheckRunner } from './checks.js';
import { SandboxRuntimeRunner } from './runtimes.js';
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
  SandboxReadiness,
  SandboxRow,
  SandboxTarget,
  SandboxRuntimes,
} from './types.js';

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
    runtime: z
      .object({
        provider: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
        offerId: z.string().min(1).max(256),
        releaseId: z.string().regex(/^rt1_[0-9a-f]{64}$/),
        leaseSeconds: z.number().int().min(60).max(86_400),
        ttlSeconds: z.number().int().min(1).max(3600).default(300),
      })
      .strict()
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
 * unreachable service so the row degrades instead of disappearing.
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
  /**
   * Present only where the deployment named the bucket origins a check's source may be
   * uploaded to, so a project check is opt-in per deployment rather than per request.
   */
  readonly checks?: SandboxChecks;
  readonly runtimes?: SandboxRuntimes;

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
    if (parsed.data.runtime) {
      const runner = new SandboxRuntimeRunner(
        this.#client,
        (projectId) => this.#connectionFor(projectId),
        parsed.data.runtime,
      );
      const { leaseSeconds } = parsed.data.runtime;
      this.runtimes = {
        profileId: runner.profileId,
        leaseSeconds,
        // C0 stub: G1 builds one runner per configured profile and describes their offers.
        profiles: [{ key: 'standard', id: runner.profileId, leaseSeconds }],
        describe: async () => null,
        connected: (projectId) =>
          this.#connections.some(
            (entry) => entry.projectId === projectId && this.#client.configured(entry),
          ),
        provision: (projectId, operationKey) =>
          this.#run({ projectId, operationKey }, ({ projectId, operationKey }) =>
            runner.provision(projectId, operationKey),
          ),
        inspect: (projectId, handle) =>
          this.#run({ projectId, handle }, ({ projectId, handle }) =>
            runner.inspect(projectId, handle),
          ),
        launch: (projectId, handle, operationKey, bootstrap) =>
          this.#run(
            { projectId, handle, operationKey, bootstrap },
            ({ projectId, handle, operationKey, bootstrap }) =>
              runner.launch(projectId, handle, operationKey, bootstrap),
          ),
        acknowledge: (projectId, handle) =>
          this.#run({ projectId, handle }, ({ projectId, handle }) =>
            runner.acknowledge(projectId, handle),
          ),
        stop: (projectId, handle) =>
          this.#run({ projectId, handle }, ({ projectId, handle }) =>
            runner.stop(projectId, handle),
          ),
        renew: (projectId, handle) =>
          this.#run({ projectId, handle }, ({ projectId, handle }) =>
            runner.renew(projectId, handle),
          ),
      };
    }
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
}

export const sandboxesPlugin = {
  name: 'merv-sandboxes',
  Config: configuration,
  apply(ctx: Context, config: SandboxesConfig) {
    const service = new SandboxService(config);
    ctx.effect(() => service.start());
    ctx.provide('sandboxes', service);
  },
};
export default sandboxesPlugin;

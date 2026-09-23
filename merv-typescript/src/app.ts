import { Context, FiberState, type Fiber } from 'cordis';
import Loader from '@cordisjs/plugin-loader';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { check, type PluginStatus } from '@merv/contracts';
import type {} from '@merv/api';
import { loadConfiguration, type ConfigurationOptions } from './config.js';

export type AppOptions = ConfigurationOptions;

const states: Record<FiberState, PluginStatus['state']> = {
  [FiberState.PENDING]: 'pending',
  [FiberState.LOADING]: 'loading',
  [FiberState.ACTIVE]: 'active',
  [FiberState.FAILED]: 'failed',
  [FiberState.DISPOSED]: 'disposed',
  [FiberState.UNLOADING]: 'unloading',
};

/** Composition and readiness policy only. Cordis owns the dependency graph and its lifecycle. */
export async function createApp(options: AppOptions) {
  const configuration = loadConfiguration(options);
  const directory = resolve(options.directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const ctx = new Context();
  const required = new Map(
    configuration.entries.map((entry) => [entry.id, entry.required !== false]),
  );
  let stopping: Promise<void> | undefined;
  let changing: Promise<unknown> = Promise.resolve();
  try {
    await ctx.plugin(Loader, { baseUrl: configuration.baseUrl });
    const loader = ctx.loader;
    const failed = new WeakSet<Fiber>();
    /**
     * A feature's tool, UI and API adapters are plugins its service mounts as children, named
     * `merv-…-tools`, `-ui` or `-api`. Each reports as the row `<entry>-<kind>` under the module
     * name `<entry module>/<kind>`, so a broken tool registration still fails readiness.
     */
    const adapters = (parent: Fiber | undefined) => {
      const found: { id: string; name: string; kind: string; fiber: Fiber }[] = [];
      const entry = [...loader.entries()].find((item) => item.fiber === parent);
      if (!parent || !entry) return found;
      for (const runtime of ctx.registry.values())
        for (const fiber of runtime.fibers) {
          const kind = /-(tools|ui|api)$/.exec(runtime.name ?? '')?.[1];
          // The loader keeps a wrapper of its entry's fiber; the uid names the fiber itself.
          if (kind && parent.uid !== null && fiber.parent.fiber.uid === parent.uid)
            found.push({
              id: `${entry.id}-${kind}`,
              name: `${entry.options.name}/${kind}`,
              kind,
              fiber,
            });
        }
      return found;
    };
    const settle = async () => {
      await loader.await();
      // The loader joins the graph. A final inspection captures validation errors:
      // Cordis can leave a rejected Config validation fiber marked PENDING.
      const join = async (fiber: Fiber | undefined) => {
        if (!fiber) return;
        try {
          await fiber.await();
        } catch {
          failed.add(fiber);
        }
      };
      const entries = [...loader.entries()];
      await Promise.all(entries.map(({ fiber }) => join(fiber)));
      // Adapters load once their owner is provided; join them after their owners.
      await Promise.all(
        entries.flatMap(({ fiber }) => adapters(fiber).map((adapter) => join(adapter.fiber))),
      );
    };
    const missing = (fiber: Fiber) =>
      Object.keys(fiber.inject).filter((name) => fiber.parent.get(name) === undefined);
    const state = (fiber: Fiber): PluginStatus['state'] =>
      failed.has(fiber) ? 'failed' : (states[fiber.state] ?? 'failed');
    const status = (): PluginStatus[] =>
      [...loader.entries()].flatMap((entry) => {
        const fiber = entry.fiber;
        const current =
          fiber?.state === FiberState.UNLOADING
            ? 'unloading'
            : entry.disabled
              ? 'disabled'
              : fiber
                ? state(fiber)
                : 'failed';
        const row: PluginStatus = {
          id: entry.id,
          name: entry.options.name,
          state: current,
          required: required.get(entry.id) ?? true,
          missingDependencies: fiber && current === 'pending' ? missing(fiber) : [],
        };
        const rows = adapters(fiber).flatMap((adapter): PluginStatus[] => {
          const adapterState = state(adapter.fiber);
          const waiting = adapterState === 'pending' ? missing(adapter.fiber) : [];
          // With no registry of its kind composed at all, an adapter has nothing to publish to.
          if (waiting.includes(adapter.kind) && !loader.store[adapter.kind]) return [];
          return [
            {
              id: adapter.id,
              name: adapter.name,
              state: adapterState,
              // Browser rows never gate readiness; transports are as required as their feature.
              required: row.required && adapter.kind !== 'ui',
              missingDependencies: waiting,
            },
          ];
        });
        return [row, ...rows];
      });
    const assertReady = (items: PluginStatus[]) => {
      const inactive = items.filter(
        (entry) => entry.state !== 'active' && entry.state !== 'disabled',
      );
      check(
        !inactive.length,
        'plugin_unavailable',
        `Plugins failed or have missing dependencies: ${inactive
          .map(
            (entry) =>
              `${entry.id} (${entry.name}): ${entry.state}${entry.missingDependencies.length ? `; requires ${entry.missingDependencies.join(', ')}` : ''}`,
          )
          .join('; ')}`,
        503,
      );
    };
    // Plugins read lifecycle state from this report, never by recomputing it from the loader.
    ctx.provide('composition', { status });
    // A required flag is Merv readiness policy; do not pass it as a loader/plugin option.
    await loader.root.update(
      configuration.entries.map(({ required: _required, ...entry }) => entry),
    );
    await settle();
    assertReady(status().filter((entry) => entry.required));

    const getFiber = (id: string): Fiber | undefined =>
      loader.store[id]?.fiber ??
      [...loader.entries()]
        .flatMap((entry) => adapters(entry.fiber))
        .find((adapter) => adapter.id === id)?.fiber;
    const setEnabled = (id: string, enabled: boolean): Promise<void> => {
      check(!stopping, 'unavailable', 'Application is stopping', 503);
      check(typeof enabled === 'boolean', 'invalid_config', 'enabled must be a boolean');
      // Serialize administrative changes; domain calls continue while consumers drain.
      const operation = changing.then(async () => {
        check(!stopping, 'unavailable', 'Application is stopping', 503);
        check(loader.store[id], 'plugin_not_found', `Plugin entry not found: ${id}`, 404);
        await loader.update(id, { disabled: !enabled });
        await settle();
        if (enabled) {
          const own = new Set([id, ...adapters(loader.store[id]?.fiber).map((item) => item.id)]);
          assertReady(status().filter((entry) => own.has(entry.id)));
        }
      });
      changing = operation.catch(() => undefined);
      return operation;
    };
    return {
      ctx,
      directory,
      loader,
      status,
      getFiber,
      setEnabled,
      stop: () =>
        (stopping ??= (async () => {
          const errors: unknown[] = [];
          // An in-progress disable must finish draining before destroying the entry tree.
          await changing;
          try {
            const api = ctx.get('api');
            if (api) await api.stop();
          } catch (error) {
            errors.push(error);
          }
          try {
            await ctx.fiber.dispose();
          } catch (error) {
            errors.push(error);
          }
          if (errors.length === 1) throw errors[0];
          if (errors.length > 1) throw new AggregateError(errors, 'Application shutdown failed');
        })()),
    };
  } catch (error) {
    await ctx.fiber.dispose();
    throw error;
  }
}

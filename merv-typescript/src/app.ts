import { Context, FiberState, type Fiber } from 'cordis';
import Loader from '@cordisjs/plugin-loader';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { check, pluginState } from '@merv/contracts';
import type {} from '@merv/api';
import { loadConfiguration, type ConfigurationOptions } from './config.js';

export type AppOptions = ConfigurationOptions;
/** Compatibility alias: new plugin IDs are configuration data, not a bootstrap union. */
export type Component = string;

export interface PluginStatus {
  id: string;
  name: string;
  state: 'pending' | 'loading' | 'active' | 'failed' | 'disposed' | 'unloading' | 'disabled';
  required: boolean;
  missingDependencies: string[];
}

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
    const settle = async () => {
      await loader.await();
      // The loader joins the graph. A final inspection captures validation errors:
      // Cordis can leave a rejected Config validation fiber marked PENDING.
      await Promise.all(
        [...loader.entries()].map(async ({ fiber }) => {
          if (!fiber) return;
          try {
            await fiber.await();
          } catch {
            failed.add(fiber);
          }
        }),
      );
    };
    const status = (): PluginStatus[] =>
      [...loader.entries()].map((entry) => {
        const fiber = entry.fiber;
        const state =
          fiber?.state === FiberState.UNLOADING
            ? 'unloading'
            : entry.disabled
              ? 'disabled'
              : fiber && failed.has(fiber)
                ? 'failed'
                : fiber
                  ? pluginState(fiber.state)
                  : 'failed';
        return {
          id: entry.id,
          name: entry.options.name,
          state,
          required: required.get(entry.id) ?? true,
          missingDependencies:
            fiber && state === 'pending'
              ? Object.keys(fiber.inject).filter((name) => fiber.parent.get(name) === undefined)
              : [],
        };
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
    // A required flag is Merv readiness policy; do not pass it as a loader/plugin option.
    await loader.root.update(
      configuration.entries.map(({ required: _required, ...entry }) => entry),
    );
    await settle();
    assertReady(status().filter((entry) => entry.required));

    const getFiber = (id: string): Fiber | undefined => loader.store[id]?.fiber;
    const setEnabled = (id: string, enabled: boolean): Promise<void> => {
      check(!stopping, 'unavailable', 'Application is stopping', 503);
      check(typeof enabled === 'boolean', 'invalid_config', 'enabled must be a boolean');
      // Serialize administrative changes; domain calls continue while consumers drain.
      const operation = changing.then(async () => {
        check(!stopping, 'unavailable', 'Application is stopping', 503);
        check(loader.store[id], 'plugin_not_found', `Plugin entry not found: ${id}`, 404);
        await loader.update(id, { disabled: !enabled });
        await settle();
        if (enabled) assertReady(status().filter((entry) => entry.id === id));
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
      // Compatibility views are rebuilt from current entries; replacement fibers are not cached.
      get components(): ReadonlyMap<string, Fiber> {
        return new Map(
          [...loader.entries()]
            .filter((entry) => !/-(tools|ui|api)$/.test(entry.id) && entry.fiber)
            .map((entry) => [entry.id, entry.fiber!]),
        );
      },
      get adapters(): ReadonlyMap<string, Fiber> {
        return new Map(
          [...loader.entries()]
            .filter((entry) => /-(tools|ui|api)$/.test(entry.id) && entry.fiber)
            .map((entry) => [entry.id.replace(/-tools$/, ''), entry.fiber!]),
        );
      },
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

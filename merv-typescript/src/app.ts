import { Context, FiberState, type Fiber } from 'cordis';
import Loader from '@cordisjs/plugin-loader';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import {
  check,
  MervError,
  type Composition,
  type ConfiguredEnv,
  type PluginStatus,
} from '@merv/contracts';
import type {} from '@merv/api';
import type {} from '@merv/secrets/types';
import { loadConfiguration, type ConfigurationOptions } from './config.js';

const states: Record<FiberState, PluginStatus['state']> = {
  [FiberState.PENDING]: 'pending',
  [FiberState.LOADING]: 'loading',
  [FiberState.ACTIVE]: 'active',
  [FiberState.FAILED]: 'failed',
  [FiberState.DISPOSED]: 'disposed',
  [FiberState.UNLOADING]: 'unloading',
};

/** Loaded first and alone: the store of platform secrets, and the state it keeps them in. */
const FIRST = new Set(['@merv/state', '@merv/secrets']);
/** Whose env no stored secret replaces: what State and Secrets read before the store opens,
 *  Identity's, which the API verifies every request through, so a reload of it would stop the
 *  API under the request that asked for it, and the Sandboxes host's database and vault. */
const FIXED = new Set([...FIRST, '@merv/identity', '@merv/sandboxes/host']);
/** A key Merv seals stored data or signs what it hands out with (its owner's purpose says so):
 *  replaced, everything it sealed or signed stops working. */
const issued = (purpose: string) => /· (encryption key|signing secret)$/.test(purpose);

/** The `.describe()` a zod config schema gives the field at `path`, through its wrappers,
 *  unions, arrays and records. */
function describedAt(schema: unknown, path: readonly string[]): string | undefined {
  const def = (schema as { _def?: Record<string, any> } | null | undefined)?._def;
  if (!def) return undefined;
  if (!path.length && def.description) return def.description;
  const [key, ...rest] = path;
  if (def.typeName === 'ZodObject') return key && describedAt(def.shape()[key], rest);
  if (def.typeName === 'ZodArray') return describedAt(def.type, rest);
  if (def.typeName === 'ZodRecord') return describedAt(def.valueType, rest);
  if (def.options) return def.options.map((o: unknown) => describedAt(o, path)).find(Boolean);
  return describedAt(def.innerType ?? def.schema ?? def.in ?? def.type ?? def.getter?.(), path);
}

/** Composition and readiness policy only. Cordis owns the dependency graph and its lifecycle. */
export async function createApp(options: ConfigurationOptions) {
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
                  ? (states[fiber.state] ?? 'failed')
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
    // Config names secrets and never holds them: every `*Env` string field, at any depth, of the
    // config each enabled entry was given, its plugin's defaults applied where it loaded, for
    // what its plugin's config schema says the field is for.
    type Named = Omit<ConfiguredEnv, 'plugin' | 'overridable'>;
    const named = (value: unknown, schema: unknown, path: string[] = []): Named[] =>
      value && typeof value === 'object'
        ? Object.entries(value).flatMap(([key, child]) => {
            const at = [...path, key];
            const field = at.join('.');
            return typeof child === 'string' && key.endsWith('Env')
              ? [{ field, env: child, purpose: describedAt(schema, at) ?? field }]
              : named(child, schema, at);
          })
        : [];
    const environment = (): ConfiguredEnv[] => {
      const entries = [...loader.entries()]
        .filter((entry) => !entry.disabled)
        .map((entry) => ({
          entry,
          refs: named(entry.fiber?.config ?? entry.options.config, entry.fiber?.runtime?.Config),
        }));
      const fixed = new Set(
        entries
          .flatMap(({ entry, refs }) =>
            refs.filter((ref) => FIXED.has(entry.options.name) || issued(ref.purpose)),
          )
          .map((ref) => ref.env),
      );
      return entries.flatMap(({ entry, refs }) =>
        refs.map((ref) => ({ plugin: entry.id, ...ref, overridable: !fixed.has(ref.env) })),
      );
    };

    // Serialize administrative changes; domain calls continue while consumers drain.
    const serialized = <T>(change: () => Promise<T>): Promise<T> => {
      check(!stopping, 'unavailable', 'Application is stopping', 503);
      const operation = changing.then(async () => {
        check(!stopping, 'unavailable', 'Application is stopping', 503);
        return await change();
      });
      changing = operation.catch(() => undefined);
      return operation;
    };
    const toggle = async (ids: string[], enabled: boolean) => {
      for (const id of ids) {
        check(loader.store[id], 'plugin_not_found', `Plugin entry not found: ${id}`, 404);
        await loader.update(id, { disabled: !enabled });
      }
      await settle();
      if (enabled) assertReady(status().filter((entry) => ids.includes(entry.id)));
    };
    const setEnv = (env: string, value: string | undefined) =>
      value === undefined ? delete process.env[env] : (process.env[env] = value);
    /** The entries whose config names `env` reload with `value`, then `then` runs (a provider
     *  rebinding its key); Secrets keeps it only once all of that took it, else the previous
     *  value is back. */
    const override: Composition['override'] = (env, value, by, then = async () => []) =>
      serialized(async () => {
        const refs = environment().filter((ref) => ref.env === env);
        check(
          refs.every((ref) => ref.overridable),
          'credential_fixed',
          'This secret is read before stored secrets apply; change it in the deployment',
          409,
        );
        const secrets = ctx.get('secrets');
        check(secrets, 'secrets_unavailable', 'Stored platform secrets are unavailable', 503);
        const ids = [...new Set(refs.map((ref) => ref.plugin))];
        const previous = process.env[env];
        const apply = async (to: string | undefined) => {
          setEnv(env, to);
          await toggle(ids, false);
          await toggle(ids, true);
          return [...ids, ...(await then())];
        };
        try {
          const reloaded = await apply(value);
          await secrets.setPlatformSecret(env, value, by);
          return reloaded;
        } catch (error) {
          await apply(previous).catch(() => undefined);
          // A refusal names the problem; a plugin that failed with the value names nothing of it.
          if (error instanceof MervError && error.code !== 'plugin_unavailable') throw error;
          throw new MervError('credential_rejected', 'The new value did not load', 422);
        }
      });
    // Plugins read lifecycle state from this report, never by recomputing it from the loader.
    ctx.provide('composition', { status, environment, override });
    // A required flag is Merv readiness policy; do not pass it as a loader/plugin option.
    const entries = configuration.entries.map(({ required: _required, ...entry }) => entry);
    // State and Secrets load alone, and each platform secret stored there replaces its env value
    // before any other entry reads it.
    await loader.root.update(entries.filter((entry) => FIRST.has(entry.name)));
    await settle();
    const first = new Set(environment().map((ref) => ref.env));
    const secrets = ctx.get('secrets');
    for (const { env } of (await secrets?.platformSecrets()) ?? []) {
      // A value that no longer opens (the store's key replaced) leaves the deployment's.
      const value = first.has(env) ? null : await secrets!.platformSecret(env).catch(() => null);
      if (value !== null) process.env[env] = value;
    }
    await loader.root.update(entries);
    await settle();
    assertReady(status().filter((entry) => entry.required));

    const getFiber = (id: string): Fiber | undefined => loader.store[id]?.fiber;
    const setEnabled = (id: string, enabled: boolean): Promise<void> => {
      check(typeof enabled === 'boolean', 'invalid_config', 'enabled must be a boolean');
      return serialized(() => toggle([id], enabled));
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

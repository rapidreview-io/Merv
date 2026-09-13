import { Context, FiberState, type Fiber } from 'cordis';
import { resolve, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { check } from '@merv/contracts';
import { statePlugin } from '@merv/state';
import { blobsPlugin } from '@merv/blobs';
import { scopePlugin } from '@merv/scope';
import { artifactsPlugin } from '@merv/artifacts';
import { workflowsPlugin } from '@merv/workflows';
import { reviewsPlugin } from '@merv/reviews';
import { tasksPlugin } from '@merv/tasks';
import { feedPlugin } from '@merv/feed';
import { apiPlugin, toolsPlugin } from '@merv/api';
import { scopeToolsPlugin } from '@merv/scope/tools';
import { artifactToolsPlugin } from '@merv/artifacts/tools';
import { workflowToolsPlugin } from '@merv/workflows/tools';
import { reviewToolsPlugin } from '@merv/reviews/tools';
import { taskToolsPlugin } from '@merv/tasks/tools';
import { feedToolsPlugin } from '@merv/feed/tools';

export const CORE_COMPONENTS = [
  'state',
  'blobs',
  'scope',
  'artifacts',
  'workflows',
  'reviews',
  'tasks',
  'feed',
] as const;
export type Component = (typeof CORE_COMPONENTS)[number];
export interface AppOptions {
  directory: string;
  components?: Component[];
  api?: boolean;
  host?: string;
  port?: number;
}

/** The only composition root: domain services never import another component implementation. */
export async function createApp(options: AppOptions) {
  const directory = resolve(options.directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const ctx = new Context();
  const selected = new Set(options.components ?? CORE_COMPONENTS);
  const fibers: Fiber[] = [];
  const components = new Map<Component, Fiber>();
  const adapters = new Map<Component, Fiber>();
  const add = async (plugin: any, config?: any) => {
    const fiber = await ctx.plugin(plugin, config);
    fibers.push(fiber);
    return fiber;
  };
  const settle = async () => {
    // A Fiber's await() joins only its current activation. A provider can awaken
    // a consumer after that consumer's await() already returned while pending.
    // Settle the complete graph in rounds before checking readiness.
    for (let round = 0; round <= fibers.length; round++) {
      await Promise.all(fibers.map((fiber) => fiber.await()));
      if (fibers.every((fiber) => fiber.state === FiberState.ACTIVE)) return;
      if (fibers.some((fiber) => fiber.state === FiberState.FAILED)) break;
    }
    const inactive = fibers
      .filter((fiber) => fiber.state !== FiberState.ACTIVE)
      .map((fiber) => fiber.name);
    check(
      !inactive.length,
      'plugin_unavailable',
      `Plugins failed or have missing dependencies: ${inactive.join(', ')}`,
      503,
    );
  };
  try {
    // Register consumers before providers to exercise Cordis dependency-driven activation.
    for (const [name, plugin, config] of [
      ['feed', feedPlugin],
      ['tasks', tasksPlugin],
      ['reviews', reviewsPlugin],
      ['artifacts', artifactsPlugin],
      ['workflows', workflowsPlugin],
      ['scope', scopePlugin],
      ['blobs', blobsPlugin, { root: join(directory, 'blobs') }],
      ['state', statePlugin, { path: join(directory, 'state.sqlite') }],
    ] as const)
      if (selected.has(name)) components.set(name, await add(plugin, config));
    await settle();
    if (options.api) {
      check(selected.has('scope'), 'missing_dependency', 'API requires the scope component');
      await add(toolsPlugin);
      for (const [name, plugin] of [
        ['scope', scopeToolsPlugin],
        ['artifacts', artifactToolsPlugin],
        ['workflows', workflowToolsPlugin],
        ['reviews', reviewToolsPlugin],
        ['tasks', taskToolsPlugin],
        ['feed', feedToolsPlugin],
      ] as const)
        if (selected.has(name)) adapters.set(name, await add(plugin));
      await add(apiPlugin, { host: options.host ?? '127.0.0.1', port: options.port ?? 3081 });
      await settle();
    }
    let stopping: Promise<void> | undefined;
    // Expose the actual Cordis handles for lifecycle operations; no parallel
    // dependency manager or HTTP administration endpoint is introduced.
    return {
      ctx,
      directory,
      components: components as ReadonlyMap<Component, Fiber>,
      adapters: adapters as ReadonlyMap<Component, Fiber>,
      stop: () =>
        (stopping ??= (async () => {
          const errors: unknown[] = [];
          try {
            if (options.api && ctx.api) await ctx.api.stop();
          } catch (error) {
            errors.push(error);
          }
          // A transport shutdown failure must still unwind the complete plugin graph.
          // Cordis disposers can retry resource cleanup while draining their dependents.
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

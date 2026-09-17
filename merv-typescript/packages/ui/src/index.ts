import { mapAsync } from '@merv/contracts';
import { FiberState, type Context } from 'cordis';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { check, type Caller, type Json } from '@merv/contracts';
import type {} from '@merv/api/types';
import type {} from '@cordisjs/plugin-loader';
import type { Ui, UiRow, UiRowDescription, UiRowStatus } from './types.js';
import { homeRead, identityOf } from './home.js';
import { serveBundle } from './static.js';

export type { Ui, UiRow, UiRowDescription, UiRowStatus } from './types.js';

export interface PluginState {
  id: string;
  name: string;
  state: 'pending' | 'loading' | 'active' | 'failed' | 'disposed' | 'unloading' | 'disabled';
}
const states: Record<FiberState, PluginState['state']> = {
  [FiberState.PENDING]: 'pending',
  [FiberState.LOADING]: 'loading',
  [FiberState.ACTIVE]: 'active',
  [FiberState.FAILED]: 'failed',
  [FiberState.DISPOSED]: 'disposed',
  [FiberState.UNLOADING]: 'unloading',
};
const idPattern = /^[a-z][a-z0-9-]{0,63}$/;

/** Sidebar rows registered by feature adapters; a disposed registration disappears immediately. */
export class UiRegistry implements Ui {
  private readonly entries = new Map<string, UiRow>();

  register(row: UiRow): () => void {
    check(row && typeof row === 'object', 'invalid_row', 'Row must be an object');
    check(
      idPattern.test(row.id),
      'invalid_row',
      'Row id must be lowercase letters, digits, dashes',
    );
    check(
      typeof row.label === 'string' && row.label.trim().length > 0 && row.label.length <= 40,
      'invalid_row',
      'Row label must contain 1–40 characters',
    );
    check(idPattern.test(row.group), 'invalid_row', 'Row group must be a lowercase identifier');
    check(Number.isInteger(row.order), 'invalid_row', 'Row order must be an integer');
    check(/^\/[a-z0-9/-]*$/.test(row.path), 'invalid_row', 'Row path must be an absolute route');
    check(
      !!row.view && typeof row.view === 'object' && typeof row.view.kind === 'string',
      'invalid_row',
      'Row view must declare a kind',
    );
    check(!this.entries.has(row.id), 'row_conflict', `Row is already registered: ${row.id}`, 409);
    const entry: UiRow = { ...row, view: structuredClone(row.view) };
    this.entries.set(row.id, entry);
    return () => {
      if (this.entries.get(row.id) === entry) this.entries.delete(row.id);
    };
  }

  rows(): UiRow[] {
    return [...this.entries.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  }

  async describe(caller: Caller): Promise<UiRowDescription[]> {
    return await mapAsync(this.rows(), async ({ status, read, ...row }) => {
      let live: UiRowStatus = {};
      try {
        live = (await status?.(caller)) ?? {};
      } catch (error) {
        live = {
          state: 'unavailable',
          detail: error instanceof Error ? error.message : 'Status is unavailable',
        };
      }
      return { ...row, status: live, readable: typeof read === 'function' };
    });
  }

  async read(caller: Caller, rowId: string, params?: Record<string, unknown>): Promise<Json> {
    const row = this.entries.get(rowId);
    check(row?.read, 'row_unreadable', `Row has no readable data: ${rowId}`, 404);
    return await row.read(caller, params);
  }
}

export const uiPlugin = {
  name: 'merv-ui',
  Config: z
    .object({
      assets: z
        .string()
        .refine((path) => path.trim().length > 0)
        .optional(),
    })
    .strict()
    .default({}),
  inject: ['api', 'tools'],
  apply(ctx: Context, config: { assets?: string } = {}) {
    const ui = new UiRegistry();
    const assets = config.assets ?? fileURLToPath(new URL('../dist/', import.meta.url));
    // The loader is optional at type and runtime: an embedded composition without it reports no plugins.
    const plugins = (): PluginState[] => {
      const loader = ctx.get('loader');
      if (!loader) return [];
      return [...loader.entries()].map((entry) => ({
        id: entry.id,
        name: entry.options.name,
        state: entry.disabled
          ? 'disabled'
          : entry.fiber
            ? (states[entry.fiber.state] ?? 'failed')
            : 'failed',
      }));
    };
    ctx.effect(() => ctx.api.mount('/ui', serveBundle(assets)));
    ctx.effect(() =>
      ctx.tools.register({
        name: 'ui.shell',
        description:
          'Read your actor identity and selected project, the sidebar rows currently registered by active plugins with live row status, and the plugin lifecycle table.',
        inputSchema: z.object({}).strict(),
        readOnly: true,
        handler: async (caller: Caller) => ({
          ...(await identityOf(ctx.tools, caller)),
          rows: await ui.describe(caller),
          plugins: plugins(),
        }),
      }),
    );
    ctx.effect(() =>
      ctx.tools.register({
        name: 'ui.home',
        description:
          'Read everything the home page draws in one answer: the project, its records, the people who own them, and the gate every unfinished workflow stands at.',
        inputSchema: z.object({}).strict(),
        // Composes read-only tools that each take their own snapshot; unscoped so they read in parallel.
        readOnly: false,
        handler: async (caller: Caller) =>
          await homeRead(
            ctx.tools,
            ui.rows(),
            async (as, rowId, params) => await ui.read(as, rowId, params),
            caller,
          ),
      }),
    );
    ctx.effect(() =>
      ctx.tools.register({
        name: 'ui.read',
        description: 'Read the data a sidebar row owns when it has no dedicated domain tool.',
        inputSchema: z
          .object({ rowId: z.string().min(1), params: z.record(z.unknown()).optional() })
          .strict(),
        readOnly: true,
        handler: async (
          caller: Caller,
          input: { rowId: string; params?: Record<string, unknown> },
        ) => await ui.read(caller, input.rowId, input.params),
      }),
    );
    ctx.effect(() =>
      ui.register({
        id: 'settings',
        label: 'Settings',
        group: 'settings',
        order: 100,
        path: '/settings',
        view: { kind: 'settings' },
      }),
    );
    ctx.provide('ui', ui);
  },
};
export default uiPlugin;

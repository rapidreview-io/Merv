import { clip, visible, mapAsync, runningKeyPattern } from '@merv/contracts';
import type { Context } from 'cordis';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { check, type Caller, type Json } from '@merv/contracts';
import type {} from '@merv/api/types';
import type { RunningContribution, Ui, UiRow, UiRowDescription, UiRowStatus } from './types.js';
import { homeRead, identityOf } from './home.js';
import { RunningRegistry, runningBoard, runningPanel, type RunningSources } from './running.js';
import { serveBundle } from './static.js';

export type {
  RunningContribution,
  RunningRead,
  Ui,
  UiRow,
  UiRowDescription,
  UiRowStatus,
} from './types.js';

const idPattern = /^[a-z][a-z0-9-]{0,63}$/;

/** Sidebar rows registered by feature adapters; a disposed registration disappears immediately. */
export class UiRegistry implements Ui {
  private readonly entries = new Map<string, UiRow>();
  private readonly running = new RunningRegistry();

  register(row: UiRow): () => void {
    check(row && typeof row === 'object', 'invalid_row', 'Row must be an object');
    check(
      idPattern.test(row.id),
      'invalid_row',
      'Row id must be lowercase letters, digits, dashes',
    );
    check(
      typeof row.label === 'string' && visible(row.label) && row.label.length <= 40,
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
    // A row this composition does not have and a row that carries no read read differently,
    // under the one code a client already knows.
    check(row, 'row_unreadable', `No row named ${clip(String(rowId), 80)} in this project`, 404);
    check(row.read, 'row_unreadable', `Row has no readable data: ${row.id}`, 404);
    return await row.read(caller, params);
  }

  /** Adds one owner's part of the Running page; a disposed contribution leaves it at once. */
  contribute(contribution: RunningContribution): () => void {
    return this.running.contribute(contribution);
  }

  contributions(): RunningContribution[] {
    return this.running.contributions();
  }
}

export const uiPlugin = {
  name: 'merv-ui',
  Config: z
    .object({
      assets: z.string().refine(visible).optional(),
    })
    .strict()
    .default({}),
  inject: ['api', 'tools'],
  apply(ctx: Context, config: { assets?: string } = {}) {
    const ui = new UiRegistry();
    const assets = config.assets ?? fileURLToPath(new URL('../dist/', import.meta.url));
    // The composition root's own report; composed without createApp, the table is empty.
    const plugins = () =>
      (ctx.get('composition')?.status() ?? []).map(({ id, name, state }) => ({ id, name, state }));
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
        // One snapshot for every part: sequential reads on one connection cost tens of
        // milliseconds; parallel parts each queued on the writer lock cost seconds.
        readOnly: true,
        handler: async (caller: Caller) =>
          await homeRead(
            ctx.tools,
            ui.rows(),
            async (as, rowId, params) => await ui.read(as, rowId, params),
            caller,
          ),
      }),
    );
    const running: RunningSources = {
      contributions: () => ui.contributions(),
      tools: async () => (await ctx.tools.list()).map((tool) => tool.name),
    };
    // A person's monitor. Its sidebars can hold what only an operator may read, so no
    // conversation is offered it and the reads refuse leased workers and managed runners.
    // One snapshot for every owner's part, as for ui.home.
    ctx.effect(() =>
      ctx.tools.register({
        name: 'ui.running',
        description:
          'Read what is in flight in this project in three lanes: the work, the agent sessions on it and the machines they use, with what needs a person and the edges between them.',
        inputSchema: z.object({}).strict(),
        readOnly: true,
        conversation: 'never' as const,
        handler: async (caller: Caller) => await runningBoard(running, caller),
      }),
    );
    ctx.effect(() =>
      ctx.tools.register({
        name: 'ui.running_panel',
        description:
          "Read the Running sidebar of one key: its owner's head, the sections every owner adds about it, and the controls this caller may use.",
        inputSchema: z.object({ key: z.string().regex(runningKeyPattern) }).strict(),
        readOnly: true,
        conversation: 'never' as const,
        handler: async (caller: Caller, input: { key: string }) =>
          await runningPanel(running, caller, input.key),
      }),
    );
    ctx.effect(() =>
      ctx.tools.register({
        name: 'ui.read',
        description: 'Read the data a sidebar row owns when it has no dedicated domain tool.',
        inputSchema: z
          .object({ rowId: z.string().min(1).max(200), params: z.record(z.unknown()).optional() })
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

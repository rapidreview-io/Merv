import type { Context } from 'cordis';
import { z } from 'zod';
import { check, idSchema, MervError, type Json } from '@merv/contracts';
import type {} from '@merv/ui/types';
import {
  initializeLegacyHistory,
  legacyHistoryTables,
  LegacyHistoryReader,
  type LegacyHistoryType,
} from './legacy-history.js';
import { historyMediaLinks } from './legacy-media-links.js';

const recordType = z.enum(
  Object.keys(legacyHistoryTables) as [LegacyHistoryType, ...LegacyHistoryType[]],
);
const request = z.discriminatedUnion('action', [
  z.object({ action: z.literal('summary') }).strict(),
  z
    .object({
      action: z.literal('list'),
      type: recordType,
      after: z.string().max(4096).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    })
    .strict(),
  z
    .object({ action: z.literal('detail'), type: recordType, id: z.string().min(1).max(4096) })
    .strict(),
]);

/** Optional migration reader; no new domain capability, agent tool, or live workflow adapter. */
export const legacyHistoryUiPlugin = {
  name: 'merv-legacy-history-ui',
  Config: z.object({ sourceId: idSchema }).strict(),
  inject: ['state', 'scope', 'ui'],
  async apply(ctx: Context, config: { sourceId: string }) {
    const state = ctx.state;
    const scope = ctx.scope;
    await initializeLegacyHistory(state);
    const history = new LegacyHistoryReader(state, scope);
    ctx.effect(() =>
      ctx.ui.register({
        id: 'legacy-history',
        label: 'Previous research',
        group: 'work',
        order: 19,
        path: '/legacy-history',
        view: { kind: 'legacy-history' },
        status: async (caller) => {
          try {
            const summary = await history.summary(caller, config);
            return { count: Object.values(summary.counts).reduce((sum, count) => sum + count, 0) };
          } catch (error) {
            if (error instanceof MervError && error.code === 'legacy_history_not_found')
              return { count: 0, detail: 'No previous research was imported for this project.' };
            throw error;
          }
        },
        read: async (caller, params) => {
          const parsed = request.safeParse(params ?? { action: 'summary' });
          check(parsed.success, 'invalid_input', 'History query is invalid');
          const input = parsed.data;
          if (input.action === 'summary')
            return (await history.summary(caller, config)) as unknown as Json;
          if (input.action === 'list') {
            const { action: _action, ...query } = input;
            return (await history.list(caller, { ...query, ...config })) as unknown as Json;
          }
          const { action: _action, ...query } = input;
          const record = await history.detail(caller, { ...query, ...config });
          return {
            ...record,
            files: historyMediaLinks(record.type, record.id, record.data, caller.projectId),
          } as unknown as Json;
        },
      }),
    );
  },
};
export default legacyHistoryUiPlugin;

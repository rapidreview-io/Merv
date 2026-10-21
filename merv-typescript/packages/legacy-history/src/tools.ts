import type { Context } from 'cordis';
import { z } from 'zod';
import { idSchema } from '@merv/contracts';
import type { NounAction } from '@merv/api/types';
import { request } from './requests.js';
import type {} from './types.js';

/** The archive's agent read for one imported source. */
export const legacyHistoryToolsPlugin = {
  name: 'merv-legacy-history-tools',
  Config: z.object({ sourceId: idSchema }).strict(),
  inject: ['legacyHistory', 'tools'],
  apply(ctx: Context, config: { sourceId: string }) {
    const history = ctx.legacyHistory;
    ctx.effect(() =>
      ctx.tools.noun('history.read', {
        tier: 'deferred',
        readOnly: true,
        description:
          'Read imported legacy research: summary, list records by type, or get one record.',
        actions: Object.fromEntries(
          request.options.map<[string, NounAction]>((schema) => {
            const { action, ...shape } = schema.shape;
            const method = action.value;
            return [
              method === 'detail' ? 'get' : method,
              {
                description: `Read the imported research ${method}.`,
                input: z.object(shape).strict(),
                handler: (caller, input) => history[method](caller, { ...input, ...config }),
              },
            ];
          }),
        ),
      }),
    );
  },
};
export default legacyHistoryToolsPlugin;

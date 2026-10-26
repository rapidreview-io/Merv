import type { Context } from 'cordis';
import type {} from '@merv/ui/types';
import type {} from './service.js';
export const metricsUiPlugin = {
  name: 'merv-metrics-ui',
  inject: ['metrics', 'ui'],
  apply(ctx: Context) {
    ctx.effect(() =>
      ctx.ui.register({
        id: 'metrics',
        label: 'Metrics',
        group: 'hidden',
        order: 34,
        path: '/metrics',
        view: { kind: 'metrics' },
        read: async (caller) => {
          await ctx.metrics.read(caller);
          return {};
        },
      }),
    );
  },
};
export default metricsUiPlugin;

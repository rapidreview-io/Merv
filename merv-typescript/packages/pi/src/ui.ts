import type { Context } from 'cordis';
import type {} from '@merv/ui/types';
import type {} from './types.js';

export const piUiPlugin = {
  name: 'merv-pi-ui',
  inject: ['pi', 'ui'],
  apply(ctx: Context) {
    if (!ctx.pi.config.enabled) return;
    ctx.effect(() =>
      ctx.ui.register({
        id: 'pi',
        label: 'Agent',
        group: 'operations',
        order: 0,
        path: '/agent',
        view: { kind: 'pi' },
      }),
    );
  },
};
export default piUiPlugin;

import type { Context } from 'cordis';
import type { Json } from '@merv/contracts';
import type {} from '@merv/ui/types';

export const mountsUiPlugin = {
  name: 'merv-mounts-ui',
  inject: ['mounts', 'ui'],
  apply(ctx: Context) {
    const mounts = ctx.mounts;
    ctx.effect(() =>
      ctx.ui.register({
        id: 'connections',
        label: 'Connections',
        group: 'system',
        order: 40,
        path: '/connections',
        view: { kind: 'connections' },
        status: () => {
          const all = mounts.status();
          const down = all.filter((mount) => mount.state !== 'ready');
          return down.length
            ? {
                state: 'degraded',
                count: all.length,
                detail: `${down.length} of ${all.length} not ready`,
              }
            : { state: 'ready', count: all.length };
        },
        read: () => mounts.status() as unknown as Json,
      }),
    );
  },
};
export default mountsUiPlugin;

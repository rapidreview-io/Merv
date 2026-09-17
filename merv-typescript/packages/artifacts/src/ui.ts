import type { Context } from 'cordis';
import type {} from '@merv/ui/types';

export const artifactUiPlugin = {
  name: 'merv-artifact-ui',
  inject: ['artifacts', 'ui'],
  apply(ctx: Context) {
    ctx.effect(() =>
      ctx.ui.register({
        id: 'artifacts',
        label: 'Files',
        group: 'work',
        order: 32,
        path: '/artifacts',
        view: { kind: 'artifacts' },
      }),
    );
  },
};
export default artifactUiPlugin;

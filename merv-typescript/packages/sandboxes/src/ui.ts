import type { Context } from 'cordis';
import type {} from '@merv/ui/types';
import type {} from './types.js';

/**
 * Mirrors the remote rows into the sidebar. The service owns the manifest; this owns nothing
 * but the registrations, which follow it: a changed manifest re-registers, an unreachable
 * service leaves the rows in place reporting degraded, and unloading withdraws them.
 */
export const sandboxesUiPlugin = {
  name: 'merv-sandboxes-ui',
  inject: ['sandboxes', 'ui'],
  apply(ctx: Context) {
    const sandboxes = ctx.sandboxes;
    ctx.effect(() => {
      let registered: (() => void)[] = [];
      const withdraw = () => {
        for (const dispose of registered) dispose();
        registered = [];
      };
      const publish = () => {
        withdraw();
        registered = sandboxes.rows().map((row) =>
          ctx.ui.register({
            ...row,
            // Readiness, never a count: a number beside a row label means open work.
            status: () => sandboxes.status(),
            read: async (caller, params) => await sandboxes.read(caller, row.id, params),
          }),
        );
      };
      const unsubscribe = sandboxes.subscribe(publish);
      publish();
      return () => {
        unsubscribe();
        withdraw();
      };
    });
  },
};
export default sandboxesUiPlugin;

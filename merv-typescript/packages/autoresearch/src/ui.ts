import type { Context } from 'cordis';
import type {} from '@merv/ui/types';
import type {} from './types.js';

export const autoresearchUiPlugin = {
  name: 'merv-autoresearch-ui',
  inject: ['autoresearch', 'ui'],
  apply(ctx: Context) {
    const autoresearch = ctx.autoresearch;
    ctx.effect(() =>
      ctx.ui.register({
        id: 'autoresearch',
        label: 'Autoresearch',
        group: 'lead',
        order: 15,
        path: '/autoresearch',
        workflow: 'autoresearch',
        view: { kind: 'autoresearch' },
        // Home and Needs you read the manager as one record: a pause at the cap or the wake
        // limit is its owner's move, said by the blocker Autoresearch publishes on it.
        home: {
          list: async (caller) => {
            const status = await autoresearch.status(caller);
            return status.managerId
              ? [{ id: status.managerId, name: 'Autoresearch', ...status }]
              : [];
          },
          keep: ['id', 'name', 'ownerId', 'enabled', 'state', 'paused', 'spend', 'wakes'],
        },
        needs: { name: 'name', owner: 'ownerId' },
        status: async (caller) => {
          const status = await autoresearch.status(caller);
          return status.enabled
            ? {
                state: 'ready' as const,
                detail: status.paused
                  ? `Paused (${status.paused.replace('_', ' ')})`
                  : (status.state ?? ''),
                ...(status.paused && { badge: { text: '!', label: 'Autoresearch needs you' } }),
              }
            : { state: 'ready' as const, detail: 'Off' };
        },
      }),
    );
  },
};
export default autoresearchUiPlugin;

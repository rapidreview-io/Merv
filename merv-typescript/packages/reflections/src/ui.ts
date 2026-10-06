import type { Context } from 'cordis';
import { keyId, type Caller, type Json } from '@merv/contracts';
import type {} from '@merv/ui/types';
import type {} from './types.js';
export const reflectionUiPlugin = {
  name: 'merv-reflection-ui',
  inject: ['reflections', 'ui'],
  apply(ctx: Context) {
    const reflections = ctx.reflections;
    ctx.effect(() =>
      ctx.ui.register({
        id: 'reflections',
        label: 'Reflections',
        // Reached from the Work page and its records; the rail does not list it.
        group: 'hidden',
        order: 35,
        path: '/reflections',
        workflow: 'reflection',
        view: { kind: 'reflections' },
        home: { tool: 'reflection.list', keep: ['id', 'title', 'ownerId', 'workflow', 'lenses'] },
        // A wave names the review of it, which is asked for as work: a wave is no delivery.
        needs: { name: 'title', owner: 'ownerId', subjectOnly: true },
        read: async (caller: Caller) =>
          JSON.parse(JSON.stringify(await reflections.list(caller))) as Json,
      }),
    );
    // The open wave heads the Running page's work lane with its lenses folded into it.
    ctx.effect(() =>
      ctx.ui.contribute({
        owner: 'reflections',
        kinds: ['work'],
        workflows: ['reflection'],
        lanes: ['work'],
        nodes: async (read) => ({ nodes: await reflections.running(read.caller, read.include) }),
        panel: async (read, key) =>
          await reflections.runningPanel(read.caller, keyId(key), read.route),
      }),
    );
  },
};
export default reflectionUiPlugin;

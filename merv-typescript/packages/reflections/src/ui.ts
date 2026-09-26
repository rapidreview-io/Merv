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
        group: 'work',
        order: 35,
        path: '/reflections',
        view: { kind: 'reflections' },
        // Only one wave is ever open in a project.
        status: async (caller: Caller) => ({ count: (await reflections.open(caller)) ? 1 : 0 }),
        read: async (caller: Caller) =>
          JSON.parse(JSON.stringify(await reflections.list(caller))) as Json,
      }),
    );
    // The open wave heads the Running page's work lane with its lenses folded into it.
    ctx.effect(() =>
      ctx.ui.contribute({
        owner: 'reflections',
        kinds: ['work'],
        lanes: ['work'],
        nodes: async (read) => ({ nodes: await reflections.running(read.caller, read.include) }),
        panel: async (read, key) => await reflections.runningPanel(read.caller, keyId(key)),
      }),
    );
  },
};
export default reflectionUiPlugin;

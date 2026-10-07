import type { Context } from 'cordis';
import { check, keyId, type Caller, type Json } from '@merv/contracts';
import type {} from '@merv/ui/types';
import type {} from './types.js';
import { WAVE_STATES } from './running.js';
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
        // A lens lives in its wave, so its page opens one too.
        holds: ['reflection.lens'],
        states: WAVE_STATES,
        view: { kind: 'reflections' },
        // Each wave and its current lenses, read for all waves at once.
        home: {
          list: async (caller) => await reflections.home(caller),
          keep: ['id', 'title', 'ownerId', 'workflow', 'lenses'],
        },
        // A wave names the review of it, which is asked for as work: a wave is no delivery. A
        // lens's agent may ask its owner, and the wave waits on the answer, so a lens's gate may
        // name the reader's move too, on the wave's card.
        needs: { name: 'title', owner: 'ownerId', subjectOnly: true, parts: 'lenses' },
        // One wave and the stage it stands at, read without running an action's check: its
        // page polls this and draws no action.
        read: async (caller: Caller, params) => {
          const id = params?.id;
          check(
            typeof id === 'string' && id.length > 0,
            'invalid_input',
            'params.id names the record',
          );
          return JSON.parse(JSON.stringify(await reflections.page(caller, id))) as Json;
        },
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

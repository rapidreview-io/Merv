import type { Context } from 'cordis';
import { z } from 'zod';
import type { Caller } from '@merv/contracts';
import type {} from '@merv/api/types';
import type { ResearchCreate, ResearchAdvance } from './types.js';
import { createSchema, getSchema, listSchema, advanceSchema } from './input.js';
export const researchToolsPlugin = {
  name: 'merv-research-tools',
  inject: ['research', 'tools'],
  apply(ctx: Context) {
    const research = ctx.research;
    const requestId = z.string().min(1).max(200);
    for (const tool of [
      {
        name: 'reflection.create',
        description:
          'Create five independent lens workflows over live project research. Pause new task and experiment creation until the wave is approved; existing work continues. Only one unfinished reflection wave is allowed per project.',
        inputSchema: z
          .object({ title: z.string().trim().min(1).max(300).optional(), requestId })
          .strict(),
        handler: async (caller: Caller, input: { title?: string; requestId: string }) =>
          await research.startReflection(caller, input),
      },

      {
        name: 'research.create',
        description:
          'Start an outer research cycle around selected existing workflow IDs. It coordinates project definition, research and reflection. With consolidationWorkspace none (default), finish after reflection approval; choose git to add code implementation and review. Paper edits are reviewed within scientific workflows.',
        inputSchema: createSchema,
        handler: async (caller: Caller, input: ResearchCreate) =>
          await research.create(caller, input),
      },
      {
        name: 'research.list',
        description: 'List research cycles and their exact child workflow references.',
        readOnly: true,
        inputSchema: listSchema,
        handler: async (caller: Caller) => await research.list(caller),
      },
      {
        name: 'research.get',
        description:
          'Read a research cycle, its accepted project definition, current outer gate and child workflow IDs. Use workflow.status_and_next for blockers.',
        readOnly: true,
        inputSchema: getSchema,
        handler: async (caller: Caller, input: { researchId: string }) =>
          await research.get(caller, input.researchId),
      },
      {
        name: 'research.advance',
        description:
          'Explicitly advance the current outer gate when its prerequisites are complete. Creates the next child workflows atomically, preserving their identities on replay. Never launches agents or publishes central Git. Reuse the same requestId and exact expectedRevision for an uncertain response.',
        inputSchema: advanceSchema,
        handler: async (caller: Caller, input: ResearchAdvance) =>
          await research.advance(caller, input),
      },
    ])
      ctx.effect(() => ctx.tools.register(tool));
  },
};
export default researchToolsPlugin;

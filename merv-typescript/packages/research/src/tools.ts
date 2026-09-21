import { visible } from '@merv/contracts';
import type { Context } from 'cordis';
import { z } from 'zod';
import type { Caller } from '@merv/contracts';
import type {} from '@merv/api/types';
import type { ResearchCreate, ResearchAdvance, ResearchEnd, ResearchReplan } from './types.js';
import {
  createSchema,
  endSchema,
  getSchema,
  listSchema,
  advanceSchema,
  replanSchema,
} from './input.js';
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
          .object({
            title: z.string().trim().min(1).max(300).refine(visible).optional(),
            requestId,
          })
          .strict(),
        handler: async (caller: Caller, input: { title?: string; requestId: string }) =>
          await research.startReflection(caller, input),
      },

      {
        name: 'research.create',
        description:
          "Start an outer research cycle around selected existing workflow IDs. It coordinates project definition, research and reflection. With consolidationWorkspace none (default), finish after reflection approval; choose git to add code implementation and review. Name a complete, abandoned or failed cycle as previousCycleId to follow it: its digest of what was decided is composed if missing and handed to this cycle's reflection, and a cycle is followed by at most one other. Paper edits are reviewed within scientific workflows.",
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
        name: 'research.lineage',
        description:
          'Read the cycles a research cycle follows, oldest first, each with its immutable digest artifact of what that cycle decided, and the cycle that follows it. Read a digest with artifact.read.',
        readOnly: true,
        inputSchema: getSchema,
        handler: async (caller: Caller, input: { researchId: string }) =>
          await research.lineage(caller, input.researchId),
      },
      {
        name: 'research.replan',
        description:
          'Owner: reselect the existing work a research cycle waits on, while it is still defining or researching. dependsOn is the whole new selection: work missing from it is dropped, work new to it is added. Use it when a selected experiment was abandoned or failed and the cycle should carry on without it.',
        inputSchema: replanSchema,
        handler: async (caller: Caller, input: ResearchReplan) =>
          await research.replan(caller, input),
      },
      {
        name: 'research.end',
        description:
          'Owner: end a research cycle that cannot reach an answer, as abandoned when the question is no longer worth pursuing or failed when it was pursued and cannot be completed. Its reflection and consolidation keep their own records and are ended separately. Requires a specific reason and the current revision. This is terminal.',
        inputSchema: endSchema,
        handler: async (caller: Caller, input: ResearchEnd) => await research.end(caller, input),
      },
      {
        name: 'research.advance',
        description:
          'Explicitly advance the current outer gate when its prerequisites are complete. Creates the next child workflows atomically, preserving their identities on replay. When the approved reflection carries a structured plan that continues, the advance that completes the cycle requires nextWave: create opens the plan’s tasks, experiments and the next research cycle in the same transaction, under you; skip completes without them. A text change specification creates nothing. Never publishes central Git. Reuse the same requestId and exact expectedRevision for an uncertain response.',
        inputSchema: advanceSchema,
        handler: async (caller: Caller, input: ResearchAdvance) =>
          await research.advance(caller, input),
      },
    ])
      ctx.effect(() => ctx.tools.register(tool));
  },
};
export default researchToolsPlugin;

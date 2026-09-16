import type { Context } from 'cordis';
import { z } from 'zod';
import type { Caller } from '@merv/contracts';
import type {} from '@merv/api/types';
import type {} from './types.js';
const id = z.string().min(1);
const requestId = z.string().min(1).max(200);
const expectedRevision = z.number().int().nonnegative();
export const reflectionToolsPlugin = {
  name: 'merv-reflection-tools',
  inject: ['reflections', 'tools'],
  apply(ctx: Context) {
    const definitions = [
      {
        name: 'reflection.list',
        description: 'List project reflection waves and their current stages.',
        inputSchema: z.object({}).strict(),
        readOnly: true,
        handler: async (caller: Caller) => await ctx.reflections.list(caller),
      },
      {
        name: 'reflection.get',
        description:
          'Read a reflection wave, current lens submissions and exact synthesis review. New waves use live research through project.records; only legacy waves contain a frozen corpus.',
        inputSchema: z.object({ reflectionId: id }).strict(),
        readOnly: true,
        handler: async (caller: Caller, input: { reflectionId: string }) =>
          await ctx.reflections.get(caller, input.reflectionId),
      },
      {
        name: 'reflection.lens',
        description:
          'Read one lens assignment and its own pinned output. This does not disclose other lens outputs.',
        inputSchema: z.object({ lensId: id }).strict(),
        readOnly: true,
        handler: async (caller: Caller, input: { lensId: string }) =>
          await ctx.reflections.lens(caller, input.lensId),
      },
      {
        name: 'reflection.submit_lens',
        description:
          'Complete one lens workflow with your own immutable report from this execution, containing a Summary. The fifth completed independent lens opens synthesis.',
        inputSchema: z.object({ lensId: id, artifactId: id, expectedRevision, requestId }).strict(),
        handler: async (
          caller: Caller,
          input: {
            lensId: string;
            artifactId: string;
            expectedRevision: number;
            requestId: string;
          },
        ) => await ctx.reflections.submitLens(caller, input),
      },
      {
        name: 'reflection.submit',
        description:
          'Submit your immutable synthesis report, change specification, and optional JSON paperChangesArtifactId for the same independent review. Accepted paper edits apply with approval. Review rejections return to synthesis or require five new lenses.',
        inputSchema: z
          .object({
            reflectionId: id,
            reportArtifactId: id,
            changeSpecArtifactId: id,
            paperChangesArtifactId: id.optional(),
            expectedRevision,
            requestId,
          })
          .strict(),
        handler: async (
          caller: Caller,
          input: {
            reflectionId: string;
            reportArtifactId: string;
            changeSpecArtifactId: string;
            expectedRevision: number;
            requestId: string;
          },
        ) => await ctx.reflections.submit(caller, input),
      },
    ];
    for (const definition of definitions) ctx.effect(() => ctx.tools.register(definition));
  },
};
export default reflectionToolsPlugin;

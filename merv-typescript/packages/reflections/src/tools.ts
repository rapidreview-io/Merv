import type { Context } from 'cordis';
import { z } from 'zod';
import { visible } from '@merv/contracts';
import { EXPERIMENT_NAME_RULE } from '@merv/experiments/rules';
import type { ToolDefinition } from '@merv/api/types';
const id = z.string().min(1);
const requestId = z.string().min(1).max(200);
const expectedRevision = z.number().int().nonnegative();
export const reflectionToolsPlugin = {
  name: 'merv-reflection-tools',
  inject: ['reflections', 'tools'],
  apply(ctx: Context) {
    const definitions: ToolDefinition[] = [
      {
        name: 'reflection.submit_lens',
        description:
          'Complete one lens workflow with your own immutable report from this execution, containing a Summary. The fifth completed independent lens opens synthesis.',
        inputSchema: z.object({ lensId: id, artifactId: id, expectedRevision, requestId }).strict(),
        handler: (caller, input) => ctx.reflections.submitLens(caller, input),
      },
      {
        name: 'reflection.submit',
        description: `Submit your immutable synthesis report and change specification for independent review. The reviewer owns Methods/Results edits through review.submit.paperChanges. A change specification with mediaType application/json is validated as a structured next-wave plan (an experiment item’s name, like experiment.create’s, is ${EXPERIMENT_NAME_RULE}, with no spaces), reviewed item by item, and created as tasks and experiments only when the research owner chooses that in research.advance; a text change specification is accepted as before and creates no work. Review rejections return to synthesis or require five new lenses.`,
        inputSchema: z
          .object({
            reflectionId: id,
            reportArtifactId: id,
            changeSpecArtifactId: id,
            expectedRevision,
            requestId,
          })
          .strict(),
        handler: (caller, input) => ctx.reflections.submit(caller, input),
      },
    ];
    // A lens worker's and a synthesizer's own handoffs: Pi and leased workers are listed them.
    for (const definition of definitions)
      ctx.effect(() => ctx.tools.register({ ...definition, for: 'conversations' }));
    ctx.effect(() =>
      ctx.tools.noun('reflection.read', {
        readOnly: true,
        description:
          'Read reflection waves: list (every wave and its stage), get (one wave, its lens submissions and synthesis review) and lens (one lens assignment and its own output).',
        actions: {
          list: {
            description: 'List project reflection waves and their current stages.',
            input: z.object({}).strict(),
            was: ['reflection.list'],
            handler: (caller) => ctx.reflections.list(caller),
          },
          get: {
            description:
              'Read a reflection wave, current lens submissions and exact synthesis review. A wave uses live research through project.records.',
            input: z.object({ reflectionId: id }).strict(),
            was: ['reflection.get'],
            handler: (caller, input) => ctx.reflections.get(caller, input.reflectionId),
          },
          lens: {
            description:
              'Read one lens assignment and its own pinned output. This does not disclose other lens outputs.',
            input: z.object({ lensId: id }).strict(),
            was: ['reflection.lens'],
            handler: (caller, input) => ctx.reflections.lens(caller, input.lensId),
          },
        },
      }),
    );
    ctx.effect(() =>
      ctx.tools.noun('reflection.write', {
        description:
          'Start or end reflection waves: create (five independent lenses over the live research, pausing new work until approval) and end (abandon a wave that cannot finish).',
        actions: {
          create: {
            description:
              'Create five independent lens workflows over live project research. Pause new task and experiment creation until the wave is approved; existing work continues. Only one unfinished reflection wave is allowed per project.',
            input: z
              .object({
                title: z.string().trim().min(1).max(300).refine(visible).optional(),
                requestId,
              })
              .strict(),
            was: ['reflection.create'],
            handler: (caller, input) => ctx.reflections.create(caller, input),
          },
          end: {
            description:
              'Owner or operator: abandon a reflection wave that cannot finish, as when five independent lens authors cannot be found. Its unfinished lenses end with it, an open review is withdrawn, and new tasks and experiments may start again. A research cycle waiting on the wave is then ended with research.end. Requires a specific reason and the current revision. This is terminal.',
            input: z
              .object({
                reflectionId: id,
                expectedRevision,
                reason: z.string().trim().min(1).max(16000),
                requestId,
              })
              .strict(),
            was: ['reflection.end'],
            handler: (caller, input) => ctx.reflections.end(caller, input),
          },
        },
      }),
    );
  },
};
export default reflectionToolsPlugin;

import type { Context } from 'cordis';
import type { Caller } from '@merv/contracts';
import type {} from '@merv/api/types';
import type { ConsolidationCreate, ConsolidationSubmit } from './types.js';
import { createSchema, getSchema, listSchema, submitSchema } from './input.js';
export const consolidationToolsPlugin = {
  name: 'merv-consolidation-tools',
  inject: ['consolidation', 'tools'],
  apply(ctx: Context) {
    const service = ctx.consolidation;
    for (const tool of [
      {
        name: 'consolidation.create',
        description:
          'Start consolidation from retained sourceArtifactIds and explicit experimentIds to decide on. Pins their exact metadata and hashes. The originating workflow is responsible for selecting approved inputs. Additional prerequisite workflow IDs block execution until successful. Use workspace git when retaining or adapting code.',
        inputSchema: createSchema,
        handler: async (caller: Caller, input: ConsolidationCreate) =>
          await service.create(caller, input),
      },
      {
        name: 'consolidation.list',
        description:
          'List project consolidations and their exact reviewed outputs. Workflow guidance uses workflow.status_and_next.',
        readOnly: true,
        inputSchema: listSchema,
        handler: async (caller: Caller) => await service.list(caller),
      },
      {
        name: 'consolidation.get',
        description:
          'Read a consolidation and its pinned source artifacts, experiment decisions, sealed proposals, review rounds and completion receipt. Completion does not publish central Git.',
        readOnly: true,
        inputSchema: getSchema,
        handler: async (caller: Caller, input: { consolidationId: string }) =>
          await service.get(caller, input.consolidationId),
      },
      {
        name: 'consolidation.submit',
        description:
          'Seal this producer’s report, evidence and exactly one decision per frozen experiment for independent review. Git mode requires the current worker’s successful code.commit commandId. Rejections return only to consolidation. Stop after successful submission.',
        inputSchema: submitSchema,
        handler: async (caller: Caller, input: ConsolidationSubmit) =>
          await service.submit(caller, input),
      },
    ])
      ctx.effect(() => ctx.tools.register(tool));
  },
};
export default consolidationToolsPlugin;

import type { Context } from 'cordis';
import type {} from '@merv/api/types';
import type {} from './types.js';
import { knowledgeRecordsSchema, knowledgeReferencesSchema } from './input.js';

export const knowledgeToolsPlugin = {
  name: 'merv-knowledge-tools',
  inject: ['knowledge', 'tools'],
  apply(ctx: Context) {
    const knowledge = ctx.knowledge;
    ctx.effect(() =>
      ctx.tools.noun('project.read', {
        tier: 'core',
        readOnly: true,
        description:
          'records (an index of every task and experiment, or some whole) and references (record ids resolved to their labels and states).',
        actions: {
          records: {
            description:
              'Index the project: its id and name, then one short entry per task and experiment (state, review, deliveries, conclusion), terminal work included. Pass ids (up to 20 task or experiment ids) to get those records whole instead, with every attempt, evidence association, submission and delivery confirmation; ids that are neither come back in missing. task.get and experiment.get_state read one record whole. The project Introduction is the Problem of the paper, which paper.read returns. Does not read artifact bytes or advance workflows. To resolve other ids to labels and states use project.references; gate, blockers and next actions use workflow.status_and_next.',
            input: knowledgeRecordsSchema,
            was: ['project.records'],
            handler: async (caller, input) => await knowledge.read(caller, input),
          },
          references: {
            description:
              'Resolve up to 200 project-scoped references to exact record metadata. Accepts record IDs or task:, experiment:, reflection:, research:, artifact:, review:, code-commit: and session-final: followed by an ID. Each result explicitly identifies resolved, missing or unsupported references; a bare ID is unavailable while a service that might hold it is restarting. Does not read artifact bytes.',
            input: knowledgeReferencesSchema,
            was: ['project.references'],
            handler: async (caller, input) => await knowledge.resolve(caller, input.refs),
          },
        },
      }),
    );
  },
};
export default knowledgeToolsPlugin;

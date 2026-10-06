import type { Context } from 'cordis';
import type {} from '@merv/api/types';
import type {} from './types.js';
import { z } from 'zod';
import { knowledgeReferencesSchema } from './input.js';

export const knowledgeToolsPlugin = {
  name: 'merv-knowledge-tools',
  inject: ['knowledge', 'tools'],
  apply(ctx: Context) {
    const knowledge = ctx.knowledge;
    ctx.effect(() =>
      ctx.tools.register({
        name: 'project.records',
        description:
          'Read every project task and experiment, including terminal work, as whole records in one unpaged result: each experiment with all its attempts, evidence associations and submissions. Its tasks array is the same record list returned by task.list. Includes the current project Introduction. Does not read artifact bytes or advance workflows. For one record use task.get or experiment.get_state; to resolve ids to labels and states use project.references. Gate, blockers and next actions use workflow.status_and_next.',
        inputSchema: z.object({}).strict(),
        readOnly: true,
        handler: async (caller) => await knowledge.records(caller),
      }),
    );
    ctx.effect(() =>
      ctx.tools.register({
        name: 'project.references',
        description:
          'Resolve up to 200 project-scoped references to exact record metadata. Accepts record IDs or task:, experiment:, reflection:, research:, artifact:, review:, code-commit: and session-final: followed by an ID. Each result explicitly identifies resolved, missing or unsupported references, or unavailable ones while Code, which resolves code-commit: and session-final:, is not loaded. Does not read artifact bytes.',
        inputSchema: knowledgeReferencesSchema,
        readOnly: true,
        handler: async (caller, input: { refs: string[] }) =>
          await knowledge.resolve(caller, input.refs),
      }),
    );
  },
};
export default knowledgeToolsPlugin;

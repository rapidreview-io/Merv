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
          'Read all project tasks and experiments, with retired claims available only as archivedClaims, including terminal work, as metadata. Includes the current project Introduction and explicit publication availability. Does not read artifact bytes or advance workflows. Gate, blockers and next actions use workflow.status_and_next.',
        inputSchema: z.object({}).strict(),
        readOnly: true,
        handler: async (caller) => await knowledge.records(caller),
      }),
    );
    ctx.effect(() =>
      ctx.tools.register({
        name: 'project.references',
        description:
          'Resolve up to 200 project-scoped references to exact record metadata. Accepts record IDs or task:, experiment:, artifact:, review:, code-proposal:, code-commit: and session-final: followed by an ID. Historical claim: references remain readable. Each result explicitly identifies resolved, missing, unsupported or unpublished references. Published reflection references remain unavailable until a real reflection is published. Does not read artifact bytes.',
        inputSchema: knowledgeReferencesSchema,
        readOnly: true,
        handler: async (caller, input: { refs: string[] }) =>
          await knowledge.resolve(caller, input.refs),
      }),
    );
  },
};
export default knowledgeToolsPlugin;

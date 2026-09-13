import type { Context } from 'cordis';
import { z } from 'zod';
import type { ToolDefinition } from '@merv/api/types';

/** Optional transport adapter; the engine itself never depends on the tool gateway. */
export const workflowToolsPlugin = {
  name: 'merv-workflow-tools',
  inject: ['workflows', 'tools', 'scope'],
  apply(ctx: Context) {
    const workflows = ctx.workflows;
    const scope = ctx.scope;
    const tools = ctx.tools;
    const definitions: ToolDefinition[] = [
      {
        name: 'workflow.list',
        description: 'List workflow instances in the authenticated project.',
        inputSchema: z.object({}).strict(),
        readOnly: true,
        handler: (caller) => workflows.list(caller),
      },
      {
        name: 'workflow.get',
        description: 'Read a workflow instance and its pinned version and revision.',
        inputSchema: z.object({ instanceId: z.string().min(1) }).strict(),
        readOnly: true,
        handler: (caller, input) => workflows.get(caller, input.instanceId),
      },
      {
        name: 'workflow.history',
        description: 'Read the durable transition history of a workflow instance.',
        inputSchema: z.object({ instanceId: z.string().min(1) }).strict(),
        readOnly: true,
        handler: (caller, input) => workflows.history(caller, input.instanceId),
      },
      {
        name: 'workflow.catalog',
        description:
          'List installed versioned workflow definitions. Mutations belong to each program.',
        inputSchema: z.object({}).strict(),
        readOnly: true,
        handler: (caller) => {
          scope.require(caller, 'read');
          return workflows.catalog();
        },
      },
    ];
    // Withdraw every registration immediately; each disposer drains only its own calls.
    for (const definition of definitions) ctx.effect(() => tools.register(definition));
  },
};

export default workflowToolsPlugin;

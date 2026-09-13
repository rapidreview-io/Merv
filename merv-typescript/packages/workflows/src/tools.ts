import type { Context } from 'cordis'
import { z } from 'zod'
import '@merv/contracts'

/** Optional transport adapter; the engine itself never depends on the tool gateway. */
export const workflowToolsPlugin = {
  name: 'merv-workflow-tools',
  inject: ['workflows', 'tools', 'scope'],
  apply(ctx: Context) {
    ctx.effect(function* () {
      yield ctx.tools.register({
        name: 'workflow.list', description: 'List workflow instances in the authenticated project.',
        inputSchema: z.object({}).strict(), readOnly: true,
        handler: caller => ctx.workflows.list(caller),
      })
      yield ctx.tools.register({
        name: 'workflow.get', description: 'Read a workflow instance and its pinned version and revision.',
        inputSchema: z.object({ instanceId: z.string().min(1) }).strict(), readOnly: true,
        handler: (caller, input) => ctx.workflows.get(caller, input.instanceId),
      })
      yield ctx.tools.register({
        name: 'workflow.history', description: 'Read the durable transition history of a workflow instance.',
        inputSchema: z.object({ instanceId: z.string().min(1) }).strict(), readOnly: true,
        handler: (caller, input) => ctx.workflows.history(caller, input.instanceId),
      })
      yield ctx.tools.register({
        name: 'workflow.catalog', description: 'List installed versioned workflow definitions. Mutations belong to each program.',
        inputSchema: z.object({}).strict(), readOnly: true,
        handler: caller => { ctx.scope.require(caller, 'read'); return ctx.workflows.catalog() },
      })
    })
  },
}

export default workflowToolsPlugin

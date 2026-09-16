import type { Context } from 'cordis';
import type {} from '@merv/api/types';
import type { Caller, Data, WorkflowBegin } from '@merv/contracts';
import { z } from 'zod';

/** Generic node guidance and activation; domain tools own the work's handoff. */
export const workflowToolsPlugin = {
  name: 'merv-workflow-tools',
  inject: ['workflows', 'tools'],
  apply(ctx: Context) {
    const workflows = ctx.workflows;
    ctx.effect(() =>
      ctx.tools.register({
        name: 'workflow.status_and_next',
        description:
          'Start or resume here. With instanceId (the task ID for a task), read the current gate, caller-specific next action, blockers, references and revision. Omit instanceId for a project overview of all workflow instances. Optionally preflight an action with proposed input; this does not execute it or reserve permission. Commands recheck current rules. Use stable requestId values when calling mutation tools.',
        readOnly: true,
        inputSchema: z
          .object({
            instanceId: z.string().min(1).optional(),
            action: z.string().min(1).optional(),
            input: z.record(z.unknown()).optional(),
          })
          .strict()
          .superRefine((input, context) => {
            if (input.action !== undefined && input.instanceId === undefined)
              context.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'action requires instanceId',
              });
            if (input.input !== undefined && input.action === undefined)
              context.addIssue({ code: z.ZodIssueCode.custom, message: 'input requires action' });
          }),
        handler: async (
          caller: Caller,
          input: { instanceId?: string; action?: string; input?: Data },
        ) =>
          input.instanceId
            ? await workflows.evaluate(caller, input.instanceId, {
                action: input.action,
                input: input.input,
              })
            : await workflows.overview(caller),
      }),
    );
    ctx.effect(() =>
      ctx.tools.register({
        name: 'workflow.assignment',
        description:
          'Read your current node assignment: brief, context, evidence references, declared tools and handoff. Assignment guards are checked without recording a work start or saving a context package. An eligible reviewer can inspect an open review assignment; claim it through review.start before saving review context or submitting a verdict.',
        readOnly: true,
        inputSchema: z.object({ instanceId: z.string().min(1) }).strict(),
        handler: async (caller: Caller, input: { instanceId: string }) =>
          await workflows.assignment(caller, input.instanceId),
      }),
    );
    ctx.effect(() =>
      ctx.tools.register({
        name: 'workflow.begin',
        description:
          'Before beginning interactive node work, pass its instanceId and current expectedRevision. Rechecks your assignment and records its first start once per revision, then returns the assignment. Retries preserve the first start without changing workflow state or revision. No requestId is needed. This does not create a worker lease or claim a review.',
        readOnly: false,
        inputSchema: z
          .object({
            instanceId: z.string().min(1),
            expectedRevision: z.number().int().nonnegative(),
          })
          .strict(),
        handler: async (caller: Caller, input: WorkflowBegin) =>
          await workflows.begin(caller, input),
      }),
    );
  },
};
export default workflowToolsPlugin;

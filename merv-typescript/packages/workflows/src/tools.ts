import type { Context } from 'cordis';
import type {} from '@merv/api/types';
import type { Caller, Data, WorkflowBegin, WorkflowExtendLimit } from '@merv/contracts';
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
          'Start or resume here. With instanceId (the task ID for a task), read the current gate, caller-specific next action, blockers, references and revision. limits reports each loop limit leaving the current state; at gate loop_limit_reached every allowed return is used and the work waits for a human. Omit instanceId for a project overview of all workflow instances, where such work is listed under escalated. Optionally preflight an action with proposed input; this does not execute it or reserve permission. Commands recheck current rules. Use stable requestId values when calling mutation tools.',
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
        name: 'workflow.catalog',
        description:
          "Read the deployed workflow definitions: each program's states, its initial and terminal states, and the actions that connect them. This is the shape of the machine, never any record's place in it.",
        readOnly: true,
        inputSchema: z.object({}).strict(),
        handler: async () => workflows.catalog(),
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
        name: 'workflow.process',
        description:
          "Read one instance's process graph, derived on read: the pinned definition's states and edges, which edges the record shows were actually taken and by whom, the live status and blockers of the current state's outgoing edges, and dependency edges to other instances. An edge means the machinery stepped through a gate; it never says a finding is correct. Per-record detail stays with the domain read.",
        readOnly: true,
        inputSchema: z.object({ instanceId: z.string().min(1) }).strict(),
        handler: async (caller: Caller, input: { instanceId: string }) =>
          await workflows.process(caller, input.instanceId),
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
    ctx.effect(() =>
      ctx.tools.register({
        name: 'workflow.extend_limit',
        conversation: 'propose',
        description:
          'Allow one workflow instance more rounds of a loop limit it has exhausted (gate loop_limit_reached). Project admins only, never a leased worker. Pass the limit name from status_and_next limits, how many additional returns to allow, a reason and a stable requestId. The grant is recorded and adds to earlier grants; the instance keeps its state and revision. Each additional return buys one more automated review.',
        readOnly: false,
        inputSchema: z
          .object({
            instanceId: z.string().min(1),
            limit: z.string().min(1),
            additional: z.number().int().min(1).max(100),
            reason: z.string().trim().min(1).max(500),
            requestId: z.string().min(1).max(256),
          })
          .strict(),
        handler: async (caller: Caller, input: WorkflowExtendLimit) =>
          await workflows.extendLimit(caller, input),
      }),
    );
  },
};
export default workflowToolsPlugin;

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
    const guide = <T>(caller: Caller, value: T) => ctx.tools.guidance(caller, value);
    const byInstance = z.object({ instanceId: z.string().min(1) }).strict();
    ctx.effect(() =>
      ctx.tools.noun('workflow.read', {
        tier: 'core',
        readOnly: true,
        description:
          'Read workflow guidance: status (start or resume here: a work item’s gate, next action, blockers and limits, or the project overview), assignment (your node assignment), process (one instance’s process graph) and catalog (the deployed workflow definitions).',
        actions: {
          status: {
            description:
              'Start or resume here. With instanceId (the id of the work item, which is its workflow instance id), read the current gate, caller-specific next action, blockers, references and revision. limits reports each loop limit of the work with the state it leaves (from), so the review rounds used and remaining at each gate; at gate loop_limit_reached every allowed return there is used, nothing more is dispatched, and the work escalates to the project’s owner, who may decide it by hand or allow another round. Omit instanceId for a project overview of all workflow instances, where such work is listed under escalated. Optionally preflight an action (a name from actions[].action, never a tool name) with proposed input; this never executes it or reserves permission, and the answer’s preflight says which tool takes it. Commands recheck current rules. Use stable requestId values when calling mutation tools.',
            input: z
              .object({
                instanceId: z.string().min(1).optional(),
                action: z.string().min(1).optional(),
                input: z.record(z.unknown()).optional(),
              })
              .strict()
              .refine((i) => i.action === undefined || i.instanceId !== undefined, {
                message: 'action requires instanceId',
              })
              .refine((i) => i.input === undefined || i.action !== undefined, {
                message: 'input requires action',
              }),
            was: ['workflow.status_and_next'],
            handler: async (
              caller: Caller,
              input: { instanceId?: string; action?: string; input?: Data },
            ) => {
              if (!input.instanceId) return guide(caller, await workflows.overview(caller));
              const decision = await workflows.evaluate(caller, input.instanceId, {
                action: input.action,
                input: input.input,
              });
              if (!input.action) return guide(caller, decision);
              // A submission's input passed here once came back unchanged and was taken for done.
              const tool = decision.actions.find((action) => action.action === input.action)?.tool;
              return guide(caller, {
                ...decision,
                preflight: `Nothing was done: this only checks ${input.action}.${tool ? ` Call ${tool} to take it.` : ''}`,
              });
            },
          },
          assignment: {
            description:
              'Read your current node assignment: brief, context, evidence references, declared tools and handoff. Assignment guards are checked without recording a work start or saving a context package. Reading an assignment claims nothing; its handoff names the command that does.',
            input: byInstance,
            was: ['workflow.assignment'],
            handler: async (caller: Caller, input: { instanceId: string }) =>
              await workflows.assignment(caller, input.instanceId),
          },
          process: {
            description:
              "Read one instance's process graph, derived on read: the pinned definition's states and edges, which edges the record shows were actually taken and by whom, the live status and blockers of the current state's outgoing edges, and dependency edges to other instances. An edge means the machinery stepped through a gate; it never says a finding is correct. Per-record detail stays with the domain read.",
            input: byInstance,
            was: ['workflow.process'],
            handler: async (caller: Caller, input: { instanceId: string }) =>
              guide(caller, await workflows.process(caller, input.instanceId)),
          },
          catalog: {
            description:
              "Read the deployed workflow definitions: each program's states, its initial and terminal states, and the actions that connect them. This is the shape of the machine, never any record's place in it.",
            input: z.object({}).strict(),
            was: ['workflow.catalog'],
            handler: async (caller: Caller) => guide(caller, workflows.catalog()),
          },
        },
      }),
    );
    ctx.effect(() =>
      ctx.tools.noun('workflow.write', {
        description:
          'Move workflow instances: begin (record the first start of interactive node work and return its assignment) and extend_limit (a project admin allows an instance more rounds of an exhausted loop limit).',
        actions: {
          begin: {
            description:
              'Before beginning interactive node work, pass its instanceId and current expectedRevision. Rechecks your assignment and records its first start once per revision, then returns the assignment. Retries preserve the first start without changing workflow state or revision. No requestId is needed. This does not create a worker lease or claim a review.',
            input: z
              .object({
                instanceId: z.string().min(1),
                expectedRevision: z.number().int().nonnegative(),
              })
              .strict(),
            was: ['workflow.begin'],
            handler: async (caller: Caller, input: WorkflowBegin) =>
              await workflows.begin(caller, input),
          },
          extend_limit: {
            description:
              'Allow one workflow instance more rounds of a loop limit it has exhausted (gate loop_limit_reached). Project admins only, never a leased worker. Pass the limit name from status_and_next limits, how many additional returns to allow, a reason and a stable requestId. The grant is recorded and adds to earlier grants; the instance keeps its state and revision. Each additional return allows one more pass through the capped loop. additional 0 adds no round and only resumes work suspended before its rounds were used up.',
            input: z
              .object({
                instanceId: z.string().min(1),
                limit: z.string().min(1),
                additional: z.number().int().min(0).max(100),
                reason: z.string().trim().min(1).max(500),
                requestId: z.string().min(1).max(256),
              })
              .strict(),
            was: ['workflow.extend_limit'],
            handler: async (caller: Caller, input: WorkflowExtendLimit) =>
              await workflows.extendLimit(caller, input),
          },
        },
      }),
    );
    ctx.effect(() =>
      ctx.tools.contributeInstructions(
        "workflow.read status and assignment return Merv's own guidance for a piece of work: its next steps, instructions and blockers. Review rounds are capped: status's limits show the rounds used and left at each gate, and when a gate's rounds are used up the work stops and escalates to the project's owner instead of returning for another round.",
      ),
    );
  },
};
export default workflowToolsPlugin;

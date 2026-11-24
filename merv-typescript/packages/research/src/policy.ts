import type {
  Artifact,
  WorkflowCheckContext,
  WorkflowDefinition,
  WorkflowPolicy,
} from '@merv/contracts';
import type { ResearchContext } from './index.js';
import { endChoiceSchema, choiceSchema, parse } from './input.js';
import { ready } from './integration.js';

// The research workflow and the policy its gate judges by; it runs on ResearchService
// (index.ts) as its ResearchContext.
const stages = ['defining', 'researching', 'consolidating', 'complete'] as const;
export type Stage = (typeof stages)[number];
const instructions: Record<Stage, string> = {
  defining:
    'Complete the living paper’s problem, scope, goals and constraints, then advance to research.',
  researching:
    'Advance once all selected work has finished; failed and abandoned work are outcomes too. A project without Git completes; when Code hosts the project, accepted code that main does not hold yet is integrated by one consolidation task and published to main.',
  consolidating:
    'Wait for the consolidation task to be accepted and its publication to reach main, then complete the research cycle. A publication main overtook injects a successor task. Paper changes are reviewed within the task and experiment workflows.',
  complete:
    'The selected research and any required code integration are complete. Paper changes were handled by their scientific reviews.',
};
/**
 * The one research version: array order is part of its published fingerprint. Version 6 also
 * reflected; its cycles are history, read through their pinned definition.
 */
export const definition: WorkflowDefinition = {
  name: 'research',
  version: 7,
  initial: 'defining',
  states: [...stages, 'abandoned', 'failed'],
  terminal: ['complete', 'abandoned', 'failed'],
  edges: [
    ...stages
      .slice(0, -1)
      .map((from, index) => ({ from, action: 'advance', to: stages[index + 1] })),
    { from: 'researching', action: 'complete', to: 'complete' },
    ...stages.slice(0, -1).flatMap((from) => [
      { from, action: 'abandon', to: 'abandoned' },
      { from, action: 'mark_failed', to: 'failed' },
    ]),
    { from: 'consolidating', action: 'reinject', to: 'consolidating' },
  ],
};

export function policy(ctx: ResearchContext): WorkflowPolicy {
  return {
    successStates: ['complete'],
    dependencyFailureAction: 'end',
    describe: async (context) => {
      const record = await ctx.get(context.caller, context.snapshot.id, context.tx);
      const previous = record.previousCycleId
        ? await ctx.row(context.caller, record.previousCycleId, context.tx)
        : null;
      return {
        label: record.name,
        owner: { actorId: record.ownerId },
        gate: context.snapshot.state,
        waiting:
          context.snapshot.state === 'researching'
            ? 'Wait for the selected work to finish, including failed and abandoned work, then advance.'
            : instructions[context.snapshot.state as Stage],
        references: [
          ...record.integrations.map((id) => ({
            kind: 'workflow',
            id,
            label: 'Consolidation task',
          })),
          ...(record.successorId
            ? [{ kind: 'workflow', id: record.successorId, label: 'Next round' }]
            : []),
          ...(record.digest
            ? [{ kind: 'artifact', id: record.digest.id, label: 'Round digest' }]
            : []),
          ...(previous?.digest
            ? [
                {
                  kind: 'artifact',
                  id: (JSON.parse(previous.digest) as Artifact).id,
                  label: 'Previous round digest',
                },
              ]
            : []),
        ],
      };
    },
    actions: [
      {
        name: 'end',
        states: [...stages.slice(0, -1)],
        transitions: ['abandon', 'mark_failed'],
        // Never the suggested move: ending is what you reach for when the work cannot
        // go on, and the engine offers it by name when a prerequisite has died.
        suggested: false,
        tool: 'research.write:end',
        instruction:
          'End this research cycle when it cannot reach an answer: abandoned when the question is no longer worth pursuing, failed when it was pursued and cannot be completed. Its children keep their own records. Requires a specific reason. This is terminal. While the cycle is still defining or researching, research.replan reselects its work instead.',
        requiredInput: ['outcome', 'reason'],
        arguments: (context: WorkflowCheckContext) => ({
          researchId: context.snapshot.id,
          expectedRevision: context.snapshot.revision,
        }),
        check: async (context: WorkflowCheckContext) => {
          if (ctx.checked.found(context)) return;
          const record = await ctx.get(context.caller, context.snapshot.id, context.tx);
          await ctx.authorize(context.caller, record, context.tx);
          if (context.input) parse(endChoiceSchema, context.input);
        },
      },
      ...stages.slice(0, -1).map((stage) => ({
        name: `advance_${stage}`,
        states: [stage],
        transitions: [
          'advance',
          ...(stage === 'researching' ? ['complete'] : []),
          ...(stage === 'consolidating' ? ['reinject'] : []),
        ],
        tool: 'research.write:advance',
        instruction: instructions[stage],
        arguments: (context: WorkflowCheckContext) => ({
          researchId: context.snapshot.id,
          expectedRevision: context.snapshot.revision,
        }),
        check: async (context: WorkflowCheckContext) => {
          if (ctx.checked.found(context)) return;
          const record = await ctx.get(context.caller, context.snapshot.id, context.tx);
          await ctx.authorize(context.caller, record, context.tx);
          await ready(
            ctx,
            context.caller,
            record,
            context.tx,
            parse(choiceSchema, context.input ?? {}),
          );
        },
      })),
    ],
  };
}

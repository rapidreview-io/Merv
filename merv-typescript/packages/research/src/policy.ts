import type {
  Artifact,
  WorkflowCheckContext,
  WorkflowDefinition,
  WorkflowPolicy,
} from '@merv/contracts';
import type { ResearchService } from './index.js';
import { endChoiceSchema, nextWaveChoiceSchema, parse } from './input.js';

// The research workflow and the policy its gate judges by. The policy is Lean-sensitive and
// moved here verbatim; ResearchService (index.ts) runs it as its own method.
const stages = ['defining', 'researching', 'reflecting', 'consolidating', 'complete'] as const;
export type Stage = (typeof stages)[number];
const nextWaveGuidance =
  'When the approved reflection carries a structured plan that continues, completing the cycle requires nextWave: "create" opens the plan\'s tasks, experiments and the next research cycle in the same transaction, and "skip" completes without them. When Code hosts the project, the cycle also waits for accepted code to reach main before the next wave starts. A text change specification creates nothing; follow-on work is then the owner\'s to create.';
const instructions: Record<Stage, string> = {
  defining:
    'Complete the living paper’s problem, scope, goals and constraints, then advance to research.',
  researching:
    'Reflect once all selected work has finished. Failed and abandoned work are outcomes to examine.',
  reflecting: `Complete all reflection lenses and independent synthesis review, then finish the cycle or start its consolidation: accepted code that main does not hold yet is integrated by one task and published to main. ${nextWaveGuidance}`,
  consolidating: `Wait for the consolidation task to be accepted and its publication to reach main, then complete the research cycle. A publication main overtook injects a successor task. Paper changes are reviewed within the experiment and reflection workflows. ${nextWaveGuidance}`,
  complete:
    'The selected research, reflection and any required code integration are complete. Paper changes were handled by their scientific reviews. If the owner chose to create an approved plan, the next research cycle is referenced here.',
};
/** The one research version: array order is part of its published fingerprint. */
export const definition: WorkflowDefinition = {
  name: 'research',
  version: 6,
  initial: 'defining',
  states: [...stages, 'abandoned', 'failed'],
  terminal: ['complete', 'abandoned', 'failed'],
  edges: [
    ...stages
      .slice(0, -1)
      .map((from, index) => ({ from, action: 'advance', to: stages[index + 1] })),
    { from: 'reflecting', action: 'complete', to: 'complete' },
    ...stages.slice(0, -1).flatMap((from) => [
      { from, action: 'abandon', to: 'abandoned' },
      { from, action: 'mark_failed', to: 'failed' },
    ]),
    { from: 'consolidating', action: 'reinject', to: 'consolidating' },
  ],
};

export function policy(this: ResearchService): WorkflowPolicy {
  return {
    successStates: ['complete'],
    dependencyFailureAction: 'end',
    describe: async (context) => {
      const record = await this.get(context.caller, context.snapshot.id, context.tx);
      const previous = record.previousCycleId
        ? await this.row(context.caller, record.previousCycleId, context.tx)
        : null;
      return {
        label: record.name,
        owner: { actorId: record.ownerId },
        gate: context.snapshot.state,
        waiting:
          context.snapshot.state === 'researching'
            ? 'Wait for the selected work to finish, including failed and abandoned work, then open reflection.'
            : instructions[context.snapshot.state as Stage],
        references: [
          ...this.children(record).map((id) => ({
            kind: 'workflow',
            id,
            label: 'Child workflow',
          })),
          ...(record.successorId
            ? [{ kind: 'workflow', id: record.successorId, label: 'Next research cycle' }]
            : []),
          ...(record.digest
            ? [{ kind: 'artifact', id: record.digest.id, label: 'Cycle digest' }]
            : []),
          ...(previous?.digest
            ? [
                {
                  kind: 'artifact',
                  id: (JSON.parse(previous.digest) as Artifact).id,
                  label: 'Predecessor cycle digest',
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
        tool: 'research.end',
        instruction:
          'End this research cycle when it cannot reach an answer: abandoned when the question is no longer worth pursuing, failed when it was pursued and cannot be completed. Its children keep their own records. Requires a specific reason. This is terminal. While the cycle is still defining or researching, research.replan reselects its work instead.',
        requiredInput: ['outcome', 'reason'],
        arguments: (context: WorkflowCheckContext) => ({
          researchId: context.snapshot.id,
          expectedRevision: context.snapshot.revision,
        }),
        check: async (context: WorkflowCheckContext) => {
          if (this.checked.found(context)) return;
          const record = await this.get(context.caller, context.snapshot.id, context.tx);
          await this.authorize(context.caller, record, context.tx);
          if (context.input) parse(endChoiceSchema, context.input);
        },
      },
      ...stages.slice(0, -1).map((stage) => ({
        name: `advance_${stage}`,
        states: [stage],
        transitions: [
          'advance',
          ...(stage === 'reflecting' ? ['complete'] : []),
          ...(stage === 'consolidating' ? ['reinject'] : []),
        ],
        tool: 'research.advance',
        instruction: instructions[stage],
        arguments: (context: WorkflowCheckContext) => ({
          researchId: context.snapshot.id,
          expectedRevision: context.snapshot.revision,
        }),
        check: async (context: WorkflowCheckContext) => {
          if (this.checked.found(context)) return;
          const record = await this.get(context.caller, context.snapshot.id, context.tx);
          await this.authorize(context.caller, record, context.tx);
          await this.ready(
            context.caller,
            record,
            context.tx,
            parse(nextWaveChoiceSchema, context.input ?? {}),
          );
        },
        // Creating a plan's work is never implied by an advance: a caller that does not know
        // about the plan is asked, rather than launching work an agent wrote.
        ...(stage === 'reflecting' || stage === 'consolidating'
          ? {
              requiredInput: async (context: WorkflowCheckContext) => {
                const { caller, snapshot, tx, input } = context;
                // A choice made, or asked by the advance taking this, was judged by the check;
                // a skip reads no plan.
                const choice = parse(nextWaveChoiceSchema, input ?? {});
                if (choice.nextWave || this.checked.found(context)) return [];
                // Without Git's answer a preflight reads the cycle as completing: the choice
                // is asked whenever the plan continues, and honoured only when it completes. The
                // transition carries that answer, so an advance that injects is not asked.
                const record = await this.get(caller, snapshot.id, tx);
                return (await this.continuing(caller, record, tx, choice.move ?? 'complete'))
                  ? ['nextWave']
                  : [];
              },
            }
          : {}),
      })),
    ],
  };
}

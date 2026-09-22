import type { Context } from 'cordis';
import type { Caller } from '@merv/contracts';
import type {} from '@merv/api/types';
import type { ExperimentAttach, ExperimentCreate, ExperimentTransition } from './types.js';
import {
  experimentAttachSchema,
  experimentCreateSchema,
  experimentExhibitSchema,
  experimentGetSchema,
  experimentListSchema,
  experimentTransitionSchema,
} from './input.js';

export const experimentsToolsPlugin = {
  name: 'merv-experiments-tools',
  inject: ['experiments', 'tools'],
  apply(ctx: Context) {
    const experiments = ctx.experiments;
    for (const definition of [
      {
        name: 'experiment.create',
        description:
          'Create a research experiment in the selected project with an immutable name, intent and optional details. Dependencies are work-item IDs in the same project. Starts planning attempt 1; at most seven experiments may remain active. Optional workspace "git" (requires Code) runs the experiment in a private Git checkout. Until an administrator binds and imports the project, the checkout uses the runner’s central base. In a hosted project Code derives its base from accepted dependencies, looking through code-less successes and using imported main when there is no contributing commit. The first planning or running lease pins it so execution inherits the plan’s base. Several commits share an automatic merge; conflicts wait for one reviewed resolution task. Unverified or unimported code shows code_base_pending; code_merge_required means automatic merging is disabled. Blocked work is never launched. Optional baseTaskId is the older explicit form: it names one Git task, which must also be in dependsOn, whose accepted delivered commit becomes the base. Reuse the same requestId and input to recover a committed response.',
        inputSchema: experimentCreateSchema,
        handler: async (caller: Caller, input: ExperimentCreate) =>
          await experiments.create(caller, input),
      },
      {
        name: 'experiment.list',
        description:
          "Read the selected project's experiment records, including terminal work, attempt history and sealed submission metadata. Artifact bytes use artifact.read. Current gate and next-action guidance come from workflow.status_and_next.",
        inputSchema: experimentListSchema,
        readOnly: true,
        handler: async (caller: Caller) => await experiments.list(caller),
      },
      {
        name: 'experiment.get_state',
        description:
          "Read one experiment's current workflow revision, attempt, approved-plan submission, evidence associations and immutable review rounds. This returns metadata only. Use the experiment ID with workflow.status_and_next and workflow.assignment for its current gate and assigned context.",
        inputSchema: experimentGetSchema,
        readOnly: true,
        handler: async (caller: Caller, input: { experimentId: string }) =>
          await experiments.get(caller, input.experimentId),
      },
      {
        name: 'experiment.attach',
        description:
          'Associate a retained artifact with this experiment at the exact current attemptIndex and expectedRevision. During planning use role plan, and role feasibility for the one JSON feasibility statement a design is submitted with: {formatVersion:1, resources:[{kind: data|compute|time, name, unit, required, available, basis}], dependencies:[{name, present, basis}], blockers:[]}, with at least one data resource and every basis naming the record the number was measured from. During execution use result or report. Selecting what the report covers is the authorship; do not hide known rework. A new version replaces the logical role/path slot while preserving earlier evidence. The active worker must own the evidence or have the exact frozen recovery input. Results explicitly distinguish JSON from qualitative evidence. The metrics exhibit is system-generated.',
        inputSchema: experimentAttachSchema,
        handler: async (caller: Caller, input: ExperimentAttach) =>
          await experiments.attach(caller, input),
      },
      {
        name: 'experiment.transition',
        description:
          'Apply an owner action at the current expectedRevision: submit_design, submit_results, retry_running, abandon or mark_failed. Submission seals evidence and queues independent review atomically; reviewers alone apply their verdict through review.submit. Retry preserves the approved plan and attempt. Terminal closure requires a specific reason in evidence.reason. Reuse an identical requestId for an uncertain response, and stop after a successful node handoff.',
        inputSchema: experimentTransitionSchema,
        handler: async (caller: Caller, input: ExperimentTransition) =>
          await experiments.transition(caller, input),
      },
      {
        name: 'experiment.exhibit',
        description:
          'Preview the deterministic metrics exhibit for this attempt from retained result data, source hashes and the first execution start. JSON data is preserved as observations; this does not calculate a score or decide scientific success. Result submission pins the applicable exhibit with its immutable review round.',
        inputSchema: experimentExhibitSchema,
        readOnly: true,
        handler: async (caller: Caller, input: { experimentId: string }) =>
          await experiments.exhibit(caller, input.experimentId),
      },
    ])
      ctx.effect(() => ctx.tools.register(definition));
  },
};
export default experimentsToolsPlugin;

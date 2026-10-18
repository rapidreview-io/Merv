import type { Context } from 'cordis';
import type { Caller } from '@merv/contracts';
import type {} from '@merv/api/types';
import type {
  Experiment,
  ExperimentAttach,
  ExperimentCreate,
  ExperimentExhibit,
  ExperimentTransition,
} from './types.js';
import {
  experimentAttachSchema,
  experimentCreateSchema,
  experimentExhibitSchema,
  experimentGetSchema,
  experimentListSchema,
  experimentTransitionSchema,
} from './input.js';

/** The largest exhibit an agent is shown whole; Merv's page reads every exhibit whole. */
export const EXHIBIT_SHOWN_BYTES = 16_000;

/**
 * What an agent is shown of an exhibit preview: its name, hash and result files by id, and its
 * content only while small. The content repeats every result file's data, so a large one
 * (0.5–1.3 MB, escaped inside the JSON) filled executors' contexts at each call (2026-10).
 */
export function exhibitPreview(exhibit: ExperimentExhibit) {
  const bytes = Buffer.byteLength(exhibit.content);
  return {
    experimentId: exhibit.experimentId,
    attemptIndex: exhibit.attemptIndex,
    path: exhibit.path,
    hash: exhibit.hash,
    bytes,
    willPin: exhibit.willPin,
    startedAt: exhibit.startedAt,
    resultFiles: exhibit.sources.map((source) => ({
      path: source.path,
      artifactId: source.artifactId,
      sha256: source.hash,
      resultFormat: source.resultFormat ?? 'json',
    })),
    ...(bytes <= EXHIBIT_SHOWN_BYTES
      ? { exhibit: JSON.parse(exhibit.content) as unknown }
      : {
          omitted: `The exhibit's ${bytes} bytes are not shown: they hold each JSON result file's data exactly as attached, under resultFiles in path order. Read a result with artifact.read by its artifactId.`,
        }),
  };
}

export const experimentsToolsPlugin = {
  name: 'merv-experiments-tools',
  inject: ['experiments', 'tools'],
  apply(ctx: Context) {
    const experiments = ctx.experiments;
    for (const definition of [
      {
        name: 'experiment.create',
        description:
          'Create a research experiment in the selected project with an immutable name, intent and optional details. Dependencies are task IDs in the same project; an order between two experiments is a task between them. Starts planning attempt 1; at most seven experiments may remain active. Full training and evaluations require independent design approval. Name actual missing data, compute, budget or prerequisite work separately. Every experiment uses a private managed Git checkout, independently of GitHub. Code derives its base from accepted dependsOn prerequisites and project main. The first planning or running lease pins this base. Conflicting dependencies wait for reviewed resolution. Missing repository storage blocks execution rather than using scratch. Retain implementation with code.commit and experimental outputs as artifacts. Reuse the same requestId and input to recover a committed response.',
        inputSchema: experimentCreateSchema.omit({ workspace: true }),
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
          'Associate a retained artifact with this experiment at the exact current attemptIndex and expectedRevision. Attached JSON or Markdown evidence must be valid UTF-8 and at most 64,000 bytes; compact JSON before upload without dropping run-level evidence. Larger supplementary files can remain standalone artifacts. An attempt keeps at most 100 result files; attaching at a path it already holds replaces that one. Artifact retention itself does not require joining or claiming an experiment; use artifact.create to save project evidence independently. An unleased experiment accepts association from its owner or a project administrator without a worker session. While a worker holds the experiment lease, only that worker may associate evidence. During planning use role plan, and role feasibility for the one JSON feasibility statement a design is submitted with: {formatVersion:1, resources:[{kind: data|compute|time, name, unit, required, available, basis}], dependencies:[{name, present, basis}], blockers:[]}, with at least one data resource and every basis naming the record the number was measured from. During execution use result or report. Selecting what the report covers is the authorship; do not hide known rework. A new version replaces the logical role/path slot while preserving earlier evidence. The associating actor must own the evidence or have the exact frozen recovery input. Results explicitly distinguish JSON from qualitative evidence. The metrics exhibit is system-generated.',
        inputSchema: experimentAttachSchema,
        handler: async (caller: Caller, input: ExperimentAttach) =>
          await experiments.attach(caller, input),
      },
      {
        name: 'experiment.transition',
        act: {
          title: ({ transition }: Record<string, unknown>) =>
            ({
              submit_design: 'Submit design',
              submit_results: 'Submit results',
              retry_running: 'Retry running',
              abandon: 'Abandon experiment',
              mark_failed: 'Mark experiment failed',
            })[String(transition)] ?? 'Move experiment',
          says: 'transition',
        },
        description:
          'Apply an owner action at the current expectedRevision: submit_design, submit_results, retry_running, abandon or mark_failed. Submission seals the evidence attached with experiment.attach and queues independent review atomically, so submit_design and submit_results take no evidence argument; reviewers alone apply their verdict through review.submit. submit_results comes only from the leased worker session that ran the attempt. retry_running, for an infrastructure interruption, preserves the approved plan and attempt and requires the interruption’s reason in evidence.reason, as terminal closure requires a specific reason there. Reuse an identical requestId for an uncertain response, and stop after a successful node handoff.',
        inputSchema: experimentTransitionSchema,
        // Ending an experiment cannot be undone: the person does it.
        conversation: (input: ExperimentTransition) =>
          ['abandon', 'mark_failed'].includes(input.transition) ? 'propose' : undefined,
        handler: async (caller: Caller, input: ExperimentTransition) =>
          await experiments.transition(caller, input),
        receipt: (experiment: Experiment) => ({
          summary: {
            id: experiment.id,
            state: experiment.workflow.state,
            revision: experiment.workflow.revision,
            reviewId: experiment.reviewId,
          },
          reread: ['experiment.get_state', 'workflow.status_and_next'],
        }),
      },
      {
        name: 'experiment.exhibit',
        description:
          'Preview the deterministic metrics exhibit for this attempt from retained result data, source hashes and the first execution start. JSON data is preserved as observations; this does not calculate a score or decide scientific success. Result submission pins the applicable exhibit with its immutable review round. You get its path (the filename a report names), hash, size, whether submission pins it and its result files by artifactId; its content, which repeats those files’ data, only up to 16,000 bytes.',
        inputSchema: experimentExhibitSchema,
        readOnly: true,
        handler: async (caller: Caller, input: { experimentId: string }) =>
          await experiments.exhibit(caller, input.experimentId),
        present: (exhibit: ExperimentExhibit) => ({
          content: [{ type: 'text' as const, text: JSON.stringify(exhibitPreview(exhibit)) }],
        }),
      },
    ])
      ctx.effect(() => ctx.tools.register(definition));
  },
};
export default experimentsToolsPlugin;

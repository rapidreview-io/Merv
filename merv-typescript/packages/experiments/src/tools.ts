import type { Context } from 'cordis';
import type { Caller } from '@merv/contracts';
import { z } from 'zod';
import type {} from '@merv/api/types';
import type {
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

/** The fields a script relies on in each read, as passthrough objects: never validators. */
const record = z
  .object({
    id: z.string(),
    name: z.string(),
    intent: z.string(),
    workflow: z.object({ state: z.string(), revision: z.number() }).passthrough(),
    settled: z.boolean(),
    reviewId: z.string().nullable(),
  })
  .passthrough();
const exhibitOutput = z
  .object({ experimentId: z.string(), path: z.string(), hash: z.string(), willPin: z.boolean() })
  .passthrough();

export const experimentsToolsPlugin = {
  name: 'merv-experiments-tools',
  inject: ['experiments', 'tools'],
  apply(ctx: Context) {
    const experiments = ctx.experiments;
    ctx.effect(() =>
      ctx.tools.noun('experiment.read', {
        tier: 'core',
        readOnly: true,
        description:
          "Read experiments: list (the project's experiment records, terminal work included), get (one experiment's revision, attempt, approved plan, evidence and review rounds) and exhibit (the metrics exhibit the running attempt's results would pin). It changes nothing.",
        actions: {
          list: {
            description:
              "Read the selected project's experiment records, including terminal work, attempt history and sealed submission metadata. Artifact bytes use artifact.read. Current gate and next-action guidance come from workflow.status_and_next.",
            input: experimentListSchema,
            output: z.array(record),
            was: ['experiment.list'],
            handler: async (caller: Caller) => await experiments.list(caller),
          },
          get: {
            description:
              "Read one experiment's current workflow revision, attempt, approved-plan submission, evidence associations and immutable review rounds. This returns metadata only. Use the experiment ID with workflow.status_and_next and workflow.assignment for its current gate and assigned context.",
            input: experimentGetSchema,
            output: record,
            was: ['experiment.get_state'],
            handler: async (caller: Caller, input: { experimentId: string }) =>
              await experiments.get(caller, input.experimentId),
          },
          exhibit: {
            description:
              'Preview the deterministic metrics exhibit for this attempt from retained result data, source hashes and the first execution start. JSON data is preserved as observations; this does not calculate a score or decide scientific success. Result submission pins the applicable exhibit with its immutable review round. You get its path (the filename a report names), hash, bytes, willPin (whether submission pins it) and resultFiles by artifactId; the exhibit itself, which repeats those files’ data, comes under exhibit only up to 16,000 bytes, and otherwise omitted says so.',
            input: experimentExhibitSchema,
            output: exhibitOutput,
            was: ['experiment.exhibit'],
            handler: async (caller: Caller, input: { experimentId: string }) =>
              await experiments.exhibit(caller, input.experimentId),
            present: (exhibit: unknown) => ({
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(exhibitPreview(exhibit as ExperimentExhibit)),
                },
              ],
            }),
          },
        },
      }),
    );
    ctx.effect(() =>
      ctx.tools.noun('experiment.write', {
        tier: 'core',
        description:
          'Change experiments: create (a new experiment, planning attempt 1), attach (a retained artifact as plan, feasibility, result or report of the current attempt) and transition (submit_design, submit_results, retry_running, abandon or mark_failed at the current revision).',
        actions: {
          create: {
            description:
              'Create a research experiment in the selected project with an immutable name, intent and optional details. Dependencies are task IDs in the same project; an order between two experiments is a task between them. Starts planning attempt 1; at most seven experiments may remain active. Full training and evaluations require independent design approval. Name actual missing data, compute, budget or prerequisite work separately. Every experiment uses a private managed Git checkout, independently of GitHub. Code derives its base from accepted dependsOn prerequisites and project main. The first planning or running lease pins this base. Conflicting dependencies wait for reviewed resolution. Missing repository storage blocks execution rather than using scratch. Retain implementation with code.commit and experimental outputs as artifacts. Reuse the same requestId and input to recover a committed response.',
            input: experimentCreateSchema.omit({ workspace: true }),
            was: ['experiment.create'],
            handler: async (caller: Caller, input: ExperimentCreate) =>
              await experiments.create(caller, input),
          },
          attach: {
            description:
              'Associate a retained artifact with this experiment at the exact current attemptIndex and expectedRevision. A plan, feasibility statement, report or JSON result must be valid UTF-8 and at most 64,000 bytes; compact JSON before upload without dropping run-level evidence. A result with resultFormat qualitative is referenced without being read, so attach a larger or binary output (a checkpoint, an archive, a capture collection) that way and the reviewer receives it with the submission. An attempt keeps at most 100 result files. Artifact retention itself does not require joining or claiming an experiment; use artifact.create to save project evidence independently. An unleased experiment accepts association from its owner or a project administrator without a worker session. While a worker holds the experiment lease, only that worker may associate evidence; to give it information or an authorization meanwhile, send it with session.message. During planning use role plan, and role feasibility for the one JSON feasibility statement a design is submitted with: {formatVersion:1, resources:[{kind: data|compute|time, name, unit, required, available, basis}], dependencies:[{name, present, basis}], blockers:[string]}, with no other keys, at least one data resource and every basis naming the record the number was measured from. During execution use result or report. Selecting what the report covers is the authorship; do not hide known rework. A result at a path the attempt already holds replaces that result, and a plan, feasibility statement or report replaces the attempt’s current one at any path, so put an addendum in the report itself or attach it as a qualitative result; earlier versions stay retained, and the response lists under replaced what left the selection. A caller attaches evidence it created or, as a worker, evidence any earlier visit to this step at the same revision created, this attempt’s Sandboxes capture or evidence the step had selected when the visit began; the plan or report a submission is made with must still be the submitting worker’s own. The metrics exhibit is system-generated.',
            input: experimentAttachSchema,
            was: ['experiment.attach'],
            handler: async (caller: Caller, input: ExperimentAttach) =>
              await experiments.attach(caller, input),
          },
          transition: {
            description:
              'Apply an owner action at the current expectedRevision: submit_design, submit_results, retry_running, abandon or mark_failed. Submission seals the evidence attached with experiment.attach and queues independent review atomically, so submit_design and submit_results take no evidence argument; reviewers alone apply their verdict through review.submit. submit_results comes only from the leased worker session that ran the attempt. retry_running, for an infrastructure interruption, preserves the approved plan and attempt and requires the interruption’s reason in evidence.reason, as terminal closure requires a specific reason there. Reuse an identical requestId for an uncertain response, and stop after a successful node handoff.',
            input: experimentTransitionSchema,
            was: ['experiment.transition'],
            handler: async (caller: Caller, input: ExperimentTransition) =>
              await experiments.transition(caller, input),
          },
        },
      }),
    );
  },
};
export default experimentsToolsPlugin;

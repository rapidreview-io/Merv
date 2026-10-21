import type { Context } from 'cordis';
import { z } from 'zod';
import type {} from '@merv/api/types';
import { experimentReminder, experimentHistory, experimentListPage } from './read-view.js';
import type { ExperimentExhibit } from './types.js';
import {
  experimentAttachSchema,
  experimentCreateSchema,
  experimentExhibitSchema,
  experimentGetSchema,
  experimentListSchema,
  experimentTransitionSchema,
} from './input.js';

export const EXHIBIT_SHOWN_BYTES = 16_000;

/** Large exhibits repeat result-file bytes; show references instead to preserve context space. */
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
        summary: 'Read experiments and metrics exhibits.',
        description:
          "Read experiments: list (paged experiment summaries, terminal work included), get (current experiment context or paged history) and exhibit (the metrics exhibit the running attempt's results would pin). It changes nothing.",
        actions: {
          list: {
            description:
              'List compact experiment summaries, 20 per page (maximum 100). Follow next for more and each reference for intent, details, current evidence and history. Includes terminal work.',
            input: experimentListSchema,
            output: z.object({
              items: z.array(z.object({ id: z.string(), name: z.string() }).passthrough()),
              total: z.number(),
              next: z.unknown(),
            }),
            was: ['experiment.list'],
            handler: async (caller, input) => {
              const page = experimentListPage(
                await experiments.summaries(caller),
                input.offset,
                input.limit,
              );
              return {
                ...page,
                next: ctx.tools.guidance(caller, page.next),
                items: page.items.map((item) => ({
                  ...item,
                  reference: ctx.tools.guidance(caller, item.reference),
                })),
              };
            },
          },
          get: {
            description:
              'Recover experiment context: intent, details, current attempt/evidence and pinned submissions. Feedback shows the latest five notes, up to 2,000 chars each. Follow references for full attempts, evidence or submissions with history and pagination (20 by default, maximum 100). workflow.assignment refreshes the assigned context; artifact.read opens document contents.',
            input: experimentGetSchema,
            output: z.union([
              record,
              z
                .object({
                  experimentId: z.string(),
                  history: z.string(),
                  items: z.array(z.unknown()),
                  next: z.unknown(),
                })
                .passthrough(),
            ]),
            was: ['experiment.get_state'],
            handler: async (caller, input) => {
              const experiment = await experiments.get(caller, input.experimentId);
              if (input.history) {
                const page = experimentHistory(
                  experiment,
                  input.history,
                  input.offset,
                  input.limit,
                );
                return {
                  ...page,
                  next: ctx.tools.guidance(caller, page.next),
                  current: ctx.tools.guidance(caller, page.current),
                };
              }
              const reminder = experimentReminder(experiment);
              return { ...reminder, references: ctx.tools.guidance(caller, reminder.references) };
            },
          },
          exhibit: {
            summary:
              'Preview attempt exhibit from retained results, hashes and first execution start. JSON stays observations: no computed score/success judgment. Submission pins the applicable exhibit. Returns report path/hash/bytes/willPin/resultFiles by artifactId; its data under exhibit only when ≤16,000 bytes, else omitted explains.',
            description:
              'Preview the deterministic metrics exhibit for this attempt from retained result data, source hashes and the first execution start. JSON data is preserved as observations; this does not calculate a score or decide scientific success. Result submission pins the applicable exhibit with its immutable review round. You get its path (the filename a report names), hash, bytes, willPin (whether submission pins it) and resultFiles by artifactId; the exhibit itself, which repeats those files’ data, comes under exhibit only up to 16,000 bytes, and otherwise omitted says so.',
            input: experimentExhibitSchema,
            output: exhibitOutput,
            was: ['experiment.exhibit'],
            handler: (caller, input) => experiments.exhibit(caller, input.experimentId),
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
        summary: 'Create experiments, attach evidence or transition work.',
        description:
          'Change experiments: create (a new experiment, planning attempt 1), attach (a retained artifact as plan, feasibility, result or report of the current attempt) and transition (submit_design, submit_results, retry_running, abandon or mark_failed at the current revision).',
        actions: {
          create: {
            summary:
              'Create immutable name/intent/details; starts planning attempt 1, maximum seven active experiments. Use intent for the question or objective. Use details for explicit requests and preferences: reference papers or previous experiments (include links or IDs), parameters, constraints, or approaches to follow. Leave details empty when the planner should choose the strategy from intent within project constraints. dependsOn contains same-project task IDs; order experiments via intervening tasks. Independent design approval precedes full training/evaluation; name missing data/compute/budget/prerequisites separately. Private managed Git uses accepted dependencies and main, pinned by the first planning/running lease. Conflicts await reviewed resolution; unavailable storage blocks execution, never scratch. Use ordinary Git; submitting a plan or results freezes the stopped producer’s working tree for independent review. Approval commits the exact reviewed tree. Retain outputs as artifacts. Retry identical requestId/input.',
            description:
              'Create a research experiment in the selected project with an immutable name, intent and optional details. Use intent for the question or objective. Use details for explicit requests and preferences: reference papers or previous experiments (include links or IDs), parameters, constraints, or approaches to follow. Leave details empty when the planner should choose the strategy from intent within project constraints. Dependencies are task IDs in the same project; an order between two experiments is a task between them. Starts planning attempt 1; at most seven experiments may remain active. Full training and evaluations require independent design approval. Name actual missing data, compute, budget or prerequisite work separately. Every experiment uses a private Git checkout with an ordinary origin remote. Code derives its base from accepted dependsOn prerequisites and project main. The first planning or running lease pins this base. Conflicting dependencies wait for reviewed resolution. Missing repository storage blocks execution rather than using scratch. Submit plans and results from the producing session, then stop so Merv can freeze the working tree. Independent approval commits that exact tree. Retain experimental outputs as artifacts. Reuse the same requestId and input to recover a committed response.',
            input: experimentCreateSchema.omit({ workspace: true }),
            was: ['experiment.create'],
            handler: (caller, input) => experiments.create(caller, input),
          },
          attach: {
            summary:
              'Attach evidence at current attemptIndex/expectedRevision. Plan, feasibility, report and JSON results: UTF-8, ≤64,000 bytes; compact JSON without losing run-level evidence. Qualitative results reference larger/binary outputs unread, including captures; maximum 100 result files. Independent artifact retention needs no experiment claim. Unleased: owner/admin; leased: only its worker (send information/authorization via session.message). Planning roles: plan and feasibility. Feasibility JSON only: {formatVersion:1,resources:[{kind:data|compute|time,name,unit,required,available,basis}],dependencies:[{name,present,basis}],blockers:[string]}; include data and measured-record bases. Execution: result/report. Disclose known rework. Same-path results replace that selection; plan/feasibility/report replace the current one at any path. Earlier versions remain; replaced lists deselections. Addenda belong in the report or qualitative results. Evidence must be yours, an earlier visit’s to this step/revision, this attempt’s Sandboxes capture, or selected when your visit began; submitted plan/report must still be the worker’s own. Metrics exhibit is system-generated.',
            description:
              'Associate a retained artifact with this experiment at the exact current attemptIndex and expectedRevision. A plan, feasibility statement, report or JSON result must be valid UTF-8 and at most 64,000 bytes; compact JSON before upload without dropping run-level evidence. A result with resultFormat qualitative is referenced without being read, so attach a larger or binary output (a checkpoint, an archive, a capture collection) that way and the reviewer receives it with the submission. An attempt keeps at most 100 result files. Artifact retention itself does not require joining or claiming an experiment; use artifact.create to save project evidence independently. An unleased experiment accepts association from its owner or a project administrator without a worker session. While a worker holds the experiment lease, only that worker may associate evidence; to give it information or an authorization meanwhile, send it with session.message. During planning use role plan, and role feasibility for the one JSON feasibility statement a design is submitted with: {formatVersion:1, resources:[{kind: data|compute|time, name, unit, required, available, basis}], dependencies:[{name, present, basis}], blockers:[string]}, with no other keys, at least one data resource and every basis naming the record the number was measured from. During execution use result or report. Selecting what the report covers is the authorship; do not hide known rework. A result at a path the attempt already holds replaces that result, and a plan, feasibility statement or report replaces the attempt’s current one at any path, so put an addendum in the report itself or attach it as a qualitative result; earlier versions stay retained, and the response lists under replaced what left the selection. A caller attaches evidence it created or, as a worker, evidence any earlier visit to this step at the same revision created, this attempt’s Sandboxes capture or evidence the step had selected when the visit began; the plan or report a submission is made with must still be the submitting worker’s own. The metrics exhibit is system-generated.',
            input: experimentAttachSchema,
            was: ['experiment.attach'],
            handler: (caller, input) => experiments.attach(caller, input),
          },
          transition: {
            summary:
              'Apply an owner action at expectedRevision. submit_design/submit_results atomically seal attached evidence and queue independent review; no evidence argument. Only reviewers give verdicts via review.submit; only the attempt’s running leased worker submits results. retry_running preserves plan/attempt after infrastructure interruption; it and terminal closure require a specific evidence.reason. Retry identical requestId; stop after successful handoff.',
            description:
              'Apply an owner action at the current expectedRevision: submit_design, submit_results, retry_running, abandon or mark_failed. Submission seals the evidence attached with experiment.attach and queues independent review atomically, so submit_design and submit_results take no evidence argument; reviewers alone apply their verdict through review.submit. submit_results comes only from the leased worker session that ran the attempt. retry_running, for an infrastructure interruption, preserves the approved plan and attempt and requires the interruption’s reason in evidence.reason, as terminal closure requires a specific reason there. Reuse an identical requestId for an uncertain response, and stop after a successful node handoff.',
            input: experimentTransitionSchema,
            was: ['experiment.transition'],
            handler: (caller, input) => experiments.transition(caller, input),
          },
        },
      }),
    );
  },
};
export default experimentsToolsPlugin;

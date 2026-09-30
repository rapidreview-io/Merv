import type { Context } from 'cordis';
import type { Caller } from '@merv/contracts';
import { z } from 'zod';
import { rentalSchema, computeOutputsSchema } from '@merv/sandboxes/managed-compute';
import type {} from '@merv/api/types';
import type {
  ComputeInput,
  ExperimentAttach,
  ExperimentCreate,
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

export const experimentsToolsPlugin = {
  name: 'merv-experiments-tools',
  inject: ['experiments', 'tools'],
  apply(ctx: Context) {
    const experiments = ctx.experiments;
    const owner = z.object({ experimentId: z.string().min(1) });
    const machine = owner.extend({ sandboxId: z.string().min(1).max(128) });
    for (const definition of [
      {
        name: 'compute.machines',
        description:
          'List GPU machines associated with this work item across worker handoffs. Check here before renting: a previous worker may have left a ready environment. State is refreshed in the background; leaseExpiresAt bounds reuse.',
        inputSchema: owner.strict(),
        readOnly: true,
        handler: (c: Caller, i: Record<string, string>) =>
          experiments.computeMachines(c, i.experimentId),
      },
      {
        name: 'compute.rent',
        description:
          'Rent a GPU for this task or experiment, available to its current and subsequent assigned workers. Use an offer from compute offers, a stable key, and a time-limited lease (minutes); current provider spending policy applies. Check machines before renting. No command is started automatically. Reuse key after an uncertain response; a released rental needs a new key. Files survive worker handoff but are lost on GPU release/expiry unless retained separately. Reviewers may optionally use compute for brief checks only, never long-running work.',
        inputSchema: owner.merge(rentalSchema).strict(),
        conversation: 'propose' as const,
        handler: (c: Caller, i: Record<string, unknown>) =>
          experiments.computeRent(
            c,
            i.experimentId as string,
            rentalSchema.parse({
              key: i.key,
              provider: i.provider,
              offerId: i.offerId,
              minutes: i.minutes,
            }),
          ),
      },
      {
        name: 'compute.ssh',
        description:
          'Get SSH access to this work item’s ready GPU. Generate an Ed25519 key locally (ssh-keygen -t ed25519 -N "" -f KEY); supply only the .pub contents. Save returned certificate as KEY-cert.pub. Add "[HOST]:PORT HOST_PUBLIC_KEY" to a known_hosts file using gateway.host, gateway.port and gateway.host_public_key (plain HOST for port 22), then ssh -i KEY -o CertificateFile=KEY-cert.pub -o UserKnownHostsFile=KNOWN_HOSTS -o StrictHostKeyChecking=yes -p PORT SANDBOX_ID@HOST. Each successor gets its own certificate. Certificates expire after five minutes; request a fresh one for a new connection. Reviewers: brief verification only; no training or full evaluations. Preserve submitted evidence.',
        inputSchema: machine.extend({ publicKey: z.string().min(20).max(16384) }).strict(),
        openWorld: true,
        conversation: 'secret' as const,
        handler: (c: Caller, i: Record<string, string>) =>
          experiments.computeSsh(c, i.experimentId, i.sandboxId, i.publicKey),
      },
      {
        name: 'compute.release',
        description:
          'Release a GPU associated with this work item. Retain needed files first; release deletes the machine’s filesystem. Leave it available only when the next worker can use it within the remaining lease.',
        inputSchema: machine.strict(),
        conversation: 'propose' as const,
        handler: (c: Caller, i: Record<string, string>) =>
          experiments.computeRelease(c, i.experimentId, i.sandboxId),
      },
    ])
      ctx.effect(() => ctx.tools.register(definition));
    const run = z
      .object({
        experimentId: z.string().min(1),
        attemptIndex: z.number().int().positive(),
        key: z.string().min(1).max(128),
        provider: z.string().min(1).max(64),
        offerId: z.string().min(1).max(256),
        command: z.string().min(1).max(65536),
        minutes: z.number().int().min(5).max(1380),
        maxUsd: z.number().finite().nonnegative(),
        commandId: z.string().min(1).optional(),
        outputs: computeOutputsSchema.optional(),
      })
      .strict();
    const cancel = z.object({ experimentId: z.string().min(1), runId: z.string().min(1) }).strict();
    for (const definition of [
      {
        name: 'compute.offers',
        description: 'Read this project’s ML allowance and available GPU offers.',
        inputSchema: z.object({}).strict(),
        readOnly: true,
        handler: async (caller: Caller) => await experiments.computeOffers(caller),
      },
      {
        name: 'compute.run',
        description:
          'Run the current experiment attempt. maxUsd covers the whole lease: allow 10 minutes setup plus 10 minutes capture overhead when outputs are requested (otherwise 1 minute capture). Optional outputs names absolute regular-file paths and a total maxBytes ceiling (up to 2 GiB); archive directories yourself. Files are captured before machine release, including diagnostics after command failure. Read compute.logs for bounded live progress (emit unbuffered stdout/stderr). Read file metadata in experiment.get_state, then use the run’s artifactId for its automatically retained capture collection. artifact.read with mode download and fileName retrieves a member without reuploading; compute.output remains available for older runs. On Code-hosted Git experiments, first code.commit and pass its succeeded commandId to ship that tree.',
        inputSchema: run,
        conversation: 'propose' as const,
        handler: async (caller: Caller, input: ComputeInput) =>
          await experiments.computeRun(caller, input),
      },
      {
        name: 'compute.logs',
        description:
          'Read the latest 8,000 bytes each of stdout and stderr for this experiment GPU run, including while running. Output is fetched only on request and may expire. Use unbuffered output (for example python -u); logs redirected to files are not streamed. Older jobs buffer their logs until completion. Progress logs are not a scientific verdict.',
        openWorld: true,
        readOnly: true,
        inputSchema: z
          .object({
            experimentId: z.string().min(1),
            runId: z.string().min(1),
            attemptIndex: z.number().int().positive().optional(),
          })
          .strict(),
        handler: async (
          caller: Caller,
          input: { experimentId: string; runId: string; attemptIndex?: number },
        ) => experiments.computeLogs(caller, input.experimentId, input.runId, input.attemptIndex),
      },
      {
        name: 'compute.output',
        openWorld: true,
        description:
          'Get a fresh download URL and SHA/size for one captured file of this experiment run, after machine release. Use its output name, not an arbitrary object ID. New captures automatically produce one collection artifact; use its artifactId and artifact.read mode download with fileName. No reupload is needed. A captured file is not a scientific success verdict.',
        inputSchema: z
          .object({
            experimentId: z.string().min(1),
            runId: z.string().min(1),
            name: z.string().min(1).max(128),
            attemptIndex: z.number().int().positive().optional(),
          })
          .strict(),
        readOnly: true,
        handler: async (
          caller: Caller,
          input: { experimentId: string; runId: string; name: string; attemptIndex?: number },
        ) =>
          experiments.computeOutput(
            caller,
            input.experimentId,
            input.runId,
            input.name,
            input.attemptIndex,
          ),
      },
      {
        name: 'compute.cancel',
        description: 'Propose cancellation of one run owned by this experiment.',
        inputSchema: cancel,
        conversation: 'propose' as const,
        handler: async (caller: Caller, input: { experimentId: string; runId: string }) =>
          await experiments.computeCancel(caller, input.experimentId, input.runId),
      },
    ])
      ctx.effect(() => ctx.tools.register(definition));
    for (const definition of [
      {
        name: 'experiment.create',
        description:
          'Create a research experiment in the selected project with an immutable name, intent and optional details. Dependencies are work-item IDs in the same project. Starts planning attempt 1; at most seven experiments may remain active. Planning workers may rent and inspect a GPU over SSH for brief feasibility checks. Full training and evaluations still require independent design approval; compute.run belongs to that execution phase. Check existing work machines before renting more. Name actual missing data, compute, budget or prerequisite work separately. Optional workspace "git" (requires Code) runs the experiment in a private Git checkout. Until an administrator binds and imports the project, the checkout uses the runner’s central base. In a hosted project Code derives its base from accepted dependencies, looking through code-less successes and using imported main when there is no contributing commit. The first planning or running lease pins it so execution inherits the plan’s base. Several commits share an automatic merge; conflicts wait for one reviewed resolution task. Unverified or unimported code shows code_base_pending; code_merge_required means automatic merging is disabled. Blocked work is never launched. In hosted projects, omit baseTaskId and use dependsOn; the incompatible legacy form is rejected at creation. For local repositories only, optional baseTaskId is the older explicit form: it names one Git task, which must also be in dependsOn, whose accepted delivered commit becomes the base. Reuse the same requestId and input to recover a committed response.',
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
          'Associate a retained artifact with this experiment at the exact current attemptIndex and expectedRevision. Attached JSON or Markdown evidence must be valid UTF-8 and at most 64,000 bytes; compact JSON before upload without dropping run-level evidence. Larger supplementary files can remain standalone artifacts. Artifact retention itself does not require joining or claiming an experiment; use artifact.create to save project evidence independently. An unleased experiment accepts association from its owner or a project administrator without a worker session. While a worker holds the experiment lease, only that worker may associate evidence. During planning use role plan, and role feasibility for the one JSON feasibility statement a design is submitted with: {formatVersion:1, resources:[{kind: data|compute|time, name, unit, required, available, basis}], dependencies:[{name, present, basis}], blockers:[]}, with at least one data resource and every basis naming the record the number was measured from. During execution use result or report. Selecting what the report covers is the authorship; do not hide known rework. A new version replaces the logical role/path slot while preserving earlier evidence. The associating actor must own the evidence or have the exact frozen recovery input. Results explicitly distinguish JSON from qualitative evidence. The metrics exhibit is system-generated.',
        inputSchema: experimentAttachSchema,
        handler: async (caller: Caller, input: ExperimentAttach) =>
          await experiments.attach(caller, input),
      },
      {
        name: 'experiment.transition',
        description:
          'Apply an owner action at the current expectedRevision: submit_design, submit_results, retry_running, abandon or mark_failed. Submission seals evidence and queues independent review atomically; reviewers alone apply their verdict through review.submit. Retry preserves the approved plan and attempt. Terminal closure requires a specific reason in evidence.reason. Reuse an identical requestId for an uncertain response, and stop after a successful node handoff.',
        inputSchema: experimentTransitionSchema,
        // Ending an experiment cannot be undone: the person does it.
        conversation: (input: ExperimentTransition) =>
          ['abandon', 'mark_failed'].includes(input.transition) ? 'propose' : undefined,
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

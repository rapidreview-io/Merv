import { visible } from '@merv/contracts';
import type { Context } from 'cordis';
import type {} from '@merv/api/types';
import { z } from 'zod';
import { rentalSchema, computeOutputsSchema } from '@merv/sandboxes/managed-compute';
import type {
  Caller,
  TaskCreate,
  TaskDelivery,
  TaskReissue,
  TaskMarkFailed,
  TaskContext,
  TaskCheckpointInput,
} from '@merv/contracts';

const requestId = z.string().min(1).max(200);
const id = z.string().min(1);
export const taskToolsPlugin = {
  name: 'merv-task-tools',
  inject: ['tools', 'tasks'],
  apply(ctx: Context) {
    const owner = z.object({ taskId: z.string().min(1) });
    const machine = owner.extend({ sandboxId: z.string().min(1).max(128) });
    for (const definition of [
      {
        name: 'task.compute_machines',
        description:
          'List GPU machines associated with this work item across worker handoffs. Check here before renting: a previous worker may have left a ready environment. State is refreshed in the background; leaseExpiresAt bounds reuse.',
        inputSchema: owner.strict(),
        readOnly: true,
        handler: (c: Caller, i: Record<string, string>) => ctx.tasks.computeMachines(c, i.taskId),
      },
      {
        name: 'task.compute_rent',
        description:
          'Rent a GPU for this task or experiment, available to its current and subsequent assigned workers. Use an offer from compute offers, a stable key, and a time-limited lease (minutes); current provider spending policy applies. Check machines before renting. No command is started automatically. Reuse key after an uncertain response; a released rental needs a new key. Files survive worker handoff but are lost on GPU release/expiry unless retained separately. Reviewers may optionally use compute for brief checks only, never long-running work.',
        inputSchema: owner.merge(rentalSchema).strict(),
        conversation: 'propose' as const,
        handler: (c: Caller, i: Record<string, unknown>) =>
          ctx.tasks.computeRent(
            c,
            i.taskId as string,
            rentalSchema.parse({
              key: i.key,
              provider: i.provider,
              offerId: i.offerId,
              minutes: i.minutes,
            }),
          ),
      },
      {
        name: 'task.compute_ssh',
        description:
          'Get SSH access to this work item’s ready GPU. Generate an Ed25519 key locally (ssh-keygen -t ed25519 -N "" -f KEY); supply only the .pub contents. Save returned certificate as KEY-cert.pub. Add "[HOST]:PORT HOST_PUBLIC_KEY" to a known_hosts file using gateway.host, gateway.port and gateway.host_public_key (plain HOST for port 22), then ssh -i KEY -o CertificateFile=KEY-cert.pub -o UserKnownHostsFile=KNOWN_HOSTS -o StrictHostKeyChecking=yes -p PORT SANDBOX_ID@HOST. Each successor gets its own certificate. Certificates expire after five minutes; request a fresh one for a new connection. Reviewers: brief verification only; no training or full evaluations. Preserve submitted evidence.',
        inputSchema: machine.extend({ publicKey: z.string().min(20).max(16384) }).strict(),
        openWorld: true,
        conversation: 'secret' as const,
        handler: (c: Caller, i: Record<string, string>) =>
          ctx.tasks.computeSsh(c, i.taskId, i.sandboxId, i.publicKey),
      },
      {
        name: 'task.compute_release',
        description:
          'Release a GPU associated with this work item. Retain needed files first; release deletes the machine’s filesystem. Leave it available only when the next worker can use it within the remaining lease.',
        inputSchema: machine.strict(),
        conversation: 'propose' as const,
        handler: (c: Caller, i: Record<string, string>) =>
          ctx.tasks.computeRelease(c, i.taskId, i.sandboxId),
      },
    ])
      ctx.effect(() => ctx.tools.register(definition));
    const computeRun = z
      .object({
        taskId: id,
        expectedRevision: z.number().int().nonnegative(),
        key: z.string().min(1).max(128),
        provider: z.string().min(1).max(64),
        offerId: z.string().min(1).max(256),
        command: z.string().min(1).max(65536),
        minutes: z.number().int().min(5).max(1380),
        maxUsd: z.number().finite().nonnegative(),
        commandId: id.optional(),
        outputs: computeOutputsSchema.optional(),
      })
      .strict();
    for (const definition of [
      {
        name: 'task.compute_offers',
        description: 'Read this project’s ML allowance and GPU offers for a task.',
        inputSchema: z.object({}).strict(),
        readOnly: true,
        handler: async (caller: Caller) => await ctx.tasks.computeOffers(caller),
      },
      {
        name: 'task.compute_status',
        description:
          'List the most recent 100 GPU run summaries for this task across work revisions. Pass runId to read one run’s result; use task.compute_logs for live output; include generation when the same key was reused in another revision.',
        inputSchema: z
          .object({
            taskId: id,
            runId: id.optional(),
            generation: z.number().int().nonnegative().optional(),
          })
          .strict(),
        readOnly: true,
        handler: async (
          caller: Caller,
          input: { taskId: string; runId?: string; generation?: number },
        ) => await ctx.tasks.computeStatus(caller, input.taskId, input.runId, input.generation),
      },
      {
        name: 'task.compute_run',
        description:
          'Run a bounded GPU command for this task revision. maxUsd covers the whole lease including 10 minutes setup plus 10 minutes capture overhead when outputs are requested (otherwise 1 minute capture). Optional outputs names absolute regular-file paths and a total maxBytes ceiling (up to 2 GiB); archive directories yourself. Capture happens before release. Read task.compute_logs for live progress (emit unbuffered stdout/stderr), task.compute_status for results, then task.compute_output for fresh URLs, and its artifactId for the automatically retained capture collection; do not reupload captured files. Reuse key to recover the same run. On Git tasks, commandId may name this task’s succeeded code.commit to ship that tree.',
        inputSchema: computeRun,
        conversation: 'propose' as const,
        handler: async (caller: Caller, input: z.infer<typeof computeRun>) =>
          await ctx.tasks.computeRun(caller, input),
      },
      {
        name: 'task.compute_logs',
        description:
          'Read the latest 8,000 bytes each of stdout and stderr for this task GPU run, including while running. Output is fetched only on request and may expire. Use unbuffered output (for example python -u); logs redirected to files are not streamed. Older jobs buffer their logs until completion. Progress logs are not a task review verdict.',
        openWorld: true,
        readOnly: true,
        inputSchema: z
          .object({
            taskId: id,
            runId: id,
            generation: z.number().int().nonnegative().optional(),
          })
          .strict(),
        handler: async (
          caller: Caller,
          input: { taskId: string; runId: string; generation?: number },
        ) => ctx.tasks.computeLogs(caller, input.taskId, input.runId, input.generation),
      },
      {
        name: 'task.compute_output',
        openWorld: true,
        description:
          'Get a fresh download URL and SHA/size for one captured file of this task run after machine release. Use the output name from task.compute_status. New captures automatically produce one collection artifact; use its artifactId and artifact.read mode download with fileName. No reupload is needed. Capture is not a task review verdict.',
        inputSchema: z
          .object({
            taskId: id,
            runId: id,
            name: z.string().min(1).max(128),
            generation: z.number().int().nonnegative().optional(),
          })
          .strict(),
        readOnly: true,
        handler: async (
          caller: Caller,
          input: { taskId: string; runId: string; name: string; generation?: number },
        ) =>
          ctx.tasks.computeOutput(caller, input.taskId, input.runId, input.name, input.generation),
      },
      {
        name: 'task.compute_cancel',
        description: 'Cancel one GPU run owned by the current leased task work revision.',
        inputSchema: z.object({ taskId: id, runId: id }).strict(),
        conversation: 'propose' as const,
        handler: async (caller: Caller, input: { taskId: string; runId: string }) =>
          await ctx.tasks.computeCancel(caller, input.taskId, input.runId),
      },
    ])
      ctx.effect(() => ctx.tools.register(definition));
    const definitions = [
      {
        name: 'task.checkpoint',
        description:
          'Save attributed progress for this task assignment. Checkpoints are unverified notes for continuity, not a delivery or verdict. Review checkpoints require the current claimId.',
        inputSchema: z
          .object({
            taskId: id,
            purpose: z.enum(['work', 'review']),
            expectedRevision: z.number().int().nonnegative(),
            claimId: id.optional(),
            notes: z.string().min(1).max(16000),
            artifactIds: z.array(id).max(50).optional(),
            requestId,
          })
          .strict(),
        handler: async (caller: Caller, input: TaskCheckpointInput) =>
          await ctx.tasks.checkpoint(caller, input),
      },
      {
        name: 'task.context',
        description:
          'Build and persist the starting context from this task type’s versioned recipe. Work context requires the producer/operator. Review context requires a current independent claimId from review.start. Returns the complete context package with source hashes.',
        inputSchema: z
          .object({
            taskId: id,
            purpose: z.enum(['work', 'review']),
            expectedRevision: z.number().int().nonnegative(),
            claimId: id.optional(),
            requestId,
          })
          .strict(),
        handler: async (caller: Caller, input: TaskContext) =>
          await ctx.tasks.context(caller, input),
      },
      {
        name: 'task.create',
        description:
          'Create a durable task. Merv renders and pins its goal and numbered checks as an immutable brief. Optional briefId uses your own text brief, which must include the goal and checks. Every new task requires a delivery confirmation for each check with evidence references and verification notes. The current actor becomes the producer. Optional dependsOn names existing work items in this project; work context and delivery wait until each succeeds. Dependencies are set at creation. Type defaults to task.work. project.reflection requires experiments and projectKnowledge artifact IDs in contextInputs; experiments are planned through the experiment tools, not as tasks. Optional workspace "git" (default none; requires Code) gives the producing worker a private Git checkout: it records its work with code.commit and delivers that commit, which the independent reviewer inspects in a read-only checkout pinned to it, so a code repository is never split into artifacts. Until an administrator binds and imports the project, the checkout uses the runner’s central base. In a hosted project Code derives and pins the base from accepted dependencies, looking through code-less successes and using imported main when there is no contributing commit. Several commits share an automatic merge; conflicts wait for one reviewed resolution task. Unverified or unimported code shows code_base_pending; code_merge_required means automatic merging is disabled. Blocked work is never launched. In hosted projects, omit baseTaskId and use dependsOn; the incompatible legacy form is rejected at creation. For local repositories only, optional baseTaskId is the older explicit form: it names one Git task, which must also be in dependsOn, whose accepted delivered commit becomes the base. The workspace is fixed at creation. Only a leased reviewer, working in that pinned checkout, can pass a Git task; an interactive reviewer may return or fail it.',
        inputSchema: z
          .object({
            title: z
              .string()
              .min(1)
              .max(300)
              .regex(/^[^\r\n]*$/, 'A title is one line'),
            goal: z.string().min(1).max(16000),
            checks: z
              .array(
                z
                  .string()
                  .min(1)
                  .max(2000)
                  .regex(/^[^\r\n]*$/, 'A check is one line'),
              )
              .min(1)
              .max(20),
            briefId: id.optional(),
            type: z.string().min(1).optional(),
            typeVersion: z.number().int().positive().optional(),
            contextInputs: z.record(z.array(id)).optional(),
            dependsOn: z
              .union([z.array(z.string()), z.string()])
              .nullable()
              .optional(),
            workspace: z.enum(['none', 'git']).optional(),
            baseTaskId: id.optional(),
            requestId,
          })
          .strict(),
        handler: async (caller: Caller, input: TaskCreate) => await ctx.tasks.create(caller, input),
      },
      {
        name: 'task.get',
        description:
          'Read task status, workflow revision, pinned evidence, current review ID, live prerequisites and dependents, and caller-specific workflow guidance.',
        inputSchema: z.object({ taskId: id }).strict(),
        readOnly: true,
        handler: async (caller: Caller, input: { taskId: string }) =>
          await ctx.tasks.get(caller, input.taskId),
      },
      {
        name: 'task.list',
        description:
          'List the tasks in the current project as records; task.get adds your guidance.',
        inputSchema: z.object({}).strict(),
        readOnly: true,
        handler: async (caller: Caller) => await ctx.tasks.list(caller),
      },
      {
        name: 'task.submit_delivery',
        description:
          'Submit immutable delivery artifacts and enter independent review atomically. Supply one confirmation per numbered acceptance check: checkNumber, met/not_met status, evidenceIds from artifactIds, and notes describing verification or the unmet condition. A met claim requires evidence. Merv pins the confirmations alongside the evidence; the reviewer decides whether the goal was achieved. A Git task (workspace "git") also requires commandId: this leased worker’s own code.commit operation, once code.operation reports it succeeded. Its artifactIds may be empty, files are optional alongside the commit, a met claim that cites no evidenceIds is backed by the delivered commit, and Merv pins a rendered record of the commit for the review. Every other task requires at least one artifact and takes no commandId. expectedRevision is the task workflow revision.',
        inputSchema: z
          .object({
            taskId: id,
            // Only a Git task may deliver its commit alone, and only Tasks knows which task is one.
            artifactIds: z.array(id),
            commandId: id.optional(),
            confirmations: z
              .array(
                z
                  .object({
                    checkNumber: z.number().int().positive(),
                    status: z.enum(['met', 'not_met']),
                    evidenceIds: z.array(id),
                    notes: z.string().min(1).max(2000),
                  })
                  .strict(),
              )
              .min(1)
              .optional(),
            expectedRevision: z.number().int().nonnegative(),
            requestId,
          })
          .strict(),
        handler: async (caller: Caller, input: TaskDelivery) =>
          await ctx.tasks.submitDelivery(caller, input),
      },
      {
        name: 'task.mark_failed',
        conversation: 'propose' as const,
        description:
          'Producer/operator: stop an active task with a specific reason, closing any unfinished review and preserving evidence. Service-owned tasks suspend until a human operator resumes them; other tasks end terminally. Use only when the task cannot or should not continue. expectedRevision is the current task workflow revision.',
        inputSchema: z
          .object({
            taskId: id,
            expectedRevision: z.number().int().nonnegative(),
            reason: z.string().min(1).max(16000).refine(visible),
            requestId,
          })
          .strict(),
        handler: async (caller: Caller, input: TaskMarkFailed) =>
          await ctx.tasks.markFailed(caller, input),
      },
      {
        name: 'task.reissue_review',
        conversation: 'propose' as const,
        description:
          'Producer/operator: replace an open review claim while preserving exactly the same evidence. Use when a reviewer is unavailable or revoked. Supersedes the old review and advances the task revision atomically; requires a reason.',
        inputSchema: z
          .object({
            taskId: id,
            expectedRevision: z.number().int().nonnegative(),
            reason: z.string().min(1).max(2000),
            requestId,
          })
          .strict(),
        handler: async (caller: Caller, input: TaskReissue) =>
          await ctx.tasks.reissueReview(caller, input),
      },
    ];
    for (const definition of definitions) ctx.effect(() => ctx.tools.register(definition));
  },
};
export default taskToolsPlugin;

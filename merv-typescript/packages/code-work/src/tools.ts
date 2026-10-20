import type { NounActions } from '@merv/api/types';
import {
  codeCommitInputSchema,
  codeMergeInputSchema,
  type Caller,
  type CodeCommandRecord,
  type CodeCommitInput,
  type CodeMergeInput,
  idSchema,
} from '@merv/contracts';
import {
  codeMirrorRetryInputSchema,
  codeRepositoryImportInputSchema,
  codeUnitFenceInputSchema,
  type CodeRepositoryImportInput,
} from '@merv/code/store/protocol';
import type { Context } from 'cordis';
import { z } from 'zod';
import { baseControlSchema, type CodeBaseControl } from './bases.js';
import { publicationControlSchema } from './publication-host.js';
import { repositoryPrepareSchema } from './repository-setup.js';
import { codeRepositoryConfigureInputSchema } from './check-configuration.js';
import { codePublicationIdSchema, codePublicationMergeSchema } from './publications.js';
import type { CodePublicationMerge, CodeRepositoryConfigureInput } from './types.js';
import type { CodeMirrorRetryInput, CodeUnitFenceInput } from './models.js';

/**
 * What a worker does about a refusal of its checkout's own content. The runner reports only the
 * code, so the move names the limit and how to find what broke it.
 */
const REFUSALS: Record<string, string> = {
  workspace_file_too_large:
    'Code keeps no file over 50 MiB, and a new or changed file in the checkout that is not ignored is larger. List the large files with `find . -path ./.git -prune -o -type f -size +50M -print`; each one `git check-ignore` does not name must be ignored in .gitignore or removed (retain data you need with artifact.upload_begin). Then commit again with a new requestId.',
  code_capture_quarantined:
    'Code refused the commit because a file in it matches a credential pattern. code.status lists the refused upload under operations, with the path and rule of each finding but never the text. A real credential must leave the checkout: remove it and commit again with a new requestId. Data that only looks like one (public datasets, fixtures) stays out of Git (retain it with artifact.upload_begin) unless a project administrator exempts its paths with secretExemptGlobs in code.repository.configure; ask with session.ask_owner.',
  workspace_foreign_path:
    'A new or changed path in the checkout lies under a symbolic link that leads outside it. Replace the link with the files themselves or remove it, then commit again with a new requestId.',
};

/**
 * A command as a worker reads it. Its workspace is the checkout as it was attached, which is
 * how its runner knows the command for its own; the head and stats there are that moment's,
 * not the checkout's now, so they are left out. The receipt carries the commit's own.
 */
const attached = async (record: Promise<CodeCommandRecord>) => {
  const { command, ...rest } = await record;
  const { headOid: _head, stats: _stats, ...workspace } = command.workspace;
  const next = rest.error ? REFUSALS[rest.error] : undefined;
  return { ...rest, ...(next ? { next } : {}), command: { ...command, workspace } };
};

/** The fields a script relies on in each read, as passthrough objects: never validators. */
const commandOutput = z
  .object({
    status: z.string(),
    error: z.string().nullable(),
    command: z.object({ id: z.string(), expectedHead: z.string() }).passthrough(),
    receipt: z.object({}).passthrough().nullable(),
  })
  .passthrough();
const outputs = {
  files: z
    .object({
      ref: z.string(),
      commit: z.string(),
      path: z.string(),
      kind: z.enum(['folder', 'file']),
      entries: z
        .array(z.object({ name: z.string(), kind: z.string(), size: z.number().optional() }))
        .optional(),
      text: z.string().optional(),
      withheld: z.enum(['too_large', 'binary']).optional(),
    })
    .passthrough(),
  log: z
    .object({
      ref: z.string(),
      commit: z.string(),
      commits: z.array(
        z
          .object({
            oid: z.string(),
            parents: z.array(z.string()),
            date: z.string(),
            subject: z.string(),
            unit: z.object({ id: z.string(), kind: z.string(), title: z.string() }).optional(),
          })
          .passthrough(),
      ),
    })
    .passthrough(),
  status: z
    .object({
      project: z.object({}).passthrough().nullable(),
      bases: z.array(z.object({ key: z.string() }).passthrough()),
      units: z.array(z.object({}).passthrough()),
      blockers: z.array(z.object({}).passthrough()),
      operations: z.array(z.object({}).passthrough()),
      warnings: z.array(z.unknown()),
    })
    .passthrough(),
  unit: z
    .object({
      unitId: z.string().optional(),
      canonicalHead: z.string().nullable().optional(),
      acceptance: z.object({}).passthrough().nullable(),
    })
    .passthrough(),
  operation: commandOutput,
};

const reads = (ctx: Context): NounActions => ({
  files: {
    description:
      "Read the project's code as files, the way GitHub shows a repository: with no path, the root folder; a path names a folder (its entries: folders first, then files with their bytes) or a file (its text, up to 1 MiB; binary and larger files say so instead). ref chooses whose code: main (the default), a task or experiment by its work unit id (its accepted code, or else the newest commit Code admitted for it), or a full commit id. It reads Code's own repository and changes nothing.",
    input: z
      .object({
        ref: z.string().trim().max(200).optional(),
        path: z.string().max(4096).optional(),
      })
      .strict(),
    output: outputs.files,
    was: ['code.files'],
    handler: async (caller: Caller, input: { ref?: string; path?: string }) =>
      await ctx.codeWork.files(caller, input),
  },
  log: {
    description:
      "Read the project's Git history newest first, like git log, with the task or experiment each commit came from (unit: its id, kind and title) — Git itself does not carry those names. ref chooses whose history: main (the default), a task or experiment by its work unit id, or a full commit id; path narrows it to commits that changed that file or folder; limit is at most 200 (default 50). Each commit has its subject, its bullet-point body, parents and date. It changes nothing.",
    input: z
      .object({
        ref: z.string().trim().max(200).optional(),
        path: z.string().max(4096).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      })
      .strict(),
    output: outputs.log,
    was: ['code.log'],
    handler: async (caller: Caller, input: { ref?: string; path?: string; limit?: number }) =>
      await ctx.codeWork.history(caller, input),
  },
  status: {
    description:
      'Read retained bases with frozen sponsors, execution epochs, admission blockers and operator reasons; each base also carries its project check — the verdict, the command, the machine it ran in, what that machine could not isolate, and what the command printed; code.base.retry, code.base.suspend/resume, code.base.cancel, code.base.quarantine, code.base.release and code.base.repair handle recovery. Read this project’s Code binding (repository, main and whether Code’s own repository holds it, the repositories it was bound to before with when, by whom and why each was left, and durability: code once Code keeps the project’s repository), its newest 200 units with their base pins and acceptances, and every blocker Code has published for work whose base cannot be pinned yet; each blocker carries next, the recovery action. store describes the project’s repository on the server: whether it is hosted, its object format and root, the newest imported tips, its disk use against its quota, and its deny and exempt globs. operations lists every unfinished transfer, oldest first, with its phase, bytes received and, under waiting, why it is not moving and what would move it, followed by the newest refused ones with their findings. mirror says how the project’s work reaches the GitHub repository it is published to: off while nothing is linked or write automation is off (blockedBy says which), otherwise idle, pending, retrying or blocked, with how many refs are waiting, since when, the last error and every ref that waits for an operator under blockedRefs, each with the operationId code.mirror.retry takes. Publishing is the server’s own asynchronous work and is never on anybody’s path: a mirror that is behind or blocked stops no session, handoff or acceptance. warnings carries the same trouble as plain statements about the repository.',
    input: z.object({}).strict(),
    output: outputs.status,
    was: ['code.status'],
    // Its recovery guidance names each action by its address, said as this caller calls it.
    handler: async (caller: Caller) =>
      ctx.tools.guidance(caller, await ctx.codeWork.status(caller)),
  },
  unit: {
    description:
      'Read what Code holds about one unit of work, named by its work unit id: the base it was pinned to with the accepted dependencies that base came from, and its acceptance with the exact reviewed code, the submission and review it names, and whether the reviewer’s checkout was attached at that code. storage code means Code’s own repository holds the accepted code, and receipt names the operation that made it durable; none means the unit was accepted without code. For a unit that lives in Code’s repository it also gives the writer: generation, the number of leased sessions that have written to it; writerState (reserved, active, closing while an upload its session had in flight when it closed, or the final capture of a worker that ended its own visit, finishes within the grace, closed, or recovery_required while a quarantined capture waits for code.unit.fence); canonicalHead, the newest commit Code admitted, which is what the next session on any machine resumes from; quarantine, the final capture Code refused, whose findings code.status lists and which code.unit.fence resolves; and mirroredHead with mirroredAt, the commit that has reached the published GitHub repository, which lags canonicalHead while publication catches up and never holds any work up.',
    input: z.object({ unitId: idSchema }).strict(),
    output: outputs.unit,
    was: ['code.unit.get'],
    handler: async (caller: Caller, input: { unitId: string }) =>
      await ctx.codeWork.unit(caller, input.unitId),
  },
  operation: {
    description:
      'Inspect a durable code operation and its immutable commit receipt, by the codecmd_ id code.commit or code.merge returned. A leased worker reads the operations of its own unit of work, its reviewer included. A succeeded receipt identifies the exact committed head, tree, parent and stats; command.workspace only names the checkout. It does not authorize central publication.',
    input: z.object({ commandId: idSchema }).strict(),
    output: outputs.operation,
    was: ['code.operation'],
    handler: async (caller: Caller, input: { commandId: string }) =>
      await attached(ctx.codeWork.operation(caller, input.commandId)),
  },
});

/** The seven base controls, each keeping its retired name's flat body for its request digest. */
const BASES = [
  ['retry', 'Retry infrastructure work on this same base with five new attempts.'],
  ['suspend', 'Suspend this base while retaining its current work and history.'],
  [
    'resume',
    'Resume a suspended base in its prior work state. A suspended resolution task resumes as its blocker’s next move says.',
  ],
  ['cancel', 'Cancel this unresolved base permanently. Replan its waiters with corrective work.'],
  [
    'quarantine',
    'Quarantine this base and its descendants, including existing pins and acceptances. Its immutable result stays retained and cannot be reused; create corrective work and replan.',
  ],
  [
    'release',
    'Release this base from quarantine after verifying the alarm was false. Every base and unit that only inherited the quarantine from it is released with it; a base quarantined in its own right keeps its own reach. A writer generation the quarantine had put into recovery_required ends at its last admitted commit on Code’s next sweep. Name the verification in reason.',
  ],
  [
    'repair',
    'Drop the Git ref an interrupted execution of this base left behind, so the next attempt can settle. Use it when this base reports that its ref names another commit. Refused for a base that is running, quarantined, or whose result is already sealed, because a sealed result is what everything pinned to it names. The receipt retains the commit that was dropped.',
  ],
] as const;

const writes = (ctx: Context): NounActions => ({
  ...Object.fromEntries(
    BASES.map(([action, instruction]) => [
      `base_${action}`,
      {
        description: `${instruction} Supply the key from code.status, a reason and a stable requestId. Only a project administrator or their agent may call it, never a leased worker.`,
        input: baseControlSchema.omit({ action: true }),
        was: [`code.base.${action}`],
        handler: async (caller: Caller, input: Omit<CodeBaseControl, 'action'>) =>
          ctx.codeWork.controlBase(caller, { ...input, action }),
      },
    ]),
  ),
  unit_fence: {
    description:
      'End the writer generation of a unit whose final capture is quarantined (code_capture_quarantined; read the findings in code.status first): every other writer generation ends by itself with its session. Refused with code_fence_unneeded for a unit no quarantined capture holds. The unit closes at the last commit Code admitted, anything the old generation was still sending is kept on the server’s disk and never admitted, and the next lease continues from that commit as the next generation. Refused with code_operation_unresolved while an admitted upload of the unit is unfinished. Only a project administrator or their agent may call it, never a leased worker. Supply a stable requestId.',
    input: codeUnitFenceInputSchema,
    was: ['code.unit.fence'],
    handler: async (caller: Caller, input: CodeUnitFenceInput) =>
      await ctx.codeWork.fenceUnit(caller, input),
  },
  mirror_retry: {
    description:
      'Put one blocked publication of a Code ref back in the queue, named by the operationId code.status reports under mirror.blockedRefs. Publishing to GitHub is the server’s own asynchronous work: it never blocks a session, a handoff or an acceptance, so a blocked ref means only that the published repository has not received a commit Code already holds. A ref blocked after repeated failures is simply queued again. A ref blocked with code_mirror_diverged holds a commit Code did not write, which is somebody’s work: keep it somewhere first, then call this with acknowledgeRemote set to exactly that commit. Nothing here ever forces or deletes a published ref; work branches only ever fast-forward and accepted and base refs are only ever created. Only a project administrator may call it, never a leased worker. Supply a stable requestId.',
    input: codeMirrorRetryInputSchema,
    was: ['code.mirror.retry'],
    handler: async (caller: Caller, input: CodeMirrorRetryInput) =>
      await ctx.codeWork.retryMirror(caller, input),
  },
  repository_import: {
    description:
      'Bring history into the repository Code keeps for this project on the server, which is what makes the project hosted: new Git work is then kept by Code and can be resumed or reviewed on another machine. Only a project administrator may call it, never a leased worker. New projects already have a managed repository. source bundle promises one Git bundle: tip is the commit it delivers, and bundle gives its sha256 and size; the call returns an operation, and the bundle is then sent in parts to PUT /code/v2/uploads/{id}/parts/{offset} and admitted with POST /code/v2/uploads/{id}/complete, which the code-import command does for you. source github reads one ref of the linked GitHub repository on the server. A bundle may build only on commits the repository already holds (store.tips in code.status), so a history larger than one transfer is imported in steps. Everything the transfer introduces is examined: integrity and connectivity, sizes and counts, paths, modes, symbolic links, submodules, the project’s deny globs and a short list of unmistakable credentials. Findings refuse the whole import and are listed on the operation without the matched text. Supply a stable requestId: the same request replays its operation, a changed one is refused.',
    input: codeRepositoryImportInputSchema,
    was: ['code.repository.import'],
    handler: async (caller: Caller, input: CodeRepositoryImportInput) =>
      await ctx.codeWork.importRepository(caller, input),
  },
  repository_configure: {
    description:
      'Set what this project’s repository refuses beyond the fixed limits, and the one command that proves a merged base works. denyGlobs are paths no admitted history may contain; secretExemptGlobs are paths the credential patterns skip, for fixtures that are shaped like tokens. A glob is matched against the whole path from the repository root: a literal matches itself, ? one character and * any run within one segment, ** any run across segments. Both lists replace what was set. check is the project check and must be stated on every call: null turns verification off, and an object gives command, timeoutSeconds and image (provider, offerId and an optional snapshotId). The command runs against the merged tree in a machine this server rents for the occasion and never on this server; it is given no Merv credential and no environment, the machine has network access and a writable copy of the source, and every base record says so beside its verdict. A failing check is treated as a conflict and resolved by the one reviewed task a Git conflict is resolved by. Without a sandbox connection a configured command leaves each base unsealed and blocked with code_check_unavailable for an operator. Only a project administrator may call it. Supply a stable requestId.',
    input: codeRepositoryConfigureInputSchema,
    was: ['code.repository.configure'],
    handler: async (caller: Caller, input: CodeRepositoryConfigureInput) =>
      await ctx.codeWork.configureRepository(caller, input),
  },
  repository_prepare: {
    description:
      'Prepare the linked GitHub repository using its selected base branch and exact head. A project administrator or their agent selects the connection revision, branch head and current main (if already bound). Imports the selected history without replacing Merv main or its repository identity. If the remote adds history, creates one integration task requiring independent review. Retry the same input after the task passes to advance Merv main with compare-and-swap; a moved local or remote head requires a new preparation. Ready means integrated locally; publication to GitHub remains separately gated. Retry the same request and input while importing or after an uncertain answer. Failed imports report findings; correct them before starting a new request. Existing work keeps its pinned base.',
    input: repositoryPrepareSchema,
    was: ['code.repository.prepare'],
    handler: (caller: Caller, input: z.infer<typeof repositoryPrepareSchema>) =>
      ctx.codeWork.prepareRepository(caller, input),
  },
  publication_sync: {
    description:
      'Reconcile reviewed integrations: advance Merv main for sealed local destinations; for GitHub destinations open approved snapshot PRs and emit exact-head approval status. Local integration requires no GitHub credentials. Requires project write authority and refuses leased workers.',
    input: z.object({}).strict(),
    was: ['code.publication.sync'],
    handler: (caller: Caller) => ctx.codeWork.syncPublications(caller),
  },
  publication_merge: {
    description:
      'Project administrator or their agent, never a leased worker: merge the independently approved proposal at its exact reviewed head. Code checks current main, rules and status, imports the merge, and completes only after verifying its parents and reviewed tree.',
    input: codePublicationMergeSchema,
    was: ['code.publication.merge'],
    handler: (caller: Caller, input: CodePublicationMerge) =>
      ctx.codeWork.mergePublication(caller, input),
  },
  publication_control: {
    description:
      'Project administrator or their agent, never a leased worker: record the release canary result, acknowledge incomplete rules visibility, or clear publication disablement after a passing canary. Keep the tested App identity, rules and evidence in reason. A stale merge that succeeds disables this publication path; other work continues.',
    input: publicationControlSchema,
    was: ['code.publication.control'],
    handler: (caller: Caller, input: unknown) => ctx.codeWork.controlPublication(caller, input),
  },
});

export const codeToolsPlugin = {
  name: 'merv-code-tools',
  inject: ['codeWork', 'tools'],
  apply(ctx: Context) {
    ctx.effect(() =>
      ctx.tools.noun('code.read', {
        tier: 'core',
        readOnly: true,
        description:
          "Read the project's code and Code's records: files (a folder or file at a ref, as GitHub shows it), log (history newest first, each commit with its work unit), status (bases, binding, units, blockers, store, transfers, mirror), unit (what Code holds about one work unit) and operation (a code.commit or code.merge operation and its receipt). It changes nothing.",
        actions: reads(ctx),
      }),
    );
    ctx.effect(() =>
      ctx.tools.noun('code.write', {
        description:
          "Change how Code keeps this project's repository; a project administrator or their agent, never a leased worker. base_retry … base_repair control a base by its key from code.read status; unit_fence, mirror_retry; repository_import, repository_configure and repository_prepare (the only way main moves to outside history); publication_sync, publication_merge and publication_control (whose own inner action names the control).",
        actions: writes(ctx),
        // Its capability is gone (founder): what remains is preparing the linked repository.
        removed: {
          'code.local.bind': 'repository_prepare',
          'code.repository.rebind': 'repository_prepare',
        },
      }),
    );
    const definitions = [
      {
        name: 'code.publication.read',
        tier: 'ui' as const,
        description:
          'Read one integration with its pull request as GitHub has it now: the files, commits, reviews and checks. Merv’s pages read it; agents use code.status.',
        inputSchema: codePublicationIdSchema,
        readOnly: true,
        openWorld: true,
        handler: (caller: Caller, input: { proposalId: string }) =>
          ctx.codeWork.publicationDetails(caller, input.proposalId),
      },
      {
        name: 'code.commit',
        tier: 'worker' as const,
        description:
          'Request a Git checkpoint of this active writable session’s assigned checkout. Read its current HEAD with local Git first. Supply that full expectedHead, a commit message and a stable requestId. The message has a fixed shape: a first line of at most 72 characters saying what changed, then a blank line and, only where there is more than one thing to say, up to ten bullet points (each a line beginning \"- \"), one per significant change, each short. No paragraphs, no restated task, no session or commit ids. The owning runner performs fixed Git operations; this does not publish central or submit a proposal. It commits what the checkout holds and stages, ignored paths aside; a new or changed file over 50 MiB fails the operation, so keep such data out of Git. Returns a durable operation. If queued or dispatched, inspect code.operation with the returned command.id. Reusing the same request with different input is refused. The runner also commits this checkout by itself every five minutes ("Checkpoint: …"), which moves HEAD: an expectedHead that only those checkpoints have moved past is taken as the newest of them, so the commit lands on top of them. An operation that failed with workspace_head_conflict means HEAD moved after you read it: read it again and commit under a new requestId.',
        inputSchema: codeCommitInputSchema,
        handler: async (caller: Caller, input: CodeCommitInput) =>
          await attached(ctx.codeWork.commit(caller, input)),
      },
      {
        name: 'code.merge',
        tier: 'worker' as const,
        description:
          'Start materializes the frozen merge in a clean checkout. Complete commits its resolution with the current checkpoint and frozen second parent. Supply expectedHead, message and a stable requestId; poll code.operation for the receipt. The message has a fixed shape: a first line of at most 72 characters saying what changed, then a blank line and, only where there is more than one thing to say, up to ten bullet points (each a line beginning \"- \"), one per significant change, each short. No paragraphs, no restated task, no session or commit ids.',
        inputSchema: codeMergeInputSchema,
        handler: async (caller: Caller, input: CodeMergeInput) =>
          await attached(ctx.codeWork.merge(caller, input)),
      },
    ];
    for (const definition of definitions) ctx.effect(() => ctx.tools.register(definition));
  },
};
export default codeToolsPlugin;

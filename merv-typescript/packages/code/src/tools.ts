import type { Context } from 'cordis';
import type {} from '@merv/api/types';
import type {} from './types.js';
import { publicationControlSchema } from './publication-host.js';
import { publicationReleaseSchema } from './publications.js';
import { baseControlSchema, type CodeBaseControl } from './bases.js';
import { codeBackupRunSchema } from './store/backup.js';
import type { CodeBaseControlInput } from '@merv/contracts';
import { z } from 'zod';
import {
  codeCommitInputSchema,
  codePublicationMergeSchema,
  type CodePublicationMerge,
  codeMergeInputSchema,
  type CodeMergeInput,
  codeLocalBindInputSchema,
  codeRepositoryConfigureInputSchema,
  codeMirrorRetryInputSchema,
  codeUnitFenceInputSchema,
  codeRepositoryImportInputSchema,
  codeRepositoryRebindInputSchema,
  type Caller,
  type CodeCommitInput,
  type CodeLocalBindInput,
  type CodeRepositoryConfigureInput,
  type CodeMirrorRetryInput,
  type CodeUnitFenceInput,
  type CodeRepositoryImportInput,
  type CodeRepositoryRebindInput,
} from '@merv/contracts';

export const codeToolsPlugin = {
  name: 'merv-code-tools',
  inject: ['code', 'tools'],
  apply(ctx: Context) {
    ctx.effect(() =>
      ctx.tools.register({
        name: 'code.publication.merge',
        description:
          'Signed-in human administrator: merge the independently approved proposal at its exact reviewed head. Code checks current main, rules and status, imports the merge, and completes only after verifying its parents and reviewed tree. A stale base returns the same consolidation for another round.',
        inputSchema: codePublicationMergeSchema,
        handler: (caller: Caller, input: CodePublicationMerge) =>
          ctx.code.mergePublication(caller, input),
      }),
    );
    ctx.effect(() =>
      ctx.tools.register({
        name: 'code.publication.sync',
        description:
          'Reconcile the server publication journal: open approved snapshot PRs, emit exact-head approval status and close superseded PRs. Requires project write authority and refuses leased workers.',
        inputSchema: z.object({}).strict(),
        handler: (caller: Caller) => ctx.code.syncPublications(caller),
      }),
    );
    ctx.effect(() =>
      ctx.tools.register({
        name: 'code.publication.control',
        description:
          'Signed-in human administrator: record the release canary result, acknowledge incomplete rules visibility, or clear publication disablement after a passing canary. Keep the tested App identity, rules and evidence in reason. A stale merge that succeeds disables this publication path; other work continues.',
        inputSchema: publicationControlSchema,
        handler: (caller: Caller, input: unknown) => ctx.code.controlPublication(caller, input),
      }),
    );
    ctx.effect(() =>
      ctx.tools.register({
        name: 'code.publication.release',
        description:
          'Let go of a publication that can no longer reach its repository, named by its proposalId from code.publication list. A publication keeps the repository, base branch and connection revision it was sealed with, so reconnecting GitHub, relinking the repository or turning write automation off leaves it unable to reach its repository for good, and the consolidation that is waiting for it has no action of its own; a publication that never managed to freeze a binding is stuck the same way. Releasing ends it and hands that consolidation straight back for another round against the connection the project has now, with its reviewed facts retained and code_publication_released recorded as its last error. Refused with code_publication_bound while the repository can still be reached, and refused once the publication has merged. Only a project administrator or operator key may call it, never a leased worker. Supply a reason and a stable requestId: the same request replays its result, a changed one is refused.',
        inputSchema: publicationReleaseSchema,
        handler: (caller: Caller, input: unknown) => ctx.code.releasePublication(caller, input),
      }),
    );
    ctx.effect(() =>
      ctx.tools.register({
        name: 'code.commit',
        description:
          'Request a Git checkpoint of this active writable session’s assigned checkout. Read its current HEAD with local Git first. Supply that full expectedHead, a commit message and a stable requestId. The owning runner performs fixed Git operations; this does not publish central or submit a proposal. Returns a durable operation. If queued or dispatched, inspect code.operation with the returned command.id. Reusing the same request with different input is refused.',
        inputSchema: codeCommitInputSchema,
        handler: async (caller: Caller, input: CodeCommitInput) =>
          await ctx.code.commit(caller, input),
      }),
    );
    ctx.effect(() =>
      ctx.tools.register({
        name: 'code.merge',
        description:
          'Start materializes the frozen merge in a clean checkout. Complete commits its resolution with the current checkpoint and frozen second parent. Supply expectedHead, message and a stable requestId; poll code.operation for the receipt.',
        inputSchema: codeMergeInputSchema,
        handler: async (caller: Caller, input: CodeMergeInput) =>
          await ctx.code.merge(caller, input),
      }),
    );
    ctx.effect(() =>
      ctx.tools.register({
        name: 'code.operation',
        description:
          'Inspect a durable code operation and its immutable commit receipt. Leased workers can inspect only their own operations. A succeeded receipt identifies the exact committed tree and parent; it does not authorize central publication.',
        inputSchema: z
          .object({ commandId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/) })
          .strict(),
        readOnly: true,
        handler: async (caller: Caller, input: { commandId: string }) =>
          await ctx.code.operation(caller, input.commandId),
      }),
    );
    for (const [action, instruction] of [
      ['retry', 'Retry infrastructure work on this same base with five new attempts.'],
      ['suspend', 'Suspend this base while retaining its current work and history.'],
      [
        'resume',
        'Resume a suspended base in its prior work state. A resolution task suspended by its review budget still needs workflow.extend_limit.',
      ],
      [
        'cancel',
        'Cancel this unresolved base permanently. Replan its waiters with corrective work.',
      ],
      [
        'quarantine',
        'Quarantine this base and its descendants, including existing pins and acceptances. Its immutable result stays retained and cannot be reused; create corrective work and replan.',
      ],
      [
        'release',
        'Release this base from quarantine after verifying the alarm was false. Every base and unit that only inherited the quarantine from it is released with it; a base quarantined in its own right keeps its own reach. A writer generation the quarantine had put into recovery_required stays there, and code.unit.fence ends it. Name the verification in reason.',
      ],
      [
        'repair',
        'Drop the Git ref an interrupted execution of this base left behind, so the next attempt can settle. Use it when this base reports that its ref names another commit. Refused for a base that is running, quarantined, or whose result is already sealed, because a sealed result is what everything pinned to it names. The receipt retains the commit that was dropped.',
      ],
    ] as const)
      ctx.effect(() =>
        ctx.tools.register({
          name: `code.base.${action}`,
          description: `${instruction} Supply the key from code.status, a reason and a stable requestId. Only a human or operator key with project admin permission may call it, never a leased worker.`,
          inputSchema: baseControlSchema.omit({ action: true }),
          handler: async (caller: Caller, input: Omit<CodeBaseControl, 'action'>) =>
            ctx.code.controlBase(caller, { ...input, action }),
        }),
      );
    // Nothing below is granted by any execution policy, so no leased worker calls it.
    ctx.effect(() =>
      ctx.tools.register({
        name: 'code.local.bind',
        description:
          'Bind this project to a repository identity and name the commit of its main before importing history. Only a signed-in project administrator may call it; an API key or a leased worker is refused. Use the existing runner repositoryId when importing legacy acceptances. mainOid is the full commit work without code-bearing dependencies starts from; hosted work waits until Code holds it. The first call binds. A later call with the same repositoryId moves main and must carry expectedMainOid, the main read from code.status, or it is refused with code_main_changed; work whose base is already pinned keeps the commit it copied. Another repositoryId is refused with code_rebind_required; code.repository.rebind changes the binding after verifying that Code holds the project’s history. Supply a stable requestId: the same request replays its result, and a changed one is refused.',
        inputSchema: codeLocalBindInputSchema,
        handler: async (caller: Caller, input: CodeLocalBindInput) =>
          await ctx.code.bindLocal(caller, input),
      }),
    );
    ctx.effect(() =>
      ctx.tools.register({
        name: 'code.unit.get',
        description:
          'Read what Code holds about one unit of work, named by its task or experiment id: the base it was pinned to with the accepted dependencies that base came from, and its acceptance with the exact reviewed code, the submission and review it names, and whether the reviewer’s checkout was attached at that code. storage legacy-local means the accepted code is retained only in the runner’s repository; storage code means Code’s own repository holds it, and receipt names the operation that made it durable. For a unit that lives in Code’s repository it also gives the writer: generation, the number of leased sessions that have written to it; writerState (reserved, active, closing while the last machine still owes its final capture, closed, or recovery_required); canonicalHead, the newest commit Code admitted, which is what the next session on any machine resumes from; quarantine, the final capture Code refused, whose findings code.status lists and which code.unit.fence resolves; and mirroredHead with mirroredAt, the commit that has reached the published GitHub repository, which lags canonicalHead while publication catches up and never holds any work up.',
        inputSchema: z
          .object({ unitId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/) })
          .strict(),
        readOnly: true,
        handler: async (caller: Caller, input: { unitId: string }) =>
          await ctx.code.unit(caller, input.unitId),
      }),
    );
    ctx.effect(() =>
      ctx.tools.register({
        name: 'code.status',
        description:
          'Read retained bases with frozen sponsors, execution epochs, admission blockers and operator reasons; each base also carries its project check — the verdict, the command, the machine it ran in, what that machine could not isolate, and what the command printed; code.base.retry, code.base.suspend/resume, code.base.cancel, code.base.quarantine, code.base.release and code.base.repair handle recovery. Read this project’s Code binding (repository, main and whether Code’s own repository holds it, the repositories it was bound to before with when, by whom and why each was left, and durability: legacy-local while accepted code stays on the runner, code once the project was imported), its newest 200 units with their base pins and acceptances, and every blocker Code has published for work whose base cannot be pinned yet; each blocker carries next, the recovery action. store describes the project’s repository on the server: whether it is hosted, its object format and root, the newest imported tips, its disk use against its quota, and its deny and exempt globs. operations lists every unfinished transfer, oldest first, with its phase, bytes received and, under waiting, why it is not moving and what would move it, followed by the newest refused ones with their findings. mirror says how the project’s work reaches the GitHub repository it is published to: off while nothing is linked or write automation is off (blockedBy says which), otherwise idle, pending, retrying or blocked, with how many refs are waiting, since when, the last error and every ref that waits for an operator under blockedRefs, each with the operationId code.mirror.retry takes. Publishing is the server’s own asynchronous work and is never on anybody’s path: a mirror that is behind or blocked stops no session, handoff or acceptance. warnings carries the same trouble as plain statements about the repository.',
        inputSchema: z.object({}).strict(),
        readOnly: true,
        handler: async (caller: Caller) => await ctx.code.status(caller),
      }),
    );
    ctx.effect(() =>
      ctx.tools.register({
        name: 'code.repository.import',
        description:
          'Bring history into the repository Code keeps for this project on the server, which is what makes the project hosted: new Git work is then kept by Code and can be resumed or reviewed on another machine. Only a project administrator may call it, never a leased worker, and the project must already be bound with code.local.bind. source bundle promises one Git bundle: tip is the commit it delivers, and bundle gives its sha256 and size; the call returns an operation, and the bundle is then sent in parts to PUT /code/v2/uploads/{id}/parts/{offset} and admitted with POST /code/v2/uploads/{id}/complete, which the code-import command does for you. source github reads one ref of the linked GitHub repository on the server. A bundle may build only on commits the repository already holds (store.tips in code.status), so a history larger than one transfer is imported in steps. Everything the transfer introduces is examined: integrity and connectivity, sizes and counts, paths, modes, symbolic links, submodules, the project’s deny globs and a short list of unmistakable credentials. Findings refuse the whole import and are listed on the operation without the matched text. Supply a stable requestId: the same request replays its operation, a changed one is refused.',
        inputSchema: codeRepositoryImportInputSchema,
        handler: async (caller: Caller, input: CodeRepositoryImportInput) =>
          await ctx.code.importRepository(caller, input),
      }),
    );
    ctx.effect(() =>
      ctx.tools.register({
        name: 'code.repository.configure',
        description:
          'Set what this project’s repository refuses beyond the fixed limits, and the one command that proves a merged base works. denyGlobs are paths no admitted history may contain; secretExemptGlobs are paths the credential patterns skip, for fixtures that are shaped like tokens. A glob is matched against the whole path from the repository root: a literal matches itself, ? one character and * any run within one segment, ** any run across segments. Both lists replace what was set. check is the project check and must be stated on every call: null turns verification off, and an object gives command, timeoutSeconds and image (provider, offerId and an optional snapshotId). The command runs against the merged tree in a machine this server rents for the occasion and never on this server; it is given no Merv credential and no environment, the machine has network access and a writable copy of the source, and every base record says so beside its verdict. A failing check is treated as a conflict and resolved by the one reviewed task a Git conflict is resolved by. Without a sandbox connection a configured command leaves each base unsealed and blocked with code_check_unavailable for an operator. Only a project administrator may call it. Supply a stable requestId.',
        inputSchema: codeRepositoryConfigureInputSchema,
        handler: async (caller: Caller, input: CodeRepositoryConfigureInput) =>
          await ctx.code.configureRepository(caller, input),
      }),
    );
    ctx.effect(() =>
      ctx.tools.register({
        name: 'code.repository.rebind',
        description:
          'Bind this hosted project to a different repository identity after proving Code can carry its history. Only a signed-in project administrator may call it; an API key or a leased worker is refused. This changes the identity the project stamps into new work; it moves no object, and it does not change or touch the GitHub repository this project is linked to. Before anything is written, Code checks that its own repository holds every commit this project has retained as authoritative — main, every accepted commit including every reviewed consolidation round’s, every unit head, every commit a unit’s base is pinned to and every resolved base — and a commit it does not hold refuses the whole rebind and is listed. A project whose repository was never imported into Code cannot be rebound. mainOid is the commit main becomes; if it is not ahead of the main being left behind, name that old main exactly as acknowledgePreviousMain. A rebind is refused while any base is unresolved or its project check is running, any writer generation is reserved, active or closing, any session holds a workspace, any transfer is unfinished, any publication is unsettled or any consolidation holds a frozen candidate set, and it names them. It is refused for the repository the project is already bound to; code.local.bind moves main. Acceptances and base pins made under the previous repository stay valid, and work accepted under it can still be frozen into a later consolidation and published to main, because the binding retains every repository it has been bound to; a frozen candidate set never spans a rebind, because one that is still outstanding refuses it. Give a reason and a stable requestId: the same request replays its operation, a changed one is refused, and a new one supersedes an unfinished rebind of yours.',
        inputSchema: codeRepositoryRebindInputSchema,
        handler: async (caller: Caller, input: CodeRepositoryRebindInput) =>
          await ctx.code.rebindRepository(caller, input),
      }),
    );
    ctx.effect(() =>
      ctx.tools.register({
        name: 'code.unit.fence',
        description:
          'End the writer generation of a unit that will not end by itself: its machine never handed over a final capture (code_recovery_required), or the final capture is quarantined (code_capture_quarantined; read the findings in code.status first). The unit closes at the last commit Code admitted, anything the old generation was still sending is kept on the server’s disk and never admitted, and the next lease continues from that commit as the next generation. Refused with code_operation_unresolved while an admitted upload of the unit is unfinished. Only a signed-in project administrator may call it. Supply a stable requestId.',
        inputSchema: codeUnitFenceInputSchema,
        handler: async (caller: Caller, input: CodeUnitFenceInput) =>
          await ctx.code.fenceUnit(caller, input),
      }),
    );
    ctx.effect(() =>
      ctx.tools.register({
        name: 'code.backup.run',
        description:
          'Take one verified copy of this project’s repository, and of the server’s database, to object storage now instead of waiting for the daily pass. Use it before a risky deploy or migration, and to give the restore drill something fresh to read. The database is dumped first and the repository bundled second, because a repository ahead of its database is recoverable and the reverse is not; the bundle carries every ref, its sha256 travels with it, and both objects are read back before the run is recorded. A project whose refs have not moved since the last copy reuses that bundle and rewrites only the pointer. The answer is the same backup block code.status reports: when the copy was taken and verified, what it wrote, the object a restore would read, and any warning — a repository whose bundle is larger than one object may be leaves the previous copy newest and warns code_backup_too_large. Copies older than the retention window are removed, never the one the pointer names. Only a project administrator or operator key may call it, never a leased worker. One pass runs at a time across the whole server, so a call made while the daily pass or another operator’s run is going is answered with code_backup_busy; ask again when it has finished. Supply a stable requestId: the same request replays its receipt. Answered with code_backup_unconfigured where this server keeps no off-host copy.',
        inputSchema: codeBackupRunSchema,
        handler: async (caller: Caller, input: unknown) => await ctx.code.runBackup(caller, input),
      }),
    );
    ctx.effect(() =>
      ctx.tools.register({
        name: 'code.mirror.retry',
        description:
          'Put one blocked publication of a Code ref back in the queue, named by the operationId code.status reports under mirror.blockedRefs. Publishing to GitHub is the server’s own asynchronous work: it never blocks a session, a handoff or an acceptance, so a blocked ref means only that the published repository has not received a commit Code already holds. A ref blocked after repeated failures is simply queued again. A ref blocked with code_mirror_diverged holds a commit Code did not write, which is somebody’s work: keep it somewhere first, then call this with acknowledgeRemote set to exactly that commit. Nothing here ever forces or deletes a published ref; work branches only ever fast-forward and accepted and base refs are only ever created. Only a project administrator may call it, never a leased worker. Supply a stable requestId.',
        inputSchema: codeMirrorRetryInputSchema,
        handler: async (caller: Caller, input: CodeMirrorRetryInput) =>
          await ctx.code.retryMirror(caller, input),
      }),
    );
  },
};
export default codeToolsPlugin;

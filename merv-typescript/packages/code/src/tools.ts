import type { Context } from 'cordis';
import type {} from '@merv/api/types';
import type {} from './types.js';
import { baseControlSchema } from './bases.js';
import type { CodeBaseControlInput } from '@merv/contracts';
import { z } from 'zod';
import {
  codeCommitInputSchema,
  codeMergeInputSchema,
  type CodeMergeInput,
  codeLocalBindInputSchema,
  codeRepositoryConfigureInputSchema,
  codeMirrorRetryInputSchema,
  codeUnitFenceInputSchema,
  codeRepositoryImportInputSchema,
  type Caller,
  type CodeCommitInput,
  type CodeLocalBindInput,
  type CodeRepositoryConfigureInput,
  type CodeMirrorRetryInput,
  type CodeUnitFenceInput,
  type CodeRepositoryImportInput,
} from '@merv/contracts';

export const codeToolsPlugin = {
  name: 'merv-code-tools',
  inject: ['code', 'tools'],
  apply(ctx: Context) {
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
    ] as const)
      ctx.effect(() =>
        ctx.tools.register({
          name: `code.base.${action}`,
          description: `${instruction} Supply the key from code.status, a reason and a stable requestId. Only a human or operator key with project admin permission may call it, never a leased worker.`,
          inputSchema: baseControlSchema.omit({ action: true }),
          handler: async (caller: Caller, input: Omit<CodeBaseControlInput, 'action'>) =>
            ctx.code.controlBase(caller, { ...input, action }),
        }),
      );
    // Nothing below is granted by any execution policy, so no leased worker calls it.
    ctx.effect(() =>
      ctx.tools.register({
        name: 'code.local.bind',
        description:
          'Bind this project to a repository identity and name the commit of its main before importing history. Only a signed-in project administrator may call it; an API key or a leased worker is refused. Use the existing runner repositoryId when importing legacy acceptances. mainOid is the full commit work without code-bearing dependencies starts from; hosted work waits until Code holds it. The first call binds. A later call with the same repositoryId moves main and must carry expectedMainOid, the main read from code.status, or it is refused with code_main_changed; work whose base is already pinned keeps the commit it copied. Another repositoryId is refused with code_rebind_required. Supply a stable requestId: the same request replays its result, and a changed one is refused.',
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
          'Read retained bases with frozen sponsors, execution epochs, admission blockers and operator reasons; code.base.retry, code.base.suspend/resume, code.base.cancel and code.base.quarantine handle recovery. Read this project’s Code binding (repository, main and whether Code’s own repository holds it, and durability: legacy-local while accepted code stays on the runner, code once the project was imported), its newest 200 units with their base pins and acceptances, and every blocker Code has published for work whose base cannot be pinned yet; each blocker carries next, the recovery action. store describes the project’s repository on the server: whether it is hosted, its object format and root, the newest imported tips, its disk use against its quota, and its deny and exempt globs. operations lists every unfinished transfer, oldest first, with its phase, bytes received and, under waiting, why it is not moving and what would move it, followed by the newest refused ones with their findings. mirror says how the project’s work reaches the GitHub repository it is published to: off while nothing is linked or write automation is off (blockedBy says which), otherwise idle, pending, retrying or blocked, with how many refs are waiting, since when, the last error and every ref that waits for an operator under blockedRefs, each with the operationId code.mirror.retry takes. Publishing is the server’s own asynchronous work and is never on anybody’s path: a mirror that is behind or blocked stops no session, handoff or acceptance. warnings carries the same trouble as plain statements about the repository.',
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
          'Set what this project’s repository refuses beyond the fixed limits. denyGlobs are paths no admitted history may contain; secretExemptGlobs are paths the credential patterns skip, for fixtures that are shaped like tokens. A glob is matched against the whole path from the repository root: a literal matches itself, ? one character and * any run within one segment, ** any run across segments. Both lists replace what was set. Only a project administrator may call it. Supply a stable requestId.',
        inputSchema: codeRepositoryConfigureInputSchema,
        handler: async (caller: Caller, input: CodeRepositoryConfigureInput) =>
          await ctx.code.configureRepository(caller, input),
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

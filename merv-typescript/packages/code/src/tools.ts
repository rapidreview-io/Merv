import type { Context } from 'cordis';
import type {} from '@merv/api/types';
import type {} from './types.js';
import { z } from 'zod';
import {
  codeCommitInputSchema,
  codeLocalBindInputSchema,
  type Caller,
  type CodeCommitInput,
  type CodeLocalBindInput,
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
    // None of the three below is granted by any execution policy, so no leased worker calls them.
    ctx.effect(() =>
      ctx.tools.register({
        name: 'code.local.bind',
        description:
          'Bind this project to the one local runner repository its Git work lives in, and name the commit of its main. Only a signed-in project administrator may call it; an API key or a leased worker is refused. repositoryId is the repository identity the runner reports for its checkouts, and mainOid is the full commit work without code-bearing dependencies starts from; the server cannot look inside a local repository, so both are taken as stated. The first call binds. A later call with the same repositoryId moves main and must carry expectedMainOid, the main read from code.status, or it is refused with code_main_changed; work whose base is already pinned keeps the commit it copied. Another repositoryId is refused with code_rebind_required. Supply a stable requestId: the same request replays its result, and a changed one is refused.',
        inputSchema: codeLocalBindInputSchema,
        handler: async (caller: Caller, input: CodeLocalBindInput) =>
          await ctx.code.bindLocal(caller, input),
      }),
    );
    ctx.effect(() =>
      ctx.tools.register({
        name: 'code.unit.get',
        description:
          'Read what Code holds about one unit of work, named by its task or experiment id: the base it was pinned to with the accepted dependencies that base came from, and its acceptance with the exact reviewed code, the submission and review it names, and whether the reviewer’s checkout was attached at that code. storage legacy-local means the accepted code is retained only in the runner’s repository.',
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
          'Read this project’s Code binding (repository, main, and that accepted code is kept legacy-local), its newest 200 units with their base pins and acceptances, and every blocker Code has published for work whose base cannot be pinned yet. Each blocker carries next, the recovery action.',
        inputSchema: z.object({}).strict(),
        readOnly: true,
        handler: async (caller: Caller) => await ctx.code.status(caller),
      }),
    );
  },
};
export default codeToolsPlugin;

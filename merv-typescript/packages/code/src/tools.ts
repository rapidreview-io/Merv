import type { Context } from 'cordis';
import type {} from '@merv/api/types';
import type {} from './types.js';
import { z } from 'zod';
import { codeCommitInputSchema, type Caller, type CodeCommitInput } from '@merv/contracts';

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
  },
};
export default codeToolsPlugin;

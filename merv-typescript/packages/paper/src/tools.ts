import type { Context } from 'cordis';
import type {} from '@merv/api/types';
import type {} from './types.js';
import { z } from 'zod';
import { citeSchema, kind, patchSchema } from './input.js';
import type { PaperKind } from './types.js';
export const paperToolsPlugin = {
  name: 'merv-paper-tools',
  inject: ['paper', 'tools'],
  apply(ctx: Context) {
    const paper = ctx.paper;
    ctx.effect(() =>
      ctx.tools.register({
        name: 'paper.read',
        description:
          'Read the living project paper: structured problem/scope/goals/constraints, literature, citation ledger, Methods and Results with reviewed paper contributions and revision history. Optional kind returns only that document; history returns its retained revisions.',
        inputSchema: z.object({ kind: kind.optional(), history: z.boolean().optional() }).strict(),
        readOnly: true,
        handler: async (caller, input: { kind?: PaperKind; history?: boolean }) =>
          input.kind
            ? input.history
              ? await paper.history(caller, input.kind)
              : (await paper.read(caller)).documents[input.kind]
            : await paper.read(caller),
      }),
    );
    ctx.effect(() =>
      ctx.tools.register({
        name: 'paper.patch',
        description:
          'Patch only changed sections of a living-paper document with expectedRevision. New sections require title/content; afterId:null moves to the beginning, afterId moves below an existing section, remove:true removes an unreferenced section. Problem uses fixed problem/scope/goals/constraints keys. Methods/Results edits are submitted as JSON change artifacts with experiment or reflection submissions and applied by their existing review.',
        inputSchema: patchSchema,
        readOnly: false,
        handler: async (caller, input) => await paper.patch(caller, input),
      }),
    );
    ctx.effect(() =>
      ctx.tools.register({
        name: 'paper.cite',
        description:
          'Create or revise one durable literature citation. Supply an identifier (for example doi:10... or arxiv:...), bibliographic fields, existing literature sectionIds, and project artifact:<id> evidence refs. expectedRevision is zero for a new entry.',
        inputSchema: citeSchema,
        readOnly: false,
        handler: async (caller, input) => await paper.cite(caller, input),
      }),
    );
  },
};
export default paperToolsPlugin;

import type { Context } from 'cordis';
import type {} from '@merv/api/types';
import type {} from './types.js';
import { z } from 'zod';
import { check } from '@merv/contracts';
import { citeSchema, id, kind, patchSchema } from './input.js';
const readSchema = z
  .object({
    kind: kind.optional(),
    history: z.boolean().optional(),
    section: id.optional(),
    offset: z.number().int().min(0).optional(),
    length: z.number().int().min(1).optional(),
  })
  .strict();
export const paperToolsPlugin = {
  name: 'merv-paper-tools',
  inject: ['paper', 'tools'],
  apply(ctx: Context) {
    const paper = ctx.paper;
    ctx.effect(() =>
      ctx.tools.register({
        name: 'paper.read',
        description:
          'Read the living project paper: structured problem/scope/goals/constraints, literature, citation ledger, Methods and Results with reviewed paper contributions and revision history. Optional kind returns only that document; history returns its retained revisions; section, one of its section ids, returns that section of the current document, and offset and length read part of its content, in characters, giving offset and total.',
        inputSchema: readSchema,
        readOnly: true,
        handler: async (caller, input: z.infer<typeof readSchema>) => {
          if (input.section === undefined)
            return input.kind
              ? input.history
                ? await paper.history(caller, input.kind)
                : (await paper.read(caller)).documents[input.kind]
              : await paper.read(caller);
          check(input.kind, 'invalid_paper_input', 'Name the kind of the section to read');
          const { revision, sections } = (await paper.read(caller)).documents[input.kind].current;
          const found = sections.find(({ id }) => id === input.section);
          check(found, 'not_found', 'Section not found', 404);
          const offset = Math.min(input.offset ?? 0, found.content.length);
          const end = input.length === undefined ? undefined : offset + input.length;
          return {
            ...found,
            kind: input.kind,
            revision,
            content: found.content.slice(offset, end),
            offset,
            total: found.content.length,
          };
        },
      }),
    );
    ctx.effect(() =>
      ctx.tools.register({
        name: 'paper.patch',
        description:
          'The main agent can directly edit any living-paper document with expectedRevision. Cite experiments as [Experiment name](/experiments/EXPERIMENT_ID), using the actual experiment name as the visible label and a stable ID in the link destination. New sections require title/content; afterId:null moves to the beginning, afterId moves below an existing section, remove:true removes an unreferenced section. Problem uses fixed problem/scope/goals/constraints keys. Assigned experiment and reflection reviewers submit Methods/Results edits in review.submit.paperChanges; producer assignments cannot edit the paper.',
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

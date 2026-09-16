import type { Context } from 'cordis';
import { z } from 'zod';
import type { Caller } from '@merv/contracts';
import type {} from '@merv/api/types';
import type { ClaimCreate, ClaimUpdate } from './types.js';
import { claimCreateSchema, claimUpdateSchema } from './input.js';

export const claimsToolsPlugin = {
  name: 'merv-claims-tools',
  inject: ['claims', 'tools'],
  apply(ctx: Context) {
    const claims = ctx.claims;
    for (const definition of [
      {
        name: 'claim.create',
        description:
          'Create a project research claim with a statement and optional prose scope. Status starts active; confidence defaults to medium. Producers and operators may write. The same normalized requestId retry returns its original receipt.',
        inputSchema: claimCreateSchema,
        handler: async (caller: Caller, input: ClaimCreate) => await claims.create(caller, input),
      },
      {
        name: 'claim.list',
        description:
          'Read all claims in the current project, including every status, in creation-time/ID order. Each record carries its current revision for updates. This does not select or start an experiment.',
        inputSchema: z.object({}).strict(),
        readOnly: true,
        handler: async (caller: Caller) => await claims.list(caller),
      },
      {
        name: 'claim.update',
        description:
          'Update a claim status and/or confidence using its current expectedRevision. Statement and scope stay unchanged. A conflicting edit requires a fresh read and decision; retrying the same requestId and input returns the original committed receipt. A completed experiment does not automatically support its claim.',
        inputSchema: claimUpdateSchema,
        handler: async (caller: Caller, input: ClaimUpdate) => await claims.update(caller, input),
      },
    ])
      ctx.effect(() => ctx.tools.register(definition));
  },
};
export default claimsToolsPlugin;

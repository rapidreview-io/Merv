import type { Context } from 'cordis';
import { z } from 'zod';
import type { Caller } from '@merv/contracts';
import type {} from '@merv/api/types';
import type { SandboxExtend, SandboxTarget } from './types.js';

const id = z.string().min(1).max(128);
/**
 * The two acts the manifest binds its Act controls to. The service decides everything else:
 * these carry one sandbox's id and, for a lease, the length the service is asked for, and
 * report the service's own answer. Both need the project's write permission, like every other
 * tool that changes something, and both are idempotent per sandbox: a lease renewed twice ends
 * where the last renewal put it, and a machine released twice is released once.
 */
export const sandboxesToolsPlugin = {
  name: 'merv-sandboxes-tools',
  inject: ['sandboxes', 'tools', 'scope'],
  apply(ctx: Context) {
    const definitions = [
      {
        name: 'sandbox.extend',
        description:
          'Adds seconds to the remaining lease on one sandbox: what is left is read first and carried, so extending a machine can only lengthen its life. The service refuses a sandbox that is no longer live, and refuses a total beyond the lease it allows. Answers the renewed record.',
        inputSchema: z.object({ id, seconds: z.number().int().min(60).max(86_400) }).strict(),
        handler: async (caller: Caller, input: SandboxExtend) => {
          await ctx.scope.require(caller, 'write');
          return await ctx.sandboxes.extend(caller, input);
        },
      },
      {
        name: 'sandbox.release',
        description:
          'Release one sandbox: the machine is deleted at the provider and everything on it goes with it, so retain what you need first. Retained job logs stay readable. Deletion is asynchronous — the answer is the record as it reads afterwards, usually while it is still deleting — and releasing an already-released sandbox changes nothing.',
        inputSchema: z.object({ id }).strict(),
        handler: async (caller: Caller, input: SandboxTarget) => {
          await ctx.scope.require(caller, 'write');
          return await ctx.sandboxes.release(caller, input);
        },
      },
    ];
    for (const definition of definitions) ctx.effect(() => ctx.tools.register(definition));
  },
};
export default sandboxesToolsPlugin;

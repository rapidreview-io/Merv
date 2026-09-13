import type { Context } from 'cordis';
import type {} from '@merv/api/types';
import { z } from 'zod';
export const scopeToolsPlugin = {
  name: 'merv-scope-tools',
  inject: ['scope', 'tools'],
  apply(ctx: Context) {
    const register = (
      name: string,
      description: string,
      inputSchema: z.ZodTypeAny,
      handler: any,
      readOnly = false,
    ) =>
      ctx.effect(() => ctx.tools.register({ name, description, inputSchema, handler, readOnly }));
    register(
      'project.get',
      'Read the current project.',
      z.object({}).strict(),
      (c: any) => ctx.scope.project(c),
      true,
    );
    register(
      'actor.whoami',
      'Read your authenticated actor identity and role.',
      z.object({}).strict(),
      (c: any) => ctx.scope.require(c, 'read'),
      true,
    );
    register(
      'actor.list',
      'Operator: list actors in this project.',
      z.object({}).strict(),
      (c: any) => ctx.scope.actors(c),
      true,
    );
    register(
      'actor.create',
      'Operator: create an actor credential. Return this token only to that actor.',
      z
        .object({
          name: z.string().min(1).max(200),
          role: z.enum(['operator', 'producer', 'reviewer', 'reader']),
        })
        .strict(),
      (c: any, i: any) => ctx.scope.issueActor(c, i),
    );
    register(
      'actor.revoke',
      'Operator: revoke another actor credential.',
      z.object({ actorId: z.string().min(1) }).strict(),
      (c: any, i: any) => {
        ctx.scope.revokeActor(c, i.actorId);
        return { revoked: true };
      },
    );
  },
};
export default scopeToolsPlugin;

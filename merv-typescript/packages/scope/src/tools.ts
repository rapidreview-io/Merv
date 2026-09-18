import type { Context } from 'cordis';
import type {} from '@merv/api/types';
import { z } from 'zod';
import { projectContextUpdateSchema } from './project-context.js';
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
      async (c: any) => await ctx.scope.project(c),
      true,
    );
    register(
      'project.context.update',
      'Replace the project Introduction using its exact previously read summary. Ordinary operators and producers only; worker sessions cannot change project intent. Reuse requestId only to retry identical input.',
      projectContextUpdateSchema,
      async (c: any, i: any) => await ctx.scope.updateProjectContext(c, i),
    );
    register(
      'actor.whoami',
      'Read your authenticated actor identity and role.',
      z.object({}).strict(),
      async (c: any) => await ctx.scope.require(c, 'read'),
      true,
    );
    register(
      'actor.list',
      'Operator: list actors in this project.',
      z.object({}).strict(),
      async (c: any) => await ctx.scope.actors(c),
      true,
    );
    register(
      'actor.create',
      'Operator: create an actor and its first project-bound token. Return this token only to that actor.',
      z
        .object({
          name: z.string().min(1).max(200),
          role: z.enum(['operator', 'producer', 'reviewer', 'reader']),
          expiresAt: z
            .string()
            .datetime({ precision: 3 })
            .describe('UTC with milliseconds, e.g. 2026-09-18T10:00:00.000Z')
            .nullable()
            .optional(),
        })
        .strict(),
      async (c: any, i: any) => await ctx.scope.issueActor(c, i),
    );
    register(
      'actor.credentials',
      'Read credential metadata for yourself, or as an operator for another actor in this project. Never returns bearer tokens or digests.',
      z.object({ actorId: z.string().min(1).optional() }).strict(),
      async (c: any, i: any) => await ctx.scope.actorCredentials(c, i.actorId),
      true,
    );
    register(
      'actor.issue_token',
      'Operator: issue an additional project-bound token for an existing actor, returning its secret once. Existing credentials stay valid. For your own rotation, verify this new token works before revoking the old one. Self-issued credentials cannot outlive the authenticating credential.',
      z
        .object({
          actorId: z.string().min(1),
          expiresAt: z
            .string()
            .datetime({ precision: 3 })
            .describe('UTC with milliseconds, e.g. 2026-09-18T10:00:00.000Z')
            .nullable()
            .optional(),
        })
        .strict(),
      async (c: any, i: any) => await ctx.scope.issueActorCredential(c, i),
    );
    register(
      'actor.rotate_token',
      'Operator: replace a project-bound actor token without changing its identity or work. To replace the token authenticating this request, use actor.issue_token followed by actor.revoke_token. Supply the old credentialId; it is revoked atomically and can only be rotated once. The new token is returned once. Omitted expiresAt preserves the old deadline. Only another actor’s operator may extend or remove a finite deadline.',
      z
        .object({
          credentialId: z.string().min(1),
          expiresAt: z
            .string()
            .datetime({ precision: 3 })
            .describe('UTC with milliseconds, e.g. 2026-09-18T10:00:00.000Z')
            .nullable()
            .optional(),
        })
        .strict(),
      async (c: any, i: any) => await ctx.scope.rotateCredential(c, i),
    );
    register(
      'actor.revoke_token',
      'Operator: revoke one credential. You may revoke an old token of your own using a different active token; the token authenticating this request cannot revoke itself. This leaves actor identity, work and review claims intact; use actor.revoke to withdraw the actor itself.',
      z.object({ credentialId: z.string().min(1) }).strict(),
      async (c: any, i: any) => {
        await ctx.scope.revokeCredential(c, i.credentialId);
        return { revoked: true };
      },
    );
    register(
      'actor.revoke',
      'Operator: withdraw another actor, blocking all its tokens and triggering actor-revocation recovery. Use actor.revoke_token to revoke only one credential.',
      z.object({ actorId: z.string().min(1) }).strict(),
      async (c: any, i: any) => {
        await ctx.scope.revokeActor(c, i.actorId);
        return { revoked: true };
      },
    );
  },
};
export default scopeToolsPlugin;

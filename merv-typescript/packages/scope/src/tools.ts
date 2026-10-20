import type { Context } from 'cordis';
import type {} from '@merv/api/types';
import { ROLES, type Caller } from '@merv/contracts';
import { z } from 'zod';

const expiresAt = z
  .string()
  .datetime({ precision: 3 })
  .describe('UTC with milliseconds, e.g. 2026-09-18T10:00:00.000Z')
  .nullable()
  .optional();
export const scopeToolsPlugin = {
  name: 'merv-scope-tools',
  inject: ['scope', 'tools'],
  apply(ctx: Context) {
    const register = <S extends z.ZodTypeAny>(
      name: string,
      description: string,
      inputSchema: S,
      handler: (caller: Caller, input: z.infer<S>) => unknown,
      readOnly = false,
      tier?: 'ui',
      worker?: 'never',
    ) =>
      ctx.effect(() =>
        ctx.tools.register({
          name,
          description,
          inputSchema,
          handler,
          readOnly,
          ...(tier && { tier }),
          worker,
        }),
      );
    register(
      'project.get',
      'Read the current project.',
      z.object({}).strict(),
      async (c) => await ctx.scope.project(c),
      true,
    );
    register(
      'project.brief',
      "Read what Merv's own agent is told each turn: who you are (actor id, name, role), the project (id, name), today's date (UTC) and the project as it is now (its paper). Your first read in a project, and to re-orient.",
      z.object({}).strict(),
      async (c) => {
        const [{ id, name, role }, project, context] = await Promise.all([
          ctx.scope.require(c, 'read'),
          ctx.scope.project(c),
          ctx.tools.context(c),
        ]);
        const today = new Date().toISOString().slice(0, 10);
        return {
          actor: { id, name, role },
          project: { id: project.id, name: project.name },
          today,
          context,
        };
      },
      true,
    );
    // The registry's own guide names no tool, so the tool's plugin says where to begin.
    ctx.effect(() =>
      ctx.tools.contributeInstructions(
        "Connected from outside Merv, make project.brief your first read in a project: who you are there, the project and its paper now (Merv's own agent is given it every turn).",
      ),
    );
    register(
      'actor.whoami',
      'Read your authenticated actor identity and role.',
      z.object({}).strict(),
      async (c) => await ctx.scope.require(c, 'read'),
      true,
    );
    register(
      'actor.list',
      'Operator: list actors in this project.',
      z.object({}).strict(),
      async (c) => await ctx.scope.actors(c),
      true,
      undefined,
      // An operator's read: a leased worker never holds admin.
      'never',
    );
    register(
      'actor.create',
      'Operator: create an actor and its first project-bound token. Return this token only to that actor. Nothing you create can outlive the credential authenticating you; an omitted expiresAt inherits its deadline.',
      z
        .object({
          name: z.string().min(1).max(200),
          role: z.enum(ROLES),
          expiresAt,
        })
        .strict(),
      async (c, i) => await ctx.scope.credentials.issueActor(c, i),
      false,
      'ui',
    );
    register(
      'actor.credentials',
      'Read credential metadata for yourself, or as an operator for another actor in this project. Never returns bearer tokens or digests.',
      z.object({ actorId: z.string().min(1).optional() }).strict(),
      async (c, i) => await ctx.scope.credentials.actorCredentials(c, i.actorId),
      true,
      'ui',
    );
    register(
      'actor.issue_token',
      'Operator: issue an additional project-bound token for an existing actor, returning its secret once. Existing credentials stay valid. For your own rotation, verify this new token works before revoking the old one. Nothing you issue can outlive the credential authenticating you; an omitted expiresAt inherits its deadline.',
      z
        .object({
          actorId: z.string().min(1),
          expiresAt,
        })
        .strict(),
      async (c, i) => await ctx.scope.credentials.issueActorCredential(c, i),
      false,
      'ui',
    );
    register(
      'actor.rotate_token',
      'Operator: replace a project-bound actor token without changing its identity or work. To replace the token authenticating this request, use actor.issue_token followed by actor.revoke_token. Supply the old credentialId; it is revoked atomically and can only be rotated once. The new token is returned once. Omitted expiresAt preserves the old deadline. Only another actor’s operator may extend or remove a finite deadline, and never beyond the deadline of the credential authenticating it.',
      z
        .object({
          credentialId: z.string().min(1),
          expiresAt,
        })
        .strict(),
      async (c, i) => await ctx.scope.credentials.rotateCredential(c, i),
      false,
      'ui',
    );
    register(
      'actor.revoke_token',
      'Operator: revoke one credential. You may revoke an old token of your own using a different active token; the token authenticating this request cannot revoke itself. This leaves actor identity, work and review claims intact; use actor.revoke to withdraw the actor itself.',
      z.object({ credentialId: z.string().min(1) }).strict(),
      async (c, i) => {
        await ctx.scope.credentials.revokeCredential(c, i.credentialId);
        return { revoked: true };
      },
      false,
      'ui',
    );
    register(
      'actor.revoke',
      'Operator: withdraw another actor, blocking all its tokens and triggering actor-revocation recovery. Use actor.revoke_token to revoke only one credential.',
      z.object({ actorId: z.string().min(1) }).strict(),
      async (c, i) => {
        await ctx.scope.credentials.revokeActor(c, i.actorId);
        return { revoked: true };
      },
      false,
      'ui',
    );
  },
};
export default scopeToolsPlugin;

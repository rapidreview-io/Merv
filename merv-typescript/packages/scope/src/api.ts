import type { Context } from 'cordis';
import { z } from 'zod';
import { check, MervError, pathSegment, ROLES, type Scope } from '@merv/contracts';
import type { MountHandler } from '@merv/api/types';
import { projectSelection, unknownEndpoint, validated } from '@merv/api/errors';
import type { IdentityProvider } from '@merv/identity/types';
import {
  invitationEmailSchema,
  ResendInvitationSender,
  type InvitationSender,
} from './invitation-email.js';
import { OAuth, oauthConfig } from './oauth.js';
import { oauthRoutes } from './oauth-api.js';
import { setupRoutes } from './setup.js';
import type { ProjectScope } from './index.js';

const nonblank = z.string().trim().min(1).max(512);
const role = z.enum(ROLES);
// Scope keys a project request by its trimmed requestId and holds it to 256 characters.
const createProjectInput = z
  .object({ name: nonblank, requestId: z.string().trim().min(1).max(256) })
  .strict();
const addMemberInput = z.object({ subject: nonblank, role }).strict();
const inviteInput = z
  .object({
    email: z
      .string()
      .trim()
      .email()
      .max(320)
      .transform((value) => value.toLowerCase()),
    role,
  })
  .strict();
const changeMemberInput = z.object({ role }).strict();
const adminInput = z.object({ issuer: nonblank, subject: nonblank }).strict();
const keyExpiry = z.string().datetime({ precision: 3 }).nullable().optional();
const keyProject = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value && !value.includes('\0'));
const createKeyInput = z
  .object({
    projectId: keyProject,
    grantScope: z.enum(['project', 'account']).optional(),
    label: z.string().max(120).nullable().optional(),
    expiresAt: keyExpiry,
  })
  .strict();
const rotateKeyInput = z.object({ expiresAt: keyExpiry }).strict();

/** A key route takes no query, except that a listing may name one project. */
function keyQuery(params: URLSearchParams, allowProject = false): string | undefined {
  if (
    [...params.keys()].some((key) => !allowProject || key !== 'projectId') ||
    params.getAll('projectId').length > 1
  )
    throw new MervError('invalid_input', 'Unsupported or repeated key query parameter');
  const projectId = params.get('projectId');
  if (projectId === null) return undefined;
  // The same 400, details included, as a key body naming a malformed project.
  return validated(keyProject.safeParse(projectId));
}

/**
 * `/account` and `/projects`: the authenticated person's, key's or actor's own account, keys,
 * projects and memberships. Scope authorizes each call, and its reads take no writer lock.
 */
export function scopeRoutes(
  scope: Scope,
  invitations?: { identity: IdentityProvider; sender: InvitationSender },
): MountHandler {
  // Bound the directory calls, including misses, before reaching Supabase. Per-process abuse guard;
  // durable per-inviter limits also apply when creating an invitation.
  const lookups = new Map<string, number[]>();
  return async (req, _res, r) => {
    const path = r.url.pathname;
    const principal = r.principal!;
    // A credential owner's caller has no account here.
    if ('caller' in principal) throw unknownEndpoint();
    if (path === '/account' && req.method === 'GET')
      return {
        ...(principal.kind === 'user'
          ? { kind: 'user', user: principal.user }
          : principal.kind === 'key'
            ? { kind: 'key', key: principal.key }
            : { kind: 'actor', actor: principal.actor }),
        projects: await scope.projects(principal),
      };
    if (path === '/account/invitations' && req.method === 'GET')
      return { invitations: await scope.members.invitations(principal) };
    const responseRoute = /^\/account\/invitations\/([^/]+)\/(accept|decline)$/.exec(path);
    if (responseRoute && req.method === 'POST') {
      await r.json(z.object({}).strict());
      return {
        membership: await scope.members.respondToInvitation(
          principal,
          pathSegment(responseRoute[1]!),
          responseRoute[2] as 'accept' | 'decline',
        ),
      };
    }
    const invitationRoute = /^\/projects\/([^/]+)\/invitations(?:\/([^/]+)(\/send)?)?$/.exec(path);
    if (invitationRoute) {
      const projectId = pathSegment(invitationRoute[1]!);
      const id = invitationRoute[2] && pathSegment(invitationRoute[2]);
      check(
        principal.kind === 'user',
        'forbidden',
        'Sign in with an account to invite members',
        403,
      );
      const caller = await r.caller(projectId);
      await scope.require(caller, 'admin');
      if (!id && req.method === 'GET')
        return { invitations: await scope.members.invitations(principal, projectId) };
      if (id && !invitationRoute[3] && req.method === 'DELETE') {
        await scope.members.revokeInvitation(principal, projectId, id);
        return { revoked: true };
      }
      if (req.method === 'POST' && (!id || invitationRoute[3])) {
        check(
          invitations?.identity.findUserByEmail,
          'invitation_email_unavailable',
          'Email invitations are not configured',
          503,
        );
        const now = Date.now();
        for (const [key, stamps] of lookups)
          if (!stamps.some((stamp) => now - stamp < 60_000)) lookups.delete(key);
        const key = JSON.stringify([principal.user.issuer, principal.user.subject]);
        const recent = (lookups.get(key) ?? []).filter((stamp) => now - stamp < 60_000);
        check(
          recent.length < 10,
          'invitation_rate_limited',
          'Too many invitation requests; try again shortly',
          429,
        );
        lookups.set(key, [...recent, now]);
        let invitation;
        if (id) {
          await r.json(z.object({}).strict());
          invitation = (await scope.members.invitations(principal, projectId)).find(
            (value) => value.id === id,
          );
          check(
            invitation?.status === 'pending',
            'invitation_closed',
            'Invitation is no longer pending',
            409,
          );
        } else {
          const input = await r.json(inviteInput);
          const recipient = await invitations.identity.findUserByEmail(input.email);
          check(
            recipient,
            'not_found',
            'No account found for that email. Ask them to sign up first.',
            404,
          );
          invitation = await scope.members.inviteMember(principal, projectId, {
            ...recipient,
            ...input,
          });
        }
        if (!invitation.sentAt) {
          await invitations.sender.send(invitation);
          await scope.members.invitationSent(principal, projectId, invitation.id);
        }
        return {
          invitation: (await scope.members.invitations(principal, projectId)).find(
            (value) => value.id === invitation.id,
          ),
        };
      }
    }
    // A key signs itself out; it can name no other key.
    if (path === '/account/key' && req.method === 'DELETE') {
      keyQuery(r.url.searchParams);
      await scope.userKeys.revokePresented(principal);
      return { revoked: true };
    }
    if (path === '/account/keys') {
      const projectId = keyQuery(r.url.searchParams, req.method === 'GET');
      if (req.method === 'GET') return { keys: await scope.userKeys.keys(principal, projectId) };
      if (req.method === 'POST')
        return await scope.userKeys.create(principal, await r.json(createKeyInput));
    }
    const keyRoute = /^\/account\/keys\/([^/]+)(\/rotate)?$/.exec(path);
    if (keyRoute) {
      keyQuery(r.url.searchParams);
      const keyId = pathSegment(keyRoute[1]!);
      if (keyRoute[2] && req.method === 'POST')
        return await scope.userKeys.rotate(principal, { keyId, ...(await r.json(rotateKeyInput)) });
      if (!keyRoute[2] && req.method === 'DELETE') {
        await scope.userKeys.revoke(principal, keyId);
        return { revoked: true };
      }
    }
    if (path === '/projects' && req.method === 'GET')
      return { projects: await scope.projects(principal) };
    if (path === '/projects' && req.method === 'POST')
      return {
        project: await scope.members.createProject(principal, await r.json(createProjectInput)),
      };
    const adminRoute = /^\/projects\/([^/]+)\/admin$/.exec(path);
    if (adminRoute && req.method === 'PATCH') {
      const projectId = pathSegment(adminRoute[1]!);
      projectSelection(req.headers['x-merv-project-id'], projectId);
      return {
        admin: await scope.members.setAdmin(principal, projectId, await r.json(adminInput)),
      };
    }
    const memberRoute = /^\/projects\/([^/]+)\/members(?:\/([^/]+))?$/.exec(path);
    if (memberRoute) {
      const projectId = pathSegment(memberRoute[1]!);
      const subject = memberRoute[2] === undefined ? undefined : pathSegment(memberRoute[2]);
      projectSelection(req.headers['x-merv-project-id'], projectId);
      if (subject === undefined && req.method === 'GET')
        return await scope.members.memberships(principal, projectId);
      if (subject === undefined && req.method === 'POST') {
        await r.json(addMemberInput);
        // Do not leave an account-ID bypass around the recipient's consent.
        throw new MervError(
          'invitation_required',
          'Invite this person by email; they must accept before joining',
          403,
        );
      }
      if (subject !== undefined && req.method === 'PATCH')
        return {
          membership: await scope.members.changeMemberRole(principal, projectId, {
            subject,
            ...(await r.json(changeMemberInput)),
          }),
        };
      if (subject !== undefined && req.method === 'DELETE') {
        await scope.members.removeMember(principal, projectId, subject);
        return { removed: true };
      }
    }
    throw unknownEndpoint();
  };
}

const Config = z
  .object({ invitations: invitationEmailSchema.optional(), oauth: oauthConfig.optional() })
  .strict()
  .default({});
export const scopeApiPlugin = {
  name: 'merv-scope-api',
  Config,
  inject: ['scope', 'api', 'identity', 'state'],
  async apply(ctx: Context, config: z.infer<typeof Config>) {
    const routes = scopeRoutes(
      ctx.scope,
      config.invitations
        ? { identity: ctx.identity, sender: new ResendInvitationSender(config.invitations) }
        : undefined,
    );
    ctx.effect(() => ctx.api.mount('/account', routes));
    ctx.effect(() => ctx.api.mount('/projects', routes));
    if (config.oauth) {
      const identity = ctx.identity.configuration();
      if (!identity.enabled || !identity.login)
        throw new MervError(
          'oauth_identity_unavailable',
          'OAuth requires configured browser account sign-in',
          503,
        );
      const oauth = new OAuth(ctx.state, ctx.scope as ProjectScope, config.oauth.publicOrigin);
      await oauth.initialize();
      const handler = oauthRoutes(oauth, ctx.identity);
      ctx.effect(() => ctx.api.mount('/oauth', handler, { public: true }));
      ctx.effect(() => ctx.api.mount('/.well-known', handler, { public: true }));
      ctx.effect(() =>
        ctx.api.oauth({
          metadataUrl: `${oauth.origin}/.well-known/oauth-protected-resource/mcp`,
          authenticate: (token) => oauth.authenticate(token),
        }),
      );
      ctx.effect(() => ctx.api.mount('/connect', setupRoutes(oauth.origin), { public: true }));
    }
  },
};
export default scopeApiPlugin;

import type { Context } from 'cordis';
import { z } from 'zod';
import { MervError, pathSegment, ROLES, type Scope } from '@merv/contracts';
import type { MountHandler } from '@merv/api/types';
import { unknownEndpoint } from '@merv/api/errors';

const nonblank = z.string().trim().min(1).max(512);
const role = z.enum(ROLES);
// Scope keys a project request by its trimmed requestId and holds it to 256 characters.
const createProjectInput = z
  .object({ name: nonblank, requestId: z.string().trim().min(1).max(256) })
  .strict();
const addMemberInput = z.object({ subject: nonblank, role }).strict();
const changeMemberInput = z.object({ role }).strict();
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
  const parsed = keyProject.safeParse(projectId);
  if (!parsed.success)
    throw new MervError(
      'invalid_input',
      'Request body failed validation',
      400,
      parsed.error.issues.map(({ path, message, code }) => ({ path, message, code })),
    );
  return parsed.data;
}

/**
 * `/account` and `/projects`: the authenticated person's, key's or actor's own account, keys,
 * projects and memberships. Scope authorizes each call, and its reads take no writer lock.
 */
export function scopeRoutes(scope: Scope): MountHandler {
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
    if (path === '/account/keys') {
      const projectId = keyQuery(r.url.searchParams, req.method === 'GET');
      if (req.method === 'GET') return { keys: await scope.keys(principal, projectId) };
      if (req.method === 'POST')
        return await scope.createKey(principal, await r.json(createKeyInput));
    }
    const keyRoute = /^\/account\/keys\/([^/]+)(\/rotate)?$/.exec(path);
    if (keyRoute) {
      keyQuery(r.url.searchParams);
      const keyId = pathSegment(keyRoute[1]!);
      if (keyRoute[2] && req.method === 'POST')
        return await scope.rotateKey(principal, { keyId, ...(await r.json(rotateKeyInput)) });
      if (!keyRoute[2] && req.method === 'DELETE') {
        await scope.revokeKey(principal, keyId);
        return { revoked: true };
      }
    }
    if (path === '/projects' && req.method === 'GET')
      return { projects: await scope.projects(principal) };
    if (path === '/projects' && req.method === 'POST')
      return { project: await scope.createProject(principal, await r.json(createProjectInput)) };
    const memberRoute = /^\/projects\/([^/]+)\/members(?:\/([^/]+))?$/.exec(path);
    if (memberRoute) {
      const projectId = pathSegment(memberRoute[1]!);
      const subject = memberRoute[2] === undefined ? undefined : pathSegment(memberRoute[2]);
      const selected = req.headers['x-merv-project-id'];
      if (selected !== undefined && (typeof selected !== 'string' || !selected.trim()))
        throw new MervError('invalid_input', 'projectId must be a non-empty string');
      if (selected !== undefined && selected !== projectId)
        throw new MervError('invalid_input', 'Conflicting Merv project selections');
      if (subject === undefined && req.method === 'GET')
        return { memberships: await scope.memberships(principal, projectId) };
      if (subject === undefined && req.method === 'POST')
        return {
          membership: await scope.addMember(principal, projectId, await r.json(addMemberInput)),
        };
      if (subject !== undefined && req.method === 'PATCH')
        return {
          membership: await scope.changeMemberRole(principal, projectId, {
            subject,
            ...(await r.json(changeMemberInput)),
          }),
        };
      if (subject !== undefined && req.method === 'DELETE') {
        await scope.removeMember(principal, projectId, subject);
        return { removed: true };
      }
    }
    throw unknownEndpoint();
  };
}

export const scopeApiPlugin = {
  name: 'merv-scope-api',
  inject: ['scope', 'api'],
  apply(ctx: Context) {
    const routes = scopeRoutes(ctx.scope);
    ctx.effect(() => ctx.api.mount('/account', routes));
    ctx.effect(() => ctx.api.mount('/projects', routes));
  },
};
export default scopeApiPlugin;

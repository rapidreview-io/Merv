import type { Context } from 'cordis';
import { z } from 'zod';
import { check, MervError, type Caller, type Scope } from '@merv/contracts';
import type { AccessPolicy, ToolGrant } from './types.js';

export type { AccessPolicy, ToolGrant } from './types.js';

const identity = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value && !/[\s*?]/.test(value), 'Expected an exact identity');
const grantsSchema = z.array(
  z
    .object({
      projectId: identity,
      actorId: identity,
      mountId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
      tools: z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/)),
    })
    .strict(),
);
const key = (caller: Caller, mountId: string, toolName: string) =>
  JSON.stringify([caller.projectId, caller.actorId, mountId, toolName]);

/** In-memory exact grants; Scope remains authoritative for the actor's current project access. */
export class ExactAccessPolicy implements AccessPolicy {
  private granted = new Set<string>();

  constructor(
    private readonly scope: Pick<Scope, 'require'>,
    grants: ToolGrant[] = [],
  ) {
    this.replace(grants);
  }

  allows(caller: Caller, mountId: string, toolName: string): boolean {
    try {
      this.scope.require(caller, 'read');
    } catch (error) {
      if (error instanceof MervError && (error.status === 401 || error.status === 403))
        return false;
      throw error;
    }
    return this.granted.has(key(caller, mountId, toolName));
  }

  require(caller: Caller, mountId: string, toolName: string): void {
    this.scope.require(caller, 'read');
    check(
      this.granted.has(key(caller, mountId, toolName)),
      'tool_forbidden',
      'Actor is not granted access to this remote tool',
      403,
    );
  }

  replace(grants: ToolGrant[]): void {
    const parsed = grantsSchema.safeParse(grants);
    check(
      parsed.success,
      'invalid_access_grants',
      'Access grants must contain exact validated identities and tool names',
    );
    const next = new Set<string>();
    for (const grant of parsed.data)
      for (const toolName of grant.tools) next.add(key(grant, grant.mountId, toolName));
    this.granted = next;
  }
}

export const accessPlugin = {
  name: 'merv-access',
  Config: z
    .object({ grants: grantsSchema.default([]) })
    .strict()
    .default({ grants: [] }),
  inject: ['scope'],
  apply(ctx: Context, config: { grants: ToolGrant[] } = { grants: [] }) {
    ctx.provide('access', new ExactAccessPolicy(ctx.scope, config.grants));
  },
};
export default accessPlugin;

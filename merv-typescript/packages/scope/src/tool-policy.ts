import { z } from 'zod';
import { check, MervError, type Caller, type Scope } from '@merv/contracts';
import type { ToolPolicy, ToolGrant } from '@merv/contracts';

const identity = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value && !/[\s*?]/.test(value), 'Expected an exact identity');
export const grantsSchema = z.array(
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
export class ExactToolPolicy implements ToolPolicy {
  private grants = new Set<string>();

  constructor(
    private readonly scope: Pick<Scope, 'require'> & Partial<Pick<Scope, 'authorityActor'>>,
    grants: ToolGrant[] = [],
  ) {
    this.replace(grants);
  }

  async granted(caller: Caller): Promise<(mountId: string, toolName: string) => boolean> {
    let holder: Caller;
    try {
      holder = await this.effective(caller);
    } catch (error) {
      if (error instanceof MervError && (error.status === 401 || error.status === 403))
        return () => false;
      throw error;
    }
    // The grants of this decision: a later replace() does not change an answer already given.
    const grants = this.grants;
    return (mountId, toolName) => grants.has(key(holder, mountId, toolName));
  }

  async require(caller: Caller, mountId: string, toolName: string): Promise<void> {
    caller = await this.effective(caller);
    check(
      this.grants.has(key(caller, mountId, toolName)),
      'tool_forbidden',
      'Actor is not granted access to this remote tool',
      403,
    );
  }

  /**
   * The grant holder, authorized for read once: a worker session acts for its delegating owner,
   * whom authorityActor checks in the same decision as the session itself.
   */
  private async effective(caller: Caller): Promise<Caller> {
    if (caller.session && this.scope.authorityActor) {
      const actor = await this.scope.authorityActor(caller);
      return { actorId: actor.id, projectId: actor.projectId };
    }
    await this.scope.require(caller, 'read');
    check(!caller.session, 'session_unavailable', 'Session authority is unavailable', 503);
    return caller;
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
    this.grants = next;
  }
}

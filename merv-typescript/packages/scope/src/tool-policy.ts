import { z } from 'zod';
import { check, MervError, type Caller, type Data, type Scope } from '@merv/contracts';
import type {
  ToolPolicy,
  SessionToolInvocation,
  SessionToolPolicy,
  ToolGrant,
} from '@merv/contracts';

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
  private granted = new Set<string>();
  private sessions?: SessionToolPolicy;

  constructor(
    private readonly scope: Pick<Scope, 'require'> & Partial<Pick<Scope, 'authorityActor'>>,
    grants: ToolGrant[] = [],
  ) {
    this.replace(grants);
  }

  async allows(caller: Caller, mountId: string, toolName: string): Promise<boolean> {
    try {
      await this.scope.require(caller, 'read');
      caller = await this.authority(caller);
    } catch (error) {
      if (error instanceof MervError && (error.status === 401 || error.status === 403))
        return false;
      throw error;
    }
    return this.granted.has(key(caller, mountId, toolName));
  }

  async require(caller: Caller, mountId: string, toolName: string): Promise<void> {
    await this.scope.require(caller, 'read');
    caller = await this.authority(caller);
    check(
      this.granted.has(key(caller, mountId, toolName)),
      'tool_forbidden',
      'Actor is not granted access to this remote tool',
      403,
    );
  }

  private async authority(caller: Caller): Promise<Caller> {
    if (!caller.session) return caller;
    check(
      this.scope.authorityActor,
      'session_unavailable',
      'Session authority is unavailable',
      503,
    );
    const actor = await this.scope.authorityActor(caller);
    return { actorId: actor.id, projectId: actor.projectId };
  }

  registerSessions(provider: SessionToolPolicy): () => void {
    check(!this.sessions, 'session_provider_conflict', 'Session policy is already registered', 409);
    this.sessions = provider;
    return () => {
      if (this.sessions === provider) this.sessions = undefined;
    };
  }

  private sessionPolicy(): SessionToolPolicy {
    check(this.sessions, 'session_unavailable', 'Session policy is unavailable', 503);
    return this.sessions;
  }

  async allowsTool(caller: Caller, name: string): Promise<boolean> {
    await this.scope.require(caller, 'read');
    return !caller.session || (await this.sessionPolicy().allowsTool(caller, name));
  }

  async prepare(caller: Caller, name: string, input: Data): Promise<SessionToolInvocation> {
    await this.scope.require(caller, 'read');
    return caller.session
      ? await this.sessionPolicy().prepare(caller, name, input)
      : { caller, tool: name, input };
  }

  async validate(caller: Caller, name: string, input: Data): Promise<void> {
    await this.scope.require(caller, 'read');
    if (caller.session) await this.sessionPolicy().validate(caller, name, input);
  }

  async cancel(invocation: SessionToolInvocation): Promise<void> {
    if (invocation.caller.session) await this.sessions?.cancel(invocation);
  }

  async run<T>(
    invocation: SessionToolInvocation,
    handler: (caller: Caller, input: Data) => T | Promise<T>,
  ): Promise<T> {
    await this.scope.require(invocation.caller, 'read');
    return invocation.caller.session
      ? this.sessionPolicy().run(invocation, handler)
      : handler(invocation.caller, invocation.input);
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

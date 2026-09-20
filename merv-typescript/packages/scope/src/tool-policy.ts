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

type SessionRegistration = { provider: SessionToolPolicy };

/** In-memory exact grants; Scope remains authoritative for the actor's current project access. */
export class ExactToolPolicy implements ToolPolicy {
  private granted = new Set<string>();
  private sessions?: SessionRegistration;
  private readonly preparations = new WeakMap<SessionToolInvocation, SessionRegistration>();

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
    const registration = { provider };
    this.sessions = registration;
    return () => {
      if (this.sessions === registration) this.sessions = undefined;
    };
  }

  private sessionPolicy(): SessionRegistration {
    check(this.sessions, 'session_unavailable', 'Session policy is unavailable', 503);
    return this.sessions;
  }

  private requireRegistration(registration: SessionRegistration): void {
    check(
      this.sessions === registration,
      'session_unavailable',
      'Session policy changed during authorization; retry with the current provider',
      503,
    );
  }

  async allowsTool(caller: Caller, name: string, read?: boolean): Promise<boolean> {
    const registration = caller.session ? this.sessionPolicy() : undefined;
    await this.scope.require(caller, 'read');
    if (!registration) return true;
    this.requireRegistration(registration);
    const allowed = await registration.provider.allowsTool(caller, name, read);
    this.requireRegistration(registration);
    return allowed;
  }

  async prepare(
    caller: Caller,
    name: string,
    input: Data,
    read?: boolean,
  ): Promise<SessionToolInvocation> {
    const registration = caller.session ? this.sessionPolicy() : undefined;
    await this.scope.require(caller, 'read');
    if (!registration) return { caller, tool: name, input };
    this.requireRegistration(registration);
    const invocation = await registration.provider.prepare(caller, name, input, read);
    try {
      this.requireRegistration(registration);
    } catch (error) {
      // Preparation may allocate a reservation before yielding. Its original owner
      // must release it even though this registration can no longer authorize work.
      await registration.provider.cancel(invocation);
      throw error;
    }
    this.preparations.set(invocation, registration);
    return invocation;
  }

  async validate(caller: Caller, name: string, input: Data): Promise<void> {
    const registration = caller.session ? this.sessionPolicy() : undefined;
    await this.scope.require(caller, 'read');
    if (registration) {
      this.requireRegistration(registration);
      await registration.provider.validate(caller, name, input);
      this.requireRegistration(registration);
    }
  }

  async cancel(invocation: SessionToolInvocation): Promise<void> {
    const registration = this.preparations.get(invocation);
    if (!registration) return;
    this.preparations.delete(invocation);
    await registration.provider.cancel(invocation);
  }

  async run<T>(
    invocation: SessionToolInvocation,
    handler: (caller: Caller, input: Data) => T | Promise<T>,
  ): Promise<T> {
    const registration = this.preparations.get(invocation);
    if (invocation.caller.session) {
      check(registration, 'session_invocation', 'Session invocation is unavailable', 403);
      this.requireRegistration(registration);
    }
    await this.scope.require(invocation.caller, 'read');
    if (!registration) return handler(invocation.caller, invocation.input);
    this.requireRegistration(registration);
    return registration.provider.run(invocation, (caller, input) => {
      // Provider admission may itself await storage. Check once more at dispatch,
      // but do not turn an already committed mutation into an error afterward.
      this.requireRegistration(registration);
      return handler(caller, input);
    });
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

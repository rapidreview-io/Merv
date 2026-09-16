import type { Caller, Data } from './index.js';

/** Exact remote tool names; a grant never expands by role, annotation, or wildcard. */
export interface ToolGrant {
  projectId: string;
  actorId: string;
  mountId: string;
  tools: string[];
}

/** A server-owned invocation; Session policy providers authenticate its identity. */
export interface SessionToolInvocation {
  readonly caller: Caller;
  readonly tool: string;
  readonly input: Data;
}
/** Consumer contract; Scope has no dependency on the Sessions implementation. */
export interface SessionToolPolicy {
  allowsTool(caller: Caller, name: string): Promise<boolean>;
  prepare(caller: Caller, name: string, input: Data): Promise<SessionToolInvocation>;
  validate(caller: Caller, name: string, input: Data): Promise<void>;
  cancel(invocation: SessionToolInvocation): void | Promise<void>;
  run<T>(
    invocation: SessionToolInvocation,
    handler: (caller: Caller, input: Data) => T | Promise<T>,
  ): Promise<T>;
}
export interface ToolPolicy extends SessionToolPolicy {
  registerSessions(provider: SessionToolPolicy): () => void;
  allows(caller: Caller, mountId: string, toolName: string): Promise<boolean>;
  require(caller: Caller, mountId: string, toolName: string): Promise<void>;
  /** Trusted in-process administration. Invalid replacements leave the current policy intact. */
  replace(grants: ToolGrant[]): void;
}

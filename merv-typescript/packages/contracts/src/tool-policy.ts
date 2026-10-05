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
/**
 * Consumer contract; the tool registry has no dependency on the Sessions implementation. `read` marks
 * a tool that only reads: a session may call any such tool with any arguments, because a
 * session reads whatever its project holds (founder, 2026-09-17: no read constraints).
 */
export interface SessionToolPolicy {
  /** What a session's MCP client is told about its connection (its MCP instructions). */
  readonly instructions?: string;
  allowsTool(caller: Caller, name: string, read?: boolean): Promise<boolean>;
  prepare(
    caller: Caller,
    name: string,
    input: Data,
    read?: boolean,
  ): Promise<SessionToolInvocation>;
  validate(caller: Caller, name: string, input: Data): Promise<void>;
  cancel(invocation: SessionToolInvocation): void | Promise<void>;
  run<T>(
    invocation: SessionToolInvocation,
    handler: (caller: Caller, input: Data) => T | Promise<T>,
  ): Promise<T>;
}
export interface ToolPolicy {
  /** One decision for a whole listing: which exact grants the caller holds now. An ordinary
   *  authentication or permission failure grants nothing; infrastructure errors propagate. */
  granted(caller: Caller): Promise<(mountId: string, toolName: string) => boolean>;
  /** Authorizes the caller's read and its exact grant in one decision: the tool registry makes
   *  no other read decision before a remote handler. */
  require(caller: Caller, mountId: string, toolName: string): Promise<void>;
  /** Trusted in-process administration. Invalid replacements leave the current policy intact. */
  replace(grants: ToolGrant[]): void;
}

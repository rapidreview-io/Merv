import type { Caller } from '@merv/contracts';
import type {} from 'cordis';

/** Exact remote tool names; a grant never expands by role, annotation, or wildcard. */
export interface ToolGrant {
  projectId: string;
  actorId: string;
  mountId: string;
  tools: string[];
}

export interface AccessPolicy {
  allows(caller: Caller, mountId: string, toolName: string): boolean;
  require(caller: Caller, mountId: string, toolName: string): void;
  /** Trusted in-process administration. Invalid replacements leave the current policy intact. */
  replace(grants: ToolGrant[]): void;
}

declare module 'cordis' {
  interface Context {
    access: AccessPolicy;
  }
}

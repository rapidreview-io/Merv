import { AsyncLocalStorage } from 'node:async_hooks';
import type { Caller } from '@merv/contracts';

/** Server-owned invocation context, inherited by nested calls; never supplied as tool input. */
export const agentAudience = new AsyncLocalStorage<boolean>();
/** The name an outside agent's MCP client gave, for the same invocation. */
export const agentClient = new AsyncLocalStorage<string | undefined>();
export const isAgentAudience = (caller: Caller): boolean =>
  !!caller.session || !!caller.conversation || agentAudience.getStore() === true;
/** Aborted, with 'said' or 'stopped', when the person behind this invocation steps in meanwhile. */
export const personInterrupts = new AsyncLocalStorage<AbortSignal>();

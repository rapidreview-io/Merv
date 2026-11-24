import { AsyncLocalStorage } from 'node:async_hooks';
import type { Caller } from '@merv/contracts';

/** Server-owned invocation context, inherited by nested calls; never supplied as tool input. */
export const agentAudience = new AsyncLocalStorage<boolean>();
/** The name an outside agent's MCP client gave, for the same invocation. */
export const agentClient = new AsyncLocalStorage<string | undefined>();
/** Identity of a lent thread, independent of its provider's display name. */
export const agentSession = new AsyncLocalStorage<string>();
export const isAgentAudience = (caller: Caller): boolean =>
  !!caller.session || !!caller.conversation || agentAudience.getStore() === true;
/** Aborted, with 'said' or 'stopped', when the person behind this invocation steps in meanwhile. */
export const personInterrupts = new AsyncLocalStorage<AbortSignal>();
/** Says a sentence aloud for the agent behind this invocation, if anything is listening to it. */
export const agentSaying = new AsyncLocalStorage<(text: string) => void>();
/** This look is the agent's snapshot of its hand-off, the one the board plays as a picture taken. */
export const agentSnapshot = new AsyncLocalStorage<boolean>();

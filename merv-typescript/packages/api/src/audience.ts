import { AsyncLocalStorage } from 'node:async_hooks';
import type { Caller } from '@merv/contracts';

/** Server-owned invocation context, inherited by nested calls; never supplied as tool input. */
export const agentAudience = new AsyncLocalStorage<boolean>();
export const isAgentAudience = (caller: Caller): boolean =>
  !!caller.session || !!caller.conversation || agentAudience.getStore() === true;

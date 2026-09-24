import type { Context } from 'cordis';
import { z } from 'zod';
import type {} from '@merv/api/types';
import type {} from './types.js';
import { createInput, id, sendInput } from './schema.js';

export const piToolsPlugin = {
  name: 'merv-pi-tools',
  inject: ['pi', 'tools'],
  apply(ctx: Context) {
    const definitions = [
      {
        name: 'pi.create',
        description:
          'Open a private read-only agent conversation. Opening a conversation does not start an agent or create a task.',
        inputSchema: createInput,
        handler: (caller: Parameters<typeof ctx.pi.create>[0], input: unknown) =>
          ctx.pi.create(caller, input),
      },
      {
        name: 'pi.list',
        description: 'List your private agent conversations in this project.',
        inputSchema: z.object({}).strict(),
        readOnly: true,
        handler: (caller: Parameters<typeof ctx.pi.list>[0]) => ctx.pi.list(caller),
      },
      {
        name: 'pi.snapshot',
        description:
          'Read the canonical messages and available transient stream tail of your conversation.',
        inputSchema: z.object({ id }).strict(),
        readOnly: true,
        handler: (caller: Parameters<typeof ctx.pi.snapshot>[0], input: { id: string }) =>
          ctx.pi.snapshot(caller, input.id),
      },
      {
        name: 'pi.send',
        description:
          'Send one message and request agent capacity. Reuse commandId only to retry the exact same message.',
        inputSchema: sendInput.extend({ id }).strict(),
        handler: (
          caller: Parameters<typeof ctx.pi.send>[0],
          input: { id: string; commandId: string; text: string },
        ) => ctx.pi.send(caller, input.id, { commandId: input.commandId, text: input.text }),
      },
      {
        name: 'pi.stop',
        description: 'Interrupt this conversation turn and release its agent.',
        inputSchema: z.object({ id }).strict(),
        handler: (caller: Parameters<typeof ctx.pi.stop>[0], input: { id: string }) =>
          ctx.pi.stop(caller, input.id),
      },
    ];
    for (const definition of definitions) ctx.effect(() => ctx.tools.register(definition));
  },
};
export default piToolsPlugin;

import type { Context } from 'cordis';
import { z } from 'zod';
import type {} from '@merv/api/types';
import type {} from './types.js';
import {
  createInput,
  id,
  machineInput,
  modelInput,
  runInput,
  sendInput,
  warmInput,
} from './schema.js';

export const piToolsPlugin = {
  name: 'merv-pi-tools',
  inject: ['pi', 'tools'],
  apply(ctx: Context) {
    const definitions = [
      {
        name: 'pi.create',
        description:
          'Open a private agent conversation: the agent acts for you in this project with exactly your permissions, and proposes what only you may run. Opening a conversation does not start an agent or create a task.',
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
        name: 'pi.prompt',
        description:
          "Read what your conversation's agent is given: the instructions every turn shares, and the latest turn's appended notes and offered tools as that turn was served.",
        inputSchema: z.object({ id }).strict(),
        readOnly: true,
        handler: (caller: Parameters<typeof ctx.pi.prompt>[0], input: { id: string }) =>
          ctx.pi.prompt(caller, input.id),
      },
      {
        name: 'pi.send',
        description:
          'Send one message and request agent capacity. Reuse commandId only to retry the exact same message.',
        inputSchema: sendInput.extend({ id }).strict(),
        handler: (caller: Parameters<typeof ctx.pi.send>[0], { id, ...message }: { id: string }) =>
          ctx.pi.send(caller, id, message),
      },
      {
        name: 'pi.warm',
        description:
          'Start your agent machine in this project before a first message, for a conversation (without an id, your latest empty one or a new one).',
        inputSchema: warmInput,
        handler: (caller: Parameters<typeof ctx.pi.warm>[0], input: unknown) =>
          ctx.pi.warm(caller, input),
      },
      {
        name: 'pi.stop',
        description:
          "Interrupt this conversation's turn; your agent machine keeps serving your other conversations.",
        inputSchema: z.object({ id }).strict(),
        handler: (caller: Parameters<typeof ctx.pi.stop>[0], input: { id: string }) =>
          ctx.pi.stop(caller, input.id),
      },
      {
        name: 'pi.machine.set',
        description:
          'Choose the machine your agent runs on in this project. It starts before the current one stops, so answers under way finish where they began.',
        inputSchema: machineInput,
        handler: (caller: Parameters<typeof ctx.pi.setMachine>[0], input: unknown) =>
          ctx.pi.setMachine(caller, input),
      },
      {
        name: 'pi.run',
        description:
          'Run a call your agent proposed in this conversation, once, as you. Its result comes back only to you.',
        inputSchema: runInput,
        handler: (caller: Parameters<typeof ctx.pi.run>[0], input: unknown) =>
          ctx.pi.run(caller, input),
      },
      {
        name: 'pi.model.set',
        description:
          'Choose the model that answers your next message in this conversation; your new conversations here start on it too. An answer under way keeps its model.',
        inputSchema: modelInput,
        handler: (caller: Parameters<typeof ctx.pi.setModel>[0], input: unknown) =>
          ctx.pi.setModel(caller, input),
      },
      {
        name: 'pi.machine.stop',
        description:
          'Stop your agent machine in this project now, ending every answer under way; the next message starts it again.',
        inputSchema: z.object({}).strict(),
        handler: (caller: Parameters<typeof ctx.pi.stopMachine>[0]) => ctx.pi.stopMachine(caller),
      },
    ];
    for (const definition of definitions) ctx.effect(() => ctx.tools.register(definition));
  },
};
export default piToolsPlugin;

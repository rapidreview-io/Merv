import type { Context } from 'cordis';
import { z } from 'zod';
import type {} from '@merv/api/types';
import type { Caller } from '@merv/contracts';
import type {} from './types.js';
import {
  createInput,
  id,
  machineInput,
  modelInput,
  runInput,
  lookInput,
  showInput,
  screenInput,
  sendInput,
  voiceInput,
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
        handler: (caller: Caller, input: unknown) => ctx.pi.create(caller, input),
      },
      {
        name: 'pi.list',
        description: 'List your private agent conversations in this project.',
        inputSchema: z.object({}).strict(),
        readOnly: true,
        worker: 'never' as const,
        handler: (caller: Caller) => ctx.pi.list(caller),
      },
      {
        name: 'pi.snapshot',
        description:
          'Read the canonical messages and available transient stream tail of your conversation.',
        inputSchema: z.object({ id }).strict(),
        readOnly: true,
        worker: 'never' as const,
        handler: (caller: Caller, input: { id: string }) => ctx.pi.snapshot(caller, input.id),
      },
      {
        name: 'pi.prompt',
        description:
          "Read what your conversation's agent is given: the instructions every turn shares, and the latest turn's appended notes and offered tools as that turn was served.",
        inputSchema: z.object({ id }).strict(),
        readOnly: true,
        worker: 'never' as const,
        handler: (caller: Caller, input: { id: string }) => ctx.pi.prompt(caller, input.id),
      },
      {
        name: 'pi.send',
        description:
          'Send one message and request agent capacity. Reuse commandId only to retry the exact same message.',
        inputSchema: sendInput.extend({ id }).strict(),
        handler: (caller: Caller, { id, ...message }: { id: string }) =>
          ctx.pi.send(caller, id, message),
      },
      {
        name: 'pi.warm',
        description:
          'Start your agent machine in this project before a first message, for a conversation (without an id, your latest empty one or a new one).',
        inputSchema: warmInput,
        handler: (caller: Caller, input: unknown) => ctx.pi.warm(caller, input),
      },
      {
        name: 'screen.look',
        description:
          "See the page the person is looking at in Merv right now. Ask a question or leave it empty for a description. Use when they refer to what they see ('this', 'here', 'on my screen'). With at, inspect a record or page without navigating them. For boards, prefer board.look: it returns the actual Excalidraw image and supports focus and camera controls without needing the person's screen. For JPEG, PNG or WebP reference artifacts, set at.record to the artifact ID to see actual pixels; do not read base64 text or request a download. Use view region to inspect detail in source pixels. The legacy at.record board route remains supported.",
        inputSchema: lookInput,
        readOnly: true,
        worker: 'never' as const,
        // Waits on the person's page, Cloudflare and the model, then writes its charge: no snapshot.
        openWorld: true,
        handler: (caller: Caller, input: unknown) => ctx.pi.look(caller, input),
        present: (value: unknown) => {
          const { image, ...metadata } = value as import('./types.js').ScreenLook;
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify(metadata) },
              ...(image ? [{ type: 'image' as const, ...image }] : []),
            ],
          };
        },
      },
      {
        name: 'screen.show',
        description:
          "Put something on the person's screen in Merv, as following a link would: a record by its id (`record`: a file, task, experiment, review, cycle or any id project.references resolves), or a page by its name in the sidebar (`page`: Work, Files, Paper, Code…). Use it when they ask to see, open or pull up something. focus (a board's shape or frame id) opens it zoomed to that part. It only navigates; their back button returns them. Answers where it went, or why it could not.",
        inputSchema: showInput,
        readOnly: true,
        worker: 'never' as const,
        // Waits on the person's page, holding no read snapshot meanwhile.
        openWorld: true,
        handler: (caller: Caller, input: unknown) => ctx.pi.show(caller, input),
      },
      {
        name: 'pi.screen',
        description:
          "Answer your agent's ask of your screen: a snapshot of this page for a look, or where it went for a show (sent by the page itself).",
        inputSchema: screenInput,
        handler: (caller: Caller, input: unknown) => ctx.pi.screen(caller, input),
      },
      {
        name: 'pi.voice',
        description:
          "Open a voice session for this conversation from your browser's WebRTC offer: GPT-Live listens and speaks, and your agent does the work.",
        inputSchema: voiceInput,
        handler: (caller: Caller, input: unknown) => ctx.pi.voice(caller, input),
      },
      {
        name: 'pi.stop',
        description:
          "Interrupt this conversation's turn; your agent machine keeps serving your other conversations.",
        inputSchema: z.object({ id }).strict(),
        handler: (caller: Caller, input: { id: string }) => ctx.pi.stop(caller, input.id),
      },
      {
        name: 'pi.machine.set',
        description:
          'Choose the machine your agent runs on in this project. It starts before the current one stops, so answers under way finish where they began.',
        inputSchema: machineInput,
        handler: (caller: Caller, input: unknown) => ctx.pi.setMachine(caller, input),
      },
      {
        name: 'pi.run',
        description:
          'Run a call your agent proposed in this conversation, once, as you. Its result comes back only to you.',
        inputSchema: runInput,
        handler: (caller: Caller, input: unknown) => ctx.pi.run(caller, input),
      },
      {
        name: 'pi.model.set',
        description:
          'Choose the model that answers your next message in this conversation; your new conversations here start on it too. An answer under way keeps its model.',
        inputSchema: modelInput,
        handler: (caller: Caller, input: unknown) => ctx.pi.setModel(caller, input),
      },
      {
        name: 'pi.machine.stop',
        description:
          'Stop your agent machine in this project now, ending every answer under way; the next message starts it again.',
        inputSchema: z.object({}).strict(),
        handler: (caller: Caller) => ctx.pi.stopMachine(caller),
      },
    ];
    for (const definition of definitions) ctx.effect(() => ctx.tools.register(definition));
  },
};
export default piToolsPlugin;

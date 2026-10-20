import { call } from '../api';
import type { StreamSource } from '../event-stream';
import type { PiConversation, PiSnapshot } from '@merv/pi/models';

/**
 * How a conversation is listed, read, sent, stopped and streamed. The Agent page reaches the
 * person's own conversations through Pi's tools and the stream Pi serves at /pi/<id>/events;
 * another page reaches the one conversation it may speak in through routes of its own (the
 * customer page, web/customer). What a transport leaves out, the page it serves goes without:
 * no `create`, no new conversation; no `warm`, no machine started ahead of a question.
 */
export interface PiTransport {
  /** The conversations there are, newest first; the first is opened. */
  list(): Promise<PiConversation[]>;
  snapshot(id: string): Promise<PiSnapshot>;
  send(id: string, input: { commandId: string; text: string; model?: string }): Promise<unknown>;
  stop(id: string): Promise<PiSnapshot>;
  /** The conversation's live stream: a path of this app, or one with credentials of its own. */
  events(id: string): string | StreamSource;
  voice?(id: string, sdp: string): Promise<{ sdp: string }>;
  create?(requestId: string): Promise<PiConversation>;
  warm?(id: string | null, requestId: string): Promise<PiSnapshot | null>;
}

/** The Agent page's transport: Pi's tools, as the signed-in person in the selected project. */
export const toolTransport: PiTransport = {
  voice: (id, sdp) => call<{ sdp: string }>('pi.voice', { id, sdp }),
  list: () => call<PiConversation[]>('pi.list'),
  snapshot: (id) => call<PiSnapshot>('pi.snapshot', { id }),
  send: (id, input) => call('pi.send', { id, ...input }),
  stop: (id) => call<PiSnapshot>('pi.stop', { id }),
  events: (id) => `/pi/${encodeURIComponent(id)}/events`,
  create: (requestId) => call<PiConversation>('pi.create', { requestId }),
  // Starts the person's machine quietly: it never holds up a question.
  warm: (id, requestId) =>
    call<PiSnapshot>('pi.warm', { requestId, ...(id ? { conversationId: id } : {}) }).catch(
      () => null,
    ),
};

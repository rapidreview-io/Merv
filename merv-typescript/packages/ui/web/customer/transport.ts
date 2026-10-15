import type { PiConversation, PiSnapshot } from '@merv/pi/models';
import type { PiTransport } from '../views/pi-transport';
import { base, currentCredentials, customerHeaders, customerRequest } from './api';

const isSnapshot = (value: unknown): value is PiSnapshot =>
  !!value && typeof value === 'object' && 'conversation' in value && 'commands' in value;

/**
 * The request's intake conversation, as its customer reaches it: the same Pi conversation, read,
 * sent, stopped and streamed through the request's chat routes with the customer's credentials
 * (customer/api.ts). There is one conversation and nothing to create, warm or run, so the page
 * draws neither a conversation list, a machine nor a proposed call.
 */
export function customerTransport(): PiTransport {
  const snapshot = () => customerRequest<PiSnapshot>('/chat');
  return {
    list: async () => [(await snapshot()).conversation] satisfies PiConversation[],
    snapshot: () => snapshot(),
    send: (_id, { commandId, text }) =>
      customerRequest('/chat/messages', { method: 'POST', body: { commandId, text } }),
    // What stopping answers is read again where it is not the conversation itself.
    stop: async () => {
      const stopped = await customerRequest<unknown>('/chat/stop', { method: 'POST', body: {} });
      return isSnapshot(stopped) ? stopped : await snapshot();
    },
    events: () => ({
      url: `${base(currentCredentials()?.request ?? '')}/chat/events`,
      headers: () => customerHeaders(),
      renew: async () => !!(await currentCredentials()?.renew()),
    }),
  };
}

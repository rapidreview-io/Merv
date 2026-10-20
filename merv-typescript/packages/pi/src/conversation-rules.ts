import { MervError } from '@merv/contracts';
import type { CallerRules } from '@merv/api/types';

/** A result holding a bearer credential: a string `token` at any depth (deeper than 24 counts). */
const holdsToken = (value: unknown, depth = 0): boolean =>
  value !== null &&
  typeof value === 'object' &&
  (depth > 24 ||
    Object.entries(value).some(
      ([key, entry]) =>
        (key === 'token' && typeof entry === 'string') || holdsToken(entry, depth + 1),
    ));

/**
 * What a conversation may do with tools, since everything it reads reaches the model provider: it
 * is offered no mounted tool and none marked `never`; everything else it runs as its person, under
 * their own role (founder, 2026-10-20: an agent is never asked for approval); and a result that
 * carries a credential never reaches it.
 */
export const conversationRules: CallerRules = {
  offers: (tool) => !tool.remote && tool.conversation !== 'never',
  forbidden: new MervError('tool_forbidden', 'This tool is not offered to conversations', 403),
  returns(result) {
    if (holdsToken(result))
      throw new MervError(
        'tool_result_secret',
        'This result carries a credential and is never returned to a conversation',
        403,
      );
  },
};

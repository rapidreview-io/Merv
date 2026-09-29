import { MervError } from '@merv/contracts';
import type { CallerRules, ConversationUse, ToolDefinition } from '@merv/api/types';

/** How a conversation may use a tool with this parsed input (ToolDefinition.conversation);
 *  undefined runs it as the person. */
export function conversationUse(
  tool: Pick<ToolDefinition, 'conversation'>,
  input: unknown,
): ConversationUse | undefined {
  const use = tool.conversation;
  return typeof use === 'function' ? use(input) : use;
}

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
 * is offered no mounted tool and none marked `never`; what only the person may run with an input
 * (`propose`, `secret`) it proposes to them instead, so running it is refused; and a result that
 * carries a credential never reaches it.
 */
export const conversationRules: CallerRules = {
  offers: (tool) => !tool.remote && tool.conversation !== 'never',
  forbidden: new MervError('tool_forbidden', 'This tool is not offered to conversations', 403),
  admits(tool, input) {
    if (conversationUse(tool, input) !== undefined)
      throw new MervError('tool_forbidden', 'Conversation tool is not admitted', 403);
  },
  returns(result) {
    if (holdsToken(result))
      throw new MervError(
        'tool_result_secret',
        'This result carries a credential and is never returned to a conversation',
        403,
      );
  },
};

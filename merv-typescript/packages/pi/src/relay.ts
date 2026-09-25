import type { ModelRelayConfig, ModelRelayFailure, ModelRelayUsage } from '@merv/api/types';
import type { PiRelayGrant } from './types.js';
import { turnCeilingMs } from './limits.js';
import {
  piRelayGrantSchema,
  piResponsesSchema,
  relayRequestBytes,
  validPiPayload,
} from './relay-schema.js';

export type { PiRelayGrant } from './types.js';
export type PiRelayFailureRecord = ModelRelayFailure<'pi_relay_failure'>;
export type PiRelayUsageRecord = ModelRelayUsage<'pi_relay_usage'>;
export type PiRelayConfig = Omit<
  ModelRelayConfig<PiRelayGrant, 'pi'>,
  'name' | 'route' | 'token' | 'grant' | 'payload' | 'lane' | 'maxRequestBytes' | 'totalTimeoutMs'
> &
  Partial<Pick<ModelRelayConfig<PiRelayGrant, 'pi'>, 'maxRequestBytes' | 'totalTimeoutMs'>> & {
    /** MERV_PI_MODELS: a grant names one of these, and the relay alone sets each call's effort. */
    models: readonly { id: string; effort: 'none' | 'low' }[];
  };

const responsesUrl = 'https://api.openai.com/v1/responses';

/** Pi's relay: one model call at a time per conversation, as a person's conversations share one
 *  machine, in the Pi-shaped request its worker sends. */
export function piModelRelay({
  models,
  authority,
  ...config
}: PiRelayConfig): ModelRelayConfig<PiRelayGrant, 'pi'> {
  const efforts = new Map(models?.map(({ id, effort }) => [id, effort]));
  if (!efforts.size) throw new Error('Pi relay requires a model');
  return {
    maxRequestBytes: relayRequestBytes,
    totalTimeoutMs: turnCeilingMs,
    ...config,
    name: 'pi',
    route: '/pi-model/responses',
    token: /^pir_[A-Za-z0-9_-]{43}$/,
    authority: authority && {
      authorize: (token) => authority.authorize(token),
      validate: async (grant) => {
        if (!efforts.has(grant.model)) throw new Error('Pi relay grant names no catalog model');
        await authority.validate(grant);
      },
    },
    grant: (raw) => piRelayGrantSchema.parse(raw),
    payload: (raw, grant) => {
      const parsed = piResponsesSchema.safeParse(raw);
      if (
        !parsed.success ||
        parsed.data.model !== grant.model ||
        !validPiPayload(parsed.data, grant.toolNames)
      )
        return null;
      // The catalog's effort, whatever the worker asked: no summary, and encrypted reasoning to
      // replay only where the model reasons.
      const effort = efforts.get(grant.model)!;
      const { reasoning: _reasoning, include: _include, ...rest } = parsed.data;
      return {
        ...rest,
        reasoning: { effort },
        ...(effort !== 'none' && { include: ['reasoning.encrypted_content'] }),
      };
    },
    lane: (grant) => grant.conversationId,
  };
}

/**
 * One small call to the relay's own upstream that names a conversation from its first exchange.
 * Anything short of a usable title is '', so the conversation keeps the name it has.
 */
export async function piTitle(model: string, key: string, user: string, reply: string) {
  try {
    const response = await fetch(responsesUrl, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        store: false,
        max_output_tokens: 24,
        reasoning: { effort: 'none' },
        instructions: 'Title this conversation in 2 to 6 words. Reply with the title only.',
        input: `User: ${user.slice(0, 2000)}\n\nAgent: ${reply.slice(0, 2000)}`,
      }),
    });
    if (!response.ok) return '';
    const { output } = (await response.json()) as {
      output: { content?: { type: string; text: string }[] }[];
    };
    return output
      .flatMap((item) => item.content ?? [])
      .filter((part) => part.type === 'output_text')
      .map((part) => part.text)
      .join('')
      .replace(/[*_`"“”«»]/g, '')
      .replace(/[\s\p{Cc}\p{Cf}]+/gu, ' ')
      .replace(/^[\s#>'‘’-]*(?:title:)?[\s'‘’]*|[\s'‘’.]+$/gi, '')
      .slice(0, 80)
      .trim();
  } catch {
    return '';
  }
}

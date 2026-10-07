import { check, type State } from '@merv/contracts';
import { dailyTokens, RESPONSES_URL } from '@merv/fleet/model-ledger';
import type { ModelRelayConfig } from '@merv/fleet/types';
import type { PiModelCharge, PiRelayGrant } from './types.js';
import { turnCeilingMs } from './limits.js';
import {
  piRelayGrantSchema,
  piResponsesSchema,
  relayRequestBytes,
  validPiPayload,
} from './relay-schema.js';

export type { PiRelayGrant } from './types.js';
type PiRelay = ModelRelayConfig<PiRelayGrant, 'pi', PiModelCharge>;
export type PiRelayConfig = Omit<
  PiRelay,
  'name' | 'route' | 'token' | 'grant' | 'payload' | 'lane' | 'maxRequestBytes' | 'totalTimeoutMs'
> &
  Partial<Pick<PiRelay, 'maxRequestBytes' | 'totalTimeoutMs'>> & {
    /** MERV_PI_MODELS: a grant names one of these, and the relay alone sets each call's effort. */
    models: readonly { id: string; effort: 'none' | 'low' }[];
  };

const piLedger = dailyTokens('pi_model_usage');
/**
 * A person's Agent tokens today: a call is charged at its most (its request and its output)
 * before it goes out and settled to its usage when that arrives; one cut off keeps its charge.
 * The day's total refuses any call that would pass the ceiling.
 */
export const piTokens = (state: State, now: () => string, ceiling: number) => ({
  async reserve(grant: { userId: string }, body: Record<string, unknown>): Promise<PiModelCharge> {
    const most =
      Math.ceil(JSON.stringify(body).length / 4) + (Number(body.max_output_tokens) || 128_000);
    const day = now().slice(0, 10);
    const charged = await state.transaction((tx) =>
      piLedger.charge(tx, grant.userId, day, most, ceiling),
    );
    check(charged, 'pi_model_ceiling', "Today's Agent tokens are used up", 403);
    return { day, tokens: most };
  },
  async settle(
    usage: { inputTokens: number; outputTokens: number },
    grant: { userId: string },
    reserved: PiModelCharge,
  ): Promise<void> {
    // Settles the day the call was charged to, even past midnight.
    const delta = usage.inputTokens + usage.outputTokens - reserved.tokens;
    await state.transaction((tx) => piLedger.settle(tx, grant.userId, reserved.day, delta));
  },
});

/** Pi's relay: one model call at a time per conversation, as a person's conversations share one
 *  machine, in the Pi-shaped request its worker sends. */
export function piModelRelay({ models, authority, ...config }: PiRelayConfig): PiRelay {
  const efforts = new Map(models?.map(({ id, effort }) => [id, effort]));
  if (!efforts.size) throw new Error('Pi relay requires a model');
  return {
    maxRequestBytes: relayRequestBytes,
    totalTimeoutMs: turnCeilingMs,
    ...config,
    name: 'pi',
    route: '/pi-model/responses',
    token: /^pir_[A-Za-z0-9_-]{43}$/,
    authority: {
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

type Usage = { inputTokens: number; outputTokens: number };
/** The request that names a conversation from its first exchange: small, without reasoning. */
export const titleRequest = (model: string, user: string, reply: string) => ({
  model,
  store: false,
  max_output_tokens: 24,
  reasoning: { effort: 'none' },
  instructions: 'Title this conversation in 2 to 6 words. Reply with the title only.',
  input: `User: ${user.slice(0, 2000)}\n\nAgent: ${reply.slice(0, 2000)}`,
});

/**
 * That request, sent to the relay's own upstream. Anything short of a usable title is '', so the
 * conversation keeps the name it has. `usage` settles its charge as the relay settles a call's:
 * none where the provider refused it, and null, keeping the charge, where it may have run it.
 */
export async function piTitle(
  key: string,
  body: ReturnType<typeof titleRequest>,
): Promise<{ title: string; usage: Usage | null }> {
  let usage: Usage | null = null;
  try {
    const response = await fetch(RESPONSES_URL, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) return { title: '', usage: { inputTokens: 0, outputTokens: 0 } };
    const answer = (await response.json()) as {
      output: { content?: { type: string; text: string }[] }[];
      usage?: { input_tokens?: unknown; output_tokens?: unknown };
    };
    const count = (value: unknown) => (Number.isSafeInteger(value) ? Number(value) : 0);
    if (answer.usage)
      usage = {
        inputTokens: count(answer.usage.input_tokens),
        outputTokens: count(answer.usage.output_tokens),
      };
    const title = answer.output
      .flatMap((item) => item.content ?? [])
      .filter((part) => part.type === 'output_text')
      .map((part) => part.text)
      .join('')
      .replace(/[*_`"“”«»]/g, '')
      .replace(/[\s\p{Cc}\p{Cf}]+/gu, ' ')
      .replace(/^[\s#>'‘’-]*(?:title:)?[\s'‘’]*|[\s'‘’.]+$/gi, '')
      .slice(0, 80)
      .trim();
    return { title, usage };
  } catch {
    return { title: '', usage };
  }
}

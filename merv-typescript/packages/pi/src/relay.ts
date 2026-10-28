import Anthropic from '@anthropic-ai/sdk';
import { check, clip, type State } from '@merv/contracts';
import { dailyTokens, RESPONSES_URL } from '@merv/fleet/model-ledger';
import type { ModelRelayConfig, ModelTokens } from '@merv/fleet/types';
import type { PiModelCharge, PiRelayGrant } from './types.js';
import { turnCeilingMs } from './limits.js';
import { piProvider } from './models.js';
import {
  piAnthropicSchema,
  piRelayGrantSchema,
  piResponsesSchema,
  relayRequestBytes,
  validPiAnthropicPayload,
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
    models: readonly { id: string; effort: 'none' | 'low' | 'medium' }[];
    modelIdPrefix?: string;
  };

/** People's own daily limits, set by the platform admin, each replace the ceiling. */
const piLedger = dailyTokens('pi_model_usage', 'pi_model_limits');
/**
 * A person's Agent tokens today: a call is charged at its most (its request and its output)
 * before it goes out and settled to its usage when that arrives; one cut off keeps its charge.
 * The day's total refuses any call that would pass their own limit, else the ceiling.
 */
export const piTokens = (state: State, now: () => string, ceiling: number) => ({
  async reserve(
    grant: { userId: string },
    body: { max_output_tokens?: unknown; max_tokens?: unknown },
  ): Promise<PiModelCharge> {
    const most =
      Math.ceil(JSON.stringify(body).length / 4) +
      (Number(body.max_output_tokens ?? body.max_tokens) || 128_000);
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
  /** Each of `persons`' tokens over the UTC days [from, to), and the daily limit that holds. */
  used: (persons: readonly string[], from: string, to: string): Promise<ModelTokens[]> =>
    state.read((sql) => piLedger.used(sql, persons, from, to, ceiling)),
  /** Sets `person`'s own daily limit, or clears it (null) so the ceiling holds again. */
  async setLimit(person: string, tokens: number | null): Promise<void> {
    await state.transaction((tx) => piLedger.setLimit(tx, person, tokens));
  },
});

/** What both of Pi's relays share: one model call at a time per conversation, as a person's
 *  conversations share one machine, under a grant that names a model of `efforts`. */
const piRelay = (efforts: ReadonlyMap<string, string>, authority: PiRelayConfig['authority']) => ({
  maxRequestBytes: relayRequestBytes,
  totalTimeoutMs: turnCeilingMs,
  name: 'pi' as const,
  token: /^pir_[A-Za-z0-9_-]{43}$/,
  authority: {
    authorize: (token: string) => authority.authorize(token),
    validate: async (grant: PiRelayGrant) => {
      if (!efforts.has(grant.model)) throw new Error('Pi relay grant names no catalog model');
      await authority.validate(grant);
    },
  },
  grant: (raw: unknown) => piRelayGrantSchema.parse(raw),
  lane: (grant: PiRelayGrant) => grant.conversationId,
});

/** Pi's relay to OpenAI, in the Pi-shaped Responses request its worker sends. */
export function piModelRelay({
  models,
  authority,
  modelIdPrefix = '',
  ...config
}: PiRelayConfig): PiRelay {
  const efforts = new Map(
    models?.filter(({ id }) => piProvider(id) === 'openai').map(({ id, effort }) => [id, effort]),
  );
  // A catalog of Claude models only leaves this relay nothing to grant.
  if (!models?.length) throw new Error('Pi relay requires a model');
  return {
    ...piRelay(efforts, authority),
    ...config,
    route: '/pi-model/responses',
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
      const effort = efforts.get(grant.model)! as 'none' | 'low' | 'medium';
      const { reasoning: _reasoning, include: _include, ...rest } = parsed.data;
      return {
        ...rest,
        model: modelIdPrefix + grant.model,
        reasoning: { effort },
        ...(effort !== 'none' && { include: ['reasoning.encrypted_content'] }),
      };
    },
  };
}

/** Pi's relay to Anthropic, in the Messages request the worker's pi-ai sends for a Claude model.
 *  Claude always thinks adaptively, at the catalog's effort: Claude Opus 5.5 cannot turn thinking
 *  off, so `none` asks for the least. */
export function piAnthropicRelay({
  models,
  authority,
  ...config
}: Omit<PiRelayConfig, 'responsesUrl' | 'modelIdPrefix'>): PiRelay {
  const efforts = new Map(
    models
      .filter(({ id }) => piProvider(id) === 'anthropic')
      .map(({ id, effort }) => [id, effort === 'medium' ? 'medium' : 'low']),
  );
  return {
    ...piRelay(efforts, authority),
    ...config,
    wire: 'anthropic',
    route: '/pi-model/anthropic/v1/messages',
    payload: (raw, grant) => {
      const parsed = piAnthropicSchema.safeParse(raw);
      if (
        !parsed.success ||
        parsed.data.model !== grant.model ||
        !validPiAnthropicPayload(parsed.data, grant.toolNames)
      )
        return null;
      const { thinking: _thinking, output_config: _output, ...rest } = parsed.data;
      return {
        ...rest,
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: efforts.get(grant.model)! },
      };
    },
  };
}

type Usage = { inputTokens: number; outputTokens: number };
/** Where Main's own requests go: the Responses provider, and both providers' keys. */
type Providers = {
  modelResponsesUrl?: string;
  modelIdPrefix?: string;
  modelApiKeyEnv: string;
  anthropicApiKeyEnv: string;
};
/** A short request Main sends itself, outside any turn (a title, a look at the screen). */
export interface PiAsk {
  model: string;
  text: string;
  instructions?: string;
  /** A JPEG it is shown with. */
  image?: Buffer;
  maxTokens: number;
  effort: 'none' | 'low';
}

/**
 * That request as its model's provider takes it, to reserve its charge for, and `send`, which
 * answers its message texts and `usage` to settle that charge as the relay settles a call's: none
 * where the provider refused it, and null, keeping the charge, where it may have run it. The
 * provider's own words, which name a refused key, are never read. Null without the provider's key.
 */
export function piAsk(providers: Providers, ask: PiAsk, timeoutMs: number) {
  const claude = piProvider(ask.model) === 'anthropic';
  const key = process.env[claude ? providers.anthropicApiKeyEnv : providers.modelApiKeyEnv];
  if (!key) return null;
  if (claude) {
    // Claude thinks adaptively at the least effort, within room beside the answer.
    const body: Anthropic.MessageCreateParamsNonStreaming = {
      model: ask.model,
      max_tokens: ask.maxTokens + 2_048,
      output_config: { effort: 'low' },
      ...(ask.instructions && { system: ask.instructions }),
      messages: [
        {
          role: 'user',
          content: [
            ...(ask.image
              ? [
                  {
                    type: 'image' as const,
                    source: {
                      type: 'base64' as const,
                      media_type: 'image/jpeg' as const,
                      data: ask.image.toString('base64'),
                    },
                  },
                ]
              : []),
            { type: 'text', text: ask.text },
          ],
        },
      ],
    };
    return { body, send: () => claudeTexts(key, body, timeoutMs) };
  }
  const body = {
    model: (providers.modelIdPrefix ?? '') + ask.model,
    store: false,
    max_output_tokens: ask.maxTokens,
    reasoning: { effort: ask.effort },
    ...(ask.instructions && { instructions: ask.instructions }),
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: ask.text },
          ...(ask.image
            ? [
                {
                  type: 'input_image',
                  image_url: `data:image/jpeg;base64,${ask.image.toString('base64')}`,
                  detail: 'high',
                },
              ]
            : []),
        ],
      },
    ],
  };
  return { body, send: () => responses(key, body, timeoutMs, providers.modelResponsesUrl) };
}

async function responses(
  key: string,
  body: object,
  timeoutMs: number,
  url = RESPONSES_URL,
): Promise<{ texts: string[]; usage: Usage | null }> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { texts: [], usage: null };
  }
  if (!response.ok) return { texts: [], usage: { inputTokens: 0, outputTokens: 0 } };
  const answer = (await response.json().catch(() => null)) as {
    output?: { type?: string; content?: { type?: string; text?: string }[] }[];
    usage?: { input_tokens?: unknown; output_tokens?: unknown };
  } | null;
  const count = (value: unknown) => (Number.isSafeInteger(value) ? Number(value) : 0);
  return {
    texts: (answer?.output ?? [])
      .filter((item) => item.type === 'message')
      .flatMap((item) => item.content ?? [])
      .filter((part) => part.type === 'output_text')
      .map((part) => part.text ?? ''),
    usage: answer?.usage
      ? {
          inputTokens: count(answer.usage.input_tokens),
          outputTokens: count(answer.usage.output_tokens),
        }
      : null,
  };
}

async function claudeTexts(
  key: string,
  body: Anthropic.MessageCreateParamsNonStreaming,
  timeoutMs: number,
): Promise<{ texts: string[]; usage: Usage | null }> {
  const client = new Anthropic({ apiKey: key, maxRetries: 0, timeout: timeoutMs });
  try {
    const message = await client.messages.create(body);
    const { usage } = message;
    return {
      texts:
        message.stop_reason === 'refusal'
          ? []
          : message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])),
      usage: {
        inputTokens:
          usage.input_tokens +
          (usage.cache_read_input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0),
        outputTokens: usage.output_tokens,
      },
    };
  } catch (error) {
    // A call cut off may have run; one Anthropic answered with an error status did not.
    if (error instanceof Anthropic.APIConnectionError || !(error instanceof Anthropic.APIError))
      return { texts: [], usage: null };
    return { texts: [], usage: { inputTokens: 0, outputTokens: 0 } };
  }
}

/** The request that names a conversation from its first exchange: small, without reasoning. */
export const titleAsk = (model: string, user: string, reply: string): PiAsk => ({
  model,
  maxTokens: 24,
  effort: 'none',
  instructions: 'Title this conversation in 2 to 6 words. Reply with the title only.',
  text: `User: ${clip(user, 2000)}\n\nAgent: ${clip(reply, 2000)}`,
});

/** That request's answer as a title: anything short of a usable one is '', so the conversation
 * keeps the name it has. */
export function piTitle(texts: string[]): string {
  const said = texts
    .join('')
    .replace(/[*_`"“”«»]/g, '')
    .replace(/[\s\p{Cc}\p{Cf}\p{Cs}]+/gu, ' ')
    .replace(/^[\s#>'‘’-]*(?:title:)?[\s'‘’]*|[\s'‘’.]+$/gi, '');
  // Never half a character, which jsonb refuses where it lists the person's conversations.
  return clip(said, 80).trim();
}

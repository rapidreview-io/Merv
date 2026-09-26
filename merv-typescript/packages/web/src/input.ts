import { isIP } from 'node:net';
import { z } from 'zod';
import { envName } from '@merv/contracts';

/** An https origin, or a loopback http one for a test's fake provider. */
function allowedOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.origin !== value) return false;
    return (
      url.protocol === 'https:' ||
      (url.protocol === 'http:' &&
        (url.hostname === 'localhost' ||
          url.hostname === '[::1]' ||
          (isIP(url.hostname) === 4 && url.hostname.startsWith('127.'))))
    );
  } catch {
    return false;
  }
}
const origin = z.string().refine(allowedOrigin, 'Expected an https origin or a loopback one');

export const webConfig = z
  .object({
    keyEnv: envName.default('MERV_TAVILY_API_KEY'),
    origin: origin.default('https://api.tavily.com'),
    fallback: z
      .object({
        keyEnv: envName,
        // Nisa's fallback runs on its Luna deployment.
        model: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
          .default('gpt-6-luna'),
        origin: origin.default('https://api.openai.com'),
        // Nisa gives its grounded call 90 s. The longest call (queue, Tavily and this) must end
        // inside the 180 s a Codex worker waits on a tool (packages/runner/src/profiles.ts).
        timeoutMs: z.number().int().min(1000).max(90_000).default(90_000),
      })
      .strict()
      .optional(),
    timeoutMs: z.number().int().min(1000).max(45_000).default(30_000),
    maxResponseBytes: z
      .number()
      .int()
      .min(1024)
      .max(32 * 1024 * 1024)
      .default(8 * 1024 * 1024),
    maxInFlight: z.number().int().min(1).max(64).default(8),
    /** Half of maxInFlight when unset. */
    maxInFlightPerProject: z.number().int().min(1).max(64).optional(),
    /** How long a call past either in-flight limit waits for its turn before web_busy. */
    queueMs: z.number().int().min(0).max(15_000).default(15_000),
    dailyCallsPerProject: z.number().int().min(1).max(100_000).default(200),
    // Projects cost nothing to make, so each one's day bounds nothing alone: the deployment's
    // day does, and its fallback searches, which spend a model's tokens, have a smaller one.
    dailyCalls: z.number().int().min(1).max(1_000_000).default(1000),
    fallbackDailyCalls: z.number().int().min(1).max(1_000_000).default(200),
  })
  .strict();
export type WebSettings = z.infer<typeof webConfig>;

// Loose on purpose, as Nisa's are: a value the model gets slightly wrong is fixed and reported
// in normalization_note rather than refused. Descriptions name no address (the Pi relay refuses
// a schema that does).
const choice = (description: string) => z.string().max(40).nullish().describe(description);
export const searchInput = z
  .object({
    query: z
      .union([z.string().max(400), z.array(z.string().max(400)).max(8)])
      .describe(
        'What to search for, in descriptive words; a site: filter alone is not a query. A list of up to 4 phrasings is combined with OR into one search.',
      ),
    max_results: z.number().nullish().describe('Number of results to return (1-20, default 5).'),
    search_depth: choice('"basic" (fast, 1 credit) or "advanced" (deeper, 2 credits).'),
    topic: choice('"general", "news", or "finance".'),
    time_range: choice('Optional recency filter: "day", "week", "month" or "year".'),
  })
  .strict();
export const extractInput = z
  .object({
    url: z.string().max(2048).describe('The page to read: an absolute http or https address.'),
    extract_depth: choice('"basic" (fast) or "advanced" (handles tables, embedded content).'),
    start_text: z
      .string()
      .max(500)
      .nullish()
      .describe('Text marking the start of the section to return, copied from the page.'),
    end_text: z.string().max(500).nullish().describe('Text marking the end of the section.'),
  })
  .strict();

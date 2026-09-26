import { isIP } from 'node:net';
import { z } from 'zod';
import { envName } from '@merv/contracts';

/** An https origin, or a loopback http one for a test's fake Nisa. */
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

export const nisaConfig = z
  .object({
    origin: z
      .string()
      .refine(allowedOrigin, 'Expected an https origin or a loopback one')
      .default('https://api.rapidreview.io'),
    keyEnv: envName.default('MERV_NISA_API_KEY'),
    // Nisa's own paper routes wait 10 s on its index.
    timeoutMs: z.number().int().min(1000).max(60_000).default(15_000),
    // Nisa's keyword search waits 30 s on its index and retries it; the semantic one embeds first.
    searchTimeoutMs: z.number().int().min(1000).max(120_000).default(40_000),
    maxResponseBytes: z
      .number()
      .int()
      .min(1024)
      .max(8 * 1024 * 1024)
      .default(2 * 1024 * 1024),
    // Nisa serves every user from one worker: Merv keeps its own share of it small.
    maxInFlight: z.number().int().min(1).max(64).default(4),
    /** Half of maxInFlight when unset, so one project's sweep leaves the others a turn. */
    maxInFlightPerProject: z.number().int().min(1).max(64).optional(),
    /** How long a call past maxInFlight waits for its turn before nisa_busy. */
    // With a search's deadline, inside the 180 s a Codex worker waits on a tool.
    queueMs: z.number().int().min(0).max(15_000).default(15_000),
  })
  .strict();
export type NisaSettings = z.infer<typeof nisaConfig>;

const modern = /^\d{2}(?:0[1-9]|1[0-2])\.\d{4,5}$/;
const legacy =
  /^([a-z]+(?:-[a-z]+)*(?:\.[A-Za-z]+(?:-[a-z]+)*)?)[/_](\d{2}(?:0[1-9]|1[0-2])\d{3})$/;

/** An arXiv ID in its canonical form, without an arxiv: prefix or version, an old-style one with
 * its slash (hep-th/9901001); undefined when the text is no arXiv ID. */
export function canonicalId(value: string): string | undefined {
  const id = value
    .trim()
    .replace(/^arxiv:/i, '')
    .replace(/v[1-9]\d{0,2}$/, '');
  if (modern.test(id)) return id;
  const old = legacy.exec(id);
  return old ? `${old[1]}/${old[2]}` : undefined;
}
/** How Nisa's routes name a paper: an old-style ID with an underscore for its slash, as Nisa's
 * full-text index keys it (a route segment cannot carry a slash, and Nisa's paper record takes
 * either; its similar-paper data holds no old-style paper at all). */
export const routeId = (id: string) => id.replace('/', '_');

export const arxivId = z
  .string()
  .max(64)
  .describe('arXiv ID, such as 2303.08774, arxiv:2303.08774v2 or hep-th/9901001')
  .transform((value, context) => {
    const id = canonicalId(value);
    if (id) return id;
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Expected an arXiv ID such as 2303.08774 or hep-th/9901001',
    });
    return z.NEVER;
  });
const text = (max: number) => z.string().trim().min(1).max(max);
const phrasings = (count: number, description: string) =>
  z.union([text(1000), z.array(text(1000)).min(1).max(count)]).describe(description);
// Nisa filters the two searches differently: its keyword index by whole name words, its
// semantic search by a substring of the author list.
const author = (description: string) => text(200).optional().describe(description);
const results = (fallback: number) =>
  z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(fallback)
    .describe(`Papers to return (1-20, default ${fallback})`);

// Nisa reads a date bound as YYYYMM: a day is checked here, and then narrows nothing.
const day = /^(?:19|20)\d{2}(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?)?$/;
const calendar = (value: string) => {
  const [year, month, date] = value.split('-').map(Number);
  if (date === undefined) return true;
  const parsed = new Date(Date.UTC(year, month - 1, date));
  return parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === date;
};
const date = z.string().trim().regex(day).refine(calendar, 'Not a calendar date');
const month = (value: string, earliest: boolean) => {
  const [year, month] = value.split('-').map(Number);
  return year * 100 + (month ?? (earliest ? 1 : 12));
};
const year = z.number().int().min(1900).max(2100);

/** The furthest offset each search pages to: Nisa clamps any further one to it. */
export const SEARCH_OFFSETS = 500;
export const SEMANTIC_OFFSETS = 200;

export const searchInput = z
  .object({
    query: phrasings(
      8,
      'Plain keywords, no operators or quotes; or a list of up to 8 phrasings searched together and merged',
    ),
    max_results: results(10),
    offset: z
      .number()
      .int()
      .min(0)
      .max(SEARCH_OFFSETS)
      .default(0)
      .describe('Papers to skip (0-500)'),
    author: author(
      'Author name as whole words, all of which must match (Yann LeCun); commas separate alternative authors (Vaswani, Hinton)',
    ),
    date_from: date.optional().describe('Earliest publication: YYYY, YYYY-MM or YYYY-MM-DD'),
    date_to: date.optional().describe('Latest publication: YYYY, YYYY-MM or YYYY-MM-DD'),
  })
  .strict()
  .refine(
    ({ date_from, date_to }) =>
      !date_from || !date_to || month(date_from, true) <= month(date_to, false),
    { message: 'date_from is after date_to', path: ['date_to'] },
  );
export const semanticInput = z
  .object({
    query: phrasings(
      4,
      'A natural-language description of the papers wanted, or a list of up to 4 paraphrases searched together',
    ),
    max_results: results(10),
    offset: z
      .number()
      .int()
      .min(0)
      .max(SEMANTIC_OFFSETS)
      .default(0)
      .describe('Papers to skip (0-200)'),
    author: author('Part of an author name, matched as a substring of the author list'),
    year_min: year.optional().describe('Earliest publication year'),
    year_max: year.optional().describe('Latest publication year'),
  })
  .strict()
  .refine(
    ({ year_min, year_max }) =>
      year_min === undefined || year_max === undefined || year_min <= year_max,
    { message: 'year_min is after year_max', path: ['year_max'] },
  );
export const paperInput = z.object({ arxiv_id: arxivId }).strict();
export const excerptsInput = z
  .object({
    arxiv_id: arxivId,
    query: text(1000).describe('The terms to find in the paper'),
    max_excerpts: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(5)
      .describe('Passages to return (1-20, default 5)'),
  })
  .strict();
export const relatedInput = z.object({ arxiv_id: arxivId, max_results: results(10) }).strict();

export type SearchInput = z.infer<typeof searchInput>;
export type SemanticInput = z.infer<typeof semanticInput>;
export type PaperInput = z.infer<typeof paperInput>;
export type ExcerptsInput = z.infer<typeof excerptsInput>;
export type RelatedInput = z.infer<typeof relatedInput>;

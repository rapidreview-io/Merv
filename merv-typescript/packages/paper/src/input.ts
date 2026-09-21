import {
  paperPatchSchema as patchSchema,
  paperChangesSchema as changesSchema,
} from '@merv/contracts';
export { patchSchema, changesSchema };
import { z } from 'zod';
import { visible, parsed } from '@merv/contracts';
export const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/);
const requestId = z.string().trim().min(1).max(200).refine(visible);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const kind = z.enum(['problem', 'literature', 'methods', 'results']);
export const reviewSchema = changesSchema
  .extend({
    source: z.object({ kind: z.enum(['experiment', 'reflection']), id, revision }).strict(),
    reviewId: id,
    verdict: z.enum(['pass', 'needs_changes', 'fail']),
    evidenceIds: z.array(id).min(1).max(2000),
  })
  .strict();
export const citeSchema = z
  .object({
    id: id.optional(),
    expectedRevision: revision,
    requestId,
    identifier: z.string().trim().min(1).max(500).refine(visible),
    title: z.string().trim().min(1).max(1000).refine(visible),
    authors: z.array(z.string().trim().min(1).max(300).refine(visible)).max(100).default([]),
    year: z.number().int().min(1000).max(9999).nullable().default(null),
    url: z
      .string()
      .url()
      .max(2000)
      .refine((v) => /^https?:\/\//.test(v))
      .nullable()
      .default(null),
    notes: z.string().max(16000).default(''),
    sectionIds: z.array(id).max(100).default([]),
    refs: z.array(id).max(200).default([]),
  })
  .strict();
export const parse = <T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown) =>
  parsed(schema, value, 'invalid_paper_input', { nodes: 20_000, depth: 8 });

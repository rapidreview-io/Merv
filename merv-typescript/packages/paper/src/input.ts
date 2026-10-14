import { z } from 'zod';
import { idSchema, visible, parsed } from '@merv/contracts';
import { REVIEW_VERDICTS } from '@merv/reviews/rules';
export const id = idSchema;
const requestId = z.string().trim().min(1).max(200).refine(visible);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const kind = z.enum(['problem', 'literature', 'methods', 'results']);
export const patchSchema = z
  .object({
    kind,
    expectedRevision: revision,
    requestId,
    changes: z
      .array(
        z
          .object({
            id,
            title: z.string().trim().min(1).max(300).refine(visible).optional(),
            content: z.string().max(100_000).optional(),
            afterId: id.nullable().optional(),
            remove: z.boolean().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
/** The Methods and Results edits an experiment or reflection reviewer submits with a verdict. */
export const changesSchema = z
  .object({
    documents: z
      .array(patchSchema.omit({ requestId: true }).extend({ kind: z.enum(['methods', 'results']) }))
      .min(1)
      .max(2),
  })
  .strict();
export const reviewSchema = changesSchema
  .extend({
    source: z.object({ kind: z.enum(['experiment', 'reflection']), id, revision }).strict(),
    reviewId: id,
    verdict: z.enum(REVIEW_VERDICTS),
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

import { z } from 'zod';
import { parsed } from '@merv/contracts';
export const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/);
const requestId = z.string().trim().min(1).max(200);
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
            title: z.string().trim().min(1).max(300).optional(),
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
export const citeSchema = z
  .object({
    id: id.optional(),
    expectedRevision: revision,
    requestId,
    identifier: z.string().trim().min(1).max(500),
    title: z.string().trim().min(1).max(1000),
    authors: z.array(z.string().trim().min(1).max(300)).max(100).default([]),
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
export const changesSchema = z
  .object({
    documents: z
      .array(patchSchema.omit({ requestId: true }).extend({ kind: z.enum(['methods', 'results']) }))
      .min(1)
      .max(2),
  })
  .strict();
export const proposeSchema = z
  .object({
    artifactId: id,
    source: z.object({ kind: z.enum(['experiment', 'reflection']), id, revision }).strict(),
    evidenceIds: z.array(id).min(1).max(2000),
  })
  .strict();
export const parse = <T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown) =>
  parsed(schema, value, 'invalid_paper_input', { nodes: 20_000, depth: 8 });

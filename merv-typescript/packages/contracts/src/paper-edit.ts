import { z } from 'zod';
import { visible } from './text.js';
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const requestId = z.string().trim().min(1).max(200).refine(visible);
const kind = z.enum(['problem', 'literature', 'methods', 'results']);
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
export const changesSchema = z
  .object({
    documents: z
      .array(patchSchema.omit({ requestId: true }).extend({ kind: z.enum(['methods', 'results']) }))
      .min(1)
      .max(2),
  })
  .strict();

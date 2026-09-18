import { z } from 'zod';
import { visible, parsed } from '@merv/contracts';

const text = (min = 0) =>
  z
    .string()
    .max(16000)
    .trim()
    .min(min)
    .refine((value) => value === '' || visible(value), 'Text must contain visible characters');
export const claimIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/);
const requestId = z.string().trim().min(1).max(200).refine(visible);
export const claimStatusSchema = z.enum([
  'draft',
  'active',
  'supported',
  'weakened',
  'contradicted',
  'abandoned',
]);
export const claimConfidenceSchema = z.enum(['low', 'medium', 'high']);
export const claimCreateSchema = z
  .object({
    statement: text(1),
    scope: text().default(''),
    confidence: claimConfidenceSchema.default('medium'),
    requestId,
  })
  .strict();
export const claimUpdateSchema = z
  .object({
    claimId: claimIdSchema,
    status: claimStatusSchema.optional(),
    confidence: claimConfidenceSchema.optional(),
    expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    requestId,
  })
  .strict()
  .refine((input) => input.status !== undefined || input.confidence !== undefined, {
    message: 'Provide status and/or confidence',
  });

export const parseClaimInput = <T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown) =>
  parsed(schema, input, 'invalid_claim_input');

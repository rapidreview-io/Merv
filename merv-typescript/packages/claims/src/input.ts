import { z } from 'zod';
import { parsed } from '@merv/contracts';

const text = z.string().max(16000).trim();
export const claimIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/);
const requestId = z.string().trim().min(1).max(200);
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
    statement: text.min(1),
    scope: text.default(''),
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

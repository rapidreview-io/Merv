import { types } from 'node:util';
import { z } from 'zod';
import { check } from '@merv/contracts';

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

/** Claims inputs are flat scalar records; copying descriptors never calls an accessor. */
export function parseClaimInput<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T {
  check(
    input !== null && typeof input === 'object' && !Array.isArray(input) && !types.isProxy(input),
    'invalid_claim_input',
    'Claim input must be a plain object',
  );
  const prototype = Object.getPrototypeOf(input);
  check(
    prototype === Object.prototype || prototype === null,
    'invalid_claim_input',
    'Claim input must be a plain object',
  );
  const keys = Reflect.ownKeys(input);
  check(
    keys.length <= 5 && keys.every((key) => typeof key === 'string'),
    'invalid_claim_input',
    'Claim input has invalid fields',
  );
  const descriptors = Object.getOwnPropertyDescriptors(input);
  check(
    Object.values(descriptors).every(
      (field) =>
        Object.hasOwn(field, 'value') &&
        field.enumerable &&
        (field.value === undefined ||
          typeof field.value === 'string' ||
          typeof field.value === 'number'),
    ),
    'invalid_claim_input',
    'Claim fields must be ordinary scalar values',
  );
  const copied = Object.fromEntries(
    Object.entries(descriptors).map(([key, field]) => [key, field.value]),
  );
  const parsed = schema.safeParse(copied);
  check(parsed.success, 'invalid_claim_input', 'Claim input does not match its schema');
  return parsed.data;
}

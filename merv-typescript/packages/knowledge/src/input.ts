import { z } from 'zod';
import { parsed } from '@merv/contracts';

export const knowledgeIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/);
export const knowledgeCaptureSchema = z
  .object({
    requestId: z
      .string()
      .min(1)
      .max(200)
      .refine((value) => value.trim().length > 0),
  })
  .strict();
export const knowledgeReferencesSchema = z
  .object({
    refs: z.array(knowledgeIdSchema).max(200),
  })
  .strict();

export const parseKnowledgeInput = <T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  input: unknown,
) => parsed(schema, input, 'invalid_knowledge_input');

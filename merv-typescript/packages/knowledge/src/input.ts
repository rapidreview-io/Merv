import { z } from 'zod';
import { idSchema, parsed } from '@merv/contracts';

export const knowledgeIdSchema = idSchema;
export const knowledgeReferencesSchema = z
  .object({
    refs: z.array(knowledgeIdSchema).max(200),
  })
  .strict();

export const parseKnowledgeInput = <T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  input: unknown,
) => parsed(schema, input, 'invalid_knowledge_input');

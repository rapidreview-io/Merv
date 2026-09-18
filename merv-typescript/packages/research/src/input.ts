import { z } from 'zod';
import { visible, parsed } from '@merv/contracts';
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/);
export const createSchema = z
  .object({
    name: z.string().trim().min(1).max(200).refine(visible),
    dependsOn: z.array(id).max(100).default([]),
    consolidationWorkspace: z
      .enum(['none', 'git'])
      .default('none')
      .describe('none: finish after reflection approval; git: add code implementation and review'),
    consolidationDependsOn: z.array(id).max(100).default([]),
    requestId: id,
  })
  .strict();
export const advanceSchema = z
  .object({
    researchId: id,
    expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    requestId: id,
  })
  .strict();
export const replanSchema = advanceSchema.extend({ dependsOn: z.array(id).max(100) }).strict();
export const getSchema = z.object({ researchId: id }).strict();
export const listSchema = z.object({}).strict();
export const parse = <T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> =>
  parsed(schema, value, 'invalid_research_input');

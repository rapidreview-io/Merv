import { z } from 'zod';
import { check } from '@merv/contracts';
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/);
export const createSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
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
export const getSchema = z.object({ researchId: id }).strict();
export const listSchema = z.object({}).strict();
export function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);
  check(parsed.success, 'invalid_research_input', parsed.success ? '' : parsed.error.message);
  return parsed.data;
}

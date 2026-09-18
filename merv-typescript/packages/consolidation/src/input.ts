import { z } from 'zod';
import { check } from '@merv/contracts';
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/);
const text = (max: number) => z.string().trim().min(1).max(max);
export const createSchema = z
  .object({
    sourceArtifactIds: z.array(id).min(1).max(2000),
    experimentIds: z.array(id).max(1000).default([]),
    name: text(200),
    workspace: z.enum(['none', 'git']).default('none'),
    dependsOn: z.array(id).max(100).default([]),
    requestId: id,
  })
  .strict();
export const getSchema = z.object({ consolidationId: id }).strict();
export const listSchema = z.object({}).strict();
export const submitSchema = z
  .object({
    consolidationId: id,
    expectedRevision: z.number().int().min(0),
    reportArtifactId: id,
    evidenceArtifactIds: z.array(id).max(48).default([]),
    decisions: z
      .array(
        z
          .object({
            experimentId: id,
            decision: z.enum(['retain', 'adapt', 'drop', 'no_code']),
            rationale: text(12000),
          })
          .strict(),
      )
      .max(1000),
    commandId: id.optional(),
    requestId: id,
  })
  .strict();
export function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  check(
    result.success,
    'invalid_consolidation_input',
    result.success
      ? ''
      : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
  );
  return result.data;
}

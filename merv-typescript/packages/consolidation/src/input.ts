import { z } from 'zod';
import { visible, parsed } from '@merv/contracts';
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/);
const text = (max: number) => z.string().trim().min(1).max(max).refine(visible);
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
export const endSchema = z
  .object({
    consolidationId: id,
    expectedRevision: z.number().int().min(0),
    outcome: z.enum(['abandoned', 'failed']),
    reason: text(16000),
    requestId: id,
  })
  .strict();
/** What the caller decides when ending one; the record and revision are bound by the engine. */
export const endChoiceSchema = endSchema.pick({ outcome: true, reason: true });
export const parse = <T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> =>
  parsed(schema, input, 'invalid_consolidation_input');

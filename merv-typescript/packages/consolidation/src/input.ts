import { z } from 'zod';
import { visible, parsed } from '@merv/contracts';
import type { ConsolidationLimits } from './types.js';

/**
 * What one consolidation may carry. A research cycle composes these from its own selection,
 * so a cap lower than what the parent can legitimately produce is a dead end, not a guard:
 * `dependsOn` holds the cycle's reflection plus its consolidation prerequisites, and
 * research.create allows 100 of the latter.
 */
export const CONSOLIDATION_LIMITS: ConsolidationLimits = {
  sourceArtifactIds: 2000,
  experimentIds: 1000,
  dependsOn: 200,
};
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/);
const text = (max: number) => z.string().trim().min(1).max(max).refine(visible);
export const createSchema = z
  .object({
    sourceArtifactIds: z.array(id).min(1).max(CONSOLIDATION_LIMITS.sourceArtifactIds),
    experimentIds: z.array(id).max(CONSOLIDATION_LIMITS.experimentIds).default([]),
    name: text(200),
    workspace: z.enum(['none', 'git']).default('none'),
    dependsOn: z.array(id).max(CONSOLIDATION_LIMITS.dependsOn).default([]),
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
/**
 * What the caller decides when ending one; the record and revision are bound by the engine.
 * Not strict: a preflight legitimately carries the bound fields alongside the choice, and
 * refusing them there would report an action blocked that the call then accepts.
 */
export const endChoiceSchema = z.object({
  outcome: z.enum(['abandoned', 'failed']),
  reason: text(16000),
});
export const parse = <T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> =>
  parsed(schema, input, 'invalid_consolidation_input');

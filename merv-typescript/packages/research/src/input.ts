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
const commandSchema = z.object({
  researchId: id,
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  requestId: id,
});
const nextWave = z
  .enum(['create', 'skip'])
  .describe(
    'Required when the approved reflection carries a plan that continues: create opens its tasks, experiments and the next cycle; skip completes this cycle without them',
  );
// Optional with no default, so the stored input of a request made before it existed still replays.
export const advanceSchema = commandSchema.extend({ nextWave: nextWave.optional() }).strict();
/**
 * The owner's choice as a guard reads it. Not strict, for the reason endChoiceSchema is not:
 * a preflight carries the bound fields alongside it.
 */
export const nextWaveChoiceSchema = z.object({ nextWave: nextWave.optional() });
export const replanSchema = commandSchema.extend({ dependsOn: z.array(id).max(100) }).strict();
export const endSchema = commandSchema
  .extend({
    outcome: z.enum(['abandoned', 'failed']),
    reason: z.string().trim().min(1).max(16000).refine(visible),
  })
  .strict();
/**
 * What the caller decides when ending one; the cycle and revision are bound by the engine.
 * Not strict: a preflight legitimately carries the bound fields alongside the choice, and
 * refusing them there would report an action blocked that the call then accepts.
 */
export const endChoiceSchema = z.object({
  outcome: z.enum(['abandoned', 'failed']),
  reason: z.string().trim().min(1).max(16000).refine(visible),
});
export const getSchema = z.object({ researchId: id }).strict();
export const listSchema = z.object({}).strict();
export const parse = <T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> =>
  parsed(schema, value, 'invalid_research_input');

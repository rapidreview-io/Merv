import { z } from 'zod';
import { visible, parsed } from '@merv/contracts';
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/);
export const createSchema = z
  .object({
    name: z.string().trim().min(1).max(200).refine(visible),
    dependsOn: z.array(id).max(100).default([]),
    // Optional with no default, so the stored input of a request made before it existed still replays.
    previousCycleId: id
      .optional()
      .describe(
        "A complete, abandoned or failed cycle this one follows; its digest is carried into this cycle's reflection",
      ),
    automatic: z
      .boolean()
      .optional()
      .describe('Automatically advance this cycle and its approved next waves'),
    maxCycles: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Automatic run limit, including this cycle; default 10'),
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
const retryIntegration = z
  .boolean()
  .describe(
    'Inject a fresh consolidation task after the current one ended without acceptance; ignored otherwise',
  );
// Both optional with no default, so the stored input of a request made before they existed still replays.
const choices = { nextWave: nextWave.optional(), retryIntegration: retryIntegration.optional() };
export const advanceSchema = commandSchema.extend(choices).strict();
/**
 * The owner's choices as a guard reads them, with the move the advance computed after asking
 * Git, which no client input carries. Not strict, for the reason endChoiceSchema is not: a
 * preflight carries the bound fields alongside them.
 */
export const nextWaveChoiceSchema = z.object({
  ...choices,
  move: z.enum(['advance', 'complete', 'inject', 'reinject']).optional(),
});
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

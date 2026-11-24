import { z } from 'zod';
import { idSchema, visible, parsed } from '@merv/contracts';
const id = idSchema;
export const createSchema = z.strictObject({
  name: z.string().trim().min(1).max(200).refine(visible),
  dependsOn: z.array(id).max(100).default([]),
  // Optional with no default, so the stored input of a request made before it existed still replays.
  previousCycleId: id
    .optional()
    .describe(
      'A complete, abandoned or failed cycle this one follows; its digest records what that cycle did',
    ),
  automatic: z.boolean().optional().describe('Automatically advance this cycle as its work ends'),
  requestId: id,
});
const commandSchema = z.object({
  researchId: id,
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  requestId: id,
});
const retryIntegration = z
  .boolean()
  .describe(
    'Inject a fresh consolidation task after the current one ended without acceptance; ignored otherwise',
  );
// Optional with no default, so the stored input of a request made before it existed still replays.
export const advanceSchema = commandSchema
  .extend({ retryIntegration: retryIntegration.optional() })
  .strict();
/**
 * The owner's choice as a guard reads it, with the move the advance computed after asking Git,
 * which no client input carries. Not strict, for the reason endChoiceSchema is not: a preflight
 * carries the bound fields alongside it.
 */
export const choiceSchema = z.object({
  retryIntegration: retryIntegration.optional(),
  move: z.enum(['complete', 'inject', 'reinject', 'advance']).optional(),
});
export const replanSchema = commandSchema.extend({ dependsOn: z.array(id).max(100) }).strict();
const ending = {
  outcome: z.enum(['abandoned', 'failed']),
  reason: z.string().trim().min(1).max(16000).refine(visible),
};
export const endSchema = commandSchema.extend(ending).strict();
/**
 * What the caller decides when ending one; the cycle and revision are bound by the engine.
 * Not strict: a preflight legitimately carries the bound fields alongside the choice, and
 * refusing them there would report an action blocked that the call then accepts.
 */
export const endChoiceSchema = z.object(ending);
export const getSchema = z.object({ researchId: id }).strict();
export const listSchema = z.object({}).strict();
export const parse = <T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> =>
  parsed(schema, value, 'invalid_research_input');

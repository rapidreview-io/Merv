import { visible, type Limits } from '@merv/contracts';
import { z } from 'zod';

/** One schema per workflow tool; extendLimit() parses the same one. */
const instanceId = z.string().min(1);
export const statusSchema = z
  .object({
    instanceId: instanceId.optional(),
    action: z.string().min(1).optional(),
    input: z.record(z.unknown()).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.action !== undefined && input.instanceId === undefined)
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'action requires instanceId' });
    if (input.input !== undefined && input.action === undefined)
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'input requires action' });
  });
export const instanceSchema = z.object({ instanceId }).strict();
export const beginSchema = z
  .object({ instanceId, expectedRevision: z.number().int().nonnegative() })
  .strict();
export const extendLimitSchema = z.object({
  instanceId,
  limit: z.string().min(1),
  additional: z.number().int().min(1).max(100),
  reason: z.string().trim().min(1).max(500),
  requestId: z
    .string()
    .min(1)
    .max(256)
    .refine(visible, 'A nonblank request id of 1–256 characters is required'),
});
/** Direct callers keep the codes they have always received; other fields are invalid_input. */
export const extendLimitFields = {
  instanceId: 'invalid_instance',
  requestId: 'invalid_request',
} satisfies Limits['fields'];

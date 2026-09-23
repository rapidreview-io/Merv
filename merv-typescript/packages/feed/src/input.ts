import { visible, type Limits } from '@merv/contracts';
import { z } from 'zod';

/** One schema per feed operation: the tools publish it and the service parses it. */
const cursor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const requestIdSchema = z
  .string()
  .min(1)
  .max(200)
  .refine(visible, 'requestId must contain 1–200 characters with visible text');
export const postSchema = z.object({
  body: z.string().min(1).max(8000).refine(visible, 'Post body must be nonblank'),
  artifactIds: z
    .array(z.string().min(1).refine(visible, 'Attachments are artifact IDs'))
    .max(10)
    .refine((ids) => new Set(ids).size === ids.length, 'Attach at most 10 distinct artifact IDs')
    .optional(),
  requestId: requestIdSchema,
});
export const listSchema = z.object({
  after: cursor.optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export const activitySchema = z.object({ after: cursor.optional() });
/** The codes direct service callers have always received for each field. */
export const postFields = {
  body: 'invalid_body',
  artifactIds: 'invalid_attachments',
  requestId: 'invalid_request',
} satisfies Limits['fields'];
export const listFields = {
  after: 'invalid_cursor',
  limit: 'invalid_limit',
} satisfies Limits['fields'];

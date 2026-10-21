import { z } from 'zod';
import { idSchema } from '@merv/contracts';

export const knowledgeReferencesSchema = z.object({ refs: z.array(idSchema).max(200) }).strict();
/** Whole records only for the ids named, so the project's size never decides a read's size. */
export const knowledgeRecordsSchema = z.strictObject({
  ids: z.array(idSchema).min(1).max(20).optional(),
});

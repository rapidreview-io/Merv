import { z } from 'zod';
import { legacyHistoryTypes } from './history.js';

const recordType = z.enum(legacyHistoryTypes);
export const request = z.discriminatedUnion('action', [
  z.object({ action: z.literal('summary') }).strict(),
  z
    .object({
      action: z.literal('list'),
      type: recordType,
      after: z.string().max(4096).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    })
    .strict(),
  z
    .object({ action: z.literal('detail'), type: recordType, id: z.string().min(1).max(4096) })
    .strict(),
]);

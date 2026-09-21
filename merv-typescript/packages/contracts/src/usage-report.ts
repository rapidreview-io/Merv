import { z } from 'zod';
import type { SessionUsageReport } from './sessions-models.js';

/**
 * One closed shape for the runner's self-report, shared by the file a launched process
 * writes, the runner that forwards it and the server that stores it, so none of the three
 * can accept what another would refuse.
 */
export const sessionUsageReportSchema: z.ZodType<SessionUsageReport> = z
  .object({
    inputTokens: z.number().int().min(0).max(1e12),
    outputTokens: z.number().int().min(0).max(1e12),
    costUsd: z.number().min(0).max(1e6).optional(),
    model: z
      .string()
      .min(1)
      .max(200)
      .refine((value) => value.trim() === value && !/[\0\r\n]/.test(value))
      .optional(),
  })
  .strict();

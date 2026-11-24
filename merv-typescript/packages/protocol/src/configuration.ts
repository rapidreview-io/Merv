import { z } from 'zod';
export const configuration = z.object({
  provider: z.enum(['claude', 'codex']),
  model: z.string().max(200),
  effort: z.string().max(40),
});
export const configurationRequest = z.object({
  project: z.string().min(1),
  provider: configuration.shape.provider,
  model: z.string().max(200).optional(),
  effort: z.string().max(40).optional(),
});
export const modelChoice = z.object({
  id: z.string(),
  name: z.string(),
  resolved: z.string().optional(),
  capabilities: z.object({ efforts: z.array(z.string()), vision: z.boolean().optional() }),
});
export type Configuration = z.infer<typeof configuration>;

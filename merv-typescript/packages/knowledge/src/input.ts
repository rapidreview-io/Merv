import { z } from 'zod';
import { idSchema } from '@merv/contracts';

export const knowledgeReferencesSchema = z.object({ refs: z.array(idSchema).max(200) }).strict();

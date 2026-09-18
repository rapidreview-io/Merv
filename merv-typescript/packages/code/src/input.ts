import { z } from 'zod';
import { parsed } from '@merv/contracts';

export const parseCodeInput = <T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown) =>
  parsed(schema, input, 'invalid_code_input', { nodes: 8192, depth: 20, bytes: 262144 });

import { types } from 'node:util';
import { z } from 'zod';
import { check } from '@merv/contracts';

export const knowledgeIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/);
export const knowledgeCaptureSchema = z
  .object({
    requestId: z
      .string()
      .min(1)
      .max(200)
      .refine((value) => value.trim().length > 0),
  })
  .strict();
export const knowledgeReferencesSchema = z
  .object({
    refs: z.array(knowledgeIdSchema).max(200),
  })
  .strict();

/** The public inputs are small plain records of strings or dense string arrays. */
export function parseKnowledgeInput<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  input: unknown,
): T {
  const ordinary = (value: unknown): value is object =>
    value !== null && typeof value === 'object' && !types.isProxy(value);
  check(
    ordinary(input) && !Array.isArray(input),
    'invalid_knowledge_input',
    'Expected a plain input object',
  );
  const prototype = Object.getPrototypeOf(input);
  check(
    prototype === Object.prototype || prototype === null,
    'invalid_knowledge_input',
    'Expected a plain input object',
  );
  const keys = Reflect.ownKeys(input);
  check(
    keys.length <= 2 && keys.every((key) => typeof key === 'string'),
    'invalid_knowledge_input',
    'Unexpected input fields',
  );
  const entries: [string, unknown][] = [];
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
    check(
      Object.hasOwn(descriptor, 'value') && descriptor.enumerable,
      'invalid_knowledge_input',
      'Input fields must be ordinary data',
    );
    let value: unknown = descriptor.value;
    if (ordinary(value) && Array.isArray(value)) {
      check(
        Object.getPrototypeOf(value) === Array.prototype,
        'invalid_knowledge_input',
        'Expected a plain array',
      );
      const length = Object.getOwnPropertyDescriptor(value, 'length')!.value as number;
      check(
        length <= 200 && Reflect.ownKeys(value).length === length + 1,
        'invalid_knowledge_input',
        'References must be a bounded dense array',
      );
      value = Array.from({ length }, (_, i) => {
        const item = Object.getOwnPropertyDescriptor(value as object, String(i));
        check(
          item && Object.hasOwn(item, 'value') && item.enumerable && typeof item.value === 'string',
          'invalid_knowledge_input',
          'References must be ordinary strings',
        );
        return item.value as string;
      });
    } else check(typeof value === 'string', 'invalid_knowledge_input', 'Expected string input');
    entries.push([key, value]);
  }
  const parsed = schema.safeParse(Object.fromEntries(entries));
  check(parsed.success, 'invalid_knowledge_input', 'Knowledge input does not match its schema');
  return parsed.data;
}

/** Format 1 sorts object keys by UTF-16 code unit, independent of process locale. */
export function canonicalKnowledge(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalKnowledge).join(',')}]`;
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalKnowledge(item)}`)
    .join(',')}}`;
}

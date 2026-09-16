import { types } from 'node:util';
import { z } from 'zod';
import { check, type Data, type Json } from '@merv/contracts';

/** Detach bounded plain JSON without invoking accessors, proxies or serializers. */
export function parseCodeInput<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T {
  let nodes = 0,
    characters = 0;
  const active = new Set<object>();
  const copy = (value: unknown, depth = 0): Json => {
    check(++nodes <= 8192 && depth <= 20, 'invalid_code_input', 'Code input is too large');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      characters += value.length;
      check(characters <= 262144, 'invalid_code_input', 'Code input is too large');
      return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    check(
      typeof value === 'object' && value !== null && !types.isProxy(value) && !active.has(value),
      'invalid_code_input',
      'Code input must be plain JSON',
    );
    const array = Array.isArray(value);
    check(
      Object.getPrototypeOf(value) === (array ? Array.prototype : Object.prototype),
      'invalid_code_input',
      'Code input must be plain JSON',
    );
    active.add(value);
    const keys = Reflect.ownKeys(value);
    check(keys.length <= 8192, 'invalid_code_input', 'Code input is too large');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    check(
      keys.every((key) => typeof key === 'string') &&
        Object.entries(descriptors).every(
          ([key, item]) =>
            Object.hasOwn(item, 'value') && (item.enumerable || (array && key === 'length')),
        ),
      'invalid_code_input',
      'Code input must contain only ordinary data fields',
    );
    if (array) {
      const length = descriptors.length.value as number;
      check(
        length <= 8192 - nodes &&
          keys.length === length + 1 &&
          Array.from({ length }, (_, index) => String(index)).every((key) =>
            Object.hasOwn(descriptors, key),
          ),
        'invalid_code_input',
        'Code arrays must be dense without extra fields',
      );
      const result = Array.from({ length }, (_, index) =>
        copy(descriptors[String(index)].value, depth + 1),
      );
      active.delete(value);
      return result;
    }
    const result: Data = {};
    for (const [key, descriptor] of Object.entries(descriptors)) {
      check(
        !['__proto__', 'prototype', 'constructor'].includes(key),
        'invalid_code_input',
        'Code input contains an invalid field',
      );
      characters += key.length;
      check(characters <= 262144, 'invalid_code_input', 'Code input is too large');
      result[key] = copy(descriptor.value, depth + 1);
    }
    active.delete(value);
    return result;
  };
  const parsed = schema.safeParse(copy(input));
  check(parsed.success, 'invalid_code_input', 'Code input does not match its schema');
  return parsed.data;
}

/** Format 1: JSON scalars/arrays, object keys sorted by UTF-16 code unit, without ambient collation. */
export function canonicalCode(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalCode).join(',')}]`;
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalCode(item)}`)
    .join(',')}}`;
}

import { types } from 'node:util';
import { z } from 'zod';
import { check, type Data, type Json } from '@merv/contracts';
import type { ExperimentTransition } from './types.js';

export const experimentIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/);
const requestId = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim().length > 0);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const attempt = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const prose = z.string().max(16000).trim();
const ids = z
  .array(experimentIdSchema)
  .max(100)
  .transform((value) => [...new Set(value)]);
export const experimentRoleSchema = z.enum(['plan', 'result', 'report']);
export const resultFormatSchema = z.enum(['json', 'qualitative']);
export const experimentPathSchema = z
  .string()
  .min(1)
  .max(1000)
  .refine(
    (value) =>
      value === value.trim() &&
      /^[A-Za-z0-9][A-Za-z0-9._/ -]*$/.test(value) &&
      value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
    'Use a relative evidence path without traversal, empty segments or special characters',
  );

export const experimentCreateSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(3)
      .max(48)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    intent: prose.min(1),
    details: prose.default(''),
    testedClaimIds: ids.default([]),
    dependsOn: ids.default([]),
    workspace: z.enum(['none', 'git']).optional(),
    requestId,
  })
  .strict();
export const experimentListSchema = z.object({}).strict();
export const experimentGetSchema = z.object({ experimentId: experimentIdSchema }).strict();
export const experimentExhibitSchema = experimentGetSchema;
export const experimentAttachSchema = z
  .object({
    experimentId: experimentIdSchema,
    artifactId: experimentIdSchema,
    role: experimentRoleSchema,
    path: experimentPathSchema,
    attemptIndex: attempt,
    expectedRevision: revision,
    requestId,
    resultFormat: resultFormatSchema.optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.role !== 'result' && input.resultFormat !== undefined)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['resultFormat'],
        message: 'resultFormat only applies to result evidence',
      });
  })
  .transform((input) =>
    input.role === 'result'
      ? { ...input, resultFormat: input.resultFormat ?? ('json' as const) }
      : input,
  );

export const experimentTransitionSchema = z
  .object({
    experimentId: experimentIdSchema,
    transition: z.enum([
      'submit_design',
      'submit_results',
      'retry_running',
      'abandon',
      'mark_failed',
    ]),
    paperChangesArtifactId: experimentIdSchema.optional(),
    expectedRevision: revision,
    requestId,
    evidence: z
      .object({ reason: prose.min(1).optional(), detail: prose.optional() })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.paperChangesArtifactId && input.transition !== 'submit_results')
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['paperChangesArtifactId'],
        message: 'Paper edits belong to the experiment results submission',
      });
    if (['abandon', 'mark_failed'].includes(input.transition) && !input.evidence?.reason)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidence', 'reason'],
        message: 'Ending an experiment requires a reason',
      });
    if (
      ['submit_design', 'submit_results'].includes(input.transition) &&
      input.evidence &&
      Object.keys(input.evidence).length
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidence'],
        message: 'Submission evidence comes from the retained artifact selection',
      });
  })
  .transform((input): ExperimentTransition => {
    if (input.transition === 'retry_running')
      return {
        ...input,
        evidence: {
          reason: input.evidence?.reason ?? 'infrastructure failure',
          detail: input.evidence?.detail ?? '',
        },
      };
    if (input.evidence && Object.keys(input.evidence).length) return input;
    const { evidence: _empty, ...rest } = input;
    return rest;
  });

export type ExperimentCreateInput = z.output<typeof experimentCreateSchema>;
export type ExperimentAttachInput = z.output<typeof experimentAttachSchema>;
export type ExperimentTransitionInput = z.output<typeof experimentTransitionSchema>;
export type ExperimentResultFormat = z.output<typeof resultFormatSchema>;

/** Detach bounded data before any parser can inspect getters, proxies or serializers. */
export function copyExperimentJson(
  input: unknown,
  limits: { maxBytes?: number; maxNodes?: number; preserveKeys?: boolean } = {},
): Json {
  const maxBytes = limits.maxBytes ?? 262144;
  const maxNodes = limits.maxNodes ?? 8192;
  let bytes = 0,
    nodes = 0;
  const active = new Set<object>();
  const fail = (message: string): never => {
    check(false, 'invalid_experiment_input', message);
  };
  const account = (value: string) => {
    bytes += Buffer.byteLength(value, 'utf8');
    if (bytes > maxBytes) fail('Experiment input is too large');
  };
  const copy = (value: unknown, depth = 0): Json => {
    if (++nodes > maxNodes || depth > 20) fail('Experiment input is too large or deeply nested');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      account(value);
      return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'object' || value === null || types.isProxy(value) || active.has(value))
      return fail('Experiment input must be finite, acyclic plain JSON');
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (
      array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
    )
      return fail('Experiment input must contain ordinary JSON objects and arrays');
    const keys = Reflect.ownKeys(value);
    if (keys.length > maxNodes || keys.some((key) => typeof key !== 'string'))
      return fail('Experiment input has too many or invalid fields');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Object.entries(descriptors).some(
        ([key, field]) =>
          !Object.hasOwn(field, 'value') || (!field.enumerable && !(array && key === 'length')),
      )
    )
      return fail('Experiment input fields must be ordinary enumerable data');
    active.add(value);
    if (array) {
      const length = descriptors.length.value as number;
      if (
        length > maxNodes - nodes ||
        keys.length !== length + 1 ||
        !Array.from({ length }, (_, index) => String(index)).every((key) =>
          Object.hasOwn(descriptors, key),
        )
      )
        return fail('Experiment arrays must be dense and have no extra properties');
      const result = Array.from({ length }, (_, index) =>
        copy(descriptors[String(index)].value, depth + 1),
      );
      active.delete(value);
      return result;
    }
    const result: Data = {};
    for (const [key, field] of Object.entries(descriptors)) {
      if (!limits.preserveKeys && ['__proto__', 'prototype', 'constructor'].includes(key))
        return fail('Experiment input contains an invalid field');
      account(key);
      // Optional in-process fields have the same request identity as omitted JSON fields.
      if (field.value !== undefined)
        Object.defineProperty(result, key, {
          value: copy(field.value, depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
    }
    active.delete(value);
    return result;
  };
  return copy(input);
}

export function parseExperimentInput<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  input: unknown,
): T {
  const parsed = schema.safeParse(copyExperimentJson(input));
  check(parsed.success, 'invalid_experiment_input', 'Experiment input does not match its schema');
  return parsed.data;
}

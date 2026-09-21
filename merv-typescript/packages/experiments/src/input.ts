import { z } from 'zod';
import { visible, parsed } from '@merv/contracts';
import type { ExperimentTransition } from './types.js';

export const experimentIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/);
const requestId = z.string().min(1).max(200).refine(visible);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const attempt = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const prose = (min = 0) =>
  z
    .string()
    .max(16000)
    .trim()
    .min(min)
    .refine((value) => value === '' || visible(value), 'Text must contain visible characters');
const ids = z
  .array(experimentIdSchema)
  .max(100)
  .transform((value) => [...new Set(value)]);
export const experimentRoleSchema = z.enum(['plan', 'result', 'report', 'feasibility']);
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
    intent: prose(1),
    details: prose().default(''),
    testedClaimIds: ids.default([]),
    dependsOn: ids.default([]),
    workspace: z.enum(['none', 'git']).optional(),
    baseTaskId: experimentIdSchema.optional(),
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
      .object({ reason: prose(1).optional(), detail: prose().optional() })
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
    if (
      ['abandon', 'mark_failed', 'retry_running'].includes(input.transition) &&
      !input.evidence?.reason
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidence', 'reason'],
        message: 'Ending or retrying an experiment requires a specific reason',
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
      return { ...input, evidence: { ...input.evidence, detail: input.evidence?.detail ?? '' } };
    if (input.evidence && Object.keys(input.evidence).length) return input;
    const { evidence: _empty, ...rest } = input;
    return rest;
  });

export const parseExperimentInput = <T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  input: unknown,
) => parsed(schema, input, 'invalid_experiment_input', { nodes: 8192, depth: 20, bytes: 262144 });

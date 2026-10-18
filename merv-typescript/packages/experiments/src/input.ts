import { z } from 'zod';
import { idSchema, visible, parsed } from '@merv/contracts';
import type { ExperimentTransition } from './types.js';
import { experimentName } from './rules.js';

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
  .array(idSchema)
  .max(100)
  .transform((value) => [...new Set(value)]);
const experimentPathSchema = z
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
    name: experimentName(z.string().trim()),
    intent: prose(1),
    details: prose().default(''),
    dependsOn: ids.default([]),
    workspace: z.enum(['none', 'git']).optional(),
    requestId,
  })
  .strict();
export const experimentListSchema = z.object({}).strict();
export const experimentGetSchema = z.object({ experimentId: idSchema }).strict();
export const experimentExhibitSchema = experimentGetSchema;
export const experimentAttachSchema = z
  .object({
    experimentId: idSchema,
    artifactId: idSchema,
    role: z.enum(['plan', 'result', 'report', 'feasibility']),
    path: experimentPathSchema,
    attemptIndex: attempt,
    expectedRevision: revision,
    requestId,
    resultFormat: z.enum(['json', 'qualitative']).optional(),
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
    experimentId: idSchema,
    transition: z.enum([
      'submit_design',
      'submit_results',
      'retry_running',
      'abandon',
      'mark_failed',
    ]),
    expectedRevision: revision,
    requestId,
    evidence: z
      .object({ reason: prose(1).optional(), detail: prose().optional() })
      .strict()
      .optional()
      .describe(
        'Only for retry_running, abandon and mark_failed, which require evidence.reason. Omit it for submit_design and submit_results: a submission seals the artifacts attached with experiment.attach.',
      ),
  })
  .strict()
  .superRefine((input, ctx) => {
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
        // Every producer passed it once (2026-10): name what to do, and that nothing was sent.
        message:
          'Omit evidence for submit_design and submit_results and call again with the same requestId; nothing was submitted. A submission seals the artifacts attached with experiment.attach, so what the reviewer should read belongs in the plan or report. evidence is only for retry_running, abandon and mark_failed.',
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

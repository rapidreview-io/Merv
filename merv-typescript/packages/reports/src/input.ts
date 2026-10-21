import { z } from 'zod';
import { idSchema, parsed, visible } from '@merv/contracts';

const requestId = z.string().trim().min(1).max(200).refine(visible);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const MAX_SOURCE_BYTES = 60_000;
export const MAX_FILE_BYTES = 500_000;
export const MAX_FILES_BYTES = 2_000_000;
export const MAX_FILES = 20;

/** Every report tool names its subject; one report exists per subject. */
export const subject = {
  subjectKind: z.enum(['experiment', 'customer_experiment']),
  subjectId: idSchema,
};
export const openSchema = z.object(subject).strict();
export const writeSchema = z
  .strictObject({
    ...subject,
    expectedRevision: revision,
    requestId,
    /** Replace these sections' bodies (text under the `## Name` heading). */
    sections: z
      .array(
        z.strictObject({
          name: z.string().trim().min(1).max(40),
          content: z.string().max(MAX_SOURCE_BYTES),
        }),
      )
      .max(20)
      .optional(),
    /** Replace the YAML between the --- lines (id, date, criteria). */
    frontMatter: z.string().max(10_000).optional(),
    /** Replace the whole Markdown; locked sections must stay as they are. */
    source: z.string().max(MAX_SOURCE_BYTES).optional(),
    /** Add or replace data files charts name by {file}; null removes one. */
    files: z
      .array(
        z.strictObject({
          name: z.string().regex(/^[\w.-]{1,80}\.(csv|json)$/),
          content: z.string().max(MAX_FILE_BYTES).nullable(),
        }),
      )
      .max(MAX_FILES)
      .optional(),
  })
  .refine((v) => v.sections || v.frontMatter !== undefined || v.source !== undefined || v.files, {
    message: 'Give sections, frontMatter, source or files to change',
  })
  .refine((v) => !(v.source !== undefined && (v.sections || v.frontMatter !== undefined)), {
    message: 'source replaces the whole report; do not combine it with sections or frontMatter',
  });
export const clearSchema = z.object({ ...subject, expectedRevision: revision, requestId }).strict();
export const checkSchema = openSchema;
export const reviewVisualSchema = z.strictObject({
  ...subject,
  chartId: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,40}$/)
    .optional(),
});
export const approveVisualSchema = z.strictObject({
  ...subject,
  chartId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/),
  expectedRevision: revision,
  requestId,
});
export const renderSchema = z
  .strictObject({ ...subject, final: z.boolean().default(false), requestId: requestId.optional() })
  .refine((v) => !v.final || v.requestId, { message: 'A final render needs a requestId' });

export const parse = <T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown) =>
  parsed(schema, value, 'invalid_report_input', { nodes: 20_000, depth: 8 });

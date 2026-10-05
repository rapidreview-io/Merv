import { z } from 'zod';
import { visible, parsed, type Project, type ProjectContextUpdate } from '@merv/contracts';

export interface ProjectRow {
  id: string;
  name: string;
  created_at: string;
  summary: string;
  context_revision: number;
}

export const projectValue = (row: ProjectRow): Project => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at,
  summary: row.summary,
  contextRevision: row.context_revision,
});

const summaryText = z
  .string()
  .max(16_000)
  .refine(
    (text) => Buffer.byteLength(text, 'utf8') <= 16_000,
    'Project Introduction must fit within 16,000 UTF-8 bytes',
  );
export const projectContextUpdateSchema = z
  .object({
    summary: summaryText.transform((text) => text.trim()),
    expectedSummary: summaryText.optional(),
    expectedContextRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    requestId: z.string().min(1).max(256).refine(visible),
  })
  .strict()
  .refine(
    (input) =>
      (input.expectedSummary === undefined) !== (input.expectedContextRevision === undefined),
    'Supply exactly one of expectedSummary or expectedContextRevision from project.get',
  );

/** A detached copy parsed, so direct service calls cannot execute supplied getters. */
export function parseProjectContextUpdate(input: unknown): ProjectContextUpdate {
  return parsed(projectContextUpdateSchema, input, 'invalid_project_context');
}

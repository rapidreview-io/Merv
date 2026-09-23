import { postgresMigrations } from './project-context.postgres.js';
import { z } from 'zod';
import {
  visible,
  parsed,
  type Migration,
  type Project,
  type ProjectContextUpdate,
} from '@merv/contracts';

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

export const projectContextMigration: Migration = {
  version: 6,
  sql: postgresMigrations[6],
};

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
    expectedSummary: summaryText,
    requestId: z.string().min(1).max(256).refine(visible),
  })
  .strict();

/** A detached copy parsed, so direct service calls cannot execute supplied getters. */
export function parseProjectContextUpdate(input: unknown): ProjectContextUpdate {
  return parsed(projectContextUpdateSchema, input, 'invalid_project_context');
}

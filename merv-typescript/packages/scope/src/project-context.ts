import { postgresMigrations } from './project-context.postgres.js';
import { types } from 'node:util';
import { z } from 'zod';
import {
  visible,
  check,
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

/** Inspect descriptors before Zod so direct service calls cannot execute supplied getters. */
export function parseProjectContextUpdate(input: unknown): ProjectContextUpdate {
  check(
    input !== null && typeof input === 'object' && !types.isProxy(input),
    'invalid_project_context',
    'Project context input must contain plain string fields',
  );
  const prototype = Object.getPrototypeOf(input);
  check(
    prototype === Object.prototype || prototype === null,
    'invalid_project_context',
    'Project context input must contain plain string fields',
  );
  const keys = Reflect.ownKeys(input);
  const fields = ['summary', 'expectedSummary', 'requestId'];
  check(
    keys.length === fields.length &&
      keys.every((key) => typeof key === 'string' && fields.includes(key)),
    'invalid_project_context',
    'Only summary, expectedSummary and requestId are accepted',
  );
  const copied: Record<string, string> = {};
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    check(
      descriptor?.enumerable && 'value' in descriptor && typeof descriptor.value === 'string',
      'invalid_project_context',
      'Project context fields must be own string values',
    );
    copied[key] = descriptor.value;
  }
  const parsed = projectContextUpdateSchema.safeParse(copied);
  check(parsed.success, 'invalid_project_context', 'Invalid project context fields or text size');
  return parsed.data;
}

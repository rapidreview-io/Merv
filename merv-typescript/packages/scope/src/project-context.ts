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
  postgres: postgresMigrations[6],
  sql: `
    ALTER TABLE projects ADD COLUMN summary TEXT NOT NULL DEFAULT '';
    ALTER TABLE projects ADD COLUMN context_revision INTEGER NOT NULL DEFAULT 0
      CHECK(context_revision >= 0 AND context_revision <= 9007199254740991);
    CREATE TABLE project_context_commands (
      project_id TEXT NOT NULL REFERENCES projects(id), actor_id TEXT NOT NULL REFERENCES actors(id),
      request_id TEXT NOT NULL, input_hash TEXT NOT NULL, result_json TEXT NOT NULL,
      PRIMARY KEY(project_id,actor_id,request_id)
    );
    CREATE TRIGGER project_context_commands_no_update BEFORE UPDATE ON project_context_commands
      BEGIN SELECT RAISE(ABORT,'Project context receipts are immutable'); END;
    CREATE TRIGGER project_context_commands_no_delete BEFORE DELETE ON project_context_commands
      BEGIN SELECT RAISE(ABORT,'Project context receipts are retained'); END;
  `,
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

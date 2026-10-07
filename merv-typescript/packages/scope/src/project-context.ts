import type { Project } from '@merv/contracts';

/**
 * A project row. `summary` and `context_revision` remain only until a later migration drops
 * them: Paper serves the project Introduction from the Problem, and nothing writes them now.
 */
export interface ProjectRow {
  id: string;
  name: string;
  created_at: string;
}

export const projectValue = (row: ProjectRow): Project => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at,
});

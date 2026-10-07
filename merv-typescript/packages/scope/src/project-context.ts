import type { Project } from '@merv/contracts';

/** A project row: its identity only. Paper serves the project Introduction from the Problem. */
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

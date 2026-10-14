import { newId, type Project, type Sql } from '@merv/contracts';

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

/** A new project named `name`, inserted in `tx`. */
export async function insertProject(tx: Sql, name: string, createdAt: string): Promise<Project> {
  const value = { id: newId('project'), name, createdAt };
  await tx.run('INSERT INTO projects(id,name,created_at) VALUES(?,?,?)', value.id, name, createdAt);
  return value;
}

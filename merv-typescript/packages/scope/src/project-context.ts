import { newId, type Project, type Sql } from '@merv/contracts';

/** A project row: its identity and its admin. Paper serves the project Introduction from the Problem. */
export interface ProjectRow {
  id: string;
  name: string;
  created_at: string;
  admin_issuer: string | null;
  admin_subject: string | null;
}

export const projectValue = (row: ProjectRow): Project => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at,
  admin:
    row.admin_issuer === null ? null : { issuer: row.admin_issuer, subject: row.admin_subject! },
});

/** A new project named `name`, inserted in `tx`. Its first live operator becomes its admin. */
export async function insertProject(tx: Sql, name: string, createdAt: string): Promise<Project> {
  const value = { id: newId('project'), name, createdAt, admin: null };
  await tx.run('INSERT INTO projects(id,name,created_at) VALUES(?,?,?)', value.id, name, createdAt);
  return value;
}

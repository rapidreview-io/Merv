import { newId, type Data, type State, type Transaction } from '@merv/contracts';

/** Published migrations: production pins each text by its digest, never edit one. */
export const auditMigrations = {
  1: `CREATE TABLE admin_audit (
    id TEXT PRIMARY KEY,
    at TEXT NOT NULL,
    issuer TEXT NOT NULL,
    subject TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT NOT NULL,
    detail_json TEXT NOT NULL
  );
  CREATE INDEX admin_audit_at ON admin_audit(at);`,
};

export interface AuditEntry {
  issuer: string;
  subject: string;
  /** What the admin did: `credits.grant`, `project.read`, … */
  action: string;
  /** The account, project or record it touched. */
  target: string;
  detail?: Data;
}

/** Who did what as a platform admin, kept for good. */
export class AdminAudit {
  constructor(private readonly state: State) {}

  async record(entry: AuditEntry, tx?: Transaction): Promise<void> {
    const write = async (sql: Transaction) =>
      await sql.run(
        'INSERT INTO admin_audit(id,at,issuer,subject,action,target,detail_json) VALUES(?,?,?,?,?,?,?)',
        newId('audit'),
        new Date().toISOString(),
        entry.issuer,
        entry.subject,
        entry.action,
        entry.target,
        JSON.stringify(entry.detail ?? {}),
      );
    await (tx ? write(tx) : this.state.transaction(write));
  }

  async recent(limit = 200) {
    return await this.state.read(
      async (sql) =>
        await sql.all<{ at: string; subject: string; action: string; target: string }>(
          'SELECT at,subject,action,target FROM admin_audit ORDER BY at DESC LIMIT ?',
          limit,
        ),
    );
  }
}

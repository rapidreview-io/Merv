import { newId, type Data, type State } from '@merv/contracts';
import type { AdminIdentity } from './index.js';

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

/** Who did what as a platform admin, kept for good. */
export class AdminAudit {
  constructor(private readonly state: State) {}

  /** `action` is what `who` did (`credits.grant`, `project.read`, …), `target` the account,
   *  project or record it touched. */
  async record(who: AdminIdentity, action: string, target: string, detail: Data = {}) {
    await this.state.transaction((sql) =>
      sql.run(
        'INSERT INTO admin_audit(id,at,issuer,subject,action,target,detail_json) VALUES(?,?,?,?,?,?,?)',
        newId('audit'),
        new Date().toISOString(),
        who.issuer,
        who.subject,
        action,
        target,
        JSON.stringify(detail),
      ),
    );
  }
}

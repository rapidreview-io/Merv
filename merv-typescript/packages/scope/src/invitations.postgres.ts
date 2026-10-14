/** Append-only published migration; do not alter after deployment. */
export const postgresMigrations: Record<number, string> = {
  11: `CREATE TABLE project_invitations (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    project_name TEXT NOT NULL,
    issuer TEXT NOT NULL,
    subject TEXT NOT NULL,
    email TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('operator','producer','reviewer','reader')),
    inviter_membership_id TEXT NOT NULL REFERENCES project_memberships(id),
    status TEXT NOT NULL CHECK(status IN ('pending','accepted','declined','revoked','expired')),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    sent_at TEXT,
    membership_id TEXT REFERENCES project_memberships(id)
  );
  CREATE UNIQUE INDEX project_invitation_pending ON project_invitations(project_id,issuer,subject) WHERE status='pending';
  CREATE INDEX project_invitation_recipient ON project_invitations(issuer,subject,status);
  CREATE INDEX project_invitation_sender ON project_invitations(inviter_membership_id,created_at);
  CREATE FUNCTION project_invitation_withdraw_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
  BEGIN
    IF OLD.active=1 AND NEW.active=0 THEN
      UPDATE project_invitations SET status='revoked' WHERE inviter_membership_id=OLD.id AND status='pending';
    END IF;
    RETURN NEW;
  END;
  $merv$;
  CREATE TRIGGER project_invitation_withdraw AFTER UPDATE ON project_memberships
    FOR EACH ROW EXECUTE FUNCTION project_invitation_withdraw_guard();`,
};

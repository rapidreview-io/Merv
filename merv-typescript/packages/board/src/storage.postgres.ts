/** Published PostgreSQL migrations. Production pins each text by its digest: never edit one. */
export const postgresMigrations: Record<number, string> = {
  1: `
CREATE TABLE boards(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,revision BIGINT NOT NULL,record TEXT NOT NULL);
CREATE INDEX boards_project ON boards(project_id);
CREATE TABLE board_elements(board_id TEXT NOT NULL,element_id TEXT NOT NULL,revision BIGINT NOT NULL,deleted BOOLEAN NOT NULL,record TEXT NOT NULL,PRIMARY KEY(board_id,element_id));
CREATE INDEX board_elements_changed ON board_elements(board_id,revision);
`,
  // Deleted shapes are purged after 30 days: a deletion is dated (one made before now from now),
  // and a board keeps the newest revision it purged, before which a reader cannot name every one.
  2: `
ALTER TABLE board_elements ADD COLUMN deleted_at TEXT;
UPDATE board_elements SET deleted_at=to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') WHERE deleted;
CREATE INDEX board_elements_deleted ON board_elements(board_id,deleted_at) WHERE deleted;
ALTER TABLE boards ADD COLUMN purged BIGINT NOT NULL DEFAULT 0;
`,
  // The bytes of the images on a project's boards, and which file each image shape shows.
  3: `
CREATE TABLE board_images(project_id TEXT NOT NULL,file_id TEXT NOT NULL,content BYTEA NOT NULL,stored_at TEXT NOT NULL,PRIMARY KEY(project_id,file_id));
ALTER TABLE board_elements ADD COLUMN file_id TEXT;
CREATE INDEX board_elements_file ON board_elements(file_id) WHERE file_id IS NOT NULL;
`,
  // What each revision made of its shapes, kept for replay, and the files history names, whose
  // bytes it keeps.
  4: `
CREATE TABLE board_history(board_id TEXT NOT NULL,revision BIGINT NOT NULL,actor_id TEXT NOT NULL,began_at TEXT NOT NULL,kind TEXT NOT NULL,shapes TEXT NOT NULL,PRIMARY KEY(board_id,revision));
CREATE TABLE board_history_files(project_id TEXT NOT NULL,file_id TEXT NOT NULL,PRIMARY KEY(project_id,file_id));
`,
  // A board's outcomes: titled drafts, mutable, each with a revision. The text stands apart from the
  // record, because the page asks for every record of the board each poll.
  5: `
CREATE TABLE board_outcomes(board_id TEXT NOT NULL,id TEXT NOT NULL,revision BIGINT NOT NULL,record TEXT NOT NULL,text TEXT NOT NULL,PRIMARY KEY(board_id,id));
`,
  6: `
CREATE TABLE board_shares(board_id TEXT PRIMARY KEY REFERENCES boards(id) ON DELETE CASCADE,digest TEXT NOT NULL UNIQUE);
`,
  // The look a person draws in now: their preference, for every board they have, changed at will.
  7: `
CREATE TABLE board_looks(project_id TEXT PRIMARY KEY,look TEXT NOT NULL,updated_at TEXT NOT NULL);
`,
  // Words said aloud in a live session, each a step of the board's history beside its drawing.
  8: `
ALTER TABLE board_history ADD COLUMN said TEXT;
`,
  // Receipts outlive retries and remote edits, but never the outcome they acknowledge.
  9: `
CREATE TABLE board_outcome_requests(
  project_id TEXT NOT NULL,actor_id TEXT NOT NULL,request_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,result TEXT NOT NULL,board_id TEXT NOT NULL,outcome_id TEXT NOT NULL,
  PRIMARY KEY(project_id,actor_id,request_id),
  FOREIGN KEY(board_id,outcome_id) REFERENCES board_outcomes(board_id,id) ON DELETE CASCADE
);
CREATE INDEX board_outcome_requests_outcome ON board_outcome_requests(board_id,outcome_id);
`,
  // Paper belongs to the artwork, not the current style preference. Recover the original
  // look from a retained board record or the preference at its earliest recorded drawing.
  // Without that history, preserve the last known paper rather than recolouring shapes.
  10: `
WITH origins AS (
  SELECT b.id, COALESCE(
    b.record::jsonb->>'look',
    (SELECT COALESCE(e.data_json::jsonb->>'look','none') FROM events e
      WHERE e.project_id=b.project_id AND e.type='board.set' AND e.data_json::jsonb ? 'look'
        AND e.created_at <= COALESCE(
          (SELECT MIN(h.began_at) FROM board_history h WHERE h.board_id=b.id),
          b.record::jsonb->>'createdAt')
      ORDER BY e.id DESC LIMIT 1),
    l.look, 'none') AS look
  FROM boards b LEFT JOIN board_looks l ON l.project_id=b.project_id
  WHERE NOT (b.record::jsonb ? 'paper')
)
UPDATE boards b SET record=jsonb_set(b.record::jsonb,'{paper}',to_jsonb(CASE origins.look
  WHEN 'khan' THEN '#000000' WHEN 'sketchnote' THEN '#fffcf5'
  WHEN 'sprint' THEN '#f8f9fa' WHEN 'blueprint' THEN '#f4f7fb'
  ELSE '#ffffff' END))::text FROM origins WHERE b.id=origins.id;
`,
  // Outcomes are retired for page cards (2026-11-18): their tables stay, read-only, for one release,
  // and each outcome moved to a page card on its board is remembered with the cards it became.
  11: `
CREATE TABLE board_outcome_pages(board_id TEXT NOT NULL,outcome_id TEXT NOT NULL,elements TEXT NOT NULL,moved_at TEXT NOT NULL,PRIMARY KEY(board_id,outcome_id));
CREATE FUNCTION board_outcomes_read_only() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN RAISE EXCEPTION 'board outcomes are retired and read-only'; END $merv$;
CREATE TRIGGER board_outcomes_read_only BEFORE INSERT OR UPDATE ON board_outcomes FOR EACH ROW EXECUTE FUNCTION board_outcomes_read_only();
CREATE TRIGGER board_outcome_requests_read_only BEFORE INSERT OR UPDATE ON board_outcome_requests FOR EACH ROW EXECUTE FUNCTION board_outcomes_read_only();
`,
};

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
};

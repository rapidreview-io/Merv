/** Published PostgreSQL migrations. Production pins each text by its digest: never edit one. */
export const postgresMigrations: Record<number, string> = {
  1: `
CREATE TABLE boards(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,revision BIGINT NOT NULL,record TEXT NOT NULL);
CREATE INDEX boards_project ON boards(project_id);
CREATE TABLE board_elements(board_id TEXT NOT NULL,element_id TEXT NOT NULL,revision BIGINT NOT NULL,deleted BOOLEAN NOT NULL,record TEXT NOT NULL,PRIMARY KEY(board_id,element_id));
CREATE INDEX board_elements_changed ON board_elements(board_id,revision);
`,
};

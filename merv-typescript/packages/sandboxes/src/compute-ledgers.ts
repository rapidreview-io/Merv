import type { Migration, State } from '@merv/contracts';

/**
 * The ledgers of the retired Merv-side compute path: managed GPU runs and work rentals. Nothing
 * reads or writes them any more. Their published migrations stay registered byte for byte, so the
 * versions production applied still match and a fresh database has the same tables; dropping them
 * is a later migration that waits on a production check.
 */
export const computeLedgers: [component: string, migrations: Migration[]][] = [
  [
    'sandboxes-compute',
    [
      {
        version: 1,
        sql: `
CREATE TABLE managed_compute_runs (
 project_id TEXT NOT NULL,owner_kind TEXT NOT NULL,owner_id TEXT NOT NULL,generation BIGINT NOT NULL,
 key TEXT NOT NULL,input_hash TEXT NOT NULL,input_json TEXT NOT NULL,run_id TEXT,
 state TEXT NOT NULL,cost TEXT,result TEXT,created_by TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 PRIMARY KEY(owner_kind,owner_id,generation,key));
CREATE INDEX managed_compute_project_state ON managed_compute_runs(project_id,state);
`,
      },
      {
        version: 2,
        sql: `
ALTER TABLE managed_compute_runs ADD COLUMN capture_pending BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE managed_compute_runs ADD COLUMN capture_artifact_id TEXT;
ALTER TABLE managed_compute_runs ADD COLUMN capture_error TEXT;
`,
      },
    ],
  ],
  [
    'sandboxes-work-machines',
    [
      {
        version: 1,
        sql: `
CREATE TABLE work_compute_machines (
 project_id TEXT NOT NULL, owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL, key TEXT NOT NULL,
 input_json TEXT NOT NULL, attempted_at TEXT, sandbox_id TEXT, state TEXT NOT NULL,
 receipt TEXT, stop_requested BOOLEAN NOT NULL DEFAULT FALSE, updated_at TEXT NOT NULL,
 PRIMARY KEY(owner_kind,owner_id,key));
CREATE UNIQUE INDEX work_compute_machine_id ON work_compute_machines(sandbox_id) WHERE sandbox_id IS NOT NULL;
CREATE INDEX work_compute_machine_active ON work_compute_machines(owner_kind,state,updated_at);
`,
      },
    ],
  ],
];

export async function initializeComputeLedgers(state: State): Promise<void> {
  for (const [component, migrations] of computeLedgers) await state.migrate(component, migrations);
}

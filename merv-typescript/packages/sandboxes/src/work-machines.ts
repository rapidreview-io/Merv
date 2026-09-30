import {
  check,
  digest,
  MervError,
  now,
  type Caller,
  type Json,
  type Scope,
  type State,
  type Transaction,
} from '@merv/contracts';
import { z } from 'zod';
import type { ComputeOwner } from './managed-compute.js';
import type { SandboxCompute, SandboxRental, SandboxRentalInput } from './types.js';

export const rentalSchema = z
  .object({
    key: z.string().min(1).max(128),
    provider: z.string().min(1).max(64),
    offerId: z.string().min(1).max(256),
    minutes: z.number().int().min(5).max(1380),
  })
  .strict();
export interface WorkMachinePolicy {
  /** Owner validates the live assignment, including the reviewer or planner lease. */
  authorize(caller: Caller, ownerId: string, tx: Transaction): Promise<void>;
  /** Independent of a session or revision: a handoff must not destroy the machine. */
  active(projectId: string, ownerId: string, tx: Transaction): Promise<boolean>;
  entitled(projectId: string, tx: Transaction): Promise<boolean>;
}
interface Row {
  project_id: string;
  owner_kind: ComputeOwner;
  owner_id: string;
  key: string;
  input_json: string;
  attempted_at: string | null;
  sandbox_id: string | null;
  state: string;
  receipt: string | null;
  stop_requested: boolean;
  updated_at: string;
}
const ended = new Set(['stopped', 'failed']);
const present = (row: Row) => ({
  key: row.key,
  ...(row.receipt ? JSON.parse(row.receipt) : {}),
  sandboxId: row.sandbox_id,
  state: row.stop_requested && !ended.has(row.state) ? 'releasing' : row.state,
  updatedAt: row.updated_at,
});

export async function initializeWorkMachines(state: State) {
  await state.migrate('sandboxes-work-machines', [
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
  ]);
}

/** Sandboxes owns durable rentals; the work owner supplies only admission and terminal state. */
export class WorkMachines {
  private pending?: Promise<void>;
  private closed = false;
  private timer: ReturnType<typeof setInterval>;
  constructor(
    private state: State,
    private scope: Scope,
    private adapter: SandboxCompute,
    private owner: ComputeOwner,
    private policy: WorkMachinePolicy,
  ) {
    this.timer = setInterval(() => void this.tick().catch(() => undefined), 15_000);
    this.timer.unref();
  }
  close() {
    this.closed = true;
    clearInterval(this.timer);
  }
  async rows(projectId: string, ownerId: string, tx: Transaction): Promise<Json[]> {
    return (
      await tx.all<Row>(
        'SELECT * FROM work_compute_machines WHERE project_id=? AND owner_kind=? AND owner_id=? ORDER BY updated_at DESC,key LIMIT 100',
        projectId,
        this.owner,
        ownerId,
      )
    ).map(present);
  }
  async list(caller: Caller, ownerId: string) {
    return this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'read', tx);
      return this.rows(caller.projectId, ownerId, tx);
    });
  }
  async rent(caller: Caller, ownerId: string, input: SandboxRentalInput) {
    input = rentalSchema.parse(input);
    check(this.adapter.rent, 'compute_unavailable', 'GPU rental is unavailable', 503);
    return this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'read', tx);
      await this.policy.authorize(caller, ownerId, tx);
      check(
        await this.policy.entitled(caller.projectId, tx),
        'compute_not_entitled',
        'This project has no ML allowance',
        403,
      );
      const previous = await tx.get<Row>(
        'SELECT * FROM work_compute_machines WHERE project_id=? AND owner_kind=? AND owner_id=? AND key=?',
        caller.projectId,
        this.owner,
        ownerId,
        input.key,
      );
      if (previous) {
        check(
          digest(JSON.parse(previous.input_json)) === digest(input),
          'compute_key_conflict',
          'This rental key has different input',
          409,
        );
        return present(previous);
      }
      await tx.run(
        `INSERT INTO work_compute_machines(project_id,owner_kind,owner_id,key,input_json,state,updated_at) VALUES(?,?,?,?,?,'queued',?)`,
        caller.projectId,
        this.owner,
        ownerId,
        input.key,
        JSON.stringify(input),
        now(),
      );
      return { key: input.key, sandboxId: null, state: 'queued' };
    });
  }
  private async authorized(caller: Caller, ownerId: string, sandboxId: string) {
    return this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'read', tx);
      await this.policy.authorize(caller, ownerId, tx);
      const row = await tx.get<Row>(
        'SELECT * FROM work_compute_machines WHERE project_id=? AND owner_kind=? AND owner_id=? AND sandbox_id=?',
        caller.projectId,
        this.owner,
        ownerId,
        sandboxId,
      );
      check(row, 'compute_not_found', 'Machine not found in this work item', 404);
      return row;
    });
  }
  async access(caller: Caller, ownerId: string, sandboxId: string, publicKey: string) {
    check(
      typeof publicKey === 'string' &&
        publicKey.length <= 16384 &&
        /^ssh-ed25519 [A-Za-z0-9+/]+=*(?: [^\r\n]*)?$/.test(publicKey),
      'invalid_public_key',
      'Supply a single Ed25519 public key; keep its private key in your workspace',
    );
    const row = await this.authorized(caller, ownerId, sandboxId);
    check(
      !row.stop_requested && row.state === 'ready',
      'compute_not_ready',
      'Machine is not ready; read compute machines for its state',
      409,
    );
    check(this.adapter.ssh, 'compute_unavailable', 'SSH access is unavailable', 503);
    const access = await this.adapter.ssh(caller.projectId, sandboxId, publicKey);
    // A handoff during certificate issuance must not return credentials to an expired lease.
    const current = await this.authorized(caller, ownerId, sandboxId);
    check(!current.stop_requested, 'compute_not_ready', 'Machine is being released', 409);
    return access;
  }
  async release(caller: Caller, ownerId: string, sandboxId: string) {
    await this.authorized(caller, ownerId, sandboxId);
    return this.state.transaction(async (tx) => {
      await this.policy.authorize(caller, ownerId, tx);
      await tx.run(
        'UPDATE work_compute_machines SET stop_requested=TRUE,updated_at=? WHERE project_id=? AND owner_kind=? AND owner_id=? AND sandbox_id=?',
        now(),
        caller.projectId,
        this.owner,
        ownerId,
        sandboxId,
      );
      return { sandboxId, state: 'releasing' };
    });
  }
  tick(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return (this.pending ??= this.pass().finally(() => {
      this.pending = undefined;
    }));
  }
  private async save(row: Row, rental: SandboxRental) {
    await this.state.transaction((tx) =>
      tx.run(
        'UPDATE work_compute_machines SET sandbox_id=?,state=?,receipt=?,updated_at=? WHERE project_id=? AND owner_kind=? AND owner_id=? AND key=?',
        rental.sandboxId,
        rental.state,
        JSON.stringify(rental),
        now(),
        row.project_id,
        this.owner,
        row.owner_id,
        row.key,
      ),
    );
  }
  private async pass() {
    if (!this.adapter.rent || !this.adapter.inspectRental || !this.adapter.releaseRental) return;
    const rows = await this.state.read((sql) =>
      sql.all<Row>(
        "SELECT * FROM work_compute_machines WHERE owner_kind=? AND state<>'stopped' AND NOT (state='failed' AND sandbox_id IS NULL) ORDER BY updated_at LIMIT 20",
        this.owner,
      ),
    );
    for (const row of rows) {
      try {
        const active = await this.state.transaction((tx) =>
          this.policy.active(row.project_id, row.owner_id, tx),
        );
        const stop = row.stop_requested || !active || row.state === 'failed';
        if (!row.sandbox_id) {
          if (stop && !row.attempted_at) {
            await this.state.transaction((tx) =>
              tx.run(
                "UPDATE work_compute_machines SET state='stopped',updated_at=? WHERE owner_kind=? AND owner_id=? AND key=? AND attempted_at IS NULL",
                now(),
                this.owner,
                row.owner_id,
                row.key,
              ),
            );
            continue;
          }
          const key = digest([row.project_id, this.owner, row.owner_id, row.key]);
          // A previous timed-out request may still commit. Reconcile it without needing the
          // offer to remain listed, and never create a new rental solely to stop it.
          const recovered =
            row.attempted_at && this.adapter.findRental
              ? await this.adapter.findRental(row.project_id, key)
              : null;
          if (stop && !recovered) {
            // Absence in one snapshot is not proof that an uncertain request failed. Keep
            // tracking; a later pass releases it if the provider finally publishes its ID.
            await this.state.transaction((tx) =>
              tx.run(
                'UPDATE work_compute_machines SET stop_requested=TRUE,updated_at=? WHERE owner_kind=? AND owner_id=? AND key=?',
                now(),
                this.owner,
                row.owner_id,
                row.key,
              ),
            );
            continue;
          }
          // Persist uncertainty before network I/O; replay has the same provider key.
          await this.state.transaction((tx) =>
            tx.run(
              'UPDATE work_compute_machines SET attempted_at=COALESCE(attempted_at,?),updated_at=? WHERE owner_kind=? AND owner_id=? AND key=?',
              now(),
              now(),
              this.owner,
              row.owner_id,
              row.key,
            ),
          );
          const rental =
            recovered ??
            (await this.adapter.rent(row.project_id, { ...JSON.parse(row.input_json), key }));
          await this.save(row, rental);
          row.sandbox_id = rental.sandboxId;
        }
        const rental = stop
          ? await this.adapter.releaseRental(row.project_id, row.sandbox_id!)
          : await this.adapter.inspectRental(row.project_id, row.sandbox_id!);
        await this.save(row, rental);
      } catch (error) {
        // Never give up tracking an existing machine because a release/inspect failed.
        const rejected =
          !row.sandbox_id &&
          !row.attempted_at &&
          error instanceof MervError &&
          error.status >= 400 &&
          error.status < 500;
        await this.state.transaction((tx) =>
          tx.run(
            `UPDATE work_compute_machines SET state=CASE WHEN ?=1 THEN 'failed' ELSE state END,updated_at=?,receipt=? WHERE owner_kind=? AND owner_id=? AND key=?`,
            rejected ? 1 : 0,
            now(),
            JSON.stringify({
              reason: error instanceof MervError ? error.code : 'compute_unavailable',
            }),
            this.owner,
            row.owner_id,
            row.key,
          ),
        );
      }
    }
  }
}

export const rentalGuidance = (prefix: 'compute.' | 'task.compute_', reviewing: boolean) =>
  ` GPU rentals belong to this work item and survive worker handoffs. Check ${prefix}machines before renting; existing machines may hold useful files and installed packages. ${prefix}rent requests a time-limited rental under the project compute allowance; ${prefix}ssh accepts your locally generated Ed25519 public key and returns a five-minute SSH certificate, gateway host key, and connection details. Keep the private key local; verify the gateway host key. ` +
  (reviewing
    ? 'Compute is optional for review. If you use it, limit it to brief verification; do not launch training, full evaluations, or other long-running work. Do not modify the submitted evidence.'
    : 'You may leave a machine ready for the next worker or reviewer when useful: save paths and progress in your handoff, and choose a lease long enough to cover that handoff. Inspect code and run small feasibility checks during planning; full experiment execution still requires independent design approval. Release unused machines promptly. Retain important files as artifacts; files left only on a GPU disappear on release or lease expiry.') +
  ' Rentals are released when this task or experiment ends, or when their provider lease expires.';

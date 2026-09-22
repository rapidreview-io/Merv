import {
  canonical,
  check,
  codeLocalBindInputSchema,
  digest,
  inTransaction,
  mapAsync,
  MervError,
  newId,
  now,
  recorded,
  type Caller,
  type CodeBasePin,
  type CodeBaseStatus,
  type CodeUnitPublication,
  type GitHubPullRequest,
  type CodeLocalBindInput,
  type CodeProjectBinding,
  type CodeProjectStatus,
  type CodeStoreWarning,
  type CodeUnit,
  type CodeUnitAcceptance,
  type CodeUnitAcceptInput,
  type Scope,
  type Sql,
  type State,
  type StoredEvent,
  type Transaction,
  type WorkflowProvidedBlockerInput,
  type WorkflowProviderDependency,
  type WorkflowProviderRelations,
  type Workflows,
} from '@merv/contracts';
import { migratePendingMerges, pinMerge, pendingMerge } from './pending-merge.js';
import { postgresMigrations } from './units.postgres.js';
import { parseCodeInput } from './input.js';
import type { CodeCapture, CodeCaptureRef, CodeCaptures, CodeUnits } from './types.js';
import type { CodeWriterService } from './writers.js';
import type { CodeBaseRecord } from '@merv/contracts';
import { INHERITED_QUARANTINE, type CodeBaseService } from './bases.js';
import { resolutionProvenance } from './provenance.js';
import type { CodeUnitPublicationSeal } from './publications.js';
import { baseKey } from './base-plan.js';
import { checkBriefSections, checkResolutionCheck } from './base-check.js';
import { acceptedRef, workBranch } from './store/refs.js';

interface ProjectRow {
  project_id: string;
  repository_id: string;
  binding_json: string;
  main_json: string;
  store_json: string | null;
}
interface UnitRow {
  project_id: string;
  unit_id: string;
  workflow: string;
  version: number;
  declared_at: string;
  base_json: string | null;
  base_hash: string | null;
  base_lease_id: string | null;
  based_at: string | null;
  acceptance_json: string | null;
  acceptance_hash: string | null;
  accepted_at: string | null;
  quarantine_base_key: string | null;
  publishes_at: string | null;
  publication_id: string | null;
}
/** The hashed body of an acceptance. It carries no time, so a repeated acceptance is byte-equal. */
interface AcceptanceBody {
  formatVersion: 1;
  unitId: string;
  workflow: string;
  version: number;
  terminalRevision: number;
  submissionRef: string;
  reviewRef: string;
  acceptedBy: string;
  code: {
    ref: CodeCaptureRef;
    commit: string;
    tree: string | null;
    repositoryId: string;
    reviewAttached: boolean;
  } | null;
  storage: CodeUnitAcceptance['storage'];
  /** Only with `code` storage: the operation that made the commit durable in Code's repository. */
  receipt?: string;
}
/** The hashed body of a base pin. Lease and time stay outside it, so racing derivations agree. */
interface BaseBody {
  formatVersion: 1;
  kind: CodeBasePin['kind'];
  reference: string;
  repositoryId: string;
  /** The declared dependency ids the pin was derived from; they may not change afterwards. */
  dependencies: string[];
  sources: { unitId: string; acceptanceHash: string; terminalRevision: number }[];
  main: { oid: string; operationId: string } | null;
}
/** The publication facts of one unit, read by the id its acceptance sealed. */
interface PublicationRow {
  pull_json: string | null;
  merge_json: string | null;
  incident_json: string | null;
  stale: number;
  verified: number;
}
/**
 * What an open publication means for the unit that is waiting on it. A done unit carrying one
 * of these is not failing and is not work anybody can take: it is a fact about where its
 * accepted code stands, and every one of them names who ends the wait.
 */
function publicationBlockers(publication: CodeUnitPublication): WorkflowProvidedBlockerInput[] {
  if (publication.state === 'published') return [];
  const pull = publication.pull;
  const named = pull ? ` (pull request #${pull.number})` : '';
  const related = pull ? [{ kind: 'pull-request', id: pull.url, label: `#${pull.number}` }] : [];
  const said = {
    pending: {
      code: 'code_publication_pending',
      message: 'waiting on publication: a signed-in operator merges the pull request',
      next: pull
        ? `A signed-in project operator merges pull request #${pull.number} with code.publication.merge; nothing here is owed by an agent.`
        : 'Nothing: the publication journal opens the pull request, and a signed-in operator merges it.',
    },
    stale: {
      code: 'code_publication_stale',
      message: `main moved; a successor task integrates it${named}`,
      next: 'Create the successor work that takes this accepted commit and the newer main; this unit stays as it is.',
    },
    disabled: {
      code: 'code_publication_disabled',
      message: `publication is not enabled for this project${named}`,
      next: 'An administrator repairs enforcement, records a passing canary for this App and its rules, and clears any disablement with code.publication.control.',
    },
    closed: {
      code: 'code_publication_closed',
      message: `the pull request was closed without merging${named}`,
      next: pull
        ? `A signed-in project operator reopens pull request #${pull.number} on GitHub, or creates the successor work that carries this accepted commit to main.`
        : 'Create the successor work that carries this accepted commit to main.',
    },
    unsealed: {
      code: 'code_publish_unverifiable',
      message:
        'this unit was declared to publish to main, but its acceptance could not open a publication',
      next: 'An administrator reads code.status for this unit and creates the successor work that carries its accepted code to main; this unit stays as it is.',
    },
    incident: {
      code: 'code_publication_incident',
      message: `a publication incident is retained for this unit${named}`,
      next: 'An administrator investigates the observed merge commit in code.status.publication; a retry never clears it.',
    },
  }[publication.state];
  return [{ key: 'publication', status: 409, related, ...said }];
}
/**
 * Whether an acceptance made under `repositoryId` belongs to this project: the repository it is
 * bound to now, or any it was bound to before a verified rebind. A pre-rebind acceptance that
 * passes here goes on to the storage gate below, which a project-keyed import receipt satisfies
 * — safe only because a rebind proves Code's own repository holds every commit the project
 * retained as authoritative before it writes the new binding. Derivation and consolidation's
 * candidate freeze ask the same question, so they ask it here: an acceptance a base may build
 * on is one a consolidation may carry to main.
 */
export function bindsRepository(
  bound: { repository_id: string; binding_json: string },
  repositoryId: string,
): boolean {
  if (bound.repository_id === repositoryId) return true;
  const binding = JSON.parse(bound.binding_json) as { previous?: { repositoryId: string }[] };
  return !!binding.previous?.some((entry) => entry.repositoryId === repositoryId);
}
/** What a derivation finds; only `ready` carries a body a lease may pin. */
type Derived =
  | { status: 'waiting' }
  /** `merge` names the accepted commits a base has still to be made from. */
  | { status: 'blocked'; blockers: WorkflowProvidedBlockerInput[]; merge?: string[] }
  | { status: 'ready'; body: BaseBody; merge?: string[] };
const PROVIDER = 'code';
const EXPLICIT_BASE =
  'Recreate this work with baseTaskId naming one accepted Git task, which is the explicit form of a base';
const unitColumns =
  'project_id,unit_id,workflow,version,declared_at,base_json,base_hash,base_lease_id,based_at,acceptance_json,acceptance_hash,accepted_at,quarantine_base_key,publishes_at,publication_id';
const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** The workspace driver whose units live in Code's own repository. */
export const CODE_DRIVER = 'code.v2';
const IMPORT = 'An administrator imports it with `merv code-import`';

/**
 * Units of work as Code knows them: one immutable base pin and at most one immutable
 * acceptance each, beside the project's local binding. Owners reach this only inside their
 * own transactions; they hand over capture references and never see what those resolve to.
 */
export class CodeUnitService implements CodeUnits {
  private closed = false;
  /** Set once the project repositories exist; without it several commits are never merged. */
  bases?: CodeBaseService;
  /** The journal that carries an accepted unit to main; without it nothing publishes. */
  publications?: {
    openUnit(caller: Caller, input: CodeUnitPublicationSeal, tx: Transaction): Promise<void>;
  };
  reviews?: import('@merv/contracts').Reviews;
  resolutionTasks?: import('@merv/contracts').ServiceTaskCreator;
  constructor(
    private readonly state: State,
    private readonly scope: Scope,
    private readonly workflows: Workflows,
    private readonly captures: CodeCaptures,
    private readonly writers: CodeWriterService,
    private readonly sessions: Pick<import('@merv/sessions/types').Sessions, 'contributors'>,
  ) {}

  reviewProvenance(projectId: string, taskId: string, tx: Transaction) {
    check(
      !this.closed && this.bases,
      'code_provenance_unverifiable',
      'Base provenance is unavailable',
      503,
    );
    return resolutionProvenance(tx, this.bases, this.sessions, projectId, taskId);
  }

  /** Complete storage migrations before publishing this service. */
  async initialize(): Promise<void> {
    await this.state.migrate('code_units', [
      {
        version: 1,
        postgres: postgresMigrations[1],
        sql: `
CREATE TABLE code_projects (
  project_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('local')),
  repository_id TEXT NOT NULL,
  binding_json TEXT NOT NULL,
  main_json TEXT NOT NULL,
  limits_json TEXT NOT NULL,
  warnings_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  store_json TEXT
);
CREATE TABLE code_units (
  project_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  workflow TEXT NOT NULL,
  version INTEGER NOT NULL,
  declared_at TEXT NOT NULL,
  base_json TEXT,
  base_hash TEXT,
  base_lease_id TEXT,
  based_at TEXT,
  acceptance_json TEXT,
  acceptance_hash TEXT,
  accepted_at TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  writer_state TEXT NOT NULL DEFAULT 'idle' CHECK (writer_state IN ('idle','reserved','active','closing','closed','recovery_required')),
  writer_session_id TEXT,
  writer_lease_id TEXT,
  writer_changed_at TEXT,
  head_oid TEXT,
  head_operation_id TEXT,
  mirrored_oid TEXT,
  mirrored_at TEXT,
  quarantine_operation_id TEXT,
  quarantine_base_key TEXT,
  PRIMARY KEY (project_id,unit_id),
  CHECK ((base_json IS NULL)=(base_hash IS NULL) AND (base_json IS NULL)=(base_lease_id IS NULL) AND (base_json IS NULL)=(based_at IS NULL)),
  CHECK ((acceptance_json IS NULL)=(acceptance_hash IS NULL) AND (acceptance_json IS NULL)=(accepted_at IS NULL))
);
CREATE INDEX code_units_declared ON code_units(project_id,declared_at,unit_id);
CREATE TABLE code_edges (
  project_id TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  relation TEXT NOT NULL,
  target_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id,source_ref,relation,target_ref)
);
CREATE INDEX code_edges_target ON code_edges(project_id,target_ref,relation);
CREATE TABLE code_operations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  principal_scope TEXT NOT NULL,
  request_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('prepared','completed','failed')),
  result_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  unit_id TEXT,
  generation INTEGER,
  phase TEXT,
  progress_json TEXT,
  detail_json TEXT,
  claim_id TEXT,
  claim_until TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at TEXT,
  updated_at TEXT,
  UNIQUE (project_id,principal_scope,request_id),
  CHECK (
    (status='prepared' AND result_json IS NULL AND error IS NULL AND completed_at IS NULL) OR
    (status='completed' AND result_json IS NOT NULL AND error IS NULL AND completed_at IS NOT NULL) OR
    (status='failed' AND result_json IS NULL AND error IS NOT NULL AND completed_at IS NOT NULL)
  )
);
CREATE TRIGGER code_projects_binding BEFORE UPDATE ON code_projects
  WHEN NEW.project_id IS NOT OLD.project_id OR NEW.mode IS NOT OLD.mode OR NEW.repository_id IS NOT OLD.repository_id OR NEW.binding_json IS NOT OLD.binding_json
  BEGIN SELECT RAISE(ABORT,'Code repository binding is immutable'); END;
CREATE TRIGGER code_projects_no_delete BEFORE DELETE ON code_projects
  BEGIN SELECT RAISE(ABORT,'Code repository bindings are retained'); END;
CREATE TRIGGER code_units_identity BEFORE UPDATE ON code_units
  WHEN NEW.project_id IS NOT OLD.project_id OR NEW.unit_id IS NOT OLD.unit_id OR NEW.workflow IS NOT OLD.workflow OR NEW.version IS NOT OLD.version OR NEW.declared_at IS NOT OLD.declared_at
  BEGIN SELECT RAISE(ABORT,'Code unit identity is immutable'); END;
CREATE TRIGGER code_units_base BEFORE UPDATE ON code_units
  WHEN OLD.base_json IS NOT NULL AND (NEW.base_json IS NOT OLD.base_json OR NEW.base_hash IS NOT OLD.base_hash OR NEW.base_lease_id IS NOT OLD.base_lease_id OR NEW.based_at IS NOT OLD.based_at)
  BEGIN SELECT RAISE(ABORT,'The base pin of a unit is immutable'); END;
CREATE TRIGGER code_units_acceptance BEFORE UPDATE ON code_units
  WHEN OLD.acceptance_json IS NOT NULL AND (NEW.acceptance_json IS NOT OLD.acceptance_json OR NEW.acceptance_hash IS NOT OLD.acceptance_hash OR NEW.accepted_at IS NOT OLD.accepted_at)
  BEGIN SELECT RAISE(ABORT,'The acceptance of a unit is immutable'); END;
CREATE TRIGGER code_units_no_delete BEFORE DELETE ON code_units
  BEGIN SELECT RAISE(ABORT,'Code units are retained'); END;
CREATE TRIGGER code_edges_no_update BEFORE UPDATE ON code_edges
  BEGIN SELECT RAISE(ABORT,'Code lineage is immutable'); END;
CREATE TRIGGER code_edges_no_delete BEFORE DELETE ON code_edges
  BEGIN SELECT RAISE(ABORT,'Code lineage is retained'); END;
CREATE TRIGGER code_operations_identity BEFORE UPDATE ON code_operations
  WHEN NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id OR NEW.principal_scope IS NOT OLD.principal_scope OR NEW.request_id IS NOT OLD.request_id OR NEW.kind IS NOT OLD.kind OR NEW.input_hash IS NOT OLD.input_hash OR NEW.payload_json IS NOT OLD.payload_json OR NEW.created_at IS NOT OLD.created_at
  BEGIN SELECT RAISE(ABORT,'Code operation identity is immutable'); END;
CREATE TRIGGER code_operations_result BEFORE UPDATE ON code_operations
  WHEN OLD.status <> 'prepared'
  BEGIN SELECT RAISE(ABORT,'A finished Code operation is immutable'); END;
CREATE TRIGGER code_operations_no_delete BEFORE DELETE ON code_operations
  BEGIN SELECT RAISE(ABORT,'Code operations are retained'); END;
CREATE TRIGGER code_projects_store BEFORE UPDATE ON code_projects
  WHEN OLD.store_json IS NOT NULL AND NEW.store_json IS NOT OLD.store_json
  BEGIN SELECT RAISE(ABORT,'The repository of a project is recorded once and is immutable'); END;
CREATE UNIQUE INDEX code_operations_unit_open ON code_operations(project_id,unit_id,kind) WHERE status='prepared' AND unit_id IS NOT NULL;
CREATE INDEX code_operations_due ON code_operations(status,kind,next_at);
CREATE TRIGGER code_units_generation BEFORE UPDATE ON code_units
  WHEN NEW.generation < OLD.generation OR NEW.generation > OLD.generation + 1
  BEGIN SELECT RAISE(ABORT,'A writer generation only advances by one'); END;
CREATE TRIGGER code_units_generation_open BEFORE UPDATE ON code_units
  WHEN NEW.generation IS NOT OLD.generation AND EXISTS (
    SELECT 1 FROM code_operations
    WHERE project_id=OLD.project_id AND unit_id=OLD.unit_id AND kind='upload' AND status='prepared' AND phase IN ('admitting','objects_durable','refs_applied')
  )
  BEGIN SELECT RAISE(ABORT,'A writer generation cannot change while an admitted upload is unresolved'); END;
CREATE TABLE code_unit_frontiers(project_id TEXT NOT NULL,unit_id TEXT NOT NULL,inputs_json TEXT NOT NULL,PRIMARY KEY(project_id,unit_id));
CREATE TRIGGER code_unit_frontiers_no_update BEFORE UPDATE ON code_unit_frontiers BEGIN SELECT RAISE(ABORT,'Unit frontier is immutable'); END;
CREATE TRIGGER code_unit_frontiers_no_delete BEFORE DELETE ON code_unit_frontiers BEGIN SELECT RAISE(ABORT,'Unit frontier is retained'); END;
CREATE TABLE code_unit_inputs(project_id TEXT NOT NULL,unit_id TEXT NOT NULL,reference TEXT NOT NULL,PRIMARY KEY(project_id,unit_id));
CREATE TRIGGER code_unit_inputs_no_update BEFORE UPDATE ON code_unit_inputs BEGIN SELECT RAISE(ABORT,'Unit inputs are immutable'); END;
CREATE TRIGGER code_unit_inputs_no_delete BEFORE DELETE ON code_unit_inputs BEGIN SELECT RAISE(ABORT,'Unit inputs are retained'); END;
CREATE INDEX code_units_accepted_commit ON code_units(project_id,json_extract(acceptance_json,'$.code.commit')) WHERE acceptance_json IS NOT NULL;
CREATE TRIGGER code_units_base_quarantine BEFORE UPDATE ON code_units
WHEN OLD.quarantine_base_key IS NOT NULL AND NEW.quarantine_base_key IS NOT OLD.quarantine_base_key
BEGIN SELECT RAISE(ABORT,'Base quarantine is retained'); END;
`,
      },
      {
        version: 2,
        postgres: postgresMigrations[2],
        // A quarantine is still never pointed at another base behind the record's back, but a
        // released one has to be able to go: without this no operator route could ever undo a
        // quarantine given by mistake, and every unit it reached would stay unusable forever.
        sql: `
DROP TRIGGER code_units_base_quarantine;
CREATE TRIGGER code_units_base_quarantine BEFORE UPDATE ON code_units
WHEN OLD.quarantine_base_key IS NOT NULL AND NEW.quarantine_base_key IS NOT OLD.quarantine_base_key AND NEW.quarantine_base_key IS NOT NULL
BEGIN SELECT RAISE(ABORT,'Base quarantine is retained'); END;
`,
      },
      {
        // Publishing to main is declared once on the unit and, once sealed, its publication is
        // immutable. Version 2 shipped on 2026-09-22 before these columns existed.
        version: 3,
        postgres: postgresMigrations[3],
        sql: `
ALTER TABLE code_units ADD COLUMN publishes_at TEXT;
ALTER TABLE code_units ADD COLUMN publication_id TEXT;
CREATE TRIGGER code_units_publish BEFORE UPDATE ON code_units
WHEN (OLD.publishes_at IS NOT NULL AND NEW.publishes_at IS NOT OLD.publishes_at) OR (OLD.publication_id IS NOT NULL AND NEW.publication_id IS NOT OLD.publication_id)
BEGIN SELECT RAISE(ABORT,'Publishing to main is declared once and its publication is immutable'); END;
`,
      },
      {
        // The binding is still not something a writer may edit; it is now something exactly one
        // operation may. Naming a prepared rebind would not be enough on its own: it would let
        // any writer put any value in repository_id, and would leave binding_json rewritable in
        // that window — including rewriting `previous`, the list that keeps every pre-rebind
        // acceptance valid at derive(), and a forged entry there is how an acceptance stamped
        // with a foreign repository would pass that gate. So the value written must be the one
        // the operation was journalled with (payload_json is immutable under
        // code_operations_identity), and the new lineage must be the old one exactly, with one
        // entry appended that names the repository being left. A subquery in a WHEN clause is
        // already how code_units_generation_open reads code_operations, in version 1.
        version: 4,
        postgres: postgresMigrations[4],
        sql: `
DROP TRIGGER code_projects_binding;
CREATE TRIGGER code_projects_binding BEFORE UPDATE ON code_projects
  WHEN NEW.project_id IS NOT OLD.project_id OR NEW.mode IS NOT OLD.mode
    OR ((NEW.repository_id IS NOT OLD.repository_id OR NEW.binding_json IS NOT OLD.binding_json) AND NOT EXISTS (
      SELECT 1 FROM code_operations
      WHERE id=json_extract(NEW.binding_json,'$.operationId') AND project_id=OLD.project_id
        AND kind='rebind' AND status='prepared'
        AND json_extract(payload_json,'$.repositoryId')=NEW.repository_id
    ))
    OR (NEW.repository_id IS NOT OLD.repository_id AND (
      json_extract(NEW.binding_json,'$.previous[#-1].repositoryId') IS NOT OLD.repository_id
      OR json_remove(json_extract(NEW.binding_json,'$.previous'),'$[#-1]') IS NOT COALESCE(json_extract(OLD.binding_json,'$.previous'),json_array())
    ))
  BEGIN SELECT RAISE(ABORT,'Code repository binding is immutable outside its own rebind operation'); END;
`,
      },
    ]);
    await migratePendingMerges(this.state);
  }

  async declareUnit(
    caller: Caller,
    unitId: string,
    tx: Transaction,
    baseReference?: string,
    derivationInputs?: string[],
  ): Promise<CodeUnit> {
    this.assertOpen();
    this.state.assertTransaction(tx);
    caller = structuredClone(caller);
    derivationInputs = derivationInputs && [...derivationInputs];
    await this.scope.require(caller, 'read', tx);
    const relations = await this.workflows.dependencyRelations(caller.projectId, unitId, tx);
    check(relations, 'code_unit_not_found', 'No such unit of work in this project', 404);
    const row = await this.row(tx, caller.projectId, unitId);
    if (!row)
      await tx.run(
        'INSERT INTO code_units (project_id,unit_id,workflow,version,declared_at) VALUES (?,?,?,?,?)',
        caller.projectId,
        unitId,
        relations.instance.workflow,
        relations.instance.version,
        now(),
      );
    if (baseReference !== undefined) {
      check(
        !(await tx.get(
          'SELECT 1 FROM code_unit_frontiers WHERE project_id=? AND unit_id=?',
          caller.projectId,
          unitId,
        )),
        'code_base_conflict',
        'A declared frontier cannot be replaced by a fixed input',
        409,
      );
      check(
        !caller.session && oid.test(baseReference),
        'invalid_base',
        'Only an owner can declare a fixed unit input',
        403,
      );
      const existing = await tx.get<{ reference: string }>(
        'SELECT reference FROM code_unit_inputs WHERE project_id=? AND unit_id=?',
        caller.projectId,
        unitId,
      );
      check(
        !existing || existing.reference === baseReference,
        'code_base_conflict',
        'This unit already has another fixed input',
        409,
      );
      if (!existing)
        await tx.run(
          'INSERT INTO code_unit_inputs(project_id,unit_id,reference) VALUES (?,?,?)',
          caller.projectId,
          unitId,
          baseReference,
        );
    }
    if (derivationInputs !== undefined) {
      check(
        baseReference === undefined,
        'invalid_base',
        'A unit has either fixed or derived inputs',
      );
      const inputs = [...new Set(derivationInputs)].sort();
      const existing = await tx.get<{ inputs_json: string }>(
        'SELECT inputs_json FROM code_unit_frontiers WHERE project_id=? AND unit_id=?',
        caller.projectId,
        unitId,
      );
      check(
        existing ? existing.inputs_json === canonical(inputs) : !row,
        'code_base_conflict',
        'The declared unit frontier cannot change',
        409,
      );
      for (const id of inputs) {
        const input = await this.relations(tx, caller.projectId, id);
        check(
          id !== unitId && input.instance.settled,
          'invalid_base',
          'Derivation inputs must be successful units of this project',
          409,
        );
      }
      if (!existing)
        await tx.run(
          'INSERT INTO code_unit_frontiers(project_id,unit_id,inputs_json) VALUES (?,?,?)',
          caller.projectId,
          unitId,
          canonical(inputs),
        );
    }
    // A unit that cannot start is shown from the moment it exists, not from its first poll.
    await this.reconcileUnit(tx, caller.projectId, unitId);
    return await this.record(tx, (await this.row(tx, caller.projectId, unitId))!);
  }

  /** A base's disposition also gates its resolution task, without changing Tasks' history. */
  private async resolutionBlocker(
    tx: Transaction,
    projectId: string,
    unitId: string,
  ): Promise<WorkflowProvidedBlockerInput | null> {
    const base = await this.bases?.forTask(tx, projectId, unitId);
    if (!base || (!base.quarantined && !['suspended', 'cancelled'].includes(base.state)))
      return null;
    return {
      key: 'resolution-base',
      code: base.quarantined ? 'code_quarantined' : 'code_base_blocked',
      status: 409,
      message: `Resolution base ${base.key} is ${base.quarantined ? 'quarantined' : base.state}: ${base.operatorReason ?? 'operator control'}.`,
      next:
        base.state === 'suspended' && !base.quarantined
          ? 'An administrator uses code.base.resume before this resolution can continue.'
          : 'The base is retained but unusable; an administrator creates corrective work and replans the waiters.',
      related: [],
    };
  }

  /**
   * What a lease would find now. It never writes: lease admission, assignment checks and the
   * dispatch candidate scan all ask, and any of them may run for a caller who holds no lease.
   */
  async baseStatus(caller: Caller, unitId: string, tx: Transaction): Promise<CodeBaseStatus> {
    this.assertOpen();
    this.state.assertTransaction(tx);
    caller = structuredClone(caller);
    await this.scope.require(caller, 'read', tx);
    const disposition = await this.resolutionBlocker(tx, caller.projectId, unitId);
    if (disposition) return { status: 'blocked', blockers: [disposition] };
    const row = await this.row(tx, caller.projectId, unitId);
    if (row?.quarantine_base_key)
      return { status: 'blocked', blockers: [this.quarantineBlocker(row.quarantine_base_key)] };
    if (row?.base_json) return { status: 'pinned', pin: this.pin(row)! };
    return this.baseState(await this.derive(tx, caller.projectId, unitId));
  }

  /** A stale publication keeps the original pin and adds one frozen merge round on its branch. */
  async pinPublication(caller: Caller, unitId: string, tx: Transaction) {
    const row = await this.row(tx, caller.projectId, unitId);
    if (row?.workflow !== 'consolidation' || row.version !== 5) return;
    const stale = await tx.get<{ id: string; revision: number }>(
      'SELECT s.id,s.revision FROM code_proposals s JOIN code_publications p ON p.proposal_id=s.id WHERE s.project_id=? AND s.instance_id=? AND p.stale=1 ORDER BY s.revision DESC LIMIT 1',
      caller.projectId,
      unitId,
    );
    if (!stale) return;
    const plan = digest({ publication: stale.id });
    const existing = await pendingMerge(tx, caller.projectId, unitId);
    if (existing?.plan === plan) return;
    const writer = await this.writers.row(tx, caller.projectId, unitId);
    const project = await this.project(tx, caller.projectId);
    check(
      writer && project && row.base_json,
      'code_base_pending',
      'The publication round needs a retained base and writer',
      409,
    );
    await pinMerge(
      tx,
      caller.projectId,
      unitId,
      plan,
      writer.head_oid ?? JSON.parse(row.base_json).reference,
      project.main.oid,
      stale.revision,
    );
  }

  /** The pin alone, for an owner's references(): that hook runs on every read and must not derive. */
  async basePin(caller: Caller, unitId: string, tx: Transaction): Promise<CodeBasePin | null> {
    this.assertOpen();
    this.state.assertTransaction(tx);
    caller = structuredClone(caller);
    await this.scope.require(caller, 'read', tx);
    const row = await this.row(tx, caller.projectId, unitId);
    return row ? this.pin(row) : null;
  }

  /**
   * Called only from the owner's lease acquisition, so the base is fixed in the transaction
   * that creates the lease and rolls back with a refused offer. The derivation is repeated
   * here rather than trusted from admission: a dependency accepted in between changes it. The
   * hashed body leaves out lease and time, so two racing offers derive byte-equal pins and
   * the one that lands second simply reads the first.
   */
  async pinBase(
    caller: Caller,
    { unitId, leaseId }: { unitId: string; leaseId: string },
    tx: Transaction,
  ): Promise<CodeBasePin> {
    this.assertOpen();
    this.state.assertTransaction(tx);
    caller = structuredClone(caller);
    await this.scope.require(caller, 'read', tx);
    const disposition = await this.resolutionBlocker(tx, caller.projectId, unitId);
    if (disposition) throw new MervError(disposition.code, disposition.message, 409);
    const relations = await this.relations(tx, caller.projectId, unitId);
    const declared = relations.dependencies
      .filter((item) => item.kind !== 'system')
      .map((item) => item.id)
      .sort();
    const existing = await this.row(tx, caller.projectId, unitId);
    check(
      !existing?.quarantine_base_key,
      'code_quarantined',
      'This unit retains a quarantined base; corrective work must use a new unit',
      409,
    );
    if (existing?.base_json) {
      check(
        canonical((JSON.parse(existing.base_json) as BaseBody).dependencies) ===
          canonical(declared),
        'code_dependencies_changed',
        'The dependencies of this unit changed after its base was pinned',
        409,
      );
      return this.pin(existing)!;
    }
    const derived = await this.derive(tx, caller.projectId, unitId);
    if (derived.status !== 'ready') {
      // A dependency that is not settled is refused by Workflows before any lease hook runs;
      // should that ever change, the refusal is still one a poll never counts as a failure.
      const first = derived.status === 'blocked' ? derived.blockers[0] : undefined;
      throw new MervError(
        first?.code ?? 'code_base_pending',
        first?.message ??
          'A base cannot be derived until every dependency of this unit has settled',
        409,
      );
    }
    const at = now();
    if (!existing)
      await tx.run(
        'INSERT INTO code_units (project_id,unit_id,workflow,version,declared_at) VALUES (?,?,?,?,?)',
        caller.projectId,
        unitId,
        relations.instance.workflow,
        relations.instance.version,
        at,
      );
    await tx.run(
      'UPDATE code_units SET base_json=?,base_hash=?,base_lease_id=?,based_at=? WHERE project_id=? AND unit_id=? AND base_json IS NULL',
      canonical(derived.body),
      digest(derived.body),
      leaseId,
      at,
      caller.projectId,
      unitId,
    );
    const stored = (await this.row(tx, caller.projectId, unitId))!;
    if (stored.base_lease_id === leaseId)
      for (const target of [
        ...derived.body.sources.map((item) => `acceptance:${item.unitId}@${item.acceptanceHash}`),
        ...(derived.body.main ? [`main:${derived.body.main.oid}`] : []),
      ])
        await tx.run(
          'INSERT INTO code_edges (project_id,source_ref,relation,target_ref,created_at) VALUES (?,?,?,?,?)',
          caller.projectId,
          `unit:${unitId}`,
          'based_on',
          target,
          at,
        );
    await this.workflows.replaceBlockers(
      { projectId: caller.projectId, instanceId: unitId, provider: PROVIDER, blockers: [] },
      tx,
    );
    return this.pin(stored)!;
  }

  /**
   * Called by the owner inside its successful review transaction, after the workflow moved.
   * It refuses only what the owner itself already required of the submission, so a review
   * that would have passed before acceptances existed still passes: whether the accepted code
   * can serve as a base is judged later, where a base is derived. A code-less acceptance
   * reads no capture and ignores whether Code is closing, because nothing about scratch work
   * may come to depend on Code being well.
   */
  async acceptUnit(
    caller: Caller,
    { ...input }: CodeUnitAcceptInput,
    tx: Transaction,
  ): Promise<CodeUnitAcceptance> {
    this.state.assertTransaction(tx);
    caller = structuredClone(caller);
    const relations = await this.workflows.dependencyRelations(caller.projectId, input.unitId, tx);
    check(
      relations &&
        (relations.instance.settled ||
          (relations.instance.workflow === 'consolidation' &&
            relations.instance.version === 5 &&
            relations.instance.state === 'awaiting_publication')) &&
        relations.instance.revision === input.terminalRevision,
      'code_acceptance_unverifiable',
      'Only a unit approved by its owner at the named revision can be accepted',
      409,
    );
    const disposition = await this.resolutionBlocker(tx, caller.projectId, input.unitId);
    if (disposition) throw new MervError(disposition.code, disposition.message, 409);
    const health = await this.row(tx, caller.projectId, input.unitId);
    check(
      !health?.quarantine_base_key,
      'code_quarantined',
      'This unit retains a quarantined base and cannot be accepted',
      409,
    );
    const code =
      input.codeRef === null
        ? null
        : await this.reviewedCode(caller, input.unitId, input.codeRef, input.reviewSessionId, tx);
    // A unit that ever had a writer generation lives in Code's repository, and only there.
    const writer = code ? await this.writers.row(tx, caller.projectId, input.unitId) : undefined;
    const kept = !!writer && Number(writer.generation) >= 1;
    let receipt: string | null = null;
    if (code && kept) {
      check(
        writer.quarantine_operation_id === null,
        'code_capture_quarantined',
        'A capture of this unit is quarantined; it cannot be accepted before an operator fences it',
        409,
      );
      receipt = await this.writers.receipt(tx, caller.projectId, input.unitId, code.commit);
      check(
        receipt,
        'code_acceptance_unverifiable',
        'Code never admitted the commit that was reviewed',
        409,
      );
    }
    const pending = await pendingMerge(tx, caller.projectId, input.unitId);
    if (pending) {
      check(
        (relations.instance.workflow === 'consolidation' && relations.instance.version === 5) ||
          (await this.resolutionReview(caller, tx, input)),
        'code_provenance_unverifiable',
        'Resolution acceptance requires a passing review with the current retained contributor provenance.',
        409,
      );
      const proof = receipt
        ? await tx.get<{ result_json: string }>(
            "SELECT result_json FROM code_operations WHERE id=? AND status='completed'",
            receipt,
          )
        : null;
      const verified = proof ? JSON.parse(proof.result_json).merge : null;
      check(
        code &&
          verified?.firstMerge &&
          verified.firstMerge === pending.firstMerge &&
          verified.plan === pending.plan &&
          verified.left === pending.firstParent &&
          verified.right === pending.secondParent,
        'code_resolution_merge_required',
        'Resolution acceptance requires the admitted two-parent merge of the frozen inputs and its corrective first-parent lineage.',
        409,
      );
    }
    const body: AcceptanceBody = {
      formatVersion: 1,
      unitId: input.unitId,
      workflow: relations.instance.workflow,
      version: relations.instance.version,
      terminalRevision: input.terminalRevision,
      submissionRef: input.submissionRef,
      reviewRef: input.reviewRef,
      acceptedBy: caller.actorId,
      code,
      storage: code === null ? 'none' : receipt ? 'code' : 'legacy-local',
      ...(receipt ? { receipt } : {}),
    };
    const encoded = canonical(body),
      hash = digest(body);
    if (body.workflow === 'consolidation' && body.version === 5) {
      const existing = await tx.get<{ acceptance_json: string; accepted_at: string }>(
        'SELECT acceptance_json,accepted_at FROM code_review_acceptances WHERE project_id=? AND unit_id=? AND review_id=?',
        caller.projectId,
        input.unitId,
        input.reviewRef,
      );
      check(
        !existing || existing.acceptance_json === encoded,
        'code_acceptance_conflict',
        'This review already accepted different code',
        409,
      );
      const at = existing?.accepted_at ?? now();
      if (!existing)
        await tx.run(
          'INSERT INTO code_review_acceptances(project_id,unit_id,review_id,acceptance_json,accepted_at) VALUES(?,?,?,?,?)',
          caller.projectId,
          input.unitId,
          input.reviewRef,
          encoded,
          at,
        );
      return {
        unitId: input.unitId,
        hash,
        acceptedAt: at,
        terminalRevision: input.terminalRevision,
        submissionRef: input.submissionRef,
        reviewRef: input.reviewRef,
        acceptedBy: caller.actorId,
        reference: code?.commit ?? null,
        reviewAttached: code?.reviewAttached ?? null,
        storage: body.storage,
        ...(receipt ? { receipt } : {}),
      };
    }
    const existing = await this.row(tx, caller.projectId, input.unitId);
    if (existing?.acceptance_hash) {
      check(
        existing.acceptance_hash === hash,
        'code_acceptance_conflict',
        'This unit already has a different acceptance',
        409,
      );
      this.bases?.soon(caller.projectId);
      return this.acceptance(existing)!;
    }
    const at = now();
    if (existing)
      await tx.run(
        'UPDATE code_units SET acceptance_json=?,acceptance_hash=?,accepted_at=? WHERE project_id=? AND unit_id=? AND acceptance_json IS NULL',
        encoded,
        hash,
        at,
        caller.projectId,
        input.unitId,
      );
    else
      await tx.run(
        'INSERT INTO code_units (project_id,unit_id,workflow,version,declared_at,acceptance_json,acceptance_hash,accepted_at) VALUES (?,?,?,?,?,?,?,?)',
        caller.projectId,
        input.unitId,
        body.workflow,
        body.version,
        at,
        encoded,
        hash,
        at,
      );
    await this.retainAcceptance(caller, input.unitId, body, at, tx);
    const stored = (await this.row(tx, caller.projectId, input.unitId))!;
    if (stored.publishes_at)
      await this.sealPublication(caller, relations.instance.name, stored, body, hash, tx);
    this.bases?.soon(caller.projectId);
    return this.acceptance(stored)!;
  }

  /**
   * Seals the publication of an accepted unit from its own facts and hands it to the journal
   * a reviewed consolidation already uses: an immutable snapshot, a pull request against main
   * carrying the approval status on exactly this head, and a signed-in operator's merge. The
   * unit is done either way; what is left is a wait on a human, not more work.
   *
   * A unit whose facts cannot open a publication is still accepted. Acceptance is the record
   * of work that was done and reviewed, and `publishes_at` is write-once, so refusing here
   * would refuse the review itself and leave work that could never be accepted by anyone.
   * The unit ends with a retained blocker naming the operator recovery instead.
   */
  private async sealPublication(
    caller: Caller,
    title: string,
    row: UnitRow,
    body: AcceptanceBody,
    acceptanceHash: string,
    tx: Transaction,
  ): Promise<void> {
    check(this.publications, 'code_unavailable', 'The publication journal is unavailable', 503);
    const base = row.base_json ? (JSON.parse(row.base_json) as BaseBody) : null;
    if (!(body.storage === 'code' && body.code?.tree) || !base?.main) {
      await this.reconcileUnit(tx, caller.projectId, row.unit_id);
      return;
    }
    const review = await tx.get<{ provenance_json: string | null }>(
      'SELECT provenance_json FROM reviews WHERE id=? AND project_id=?',
      body.reviewRef,
      caller.projectId,
    );
    const publicationId = newId('codeprop');
    await tx.run(
      'UPDATE code_units SET publication_id=? WHERE project_id=? AND unit_id=? AND publication_id IS NULL',
      publicationId,
      caller.projectId,
      row.unit_id,
    );
    await this.publications!.openUnit(
      caller,
      {
        publicationId,
        unitId: row.unit_id,
        title,
        reviewId: body.reviewRef,
        baseOid: base.reference,
        headOid: body.code.commit,
        treeOid: body.code.tree,
        approval: {
          source: 'unit',
          integrationBase: base.main.oid,
          certificateHash: review?.provenance_json
            ? (JSON.parse(review.provenance_json) as { hash: string }).hash
            : null,
          acceptanceHash,
        },
      },
      tx,
    );
    await this.reconcileUnit(tx, caller.projectId, row.unit_id);
  }

  /**
   * Records, once, that this unit's accepted code goes to main. It is a declaration and not a
   * power: the merge itself still waits for a signed-in operator, and the declaration is the
   * operator's or the directing agent's, never the worker's own. It has to come before the
   * first lease, because main joins the base at derivation and a pin is immutable.
   */
  async publishOnAcceptance(
    caller: Caller,
    { unitId }: { unitId: string },
    tx: Transaction,
  ): Promise<CodeUnit> {
    this.assertOpen();
    this.state.assertTransaction(tx);
    caller = structuredClone(caller);
    // A leased worker holds `write`, which is how acceptance reaches Code from a reviewer
    // session, so the refusal is named here rather than left to the scope: nothing a worker
    // does may put its own branch on the road to main.
    check(
      !caller.session,
      'session_forbidden',
      'A leased worker cannot declare that its own work publishes to main',
      403,
    );
    await this.scope.require(caller, 'write', tx);
    const row = await this.row(tx, caller.projectId, unitId);
    check(row, 'code_unit_not_found', 'This unit of work has not been declared to Code', 404);
    if (!row.publishes_at) {
      const project = await this.project(tx, caller.projectId);
      check(
        project?.durability === 'code' && project.main.stored,
        'code_publish_unhosted',
        'Publishing to main needs Code to host this project and hold the commit that is main',
        409,
      );
      check(
        !row.acceptance_json,
        'code_publish_accepted',
        'This unit is already accepted; a successor publishes what it left',
        409,
      );
      check(
        !row.base_json &&
          !(await tx.get(
            'SELECT 1 FROM code_unit_inputs WHERE project_id=? AND unit_id=?',
            caller.projectId,
            unitId,
          )),
        'code_publish_based',
        'This unit already stands on a base that does not include main; a successor publishes what it left',
        409,
      );
      // The reads above name what is wrong in the ordinary case; the write repeats them, so a
      // lease or an acceptance committing between them cannot leave a unit marked to publish
      // while standing on a base that never took main — a state nothing could recover from.
      const marked = await tx.run(
        'UPDATE code_units SET publishes_at=? WHERE project_id=? AND unit_id=? AND publishes_at IS NULL AND base_json IS NULL AND acceptance_json IS NULL',
        now(),
        caller.projectId,
        unitId,
      );
      check(
        marked.changes === 1,
        'code_publish_based',
        'This unit took a base or an acceptance while publication was being declared; a successor publishes what it left',
        409,
      );
      await this.reconcileUnit(tx, caller.projectId, unitId);
    }
    return await this.record(tx, (await this.row(tx, caller.projectId, unitId))!);
  }

  /**
   * Every accepted commit this repository holds, with the unit it belongs to and the main to
   * compare them against. Whether main already contains one is a question for Git, which is
   * asked once, outside every transaction, by whoever holds the repository.
   */
  async acceptedCandidates(
    caller: Caller,
    tx?: Transaction,
  ): Promise<{
    main: string;
    candidates: { unitId: string; commit: string; quarantined: boolean }[];
  }> {
    this.assertOpen();
    caller = structuredClone(caller);
    return await inTransaction(this.state, tx, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      const project = await this.project(tx, caller.projectId);
      check(project, 'code_project_unbound', 'This project has no Code binding', 409);
      const candidates: { unitId: string; commit: string; quarantined: boolean }[] = [];
      for (const row of await tx.all<UnitRow>(
        `SELECT ${unitColumns} FROM code_units WHERE project_id=? AND acceptance_json IS NOT NULL ORDER BY unit_id`,
        caller.projectId,
      )) {
        const accepted = JSON.parse(row.acceptance_json!) as AcceptanceBody;
        // A code-less success is nothing main could be missing. A legacy acceptance is code
        // this repository holds as soon as it was imported, which is the same question
        // derive() asks before it will build on one; only what was never imported is unasked.
        if (!accepted.code) continue;
        if (
          accepted.storage !== 'code' &&
          !(await tx.get(
            "SELECT id FROM code_operations WHERE project_id=? AND kind='import' AND status='completed' AND result_json LIKE ? LIMIT 1",
            caller.projectId,
            `%"head":"${accepted.code.commit}"%`,
          ))
        )
          continue;
        candidates.push({
          unitId: row.unit_id,
          commit: accepted.code.commit,
          quarantined: !!row.quarantine_base_key,
        });
      }
      return { main: project.main.oid, candidates };
    });
  }

  private async reviewedCode(
    caller: Caller,
    unitId: string,
    ref: CodeCaptureRef,
    reviewSessionId: string | null,
    tx: Transaction,
  ): Promise<NonNullable<AcceptanceBody['code']>> {
    this.assertOpen();
    const capture = await this.captures.capture(caller, ref, tx);
    const workspace = capture.workspace;
    check(
      capture.status === 'ready' &&
        workspace &&
        capture.provenance.projectId === caller.projectId &&
        capture.provenance.instanceId === unitId &&
        !capture.provenance.readOnly &&
        oid.test(workspace.headOid),
      'code_acceptance_unverifiable',
      'The accepted code is not a ready capture of this unit’s own writable session',
      409,
    );
    let review: CodeCapture | null = null;
    if (reviewSessionId !== null)
      try {
        review = await this.captures.capture(
          caller,
          { kind: 'session-final', sessionId: reviewSessionId },
          tx,
        );
      } catch (error) {
        // A reviewer without a readable checkout is recorded as not attached, which is true.
        if (!(error instanceof MervError) || error.status >= 500) throw error;
      }
    return {
      ref,
      commit: workspace.headOid,
      tree: workspace.treeOid ?? null,
      repositoryId: workspace.repositoryId,
      reviewAttached: review?.attachedBaseOid === workspace.headOid,
    };
  }

  /**
   * Main is consolidated research, so only a signed-in human administrator names it, and
   * moving it is a compare-and-set against the main that human last read: a replayed or
   * racing call cannot move it backwards. A pin already taken keeps the commit it copied.
   * `stored` is what Code's own repository said of that commit before this transaction began,
   * so that nothing in here, or in an owner's create transaction later, has to ask Git.
   */
  async bindLocal(
    caller: Caller,
    value: CodeLocalBindInput,
    stored = false,
  ): Promise<CodeProjectBinding> {
    this.assertOpen();
    caller = structuredClone(caller);
    const input = parseCodeInput(codeLocalBindInputSchema, value);
    return await this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'admin', tx);
      check(
        caller.human && !caller.session && !caller.key,
        'code_human_required',
        'A signed-in project administrator binds the repository and names its main',
        403,
      );
      const principal = `actor:${caller.actorId}`;
      const { requestId, ...payload } = input;
      const inputHash = digest(payload);
      const previous = await tx.get<{ input_hash: string; result_json: string }>(
        'SELECT input_hash,result_json FROM code_operations WHERE project_id=? AND principal_scope=? AND request_id=?',
        caller.projectId,
        principal,
        requestId,
      );
      if (previous) {
        check(
          previous.input_hash === inputHash,
          'request_conflict',
          'This request id was used with different input',
          409,
        );
        // Every bind journalled before the lineage existed stored a result without `previous`,
        // and the contract now says the field is always there: the journal stays byte-identical
        // and the answer is normalised on the way out.
        const replayed = JSON.parse(previous.result_json) as CodeProjectBinding;
        return { ...replayed, previous: replayed.previous ?? [] };
      }
      const operationId = newId('cop'),
        at = now();
      const main = canonical({
        oid: input.mainOid,
        admittedBy: caller.actorId,
        admittedAt: at,
        operationId,
        ...(stored ? { stored: true } : {}),
      });
      const bound = await this.project(tx, caller.projectId);
      if (!bound) {
        check(
          input.expectedMainOid === undefined,
          'code_main_changed',
          'This project has no main yet; bind it without expectedMainOid',
          409,
        );
        await tx.run(
          'INSERT INTO code_projects (project_id,mode,repository_id,binding_json,main_json,limits_json,warnings_json,updated_at) VALUES (?,?,?,?,?,?,?,?)',
          caller.projectId,
          'local',
          input.repositoryId,
          canonical({ boundBy: caller.actorId, boundAt: at, operationId }),
          main,
          '{}',
          '[]',
          at,
        );
      } else {
        check(
          bound.repositoryId === input.repositoryId,
          'code_rebind_required',
          'This project is bound to another repository; code.repository.rebind changes the binding after verifying that Code holds the project’s history',
          409,
        );
        check(
          input.expectedMainOid === bound.main.oid,
          'code_main_changed',
          'Main is not where expectedMainOid says; read code.status and decide again',
          409,
        );
        if (input.mainOid !== bound.main.oid)
          await tx.run(
            'UPDATE code_projects SET main_json=?,updated_at=? WHERE project_id=?',
            main,
            at,
            caller.projectId,
          );
      }
      // Naming main is what every unit with no accepted code beneath it was waiting for.
      await this.reconcileProject(tx, caller.projectId);
      const result = (await this.project(tx, caller.projectId))!;
      await tx.run(
        'INSERT INTO code_operations (id,project_id,principal_scope,request_id,kind,input_hash,payload_json,status,result_json,created_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        operationId,
        caller.projectId,
        principal,
        requestId,
        'local_bind',
        inputHash,
        canonical(payload),
        'completed',
        canonical(result),
        at,
        at,
      );
      await recorded(this.state, tx, caller, 'code.local_bound', caller.projectId, {
        operationId,
        repositoryId: input.repositoryId,
        mainOid: input.mainOid,
        previousMainOid: bound?.main.oid ?? null,
      });
      return result;
    });
  }

  async hosted(caller: Caller, tx: Transaction): Promise<boolean> {
    this.assertOpen();
    this.state.assertTransaction(tx);
    caller = structuredClone(caller);
    await this.scope.require(caller, 'read', tx);
    return (await this.project(tx, caller.projectId))?.durability === 'code';
  }

  async unit(caller: Caller, unitId: string, tx?: Transaction): Promise<CodeUnit> {
    this.assertOpen();
    caller = structuredClone(caller);
    return await inTransaction(this.state, tx, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      const row = await this.row(tx, caller.projectId, unitId);
      check(row, 'code_unit_not_found', 'No such unit of work in this project', 404);
      return await this.record(tx, row);
    });
  }

  async status(caller: Caller): Promise<CodeProjectStatus> {
    this.assertOpen();
    caller = structuredClone(caller);
    return await this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'read', tx);
      // The whole window is read at once and nothing in it can change while it is, so each
      // unit is asked of Workflows once: a project of open unpinned units otherwise asks for
      // the same unit three times over and for a shared dependency once per waiter.
      this.asked.set(tx, new Map());
      const warnings = await tx.get<{ warnings_json: string }>(
        'SELECT warnings_json FROM code_projects WHERE project_id=?',
        caller.projectId,
      );
      return {
        project: await this.project(tx, caller.projectId),
        store: null,
        operations: [],
        mirror: null,
        warnings: JSON.parse(warnings?.warnings_json ?? '[]') as CodeStoreWarning[],
        units: await mapAsync(
          await tx.all<UnitRow>(
            `SELECT ${unitColumns} FROM code_units WHERE project_id=? ORDER BY declared_at DESC,unit_id LIMIT 200`,
            caller.projectId,
          ),
          async (row) => await this.record(tx, row),
        ),
        blockers: (await this.workflows.blockers(caller, undefined, tx)).filter(
          (blocker) => blocker.provider === 'code',
        ),
      };
    });
  }

  /**
   * What a unit depends on. A read that has said it is taking the whole project in one
   * transaction gets each answer once; every writing path asks Workflows again, because a
   * transaction that moves an instance must see what it moved.
   */
  private readonly asked = new WeakMap<
    Transaction,
    Map<string, Promise<WorkflowProviderRelations | null>>
  >();
  private async dependencies(
    tx: Transaction,
    projectId: string,
    unitId: string,
  ): Promise<WorkflowProviderRelations | null> {
    const held = this.asked.get(tx);
    if (!held) return await this.workflows.dependencyRelations(projectId, unitId, tx);
    const key = `${projectId}:${unitId}`;
    const known = held.get(key) ?? this.workflows.dependencyRelations(projectId, unitId, tx);
    held.set(key, known);
    return await known;
  }

  private async relations(
    tx: Transaction,
    projectId: string,
    unitId: string,
  ): Promise<WorkflowProviderRelations> {
    const relations = await this.dependencies(tx, projectId, unitId);
    check(relations, 'code_unit_not_found', 'No such unit of work in this project', 404);
    const frontier = await tx.get<{ inputs_json: string }>(
      'SELECT inputs_json FROM code_unit_frontiers WHERE project_id=? AND unit_id=?',
      projectId,
      unitId,
    );
    if (frontier) {
      // Scheduling prerequisites still gate the owner; only the frozen frontier contributes code.
      const inputs = await mapAsync(JSON.parse(frontier.inputs_json) as string[], async (id) => {
        const input = await this.dependencies(tx, projectId, id);
        check(input, 'code_unit_not_found', 'A declared frontier unit is missing', 409);
        return input.instance;
      });
      return {
        ...relations,
        dependencies: [
          ...inputs,
          ...relations.dependencies.filter((edge) => edge.kind === 'system'),
        ],
      };
    }
    return relations;
  }

  /**
   * The base a unit's declared dependencies imply. An accepted dependency with code ends the
   * walk on its path; one that succeeded without code is looked past, to what it was built
   * on. Everything else fails closed, because a pin is immutable: a success on a version that
   * declares a workspace but left no verifiable acceptance blocks, and so does a code-less
   * success whose own prerequisites are unfinished, since what lies beneath it is unknown.
   * Whether a version declares a workspace is Workflows' persisted fact, so the answer is the
   * same while that dependency's owner is unloaded.
   */
  private async derive(tx: Transaction, projectId: string, unitId: string): Promise<Derived> {
    let relations = await this.relations(tx, projectId, unitId);
    relations = {
      ...relations,
      dependencies: relations.dependencies.filter((item) => item.kind !== 'system'),
    };
    if (relations.dependencies.some((item) => !item.settled)) return { status: 'waiting' };
    const pending = (
      key: string,
      message: string,
      next: string,
      related = [] as WorkflowProviderDependency[],
    ) => ({
      key,
      code: 'code_base_pending',
      message,
      status: 409,
      next,
      related: related.map((item) => ({ kind: 'workflow', id: item.id, label: item.name })),
    });
    // Only hosted workflow versions declare units; the binding and imported store are retained.
    const bound = (await tx.get<Pick<ProjectRow, 'repository_id' | 'binding_json' | 'main_json'>>(
      'SELECT repository_id,binding_json,main_json FROM code_projects WHERE project_id=?',
      projectId,
    ))!;
    const main = JSON.parse(bound.main_json) as {
      oid: string;
      operationId: string;
      stored?: boolean;
    };
    const publishing = !!(await this.row(tx, projectId, relations.instance.id))?.publishes_at;
    const fixed = await tx.get<{ reference: string }>(
      'SELECT reference FROM code_unit_inputs WHERE project_id=? AND unit_id=?',
      projectId,
      relations.instance.id,
    );
    if (fixed)
      return {
        status: 'ready',
        body: {
          formatVersion: 1,
          kind: 'accepted',
          reference: fixed.reference,
          repositoryId: bound.repository_id,
          dependencies: [],
          sources: [],
          main: null,
        },
      };
    const blockers: WorkflowProvidedBlockerInput[] = [];
    const commits = new Map<
      string,
      { sources: BaseBody['sources']; units: WorkflowProviderDependency[] }
    >();
    const seen = new Set<string>();
    const queue = [...relations.dependencies];
    for (let node = queue.shift(); node; node = queue.shift()) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      const unit = await this.row(tx, projectId, node.id);
      const accepted = unit?.acceptance_json
        ? (JSON.parse(unit.acceptance_json) as AcceptanceBody)
        : null;
      if (unit?.quarantine_base_key) {
        blockers.push(this.quarantineBlocker(unit.quarantine_base_key));
        continue;
      }
      const intact = !accepted || digest(accepted) === unit!.acceptance_hash;
      if (intact && (accepted ? accepted.code === null : !node.declaresWorkspace)) {
        const below = await this.dependencies(tx, projectId, node.id);
        for (const child of (below?.dependencies ?? []).filter((item) => item.kind !== 'system'))
          if (child.settled) queue.push(child);
          else
            blockers.push(
              pending(
                `dependency:${child.id}`,
                `“${node.name}” succeeded without code, but its own prerequisite “${child.name}” has not succeeded, so what it was built on is unknown`,
                `Finish “${child.name}”. If it has failed: ${EXPLICIT_BASE}.`,
                [node, child],
              ),
            );
        continue;
      }
      if (!intact || !accepted?.code || !bindsRepository(bound, accepted.code.repositoryId)) {
        blockers.push(
          pending(
            `acceptance:${node.id}`,
            !accepted
              ? `“${node.name}” succeeded with a workspace but has no recorded acceptance, so its code cannot be verified`
              : intact
                ? `“${node.name}” was accepted with code from a repository this project is not bound to`
                : `The recorded acceptance of “${node.name}” no longer matches its hash`,
            `${EXPLICIT_BASE}, or redo “${node.name}” so that its success is accepted.`,
            [node],
          ),
        );
        continue;
      }
      if (
        accepted.storage !== 'code' &&
        // An import delivers this commit either as its tip or as history it contains; the
        // commits each import was found to contain are recorded with it, outside any
        // transaction, so this gate is a read. A tip matches both patterns, which is right.
        !(await tx.get(
          "SELECT id FROM code_operations WHERE project_id=? AND kind='import' AND status='completed' AND (result_json LIKE ? OR result_json LIKE ?) LIMIT 1",
          projectId,
          `%"head":"${accepted.code.commit}"%`,
          `%"contained":[%"${accepted.code.commit}"%`,
        ))
      ) {
        blockers.push(
          pending(
            `acceptance:${node.id}`,
            `“${node.name}” was accepted from a runner’s own repository, and Code’s repository does not hold that commit yet`,
            `${IMPORT}, naming the accepted commit of “${node.name}”.`,
            [node],
          ),
        );
        continue;
      }
      const entry = commits.get(accepted.code.commit) ?? { sources: [], units: [] };
      entry.sources.push({
        unitId: node.id,
        acceptanceHash: unit!.acceptance_hash!,
        terminalRevision: accepted.terminalRevision,
      });
      entry.units.push(node);
      commits.set(accepted.code.commit, entry);
    }
    // A unit that publishes to main is prepared from main as well: the integration everyone
    // would otherwise do after the review happens once, before the work starts, and a clash
    // with main becomes an ordinary resolution task instead of a stale publication. A unit
    // with no code-bearing dependency already starts from main, below.
    if (publishing && commits.size) {
      if (main.stored !== true)
        blockers.push(
          pending(
            'main',
            'Code’s repository does not hold the commit that is main, which this unit publishes to',
            `${IMPORT}, or names an imported commit as main with code.local.bind.`,
          ),
        );
      else if (!commits.has(main.oid)) commits.set(main.oid, { sources: [], units: [] });
    }
    const blocked = blockers.filter(
      (item, index) => blockers.findIndex((other) => other.key === item.key) === index,
    );
    if (blocked.length) return { status: 'blocked', blockers: blocked };
    const related = [...commits.values()]
      .flatMap((entry) => entry.units)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((item) => ({ kind: 'workflow', id: item.id, label: item.name }));
    // Several accepted commits are one base, made once for everyone who waits on that set.
    if (commits.size > 1 && this.bases?.enabled) {
      const base = await this.bases.find(tx, projectId, commits.keys());
      const path = base ? await this.bases.path(tx, projectId, base.key) : [];
      const held = path.find(
        (record) =>
          record.quarantined ||
          ['suspended', 'cancelled', 'blocked_infra'].includes(record.state) ||
          record.blocker,
      );
      if (held)
        return {
          status: 'blocked',
          merge: [...commits.keys()],
          blockers: [
            {
              key: 'merge',
              code: held.quarantined
                ? 'code_quarantined'
                : [
                      'sessions_unavailable',
                      'dispatch_disabled',
                      'capacity_full',
                      'budget_exceeded',
                      'usage_unavailable',
                    ].includes(held.blocker ?? '')
                  ? 'code_base_admission'
                  : 'code_base_blocked',
              status: 409,
              message: `Base ${held.key} is ${held.quarantined ? 'quarantined' : held.state}: ${held.blocker ?? held.operatorReason ?? 'operator control'}.`,
              next:
                held.quarantined || held.state === 'cancelled'
                  ? 'An operator must create corrective work and replan these waiters; this retained base cannot be used.'
                  : held.state === 'suspended'
                    ? 'An administrator uses code.base.resume and a reason.'
                    : held.state === 'blocked_infra'
                      ? 'An administrator repairs the infrastructure, then uses code.base.retry.'
                      : held.attempts > 0
                        ? 'The server retries this infrastructure failure automatically; after five failed executions an administrator uses code.base.retry.'
                        : 'Enable project dispatch, restore Sessions, free service capacity, or raise/clear the budget with usage.set_budget. Admission retries automatically without consuming launch or review limits.',
              related,
            },
          ],
        };
      if (base?.state === 'resolved' && base.result && !base.quarantined)
        return {
          status: 'ready',
          merge: [...commits.keys()],
          body: {
            formatVersion: 1,
            kind: 'merged',
            reference: base.result.commit,
            repositoryId: bound.repository_id,
            dependencies: relations.dependencies.map((item) => item.id).sort(),
            sources: [...commits.values()]
              .flatMap((entry) => entry.sources)
              .sort((left, right) => left.unitId.localeCompare(right.unitId)),
            // Main is not an acceptance, so it is never a source; the pin names it here, which
            // is also what the publication envelope reads back as its integration base.
            main: publishing ? { oid: main.oid, operationId: main.operationId } : null,
          },
        };
      const resolutions =
        base && !base.quarantined
          ? (await this.bases.path(tx, projectId, base.key)).filter(
              (record) => record.resolutionTaskId && record.state !== 'resolved',
            )
          : [];
      const resolutionBlockers: WorkflowProvidedBlockerInput[] = [];
      for (const record of resolutions) {
        const task = await this.dependencies(tx, projectId, record.resolutionTaskId!);
        resolutionBlockers.push({
          key: `resolution:${record.key}`,
          code: 'code_merge_conflict',
          status: 409,
          message: `Base resolution task “${task?.instance.name ?? record.resolutionTaskId}” (${record.resolutionTaskId}) is ${task?.instance.state ?? 'missing'}. ${record.resolutionError ?? `Conflicting paths: ${(record.conflict?.paths ?? []).join(', ')}`}`,
          next:
            task?.instance.state === 'suspended'
              ? 'A signed-in human operator must extend review_rounds with workflow.extend_limit to resume this same task, or cancel/replan the waiting work. Keep this waiter pending.'
              : 'Complete the existing resolution task and its independent review; this unit continues from the accepted result.',
          related: [
            {
              kind: 'task',
              id: record.resolutionTaskId!,
              label: task?.instance.name ?? record.resolutionTaskId!,
            },
          ],
        });
      }
      if (resolutionBlockers.length)
        return { status: 'blocked', merge: [...commits.keys()], blockers: resolutionBlockers };
      const waiting =
        !base || ['waiting_inputs', 'queued', 'running', 'retry_wait'].includes(base.state);
      const conflicted = base?.state === 'awaiting_resolution';
      return {
        status: 'blocked',
        merge: [...commits.keys()],
        blockers: [
          {
            key: 'merge',
            code: base?.quarantined
              ? 'code_quarantined'
              : waiting
                ? 'code_base_wait'
                : conflicted
                  ? 'code_merge_conflict'
                  : 'code_base_blocked',
            message: base?.quarantined
              ? 'The base made from this unit’s dependencies is quarantined'
              : waiting
                ? `The ${commits.size} commits this unit’s dependencies were accepted with are being merged into one base`
                : conflicted
                  ? base?.conflict?.paths.length
                    ? `The commits this unit’s dependencies were accepted with do not merge cleanly: ${base.conflict.paths.slice(0, 5).join(', ')}`
                    : 'The commits this unit’s dependencies were accepted with merged cleanly, and the project check of that merge failed'
                  : `The base of this unit could not be made (${base?.state})`,
            status: 409,
            next: waiting
              ? 'Nothing: the merge runs on the server, and this unit is offered when it is done.'
              : conflicted
                ? 'The conflict is resolved by one reviewed task; this unit continues from its accepted commit.'
                : 'An operator looks at the base with code.status.',
            related,
          },
        ],
      };
    }
    if (commits.size > 1)
      return {
        status: 'blocked',
        blockers: [
          {
            key: 'merge',
            code: 'code_merge_required',
            message: `The dependencies of this unit were accepted with ${commits.size} different commits, and automatic merging is disabled`,
            status: 409,
            next: `${EXPLICIT_BASE}, or make one dependency carry the combined code.`,
            related,
          },
        ],
      };
    const [accepted] = [...commits];
    if (!accepted && main.stored !== true)
      return {
        status: 'blocked',
        blockers: [
          pending(
            'main',
            'Code’s repository does not hold the commit that is main',
            `${IMPORT}, or names an imported commit as main with code.local.bind.`,
          ),
        ],
      };
    return {
      status: 'ready',
      body: {
        formatVersion: 1,
        kind: accepted ? 'accepted' : 'main',
        reference: accepted ? accepted[0] : main.oid,
        repositoryId: bound.repository_id,
        dependencies: relations.dependencies.map((item) => item.id).sort(),
        sources: (accepted?.[1].sources ?? []).sort((left, right) =>
          left.unitId.localeCompare(right.unitId),
        ),
        // A publishing unit whose one accepted commit is main itself still records it: the
        // envelope it seals later reads its integration base from here.
        main: accepted && !publishing ? null : { oid: main.oid, operationId: main.operationId },
      },
    };
  }

  private baseState(derived: Derived): CodeBaseStatus {
    return derived.status === 'ready'
      ? {
          status: 'ready',
          kind: derived.body.kind,
          sources: derived.body.sources.map((item) => item.unitId),
          // A merged base is ready at one commit the server made; the accepted commits it
          // was made from are what join this unit to that base record.
          ...(derived.merge ? { merge: derived.merge } : {}),
        }
      : derived;
  }

  /**
   * Publishes what a derivation finds for one unit that has neither a base nor an acceptance.
   * A blocked unit is refused at lease admission and so never becomes a dispatch candidate;
   * this row is the only place anyone would see why.
   *
   * A publication wait is the one opinion Code keeps about work that has already ended: it
   * names a human who can still end it, so it is a fact about done work rather than work
   * nobody may take. Every other opinion here is about work still to do, and work that has
   * ended lost its rows at that transition with nothing left to run again and withdraw one,
   * so those are never written onto an instance that has ended.
   */
  private async reconcileUnit(tx: Transaction, projectId: string, unitId: string): Promise<void> {
    const row = await this.row(tx, projectId, unitId);
    if (
      (row?.publication_id || (row?.publishes_at && row.acceptance_json)) &&
      !row.quarantine_base_key
    ) {
      const publication = await this.publicationOf(tx, projectId, row);
      await this.workflows.replaceBlockers(
        {
          projectId,
          instanceId: unitId,
          provider: PROVIDER,
          blockers: publication ? publicationBlockers(publication) : [],
        },
        tx,
      );
      return;
    }
    if (row?.quarantine_base_key) {
      if (!(await this.workflows.dependencyRelations(projectId, unitId, tx))?.instance.terminal)
        await this.workflows.replaceBlockers(
          {
            projectId,
            instanceId: unitId,
            provider: PROVIDER,
            blockers: [this.quarantineBlocker(row.quarantine_base_key)],
          },
          tx,
        );
      return;
    }
    if (!row || row.base_json !== null || row.acceptance_json !== null) return;
    const relations = await this.workflows.dependencyRelations(projectId, unitId, tx);
    if (!relations || relations.instance.terminal) return;
    let derived = await this.derive(tx, projectId, relations.instance.id);
    // The first unit to wait on a set writes its record and plan; this is a writing path,
    // which a derivation itself never is.
    let prerequisites: string[] = [];
    if (derived.status !== 'waiting' && derived.merge && this.bases) {
      const base = await this.bases.ensure(tx, projectId, derived.merge);
      let path = await this.bases.path(tx, projectId, base.key);
      if (
        path.some((record) => record.state === 'awaiting_resolution' && !record.resolutionTaskId)
      ) {
        await this.resolveBases(tx, projectId);
        path = await this.bases.path(tx, projectId, base.key);
      }
      prerequisites = path
        .flatMap((record) => (record.resolutionTaskId ? [record.resolutionTaskId] : []))
        .sort();
      derived = await this.derive(tx, projectId, relations.instance.id);
      // A pending task has no automatic work to wake; waking it here would schedule another reconciliation forever.
      if (base.state === 'queued') this.bases.soon(projectId);
    }
    const attached = relations.dependencies
      .filter((edge) => edge.kind === 'system' && edge.owner === PROVIDER)
      .map((edge) => edge.id)
      .sort();
    if (JSON.stringify(attached) !== JSON.stringify(prerequisites))
      await this.workflows.systemPrerequisites(PROVIDER).replace(
        {
          projectId,
          instanceId: unitId,
          dependencies: prerequisites,
          requestId: `base:${unitId}:${relations.instance.revision}:${digest(prerequisites)}`,
        },
        tx,
      );
    await this.workflows.replaceBlockers(
      {
        projectId,
        instanceId: unitId,
        provider: PROVIDER,
        blockers: derived.status === 'blocked' ? derived.blockers : [],
      },
      tx,
    );
  }

  /** All current waiters contribute their roots before the shared record becomes immutable. */
  async baseSponsors(tx: Transaction, projectId: string, members: string[]): Promise<string[]> {
    const waiters: string[] = [];
    for (const row of await tx.all<{ unit_id: string }>(
      'SELECT unit_id FROM code_units WHERE project_id=? AND base_json IS NULL AND acceptance_json IS NULL',
      projectId,
    )) {
      const relations = await this.workflows.dependencyRelations(projectId, row.unit_id, tx);
      if (!relations || relations.instance.terminal) continue;
      const derived = await this.derive(tx, projectId, relations.instance.id);
      if (
        'merge' in derived &&
        derived.merge &&
        members.every((member) => derived.merge!.includes(member))
      )
        waiters.push(row.unit_id);
    }
    return this.workflows.sponsoringRoots(projectId, waiters, tx);
  }

  /** Creation and linkage share the caller's transaction, so a crash never leaves an orphan. */
  private async resolveBases(tx: Transaction, projectId: string): Promise<void> {
    if (!this.bases?.enabled) return;
    for (const base of await this.bases.records(tx, projectId)) {
      if (base.state !== 'awaiting_resolution' || base.quarantined) continue;
      if (!base.resolutionTaskId && this.resolutionTasks) {
        const [left, right] = await this.bases.inputs(tx, projectId, base);
        if (!left || !right) continue;
        const brief = await this.resolutionBrief(tx, projectId, base, left, right);
        const task = await this.resolutionTasks.create(
          {
            projectId,
            requestId: `base:${base.key}`,
            ...brief,
            baseReference: left,
            checks: [
              `The first completed merge on the task branch must have exactly two parents: the current checkpoint descending from ${left}, and frozen right input ${right}, in that order. Later rounds add ordinary corrective commits.`,
              // A base whose check failed has no conflicting path to resolve, so asking for
              // that would contradict the brief's own Project check section three lines down.
              checkBriefSections(base)
                ? 'Leave no conflict markers.'
                : 'Resolve every conflicting path and leave no conflict markers.',
              // A base whose check failed merged cleanly, so what this round owes is the
              // failing command passing, not paths resolved. That sentence is where
              // "resolution rounds supply reviewed verification evidence" reaches a worker.
              checkResolutionCheck(base) ??
                'Run the project build and tests as far as this workspace permits; retain commands, results, and any checks that could not run as review evidence.',
            ],
          },
          tx,
        );
        await this.bases.linkTask(tx, projectId, base.key, task.id);
        await pinMerge(tx, projectId, task.id, base.key, left, right);
        base.resolutionTaskId = task.id;
      }
      if (base.resolutionTaskId) {
        const unit = await this.row(tx, projectId, base.resolutionTaskId);
        const accepted = unit?.acceptance_json
          ? (JSON.parse(unit.acceptance_json) as AcceptanceBody)
          : null;
        if (accepted?.code && digest(accepted) === unit!.acceptance_hash)
          await this.bases.recordAcceptance(tx, projectId, base, accepted.code.commit);
      }
    }
  }

  /** The accepting transaction compares the exact reviewed certificate once. */
  private async resolutionReview(
    caller: Caller,
    tx: Transaction,
    input: CodeUnitAcceptInput,
  ): Promise<boolean> {
    check(this.reviews, 'code_provenance_unverifiable', 'The review service is unavailable', 503);
    const review = await this.reviews.get(caller, input.reviewRef, tx);
    const provenance = await this.reviewProvenance(caller.projectId, input.unitId, tx);
    return (
      review.subjectId === input.unitId &&
      review.subjectRevision === input.terminalRevision - 1 &&
      review.snapshotHash === input.submissionRef &&
      review.status === 'submitted' &&
      review.verdict === 'pass' &&
      !!review.provenance &&
      canonical(review.provenance) === canonical(provenance)
    );
  }

  private async resolutionBrief(
    tx: Transaction,
    projectId: string,
    base: CodeBaseRecord,
    left: string,
    right: string,
  ): Promise<{ title: string; goal: string }> {
    const records = await this.bases!.records(tx, projectId);
    const inputs = (key: string) =>
      records.find((record) => record.key === key)?.members ??
      base.members.filter((commit) => baseKey([commit]) === key);
    const names = new Map<string, string[]>();
    const titles = new Map<string, string[]>();
    for (const unit of await tx.all<UnitRow>(
      `SELECT ${unitColumns} FROM code_units WHERE project_id=? AND acceptance_json IS NOT NULL ORDER BY unit_id`,
      projectId,
    )) {
      const accepted = JSON.parse(unit.acceptance_json!) as AcceptanceBody;
      if (!accepted.code || !base.members.includes(accepted.code.commit)) continue;
      const facts = await this.workflows.dependencyRelations(projectId, unit.unit_id, tx);
      const title = facts?.instance.name ?? 'Accepted work';
      titles.set(accepted.code.commit, [...(titles.get(accepted.code.commit) ?? []), title]);
      const entries = names.get(accepted.code.commit) ?? [];
      entries.push(
        `${facts?.instance.name ?? unit.unit_id} (${unit.unit_id}): ${facts?.instance.goal ?? 'No goal was recorded.'}`,
      );
      names.set(accepted.code.commit, entries);
    }
    const side = (key: string) =>
      inputs(key)
        .map((commit) => `${commit}: ${(names.get(commit) ?? ['Accepted input']).join('; ')}`)
        .join('\n');
    // Each section gets its own room, so long provenance cannot push the right input or Git's diagnostics out of the brief.
    const bounded = (value: string, limit: number) =>
      value.length <= limit ? value : `${value.slice(0, limit)}\n[Truncated in the task brief.]`;
    const titleSide = (key: string) => {
      const items = inputs(key).flatMap((commit) => titles.get(commit) ?? ['Accepted work']);
      const first = items[0] ?? 'Accepted work';
      const label = first.length > 80 ? `${first.slice(0, 79)}…` : first;
      return `‘${label}’${items.length > 1 ? ` and ${items.length - 1} more` : ''}`;
    };
    // A failing project check is a conflict with no paths: every heading and the opening
    // sentence a worker reads first would lie, so the brief says what has to pass instead.
    const checked = checkBriefSections(base);
    const sections = checked ?? [
      `Conflicting paths:\n${bounded((base.conflict?.paths ?? []).join('\n'), 4000)}`,
      `Git messages:\n${bounded(base.conflict?.messages ?? '', 4000)}`,
    ];
    return {
      title: checked
        ? `Make the project check pass on ${titleSide(base.left)} with ${titleSide(base.right)}`
        : `Merge ${titleSide(base.left)} with ${titleSide(base.right)}`,
      goal: `${
        checked
          ? `The merge of ${titleSide(base.left)} and ${titleSide(base.right)} is clean; its project check failed.`
          : `Resolve conflicts between ${titleSide(base.left)} and ${titleSide(base.right)}.`
      }\n\nLeft input ${left} (the workspace starts here):\n${bounded(side(base.left), 8000)}\n\nRight input ${right} (frozen):\n${bounded(side(base.right), 8000)}\n\n${sections[0]}\n\nUse code.merge operation start on the clean initial checkout; wait for code.operation. The right input is frozen and never follows a branch. ${checked ? 'Make the command pass on the merged tree, retain its commands and results as evidence' : 'Resolve the files, retain conflict decisions and test evidence'}, then use code.merge operation complete. code.commit and final captures save single-parent WIP before completion. After interruption on any machine, continue from the downloaded checkpoint and its pendingMerge metadata; do not restart over saved WIP. After the first completed merge, later rounds use code.commit for corrections on this same branch. Retain the operation receipt, parent evidence, and commands and results for independent review.\n\n${sections[1]}`,
    };
  }

  /** The project's repository gained history, which a unit may have been waiting for. */
  async imported(tx: Transaction, projectId: string): Promise<void> {
    this.state.assertTransaction(tx);
    await this.reconcileProject(tx, projectId);
  }

  private quarantineBlocker(key: string): WorkflowProvidedBlockerInput {
    return {
      key: 'quarantine',
      code: 'code_quarantined',
      status: 409,
      message: `This unit uses quarantined base ${key}. Its retained pin and acceptance cannot be reused.`,
      next: 'An administrator creates corrective work and replans the waiters, or, for a quarantine verified to be a false alarm, uses code.base.release. Fencing a capture cannot clear base quarantine.',
      related: [],
    };
  }

  /**
   * Quarantine follows retained lineage, including pins and successes that already left the
   * queue. The reach is derived here rather than accumulated, so releasing the base an
   * operator quarantined retracts everything that only inherited from it, while a base an
   * operator quarantined in its own right keeps its whole reach.
   */
  private async propagateQuarantine(tx: Transaction, projectId: string): Promise<void> {
    if (!this.bases) return;
    const records = await this.bases.records(tx, projectId);
    const units = await tx.all<UnitRow>(
      `SELECT ${unitColumns} FROM code_units WHERE project_id=?`,
      projectId,
    );
    const tainted = new Map<string, string>();
    const reached = new Map<string, string>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const base of records) {
        const from = records.find((b) => b.quarantined && [base.left, base.right].includes(b.key));
        const cause = from?.key ?? base.members.map((c) => tainted.get(c)).find(Boolean);
        if (!base.quarantined && cause) {
          await tx.run(
            "UPDATE code_bases SET health='quarantined',operator_reason=?,updated_at=? WHERE project_id=? AND base_key=?",
            `${INHERITED_QUARANTINE}${cause}`,
            now(),
            projectId,
            base.key,
          );
          base.quarantined = true;
          changed = true;
        }
        if (base.quarantined && base.result && !tainted.has(base.result.commit)) {
          tainted.set(base.result.commit, base.key);
          changed = true;
        }
      }
      for (const unit of units) {
        const pin = unit.base_json ? (JSON.parse(unit.base_json) as BaseBody) : null;
        const cause =
          pin &&
          (tainted.get(pin.reference) ??
            pin.sources.map((source) => reached.get(source.unitId)).find(Boolean));
        const resolution = records.find(
          (b) => b.quarantined && b.resolutionTaskId === unit.unit_id,
        );
        if (!reached.has(unit.unit_id) && (cause || resolution)) {
          reached.set(unit.unit_id, cause || resolution!.key);
          changed = true;
        }
        const accepted = unit.acceptance_json
          ? (JSON.parse(unit.acceptance_json) as AcceptanceBody)
          : null;
        const key = reached.get(unit.unit_id);
        if (key && accepted?.code && !tainted.has(accepted.code.commit)) {
          tainted.set(accepted.code.commit, key);
          changed = true;
        }
      }
    }
    for (const unit of units) {
      const key = reached.get(unit.unit_id) ?? null;
      // Two statements rather than one with the key tested inside the CASE: a placeholder whose
      // only use is `? IS NOT NULL` gives PostgreSQL nothing to infer a type from, and it
      // rejects such a statement at parse time whatever the bound value is.
      if (key !== unit.quarantine_base_key)
        await (key
          ? tx.run(
              "UPDATE code_units SET quarantine_base_key=?,writer_state=CASE WHEN writer_state IN ('reserved','active','closing') THEN 'recovery_required' ELSE writer_state END WHERE project_id=? AND unit_id=?",
              key,
              projectId,
              unit.unit_id,
            )
          : tx.run(
              'UPDATE code_units SET quarantine_base_key=NULL WHERE project_id=? AND unit_id=?',
              projectId,
              unit.unit_id,
            ));
      // As in reconcileUnit: a quarantine is a refusal to let more work start on this base,
      // and work that has ended cleared its rows when it ended with nothing left to withdraw
      // one afterwards, so a row written here would block it for good.
      if (
        (key || unit.quarantine_base_key) &&
        !(await this.workflows.dependencyRelations(projectId, unit.unit_id, tx))?.instance.terminal
      )
        await this.workflows.replaceBlockers(
          {
            projectId,
            instanceId: unit.unit_id,
            provider: PROVIDER,
            blockers: key ? [this.quarantineBlocker(key)] : [],
          },
          tx,
        );
    }
  }

  /** Every unpinned unit of a project: for a new main, and for a start after Code was away. */
  private async reconcileProject(tx: Transaction, projectId: string): Promise<void> {
    await this.propagateQuarantine(tx, projectId);
    await this.resolveBases(tx, projectId);
    for (const base of (await this.bases?.records(tx, projectId)) ?? []) {
      if (!base.resolutionTaskId) continue;
      const blocker = await this.resolutionBlocker(tx, projectId, base.resolutionTaskId);
      if (blocker || base.operatorReason)
        await this.workflows.replaceBlockers(
          {
            projectId,
            instanceId: base.resolutionTaskId,
            provider: PROVIDER,
            blockers: blocker ? [blocker] : [],
          },
          tx,
        );
    }
    for (const { unit_id } of await tx.all<{ unit_id: string }>(
      'SELECT unit_id FROM code_units WHERE project_id=? AND ((base_json IS NULL AND acceptance_json IS NULL) OR publishes_at IS NOT NULL) ORDER BY unit_id',
      projectId,
    ))
      await this.reconcileUnit(tx, projectId, unit_id);
  }

  /** Run once when Code loads: events that ended work while it was unloaded start from now. */
  async reconcileAll(): Promise<void> {
    const projects = await this.state.read(
      async (sql) =>
        await sql.all<{ project_id: string }>(
          'SELECT DISTINCT project_id FROM code_units WHERE (base_json IS NULL AND acceptance_json IS NULL) OR publishes_at IS NOT NULL ORDER BY project_id',
        ),
    );
    for (const { project_id } of projects)
      await this.state.transaction(async (tx) => await this.reconcileProject(tx, project_id));
  }

  /**
   * The durable consumer of workflow.transition. A base changes only when work ends, so every
   * other transition costs one read; then only what waits on the ended work is derived again,
   * climbing past a dependent that has itself ended, because a derivation looks through those.
   */
  async transitioned(event: StoredEvent, tx: Transaction): Promise<void> {
    const ended = await this.workflows.dependencyRelations(event.projectId, event.subjectId, tx);
    if (
      this.bases?.enabled &&
      (await this.bases.records(tx, event.projectId)).some(
        (base) => base.resolutionTaskId === event.subjectId,
      )
    ) {
      await this.reconcileProject(tx, event.projectId);
      return;
    }
    if (!ended?.instance.terminal) return;
    const seen = new Set<string>();
    const queue = [...ended.dependents];
    for (let node = queue.shift(); node; node = queue.shift()) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      if (!node.terminal) {
        await this.reconcileUnit(tx, event.projectId, node.id);
        continue;
      }
      const above = await this.workflows.dependencyRelations(event.projectId, node.id, tx);
      queue.push(...(above?.dependents ?? []));
    }
  }

  private async project(sql: Sql, projectId: string): Promise<CodeProjectBinding | null> {
    const row = await sql.get<ProjectRow>(
      'SELECT project_id,repository_id,binding_json,main_json,store_json FROM code_projects WHERE project_id=?',
      projectId,
    );
    if (!row) return null;
    const binding = JSON.parse(row.binding_json) as {
      boundBy: string;
      boundAt: string;
      previous?: CodeProjectBinding['previous'];
    };
    const main = JSON.parse(row.main_json) as CodeProjectBinding['main'];
    return {
      mode: 'local',
      repositoryId: row.repository_id,
      boundBy: binding.boundBy,
      boundAt: binding.boundAt,
      previous: binding.previous ?? [],
      main: {
        oid: main.oid,
        admittedBy: main.admittedBy,
        admittedAt: main.admittedAt,
        stored: main.stored === true,
      },
      // Once imported a project stays with Code's repository: a main it does not hold yet
      // blocks work, it never sends new work back to a runner's own repository.
      durability: row.store_json === null ? 'legacy-local' : 'code',
    };
  }

  private async row(sql: Sql, projectId: string, unitId: string): Promise<UnitRow | undefined> {
    return await sql.get<UnitRow>(
      `SELECT ${unitColumns} FROM code_units WHERE project_id=? AND unit_id=?`,
      projectId,
      unitId,
    );
  }

  private async retainAcceptance(
    caller: Caller,
    unitId: string,
    body: AcceptanceBody,
    at: string,
    tx: Transaction,
  ) {
    const { code, receipt } = body;
    if (receipt && code) {
      // The ref the acceptance is kept under is made after this transaction, by the journal.
      const payload = {
        format: 1,
        source: 'accept-ref',
        actorId: caller.actorId,
        unitId,
        tip: code.commit,
      };
      await tx.run(
        'INSERT INTO code_operations (id,project_id,principal_scope,request_id,kind,input_hash,payload_json,status,created_at,unit_id,phase,progress_json,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
        newId('cop'),
        caller.projectId,
        'system:code',
        `accept-ref:${unitId}`,
        'accept-ref',
        digest(payload),
        canonical(payload),
        'prepared',
        at,
        unitId,
        'objects_durable',
        canonical({
          received: 0,
          expectedOld: null,
          target: code.commit,
          receiptRef: acceptedRef(unitId),
        }),
        at,
      );
    }
  }

  async published(
    caller: Caller,
    unitId: string,
    reviewId: string,
    revision: number,
    tx: Transaction,
  ) {
    const round = await tx.get<{ acceptance_json: string; accepted_at: string }>(
      'SELECT acceptance_json,accepted_at FROM code_review_acceptances WHERE project_id=? AND unit_id=? AND review_id=?',
      caller.projectId,
      unitId,
      reviewId,
    );
    check(
      round,
      'code_acceptance_unverifiable',
      'The approved publication acceptance is missing',
      409,
    );
    const relations = await this.workflows.dependencyRelations(caller.projectId, unitId, tx);
    check(
      relations?.instance.settled && relations.instance.revision === revision,
      'code_acceptance_unverifiable',
      'Publication must complete its owner at this exact revision',
      409,
    );
    const body: AcceptanceBody = {
      ...JSON.parse(round.acceptance_json),
      terminalRevision: revision,
    };
    await tx.run(
      'UPDATE code_units SET acceptance_json=?,acceptance_hash=?,accepted_at=? WHERE project_id=? AND unit_id=? AND acceptance_json IS NULL',
      canonical(body),
      digest(body),
      round.accepted_at,
      caller.projectId,
      unitId,
    );
    await this.retainAcceptance(caller, unitId, body, round.accepted_at, tx);
  }

  /** What the sealed publication of this unit says now; null while nothing declared one. */
  private async publicationOf(
    sql: Sql,
    projectId: string,
    row: UnitRow,
  ): Promise<CodeUnitPublication | null> {
    if (!row.publication_id)
      // Declared to publish, accepted, and nothing opened: its own facts could not be sealed.
      return row.publishes_at && row.acceptance_json ? { state: 'unsealed' } : null;
    const publication = await sql.get<PublicationRow>(
      'SELECT pull_json,merge_json,incident_json,stale,verified FROM code_publications WHERE proposal_id=? AND project_id=?',
      row.publication_id,
      projectId,
    );
    if (!publication) return null;
    const pull = publication.pull_json
      ? (JSON.parse(publication.pull_json) as GitHubPullRequest)
      : null;
    const merge = publication.merge_json
      ? (JSON.parse(publication.merge_json) as { commitSha: string | null })
      : null;
    const controls = await sql.get<{ record_json: string }>(
      'SELECT record_json FROM code_publication_controls WHERE project_id=?',
      projectId,
    );
    const enforcement = controls
      ? (JSON.parse(controls.record_json) as {
          disabled?: boolean;
          canary?: unknown;
          visibility?: { incomplete?: boolean };
        })
      : {};
    // Every project condition PublicationHost.check and rules() refuse a merge on reads the
    // same way to a unit waiting on one: until an administrator repairs it, no merge of this
    // pull request can succeed, so the wait must not name a merge as the thing that ends it.
    const disabled =
      !!enforcement.disabled || !enforcement.canary || !!enforcement.visibility?.incomplete;
    const mergeCommit = merge?.commitSha ?? pull?.mergeCommitSha ?? null;
    const state = publication.incident_json
      ? 'incident'
      : Number(publication.verified)
        ? 'published'
        : Number(publication.stale)
          ? 'stale'
          : pull && pull.state === 'closed' && !pull.merged
            ? 'closed'
            : disabled
              ? 'disabled'
              : 'pending';
    return {
      state,
      ...(pull ? { pull: { number: pull.number, url: pull.url } } : {}),
      ...(state === 'published' && mergeCommit ? { mergeCommit } : {}),
    };
  }

  private acceptance(row: UnitRow): CodeUnitAcceptance | null {
    if (row.acceptance_json === null) return null;
    const body = JSON.parse(row.acceptance_json) as AcceptanceBody;
    return {
      unitId: row.unit_id,
      hash: row.acceptance_hash!,
      acceptedAt: row.accepted_at!,
      terminalRevision: body.terminalRevision,
      submissionRef: body.submissionRef,
      reviewRef: body.reviewRef,
      acceptedBy: body.acceptedBy,
      reference: body.code?.commit ?? null,
      reviewAttached: body.code?.reviewAttached ?? null,
      storage: body.storage,
      ...(body.receipt ? { receipt: body.receipt } : {}),
    };
  }

  private pin(row: UnitRow): CodeBasePin | null {
    if (row.base_json === null) return null;
    const base = JSON.parse(row.base_json) as BaseBody;
    return {
      unitId: row.unit_id,
      kind: base.kind,
      reference: base.reference,
      sources: base.sources.map(({ unitId, acceptanceHash }) => ({ unitId, acceptanceHash })),
      pinnedAt: row.based_at!,
      leaseId: row.base_lease_id!,
    };
  }

  private async record(tx: Transaction, row: UnitRow): Promise<CodeUnit> {
    const base = this.pin(row);
    // Only a unit that may still take a base is derived: one accepted or ended never will.
    const open =
      !base && row.acceptance_json === null
        ? await this.dependencies(tx, row.project_id, row.unit_id)
        : null;
    return {
      unitId: row.unit_id,
      workflow: row.workflow,
      version: Number(row.version),
      declaredAt: row.declared_at,
      branch: workBranch(row.unit_id),
      base,
      baseStatus: row.quarantine_base_key
        ? { status: 'blocked', blockers: [this.quarantineBlocker(row.quarantine_base_key)] }
        : base
          ? { status: 'pinned', pin: base }
          : open && !open.instance.terminal
            ? this.baseState(await this.derive(tx, row.project_id, row.unit_id))
            : null,
      acceptance: this.acceptance(row),
      publication: await this.publicationOf(tx, row.project_id, row),
      ...(await this.writers.facts(tx, row.project_id, row.unit_id)),
    };
  }

  close(): void {
    this.closed = true;
  }

  private assertOpen(): void {
    check(!this.closed, 'code_unavailable', 'Code is unavailable', 503);
  }
}

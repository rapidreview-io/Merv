import {
  check,
  digest,
  now,
  type Sql,
  type State,
  type Transaction,
  type Workflows,
} from '@merv/contracts';
import type { CodeGitHubService } from '@merv/code/github';
import type { CodeRepositories } from '@merv/code/store/repository';
import { baseKey } from './base-plan.js';
import type { CodeBaseRecord, CodeMainLanding, CodeMainLandingOutcome } from './models.js';
import type { CodeUnitService } from './units.js';

/**
 * Accepted work lands on main (founder decision, 2026-10-11). In a project Code hosts with no
 * linked GitHub repository main means all accepted work: the server carries each accepted unit
 * with code into it, oldest acceptance first and one at a time. A head that already contains
 * main moves main forward; any other is merged through the same base record dependents share,
 * and a conflict is the one resolution task every base gets. Work a dependent's base already
 * merges on top of main lands through that base, so main follows the merges its dependents
 * make instead of repeating them, conflicts and all. Nothing waits on a landing:
 * dependents still start from their dependencies' accepted commits, and only work with no
 * dependencies starts from main.
 *
 * Git never runs inside a transaction. Each landing is a row written once and settled once, and
 * main moves only by compare-and-swap, so a restart resumes the open row and a main someone else
 * moved settles it superseded; the next row takes the new main.
 */
export async function migrateLandings(state: State) {
  await state.migrate('code_main_landings', [
    {
      version: 1,
      sql: `
CREATE TABLE code_main_landings (
 project_id TEXT NOT NULL, landing_key TEXT NOT NULL, seq INTEGER NOT NULL, unit_id TEXT NOT NULL,
 acceptance_hash TEXT NOT NULL, main_oid TEXT NOT NULL, head_oid TEXT NOT NULL, base_key TEXT, message TEXT,
 result_oid TEXT, outcome TEXT CHECK (outcome IN ('ff','merged','resolved','superseded','skipped')),
 reason TEXT, created_at TEXT NOT NULL, settled_at TEXT,
 PRIMARY KEY(project_id,landing_key), UNIQUE(project_id,seq), CHECK ((outcome IS NULL)=(settled_at IS NULL))
);
CREATE UNIQUE INDEX code_main_landings_open ON code_main_landings(project_id) WHERE outcome IS NULL;
CREATE FUNCTION code_main_landings_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Main landings are retained'; END IF;
 IF NEW.project_id<>OLD.project_id OR NEW.landing_key<>OLD.landing_key OR NEW.seq<>OLD.seq OR NEW.unit_id<>OLD.unit_id
 OR NEW.acceptance_hash<>OLD.acceptance_hash OR NEW.main_oid<>OLD.main_oid OR NEW.head_oid<>OLD.head_oid
 OR NEW.base_key IS DISTINCT FROM OLD.base_key OR NEW.message IS DISTINCT FROM OLD.message OR NEW.created_at<>OLD.created_at
 OR (OLD.outcome IS NOT NULL AND (NEW.outcome IS DISTINCT FROM OLD.outcome OR NEW.result_oid IS DISTINCT FROM OLD.result_oid
  OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.settled_at IS DISTINCT FROM OLD.settled_at))
 THEN RAISE EXCEPTION 'Main landing inputs are immutable and settle once'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER code_main_landings_frozen BEFORE UPDATE OR DELETE ON code_main_landings FOR EACH ROW EXECUTE FUNCTION code_main_landings_guard();
`,
    },
  ]);
}

interface LandingRow {
  project_id: string;
  landing_key: string;
  unit_id: string;
  acceptance_hash: string;
  main_oid: string;
  head_oid: string;
  base_key: string | null;
  result_oid: string | null;
  outcome: CodeMainLandingOutcome | null;
  reason: string | null;
  settled_at: string | null;
}
type Candidate = { unitId: string; commit: string; acceptanceHash: string; acceptedAt: string };
const ACTOR = 'system:code';
const OPEN = 'SELECT * FROM code_main_landings WHERE project_id=? AND outcome IS NULL';
/** States in which an unfinished base waits on an operator rather than on its own work. */
const STOPPED = ['cancelled', 'suspended'];

/**
 * Whether a base's result will descend from `main`, and every unfinished step of its plan can
 * still finish: an input stands for main, or is a step that does. Read from the project's
 * records, which already list each step's inputs.
 */
function buildsOnMain(records: Map<string, CodeBaseRecord>, root: CodeBaseRecord, main: string) {
  let onMain = false;
  const seen = new Set<string>();
  for (const queue = [root]; queue.length;) {
    const record = queue.pop()!;
    if (seen.has(record.key)) continue;
    seen.add(record.key);
    if (record.quarantined || (!record.result && STOPPED.includes(record.state))) return false;
    if (record.result?.commit === main) {
      onMain = true;
      continue;
    }
    for (const key of [record.left, record.right]) {
      const lone = record.members.find((member) => baseKey([member]) === key);
      if (lone) onMain ||= lone === main;
      else if (records.has(key)) queue.push(records.get(key)!);
      else return false;
    }
  }
  return onMain;
}

/**
 * The commits of `commits` that `main` does not contain. `rev-list --not main` walks only the
 * history beyond main, so the reading costs what is unpublished, not the project's past.
 */
export async function beyondMain(
  repositories: CodeRepositories,
  projectId: string,
  main: string,
  commits: string[],
): Promise<Set<string>> {
  const beyond = new Set<string>();
  if (!commits.length) return beyond;
  const walk = await repositories.git.run(['rev-list', ...new Set(commits), '--not', main], {
    env: repositories.environment(projectId),
  });
  check(
    walk.code === 0,
    'code_candidate_unavailable',
    'Code must hold main and every accepted commit; import the missing history',
    409,
  );
  for (const line of walk.stdout.toString('utf8').split('\n')) if (line) beyond.add(line.trim());
  return beyond;
}

export class MainLanding {
  private readonly busy = new Map<string, Promise<void>>();
  private closed = false;
  constructor(
    private readonly state: State,
    private readonly units: CodeUnitService,
    private readonly repositories: CodeRepositories,
    private readonly github: Pick<CodeGitHubService, 'linked'>,
    private readonly workflows: Pick<Workflows, 'relations'>,
    /** The rollout switch, MERV_CODE_MAIN_LANDING; off, nothing lands and status still plans. */
    readonly enabled: boolean,
  ) {}

  async initialize(): Promise<void> {
    await migrateLandings(this.state);
  }

  /** Why nothing lands in this project now, or null; and the main a landing starts from. */
  async standing(sql: Sql, projectId: string) {
    const project = await this.units.code.binding(sql, projectId);
    const reason: CodeMainLanding['reason'] | null = !this.enabled
      ? 'disabled'
      : !project?.main.stored
        ? 'main_not_stored'
        : (await this.github.linked(projectId, sql))
          ? 'github_linked'
          : null;
    return { reason, main: project?.main.stored ? project.main.oid : null };
  }

  /** Whether landing will still carry this acceptance to main: it is on here and never skipped it. */
  async lands(sql: Sql, projectId: string, unitId: string, hash: string): Promise<boolean> {
    if ((await this.standing(sql, projectId)).reason) return false;
    return !(await sql.get(
      "SELECT 1 FROM code_main_landings WHERE project_id=? AND unit_id=? AND acceptance_hash=? AND outcome='skipped'",
      projectId,
      unitId,
      hash,
    ));
  }

  /** Asked from inside a transaction that may have made work to land: it runs after a beat. */
  soon(projectId: string): void {
    if (!this.enabled || this.closed) return;
    setTimeout(() => void this.work(projectId).catch(() => undefined), 50).unref();
  }

  /** Every project with accepted work: at start, and on Code Work's 30 s timer. */
  async tick(): Promise<void> {
    if (!this.enabled) return;
    const projects = await this.state.read((sql) =>
      sql.all<{ project_id: string }>(
        'SELECT DISTINCT project_id FROM code_units WHERE acceptance_json IS NOT NULL ORDER BY project_id',
      ),
    );
    for (const { project_id } of projects)
      if (!this.closed) await this.work(project_id).catch(() => undefined);
  }

  /** One pass per project at a time; asking again while one runs only waits for it. */
  async work(projectId: string): Promise<void> {
    if (this.closed) return;
    const running = this.busy.get(projectId);
    if (running) return await running;
    const job = (async () => {
      while (!this.closed && (await this.step(projectId)));
    })().finally(() => this.busy.delete(projectId));
    this.busy.set(projectId, job);
    await job;
  }

  /** One move: settle the open landing, or open the next. True when another may follow. */
  private async step(projectId: string): Promise<boolean> {
    const { standing, open } = await this.state.read(async (sql) => ({
      standing: await this.standing(sql, projectId),
      open: await sql.get<LandingRow>(OPEN, projectId),
    }));
    if (standing.reason) return false;
    return open ? await this.settleOpen(open) : await this.begin(projectId, standing.main!);
  }

  /**
   * The accepted units main is missing, oldest acceptance first: a dependent is accepted after
   * what it depends on, so this is also dependency order. Quarantined work, code-less work, a
   * rejected publication and a landing already skipped are never offered.
   */
  async order(projectId: string, main: string): Promise<Candidate[]> {
    return (await this.offered(projectId, main)).order;
  }

  /** The order, and the commits of work that is never offered, which no landing may carry. */
  private async offered(projectId: string, main: string) {
    const { candidates, rejected, skipped } = await this.state.read(async (sql) => ({
      ...(await this.units.records.candidatesOf(sql, projectId)),
      skipped: (
        await sql.all<{ unit_id: string; acceptance_hash: string }>(
          "SELECT unit_id,acceptance_hash FROM code_main_landings WHERE project_id=? AND outcome='skipped'",
          projectId,
        )
      ).map((row) => `${row.unit_id}@${row.acceptance_hash}`),
    }));
    const eligible = candidates.filter(
      (item) => !item.quarantined && !skipped.includes(`${item.unitId}@${item.acceptanceHash}`),
    );
    const commits = eligible.map((item) => item.commit);
    const beyond = await beyondMain(this.repositories, projectId, main, commits);
    const order = eligible
      .filter((item) => beyond.has(item.commit))
      .sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt) || a.unitId.localeCompare(b.unitId));
    const held = new Set([
      ...rejected,
      ...candidates.filter((item) => !eligible.includes(item)).map((item) => item.commit),
    ]);
    return { order, held };
  }

  /**
   * The smallest base that merges `commit` on top of `main` and can still finish, if one does.
   * Its result descends from main, so landing through it makes no merge, and asks for no
   * resolution, that the work waiting on that base does not need anyway. A base that would
   * carry work main never takes is not one.
   */
  private async integrating(
    sql: Sql,
    projectId: string,
    main: string,
    commit: string,
    held: Set<string>,
  ): Promise<CodeBaseRecord | null> {
    const records = await this.units.bases.records(sql, projectId);
    const byKey = new Map(records.map((record) => [record.key, record]));
    return (
      records
        .filter(
          (record) =>
            record.members.includes(commit) &&
            !record.members.some((member) => held.has(member)) &&
            buildsOnMain(byKey, record, main),
        )
        .sort((a, b) => a.members.length - b.members.length || a.key.localeCompare(b.key))[0] ??
      null
    );
  }

  private async begin(projectId: string, main: string): Promise<boolean> {
    const {
      order: [next],
      held,
    } = await this.offered(projectId, main);
    if (!next) return false;
    const env = { env: this.repositories.environment(projectId) };
    const ff = await this.repositories.git.run(
      ['merge-base', '--is-ancestor', main, next.commit],
      env,
    );
    check(
      ff.code < 2,
      'code_candidate_unavailable',
      'Code must hold main and the accepted commit',
      409,
    );
    return await this.state.transaction(async (tx) => {
      const standing = await this.standing(tx, projectId);
      // Main moved since it was read, or landing stopped: the next step reads again.
      if (standing.reason || standing.main !== main || (await tx.get(OPEN, projectId)))
        return !standing.reason;
      // A quarantine that reached this work since it was offered keeps it off main.
      if ((await this.units.records.row(tx, projectId, next.unitId))?.quarantine_base_key)
        return true;
      const seq = Number(
        (await tx.get<{ n: number }>(
          'SELECT COUNT(*) AS n FROM code_main_landings WHERE project_id=?',
          projectId,
        ))!.n,
      );
      const at = now();
      const members = [main, next.commit];
      const joined =
        ff.code === 0 ? null : await this.integrating(tx, projectId, main, next.commit, held);
      // A base this landing makes says, in its merge commit, which work it lands. One that
      // already existed was planned by others' waiters and keeps their message: a message read
      // by one execution and not another would make a retried merge a different commit.
      const fresh =
        ff.code !== 0 && !joined && !(await this.units.bases.find(tx, projectId, members));
      const unit = fresh ? await this.workflows.relations(projectId, next.unitId, tx) : null;
      const base =
        ff.code === 0 ? null : (joined ?? (await this.units.bases.ensure(tx, projectId, members)));
      await tx.run(
        'INSERT INTO code_main_landings(project_id,landing_key,seq,unit_id,acceptance_hash,main_oid,head_oid,base_key,message,result_oid,outcome,created_at,settled_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
        projectId,
        digest({ formatVersion: 1, seq, main, head: next.commit }),
        seq,
        next.unitId,
        next.acceptanceHash,
        main,
        next.commit,
        base?.key ?? null,
        fresh
          ? `Land ${unit?.instance.workflow ?? 'work'}: ${unit?.instance.name ?? next.unitId} (${next.unitId})`
          : null,
        base ? null : next.commit,
        base ? null : 'ff',
        at,
        base ? null : at,
      );
      if (!base) return await this.moveMain(tx, projectId, main, next.commit, next.unitId, 'ff');
      if (base.members.includes(main))
        await this.units.bases.mergesMain(tx, projectId, base.key, main, at);
      this.units.bases.soon(projectId);
      return true;
    });
  }

  /** The open landing's base reached an end, or has not yet: settle it, or wait for it. */
  private async settleOpen(row: LandingRow): Promise<boolean> {
    const projectId = row.project_id;
    return await this.state.transaction(async (tx) => {
      const open = await tx.get<LandingRow>(OPEN, projectId);
      if (open?.landing_key !== row.landing_key) return true;
      const standing = await this.standing(tx, projectId);
      if (standing.reason) return false;
      // Read with the move it decides, so a base quarantined meanwhile never reaches main.
      const path = row.base_key ? await this.units.bases.path(tx, projectId, row.base_key) : [];
      const base = path.find((record) => record.key === row.base_key) ?? null;
      const own = row.base_key === baseKey([row.main_oid, row.head_oid]);
      const stopped = path.find(
        (record) => record.quarantined || (!record.result && STOPPED.includes(record.state)),
      );
      const unusable = !base
        ? 'base_missing'
        : base.quarantined
          ? 'base_quarantined'
          : base.state === 'cancelled'
            ? 'base_cancelled'
            : !own && stopped
              ? `base_${stopped.quarantined ? 'quarantined' : stopped.state}`
              : null;
      // A base the landing joined belongs to the work that waits on it: when its plan can no
      // longer finish, this unit is offered again, not given up.
      if (unusable)
        return await this.settle(tx, row, own ? 'skipped' : 'superseded', null, unusable);
      // A bind or a publication moved main; the next landing starts from the main it left.
      if (standing.main !== row.main_oid)
        return await this.settle(tx, row, 'superseded', null, 'main_moved');
      const result = base?.state === 'resolved' ? base.result : null;
      if (!result) return false;
      const outcome = result.method === 'task' ? 'resolved' : 'merged';
      await this.settle(tx, row, outcome, result.commit, null);
      return await this.moveMain(tx, projectId, row.main_oid, result.commit, row.unit_id, outcome);
    });
  }

  private async settle(
    tx: Transaction,
    row: LandingRow,
    outcome: CodeMainLandingOutcome,
    result: string | null,
    reason: string | null,
  ): Promise<true> {
    await tx.run(
      'UPDATE code_main_landings SET outcome=?,result_oid=?,reason=?,settled_at=? WHERE project_id=? AND landing_key=? AND outcome IS NULL',
      outcome,
      result,
      reason,
      now(),
      row.project_id,
      row.landing_key,
    );
    return true;
  }

  private async moveMain(
    tx: Transaction,
    projectId: string,
    from: string,
    to: string,
    unitId: string,
    outcome: CodeMainLandingOutcome,
  ): Promise<true> {
    await this.units.code.setMainStored(tx, {
      projectId,
      expectedOid: from,
      oid: to,
      actorId: ACTOR,
    });
    await this.state.appendEvent(tx, {
      projectId,
      actorId: ACTOR,
      type: 'code.main_landed',
      subjectId: unitId,
      data: { unitId, outcome, previousMain: from, main: to },
    });
    await this.units.changed(tx, projectId);
    return true;
  }

  /** The message of a base a landing made, written with its row before the base could run. */
  async message(sql: Sql, projectId: string, key: string): Promise<string | null> {
    const row = await sql.get<{ message: string }>(
      'SELECT message FROM code_main_landings WHERE project_id=? AND base_key=? AND message IS NOT NULL ORDER BY seq LIMIT 1',
      projectId,
      key,
    );
    return row?.message ?? null;
  }

  /** The `landing` section of code.status. */
  async status(projectId: string): Promise<CodeMainLanding> {
    const { standing, open, landed, path } = await this.state.read(async (sql) => {
      const open = await sql.get<LandingRow>(OPEN, projectId);
      return {
        standing: await this.standing(sql, projectId),
        open,
        path: open?.base_key ? await this.units.bases.path(sql, projectId, open.base_key) : [],
        landed: await sql.all<LandingRow>(
          'SELECT * FROM code_main_landings WHERE project_id=? AND outcome IS NOT NULL ORDER BY seq DESC LIMIT 50',
          projectId,
        ),
      };
    });
    const order = standing.main ? await this.order(projectId, standing.main).catch(() => []) : [];
    // A joined base may wait on an earlier step of its plan rather than on its own merge.
    const base = path.find((record) => record.state === 'awaiting_resolution') ?? path[0];
    return {
      enabled: !standing.reason,
      ...(standing.reason ? { reason: standing.reason } : {}),
      current: open
        ? {
            unitId: open.unit_id,
            mainOid: open.main_oid,
            headOid: open.head_oid,
            baseKey: open.base_key,
            state: base?.state === 'awaiting_resolution' ? 'awaiting_resolution' : 'merging',
            ...(base?.resolutionTaskId ? { resolutionTaskId: base.resolutionTaskId } : {}),
          }
        : null,
      waiting: order
        .filter((item) => item.unitId !== open?.unit_id)
        .map((item) => ({ unitId: item.unitId, acceptedAt: item.acceptedAt })),
      landed: landed.map((row) => ({
        unitId: row.unit_id,
        outcome: row.outcome!,
        resultOid: row.result_oid,
        ...(row.reason ? { reason: row.reason } : {}),
        settledAt: row.settled_at!,
      })),
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.busy.values()]);
  }
}

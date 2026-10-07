import {
  canonical,
  check,
  digest,
  now,
  type Caller,
  type State,
  type Transaction,
  recorded,
} from '@merv/contracts';
import type { CodeStoreOperation } from '@merv/code/store/protocol';
import type { CodeRepositoryPrepareInput, CodeRepositoryPreparation } from './models.js';
import { pinMerge, verifyResolution } from '@merv/code/pending-merge';
import type { CodeRepositories } from '@merv/code/store/repository';
import type { CodeGitHubService } from '@merv/code/github';
import type { CodeUnitService } from './units.js';

export async function migrateRepositorySync(state: State) {
  await state.migrate('code_repository_sync', [
    {
      version: 1,
      sql: `
CREATE TABLE code_repository_sync (
 project_id TEXT NOT NULL, sync_key TEXT NOT NULL, local_oid TEXT NOT NULL, remote_oid TEXT NOT NULL,
 connection_json TEXT NOT NULL, task_id TEXT NOT NULL, promoted_oid TEXT, created_at TEXT NOT NULL,
 PRIMARY KEY(project_id,sync_key)
);
CREATE FUNCTION code_repository_sync_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Repository integrations are retained'; END IF;
 IF NEW.project_id<>OLD.project_id OR NEW.sync_key<>OLD.sync_key OR NEW.local_oid<>OLD.local_oid OR NEW.remote_oid<>OLD.remote_oid
 OR NEW.connection_json<>OLD.connection_json OR NEW.task_id<>OLD.task_id OR NEW.created_at<>OLD.created_at
 OR (OLD.promoted_oid IS NOT NULL AND NEW.promoted_oid IS DISTINCT FROM OLD.promoted_oid)
 THEN RAISE EXCEPTION 'Repository integration inputs are immutable'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER code_repository_sync_frozen BEFORE UPDATE OR DELETE ON code_repository_sync FOR EACH ROW EXECUTE FUNCTION code_repository_sync_guard();
`,
    },
  ]);
}

/** Import first, then integrate through the ordinary task/review gate. Never writes a remote ref. */
export async function reconcileRepository(
  state: State,
  repositories: CodeRepositories,
  github: CodeGitHubService,
  units: CodeUnitService,
  caller: Caller,
  input: CodeRepositoryPrepareInput,
  operation: CodeStoreOperation,
): Promise<CodeRepositoryPreparation> {
  const local = input.expectedMainOid;
  check(
    local,
    'code_main_required',
    'Reload settings and select the current Merv main before connecting GitHub',
    409,
  );
  const connection = await github.status(caller);
  check(
    connection.repository &&
      connection.revision === input.expectedRevision &&
      connection.baseBranch === input.baseBranch,
    'github_conflict',
    'The selected GitHub connection changed',
    409,
  );
  const binding = {
    revision: connection.revision,
    repository: connection.repository,
    baseBranch: input.baseBranch,
  };
  const key = digest({ project: caller.projectId, local, remote: input.headOid, binding });
  const result = (mainOid: string, taskId?: string): CodeRepositoryPreparation => ({
    state: taskId ? 'review_required' : 'ready',
    baseBranch: input.baseBranch,
    headOid: input.headOid,
    mainOid,
    ...(taskId ? { taskId } : {}),
    operation,
  });
  const env = repositories.environment(caller.projectId);
  const ancestor = await repositories.git.run(
    ['merge-base', '--is-ancestor', input.headOid, local],
    { env },
  );
  check(
    ancestor.code < 2,
    'code_sync_objects_missing',
    'The selected histories are not both retained',
    409,
  );
  const assertMain = async (tx: Transaction, expected: string) => {
    await github.assertBinding(caller, binding, tx, 'read');
    check(
      (await units.code.project(tx, caller.projectId))?.main.oid === expected,
      'code_main_changed',
      'Merv main moved; prepare a new integration against its current head',
      409,
    );
  };
  if (ancestor.code === 0) {
    await state.transaction((tx) => assertMain(tx, local));
    return result(local);
  }
  const row = await state.transaction(async (tx) => {
    await github.assertBinding(caller, binding, tx, 'read');
    const existing = await tx.get<{ task_id: string; promoted_oid: string | null }>(
      'SELECT task_id,promoted_oid FROM code_repository_sync WHERE project_id=? AND sync_key=?',
      caller.projectId,
      key,
    );
    if (existing) return existing;
    await assertMain(tx, local);
    check(
      units.resolutionTasks,
      'tasks_unavailable',
      'Repository integration requires the task and review services',
      503,
    );
    const task = await units.resolutionTasks.create(
      {
        projectId: caller.projectId,
        requestId: `sync:${key}`,
        baseReference: local,
        work: { kind: 'sync', branch: input.baseBranch, main: local, head: input.headOid },
      },
      tx,
    );
    await pinMerge(tx, caller.projectId, task.id, key, local, input.headOid);
    await tx.run(
      'INSERT INTO code_repository_sync(project_id,sync_key,local_oid,remote_oid,connection_json,task_id,created_at) VALUES(?,?,?,?,?,?,?)',
      caller.projectId,
      key,
      local,
      input.headOid,
      canonical(binding),
      task.id,
      now(),
    );
    return { task_id: task.id, promoted_oid: null };
  });
  if (row.promoted_oid) return result(row.promoted_oid);
  const unit = await units.records.unit(caller, row.task_id);
  const accepted = unit.acceptance;
  if (!accepted?.reference || !accepted.reviewAttached) return result(local, row.task_id);
  check(
    accepted.storage === 'code',
    'code_sync_not_retained',
    'The integration must be retained in managed storage',
    409,
  );
  check(
    !unit.quarantine && unit.baseStatus?.status !== 'blocked',
    'code_quarantined',
    'The reviewed integration is quarantined',
    409,
  );
  const verified = await verifyResolution(
    repositories.git,
    env,
    local,
    input.headOid,
    accepted.reference,
  );
  check(
    verified.firstMerge && !verified.error,
    'code_sync_history',
    verified.error ?? 'Both selected histories must be merged',
    409,
  );
  // Refresh the remote immediately before admission. A subsequent remote advance will still be
  // caught by the ordinary publication gate; importing never grants permission to force-push.
  const branch = (await github.branches(caller)).find((branch) => branch.name === input.baseBranch);
  check(
    branch?.sha === input.headOid,
    'code_branch_changed',
    'GitHub main moved during review; prepare its new head',
    409,
  );
  await state.transaction(async (tx) => {
    await github.assertBinding(caller, binding, tx, 'read');
    const already = await tx.get<{ promoted_oid: string | null }>(
      'SELECT promoted_oid FROM code_repository_sync WHERE project_id=? AND sync_key=?',
      caller.projectId,
      key,
    );
    if (already?.promoted_oid) {
      check(
        already.promoted_oid === accepted.reference,
        'code_sync_review_changed',
        'The integration has another retained result',
        409,
      );
      return;
    }
    await assertMain(tx, local);
    const latest = await units.records.unit(caller, row.task_id, tx);
    check(
      latest.acceptance?.hash === accepted.hash &&
        !latest.quarantine &&
        latest.baseStatus?.status !== 'blocked',
      'code_sync_review_changed',
      'The reviewed integration is no longer admissible',
      409,
    );
    await units.records.moveMain(caller, accepted.reference!, tx, local, key);
    await tx.run(
      'UPDATE code_repository_sync SET promoted_oid=? WHERE project_id=? AND sync_key=? AND promoted_oid IS NULL',
      accepted.reference,
      caller.projectId,
      key,
    );
    await recorded(state, tx, caller, 'code.repository_integrated', key, {
      taskId: row.task_id,
      previousMain: local,
      remoteHead: input.headOid,
      main: accepted.reference,
    });
    await units.changed(tx, caller.projectId);
  });
  return result(accepted.reference);
}

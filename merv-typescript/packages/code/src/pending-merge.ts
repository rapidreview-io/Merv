import {
  check,
  type CodePendingMerge,
  type Sql,
  type State,
  type Transaction,
} from '@merv/contracts';
import type { ServerGit } from './git.js';

const table = `CREATE TABLE code_pending_merges (
 project_id TEXT NOT NULL, unit_id TEXT NOT NULL, plan_key TEXT NOT NULL,
 left_oid TEXT NOT NULL, right_oid TEXT NOT NULL, head_oid TEXT NOT NULL,
 first_merge TEXT, round INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(project_id,unit_id,plan_key), UNIQUE(project_id,unit_id,round)
);`;
const changed = `(NEW.head_oid IS DISTINCT FROM OLD.head_oid AND EXISTS(SELECT 1 FROM code_pending_merges later WHERE later.project_id=OLD.project_id AND later.unit_id=OLD.unit_id AND later.round>OLD.round)) OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.unit_id IS DISTINCT FROM OLD.unit_id OR
 NEW.round IS DISTINCT FROM OLD.round OR NEW.plan_key IS DISTINCT FROM OLD.plan_key OR NEW.left_oid IS DISTINCT FROM OLD.left_oid OR NEW.right_oid IS DISTINCT FROM OLD.right_oid OR
 (OLD.first_merge IS NOT NULL AND NEW.first_merge IS DISTINCT FROM OLD.first_merge)`;
export async function migratePendingMerges(state: State): Promise<void> {
  await state.migrate('code_pending_merges', [
    {
      version: 1,
      sql: `${table}
CREATE TRIGGER code_pending_merge_frozen BEFORE UPDATE ON code_pending_merges WHEN ${changed.replaceAll('IS DISTINCT FROM', 'IS NOT')}
BEGIN SELECT RAISE(ABORT,'Merge inputs and completed first merge are frozen'); END;
CREATE TRIGGER code_pending_merge_retained BEFORE DELETE ON code_pending_merges BEGIN SELECT RAISE(ABORT,'Merge checkpoints are retained'); END;`,
      postgres: `${table}
CREATE FUNCTION code_pending_merge_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Merge checkpoints are retained'; END IF;
IF ${changed} THEN RAISE EXCEPTION 'Merge inputs and completed first merge are frozen'; END IF;
RETURN NEW; END $$;
CREATE TRIGGER code_pending_merge_frozen BEFORE UPDATE OR DELETE ON code_pending_merges FOR EACH ROW EXECUTE FUNCTION code_pending_merge_guard();`,
    },
  ]);
}
export async function pendingMerge(
  sql: Sql,
  projectId: string,
  unitId: string,
): Promise<CodePendingMerge | null> {
  const row = await sql.get<{
    plan_key: string;
    left_oid: string;
    right_oid: string;
    head_oid: string;
    first_merge: string | null;
  }>(
    'SELECT plan_key,left_oid,right_oid,head_oid,first_merge FROM code_pending_merges WHERE project_id=? AND unit_id=? ORDER BY round DESC LIMIT 1',
    projectId,
    unitId,
  );
  return row
    ? {
        plan: row.plan_key,
        firstParent: row.left_oid,
        secondParent: row.right_oid,
        checkpoint: row.head_oid,
        firstMerge: row.first_merge,
      }
    : null;
}
export async function pinMerge(
  tx: Transaction,
  projectId: string,
  unitId: string,
  plan: string,
  left: string,
  right: string,
  round = 0,
): Promise<void> {
  await tx.run(
    'INSERT INTO code_pending_merges(project_id,unit_id,plan_key,left_oid,right_oid,head_oid,round) VALUES (?,?,?,?,?,?,?) ON CONFLICT(project_id,unit_id,plan_key) DO NOTHING',
    projectId,
    unitId,
    plan,
    left,
    right,
    left,
    round,
  );
  const pinned = await pendingMerge(tx, projectId, unitId);
  check(
    pinned?.plan === plan && pinned.firstParent === left && pinned.secondParent === right,
    'code_merge_conflict',
    'The merge round already pins different inputs',
    409,
  );
}

/**
 * A WIP may have no merge yet. Once a merge appears on the task's first-parent lineage it
 * must join the frozen right input, and later corrections cannot introduce another merge.
 * Walking first parents also refuses a left input reached only through a second parent.
 */
export async function verifyResolution(
  git: ServerGit,
  env: Record<string, string>,
  left: string,
  right: string,
  head: string,
): Promise<{ firstMerge: string | null; error: string | null }> {
  const listed = await git.run(['rev-list', '--first-parent', '--parents', `${left}..${head}`], {
    env,
  });
  // Only what Git answers may judge a resolution. Git failing to run says nothing about the
  // work, and the verdict is recorded once, so a failure is raised for the caller to retry.
  check(listed.code === 0, 'code_git_failed', 'The resolution lineage could not be read.', 503);
  const lines = listed.stdout.toString('utf8').trim().split('\n').filter(Boolean).reverse();
  let previous = left;
  let firstMerge: string | null = null;
  for (const line of lines) {
    const [commit, ...parents] = line.split(' ');
    if (parents[0] !== previous)
      return {
        firstMerge,
        error: 'The first-parent lineage does not descend from the planned left input.',
      };
    if (parents.length !== 1) {
      if (firstMerge || parents.length !== 2 || parents[1] !== right)
        return {
          firstMerge,
          error:
            'The first completed merge must have exactly the current first-parent checkpoint and the frozen right input as its two ordered parents; later rounds must be corrective commits.',
        };
      firstMerge = commit;
    }
    previous = commit;
  }
  if (previous !== head)
    return { firstMerge, error: 'The resolution is not on the planned first-parent lineage.' };
  if (firstMerge) {
    const contains = await git.run(['merge-base', '--is-ancestor', right, head], { env });
    // Exit 1 is Git's answer that it is not an ancestor; anything else is Git not answering.
    check(contains.code < 2, 'code_git_failed', 'The resolution lineage could not be read.', 503);
    if (contains.code === 1)
      return { firstMerge, error: 'The resolution does not contain the frozen right input.' };
  }
  return { firstMerge, error: null };
}

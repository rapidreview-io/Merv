import { canonical, check, now, visible } from '@merv/contracts';
import type { Sql, Transaction } from '@merv/contracts';
import type {
  WorkflowProvidedBlocker,
  WorkflowProvidedBlockerInput,
  WorkflowReference,
  WorkflowWhose,
} from './models.js';

const WHOSE: readonly WorkflowWhose[] = ['owner', 'admin', 'operator', 'nobody'];

interface BlockerRow {
  instance_id: string;
  provider: string;
  blocker_key: string;
  code: string;
  message: string;
  status: number;
  next: string;
  related_json: string;
  cause: string | null;
  whose: string | null;
  revision: number | string | null;
  since: string;
  updated_at: string;
}

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && visible(value) && value.length <= max;
}

function related(value: unknown): WorkflowReference[] {
  const items = value ?? [];
  check(
    Array.isArray(items) &&
      items.length <= 50 &&
      items.every(
        (item) =>
          item !== null &&
          typeof item === 'object' &&
          text(item.kind, 100) &&
          text(item.id, 200) &&
          text(item.label, 500),
      ),
    'invalid_blocker',
    'Related records need a kind, an ID and a label',
    500,
  );
  return (items as WorkflowReference[]).map(({ kind, id, label }) => ({ kind, id, label }));
}

/**
 * The rows are a projection of what a provider thinks now, which is why this table alone may
 * be rewritten and cleared: a provider that is unloaded cannot withdraw its opinion, so work
 * that ends loses its rows at that transition rather than waiting for it. A provider may
 * still speak about work that has ended, and one does: a unit whose accepted code is waiting
 * to reach main is done, and where that wait stands is a fact about it, not work to take.
 */
export async function replaceBlockers(
  tx: Transaction,
  input: {
    projectId: string;
    instanceId: string;
    provider: string;
    blockers: WorkflowProvidedBlockerInput[];
  },
): Promise<void> {
  check(text(input.provider, 100), 'invalid_blocker', 'A blocker names its provider', 500);
  const blockers = input.blockers;
  check(
    blockers.every(
      (item) =>
        text(item.key, 300) &&
        text(item.code, 100) &&
        text(item.message, 4000) &&
        text(item.next, 4000) &&
        (item.cause === undefined || text(item.cause, 100)) &&
        (item.whose === undefined || WHOSE.includes(item.whose)) &&
        (item.revision === undefined ||
          (Number.isSafeInteger(item.revision) && item.revision >= 0)) &&
        Number.isInteger(item.status) &&
        item.status >= 400 &&
        item.status <= 599,
    ) && new Set(blockers.map((item) => item.key)).size === blockers.length,
    'invalid_blocker',
    'A blocker needs a distinct key, a code, a message, a status and a recovery action',
    500,
  );
  const existing = await tx.all<BlockerRow>(
    'SELECT * FROM wf_blockers WHERE instance_id=? AND provider=?',
    input.instanceId,
    input.provider,
  );
  for (const row of existing)
    if (!blockers.some((item) => item.key === row.blocker_key))
      await tx.run(
        'DELETE FROM wf_blockers WHERE instance_id=? AND provider=? AND blocker_key=?',
        input.instanceId,
        input.provider,
        row.blocker_key,
      );
  const at = now();
  for (const item of blockers) {
    const previous = existing.find((row) => row.blocker_key === item.key);
    const links = canonical(related(item.related));
    if (!previous) {
      await tx.run(
        'INSERT INTO wf_blockers (project_id,instance_id,provider,blocker_key,code,message,status,next,related_json,cause,whose,revision,since,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        input.projectId,
        input.instanceId,
        input.provider,
        item.key,
        item.code,
        item.message,
        item.status,
        item.next,
        links,
        item.cause ?? null,
        item.whose ?? null,
        item.revision ?? null,
        at,
        at,
      );
      continue;
    }
    // An unchanged opinion is not rewritten, so a reconcile that finds nothing new leaves
    // `updatedAt` as the moment the opinion last moved.
    if (
      previous.code === item.code &&
      previous.message === item.message &&
      Number(previous.status) === item.status &&
      previous.next === item.next &&
      previous.related_json === links &&
      previous.cause === (item.cause ?? null) &&
      previous.whose === (item.whose ?? null) &&
      (previous.revision === null ? null : Number(previous.revision)) === (item.revision ?? null)
    )
      continue;
    await tx.run(
      'UPDATE wf_blockers SET code=?,message=?,status=?,next=?,related_json=?,cause=?,whose=?,revision=?,since=?,updated_at=? WHERE instance_id=? AND provider=? AND blocker_key=?',
      item.code,
      item.message,
      item.status,
      item.next,
      links,
      item.cause ?? null,
      item.whose ?? null,
      item.revision ?? null,
      // A new code, or the same one about another revision, is a new opinion.
      previous.code === item.code &&
        (previous.revision === null ? null : Number(previous.revision)) === (item.revision ?? null)
        ? previous.since
        : at,
      at,
      input.instanceId,
      input.provider,
      item.key,
    );
  }
}

export async function clearBlockers(tx: Transaction, instanceId: string): Promise<void> {
  await tx.run('DELETE FROM wf_blockers WHERE instance_id=?', instanceId);
}

/**
 * Published blockers of the instances named, or of the whole project when none are. An opinion
 * about one revision is read only while the record stands at it.
 */
export async function readBlockers(
  sql: Sql,
  projectId: string,
  instanceIds?: readonly string[],
): Promise<WorkflowProvidedBlocker[]> {
  if (instanceIds && !instanceIds.length) return [];
  const rows = await sql.all<BlockerRow>(
    `SELECT b.* FROM wf_blockers b WHERE b.project_id=?${instanceIds ? ` AND b.instance_id IN (${instanceIds.map(() => '?').join(',')})` : ''} AND (b.revision IS NULL OR b.revision=(SELECT i.revision FROM wf_instances i WHERE i.id=b.instance_id)) ORDER BY b.since,b.instance_id,b.provider,b.blocker_key`,
    projectId,
    ...(instanceIds ?? []),
  );
  return rows.map((row) => ({
    instanceId: row.instance_id,
    provider: row.provider,
    key: row.blocker_key,
    code: row.code,
    message: row.message,
    status: Number(row.status),
    next: row.next,
    related: JSON.parse(row.related_json) as WorkflowReference[],
    ...(row.cause === null ? {} : { cause: row.cause }),
    ...(row.whose === null ? {} : { whose: row.whose as WorkflowWhose }),
    ...(row.revision === null ? {} : { revision: Number(row.revision) }),
    since: row.since,
    updatedAt: row.updated_at,
  }));
}

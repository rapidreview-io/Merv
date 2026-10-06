/**
 * The thread a session a test writes by hand visits: one per actor, as Sessions keeps them
 * (`worker_sessions.thread_id` names it and is required).
 */
import type pg from 'pg';
import type { Transaction } from '@merv/contracts';

const sql = (p: (n: number) => string) =>
  `INSERT INTO session_threads(id,project_id,instance_id,state,role,actor_id,status,created_at,updated_at)
   VALUES(${p(1)},${p(2)},'fixture','fixture','producer',${p(3)},'dormant','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')
   ON CONFLICT (actor_id) DO NOTHING`;

export async function fixtureThread(
  tx: Pick<Transaction, 'run'>,
  projectId: string,
  actorId: string,
): Promise<string> {
  await tx.run(
    sql(() => '?'),
    `thr_${actorId}`,
    projectId,
    actorId,
  );
  return `thr_${actorId}`;
}
export async function fixtureThreadPg(
  client: pg.Client,
  projectId: string,
  actorId: string,
): Promise<string> {
  await client.query(
    sql((n) => `$${n}`),
    [`thr_${actorId}`, projectId, actorId],
  );
  return `thr_${actorId}`;
}

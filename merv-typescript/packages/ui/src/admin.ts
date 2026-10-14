import { check, MervError, type State } from '@merv/contracts';
import type { ApiPrincipal, MountHandler } from '@merv/api/types';

import type { AdminIdentity, AdminExperiment, AdminOverview } from './admin-models.js';
export type { AdminIdentity } from './admin-models.js';
export function requireAdmin(principal: ApiPrincipal | undefined, admins: AdminIdentity[]) {
  check(
    principal?.kind === 'user' &&
      'user' in principal &&
      admins.some(
        (a) => a.issuer === principal.user.issuer && a.subject === principal.user.subject,
      ),
    'forbidden',
    'Platform administrator access required',
    403,
  );
}
/** Intentionally global. Never expose this projection through project-scoped tools or machine keys. */
export async function adminOverview(
  state: State,
  identities: AdminIdentity[] = [],
): Promise<AdminOverview> {
  return state.read(async (sql) => {
    const tables = new Set(
      (
        await sql.all<{ table_name: string }>(
          'SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema()',
        )
      ).map((r) => r.table_name),
    );
    const unavailable: string[] = [];
    const rows: AdminExperiment[] = [];
    type Row = {
      id: string;
      project_id: string;
      project: string;
      title: string;
      customer: string;
      owner_id: string;
      state: string;
      updated_at: string;
      created_at: string;
      attempt: number;
      paid: number | null;
    };
    const collect = async (query: string, source: AdminExperiment['source']) => {
      for (const r of await sql.all<Row>(query))
        rows.push({
          id: r.id,
          projectId: r.project_id,
          project: r.project,
          title: r.title,
          customer: r.customer,
          customerKey:
            source === 'project'
              ? 'actor:' + r.owner_id
              : r.customer === 'Not provided yet'
                ? 'guest:' + r.id
                : 'email:' + r.customer.toLowerCase(),
          source,
          state: r.state,
          updatedAt: r.updated_at,
          createdAt: r.created_at,
          attempt: Number(r.attempt),
          paid: r.paid === null ? null : !!r.paid,
          activity: r.state.replaceAll('_', ' '),
          sessions: 0,
        });
    };
    const order =
      " ORDER BY CASE WHEN w.state IN ('complete','failed','abandoned') THEN 1 ELSE 0 END,w.updated_at DESC LIMIT 1001";
    if (tables.has('experiments'))
      await collect(
        `SELECT e.id,e.owner_id,e.project_id,p.name AS project,e.name AS title,COALESCE(a.name,'Unassigned') AS customer,w.state,w.updated_at,e.created_at,e.attempt_index AS attempt,NULL AS paid FROM experiments e JOIN wf_instances w ON w.id=e.id JOIN projects p ON p.id=e.project_id LEFT JOIN actors a ON a.id=e.owner_id${order}`,
        'project',
      );
    else unavailable.push('Project experiments');
    if (tables.has('customer_experiments'))
      await collect(
        `SELECT e.id,e.owner_id,e.project_id,p.name AS project,e.title,COALESCE(e.email,'Not provided yet') AS customer,w.state,w.updated_at,e.created_at,e.attempts AS attempt,CASE WHEN e.payment_id IS NULL THEN 0 ELSE 1 END AS paid FROM customer_experiments e JOIN wf_instances w ON w.id=e.id JOIN projects p ON p.id=e.project_id${order}`,
        'standalone',
      );
    else unavailable.push('Standalone experiments');
    if (tables.has('customer_experiment_requests')) {
      // Project only these fields; never return the idempotency secret, capabilities or checkout URL.
      for (const r of await sql.all<{ id: string; experiment_id: string }>(
        "SELECT id,data_json::jsonb->>'experimentId' AS experiment_id FROM customer_experiment_requests",
      )) {
        const row = rows.find((x) => x.id === r.experiment_id);
        if (row) row.requestId = r.id;
      }
    }
    if (tables.has('worker_sessions')) {
      const sessions = await sql.all<{ instance_id: string; status: string; expires_at: string }>(
        "SELECT instance_id,status,session_json::jsonb->>'expiresAt' AS expires_at FROM worker_sessions WHERE status IN ('offered','active')",
      );
      for (const s of sessions) {
        const row = rows.find((r) => r.id === s.instance_id);
        if (row && Date.parse(s.expires_at) > Date.now()) {
          row.sessions++;
          row.activity = s.status === 'active' ? 'Agent working' : 'Agent starting';
        }
      }
    } else unavailable.push('Agent sessions');
    const short = (id: string) =>
      (id.match(/[a-f0-9]{8}-[a-f0-9-]{27}/i)?.[0] ?? id.replace(/^[a-z]+_/, '')).slice(0, 4);
    const opaque = (value: string) =>
      /[a-f0-9]{8}-[a-f0-9-]{27}/i.test(value) || /^(actor|user|wf|ce)_[a-z0-9_-]+$/i.test(value);
    const users = new Map<
      string,
      { key: string; label: string; experiments: number; active: number }
    >();
    if (tables.has('shared_users') && tables.has('member_actors')) {
      const people = await sql.all<{
        issuer: string;
        subject: string;
        actor_id: string | null;
        name: string | null;
      }>(
        'SELECT u.issuer,u.subject,m.actor_id,a.name FROM shared_users u LEFT JOIN member_actors m ON m.issuer=u.issuer AND m.subject=u.subject LEFT JOIN actors a ON a.id=m.actor_id',
      );
      for (const p of people) {
        const key = p.issuer + '|' + p.subject;
        const configured = identities.find(
          (i) => i.issuer === p.issuer && i.subject === p.subject,
        )?.label;
        const label =
          configured ||
          (p.name && !opaque(p.name) && p.name !== p.subject ? p.name : short(p.subject));
        if (!users.has(key) || configured || (p.name && !opaque(p.name) && p.name !== p.subject))
          users.set(key, { key, label, experiments: 0, active: 0 });
        for (const row of rows)
          if (row.source === 'project' && row.customerKey === 'actor:' + p.actor_id)
            row.customerKey = key;
      }
    }
    for (const row of rows) {
      if (!users.has(row.customerKey))
        users.set(row.customerKey, {
          key: row.customerKey,
          label: row.customerKey.startsWith('guest:')
            ? 'Guest · ' + short(row.requestId ?? row.id)
            : opaque(row.customer)
              ? short(row.customer)
              : row.customer,
          experiments: 0,
          active: 0,
        });
      const user = users.get(row.customerKey)!;
      row.customer = user.label;
      user.experiments++;
      if (!['complete', 'failed', 'abandoned'].includes(row.state)) user.active++;
    }
    rows.sort(
      (a, b) =>
        Number(['complete', 'failed', 'abandoned'].includes(a.state)) -
          Number(['complete', 'failed', 'abandoned'].includes(b.state)) ||
        b.updatedAt.localeCompare(a.updatedAt),
    );
    return {
      users: [...users.values()].sort(
        (a, b) =>
          b.active - a.active || b.experiments - a.experiments || a.label.localeCompare(b.label),
      ),
      at: new Date().toISOString(),
      rows: rows.slice(0, 1000),
      truncated: rows.length > 1000,
      unavailable,
    };
  });
}
export function adminHttp(state: State, admins: AdminIdentity[]): MountHandler {
  return async (req, res, r) => {
    requireAdmin(r.principal, admins);
    if (req.method !== 'GET' || r.url.pathname !== '/admin/experiments')
      throw new MervError('not_found', 'Route not found', 404);
    res.setHeader('Cache-Control', 'private, no-store');
    return adminOverview(state, admins);
  };
}

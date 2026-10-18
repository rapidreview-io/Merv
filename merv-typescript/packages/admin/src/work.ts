import type { Context } from 'cordis';
import type { DelegationSource } from '@merv/contracts';
import type { AdminWork, AdminWorkRow } from './models.js';
import { loaded, type AdminEnv, type AdminIdentity, type AdminRoutes } from './index.js';

/**
 * The work table: every unit of work running anywhere, and every unit that ended in the last
 * day, joined in memory from each owner's platform read. Every fact keeps its owner's rule:
 * terminal states are each version's own, blockers are what their providers published (a
 * dispatch hold and a code base's state among them), a customer's move is Customer
 * Experiments', an agent's need is Sessions'. Intentionally global: never expose it through
 * project-scoped tools or machine keys.
 */

/** A name that is an identifier (a UUID, a minted id's hex) names nobody. */
const opaque = (name: string) => /[0-9a-f]{8}-[0-9a-f]{4}|[0-9a-f]{16,}/i.test(name);

export async function adminWork(
  ctx: Pick<Context, 'get'>,
  admins: readonly AdminIdentity[],
): Promise<AdminWork> {
  const at = new Date().toISOString();
  const since = new Date(Date.parse(at) - 86_400_000).toISOString();
  const { get, unavailable } = loaded(ctx);
  const [workflows, sessions, fleet, pi, tasks, reflections, customers, scope] = [
    get('workflows'),
    get('sessions'),
    get('fleet'),
    get('pi'),
    get('tasks'),
    get('reflections'),
    get('customerExperiments'),
    get('scope'),
  ] as const;
  const work = (await workflows?.platformWork(since)) ?? [];
  const all = work.map(({ id }) => id);
  const turns = (await pi?.platformTurns(since)) ?? [];
  const visits = await sessions?.running.platform(work);
  const machines = new Map(
    // By its id, and by the unit it serves: a unit Sessions has no visit on yet still has one.
    ((await fleet?.platformAllocations()) ?? []).flatMap((a) => [
      [a.id, a],
      [a.work ?? a.id, a],
    ]),
  );
  const types = await tasks?.platformTypes(all);
  const lenses = await reflections?.platformLensNames(all);
  const standalone = await customers?.customers(work);
  const { people, projects } = (await scope?.directory()) ?? { people: [], projects: [] };
  const names = new Map(projects.map(({ id, name }) => [id, name]));

  // A person's label: the one configured for an admin, else a name one of their project actors
  // goes by.
  const labels = new Map<string, string>();
  const byActor = new Map<string, string>();
  for (const { issuer, subject, actors } of people) {
    const key = `${issuer}|${subject}`;
    labels.set(
      key,
      admins.find((a) => a.issuer === issuer && a.subject === subject)?.label ??
        actors.find(({ name }) => name !== subject && !opaque(name))?.name ??
        'Unnamed',
    );
    for (const { actorId } of actors) byActor.set(actorId, key);
  }
  // Work an agent or a service started, or whose starter is no member, is its project owner's.
  const identity = (source: DelegationSource) =>
    source.kind === 'human' ? `${source.issuer}|${source.subject}` : undefined;
  const owners = new Map(
    ((await scope?.projectOwners()) ?? []).map(({ projectId, source }) => [
      projectId,
      identity(source),
    ]),
  );
  const member = (key: string | undefined, projectId: string) =>
    labels.get(key || owners.get(projectId) || '') ?? 'Unassigned';
  const machine = (a: ReturnType<typeof machines.get>) =>
    a
      ? {
          phase: a.phase,
          profile: a.profile,
          provider: a.provider,
          sandboxId: a.runtime?.sandboxId ?? null,
          usdPerHour: a.usdPerHour ?? null,
        }
      : null;
  const project = (id: string) => ({ id, name: names.get(id) ?? id });

  const rows: AdminWorkRow[] = [
    ...work.map((unit) => {
      const { visit = null, usage = null } = visits?.get(unit.id) ?? {};
      const found = standalone?.get(unit.id);
      return {
        id: unit.id,
        kind: unit.workflow,
        type: types?.get(unit.id) ?? null,
        title: lenses?.get(unit.id) ?? unit.name,
        project: project(unit.projectId),
        // A standalone experiment's person is its customer, by sign-in, else the email they gave.
        person: !found
          ? member(unit.startedBy ? byActor.get(unit.startedBy) : undefined, unit.projectId)
          : ((found.issuer && labels.get(`${found.issuer}|${found.subject}`)) ??
            found.email ??
            (found.issuer ? 'Customer' : 'Guest')),
        state: unit.state,
        terminal: unit.terminal,
        attention: [
          ...unit.blockers.map(({ provider, code, message }) => ({
            reason: 'blocker' as const,
            provider,
            code,
            message,
          })),
          ...(unit.allowance ? [{ reason: 'allowance' as const, code: 'allowance' }] : []),
          ...(found?.waits ? [{ reason: 'customer' as const, code: found.waits }] : []),
          ...(visit?.need
            ? [{ reason: 'agent' as const, code: visit.need.code, message: visit.need.says }]
            : []),
        ],
        agent: visit && { role: visit.role, status: visit.status },
        machine: machine(machines.get(visit?.allocationId ?? '') ?? machines.get(unit.id)),
        lastActivity: visit?.lastActivity ?? unit.updatedAt,
        createdAt: unit.createdAt,
        updatedAt: unit.updatedAt,
        cost: usage,
        requestId: found?.requestId,
      };
    }),
    ...turns.map((turn) => {
      const moved = turn.completedAt ?? turn.startedAt ?? turn.createdAt;
      return {
        id: turn.id,
        kind: 'pi',
        type: null,
        title: turn.title,
        project: project(turn.projectId),
        person: member(identity(turn.source) ?? byActor.get(turn.source.actorId), turn.projectId),
        state: turn.status,
        terminal: !turn.live,
        attention: [],
        agent: null,
        machine: machine(machines.get(turn.runtimeId)),
        lastActivity: moved,
        createdAt: turn.createdAt,
        updatedAt: moved,
        cost: null,
      };
    }),
  ];
  return {
    rows: rows.sort(
      (a, b) =>
        Number(a.terminal) - Number(b.terminal) || b.lastActivity.localeCompare(a.lastActivity),
    ),
    at,
    unavailable,
  };
}

export const workRoutes = (env: AdminEnv): AdminRoutes => ({
  'GET /admin/work': async () => await adminWork(env.ctx, env.admins),
});

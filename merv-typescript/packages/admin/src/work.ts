import type { DelegationSource } from '@merv/contracts';
import type { AdminWork, AdminWorkRow } from './models.js';
import { personLabel, type AdminEnv } from './index.js';

/**
 * The work table: every unit of work running anywhere, and every unit that ended in the last
 * day, joined in memory from each owner's platform read. Every fact keeps its owner's rule:
 * terminal states are each version's own, blockers are what their providers published (a
 * dispatch hold and a code base's state among them), a customer's move is Customer
 * Experiments', an agent's need is Sessions'. Intentionally global: never expose it through
 * project-scoped tools or machine keys.
 */
export async function adminWork({ ctx, admins }: AdminEnv): Promise<AdminWork> {
  const at = new Date().toISOString();
  const since = new Date(Date.parse(at) - 86_400_000).toISOString();
  const work = (await ctx.get('workflows')?.platformWork(since)) ?? [];
  const ids = work.map(({ id }) => id);
  // One row per Agent conversation, its newest turn's (Pi answers newest first).
  const turns = new Map(
    ((await ctx.get('pi')?.platformTurns(since)) ?? []).reverse().map((t) => [t.conversationId, t]),
  );
  const visits = await ctx.get('sessions')?.running.platform(work);
  const machines = new Map(
    // By its id, and by the unit it serves: a unit Sessions has no visit on yet still has one.
    ((await ctx.get('fleet')?.platformAllocations()) ?? []).flatMap((a) => [
      [a.id, a],
      [a.work ?? a.id, a],
    ]),
  );
  const types = await ctx.get('tasks')?.platformTypes(ids);
  const lenses = await ctx.get('reflections')?.platformLenses(ids);
  const standalone = await ctx.get('customerExperiments')?.customers(work);
  const { people, projects } = await ctx.scope.directory();
  const names = new Map(projects.map(({ id, name }) => [id, name]));

  const labels = new Map<string, string>();
  const byActor = new Map<string, string>();
  for (const person of people) {
    const key = `${person.issuer}|${person.subject}`;
    labels.set(key, personLabel(admins, person) ?? 'Unnamed');
    for (const { actorId } of person.actors) byActor.set(actorId, key);
  }
  // Work an agent or a service started, or whose starter is no member, is its project owner's.
  const identity = (source: DelegationSource) =>
    source.kind === 'human' ? `${source.issuer}|${source.subject}` : undefined;
  const owners = new Map(
    (await ctx.scope.projectOwners()).map(({ projectId, source }) => [projectId, identity(source)]),
  );
  const member = (key: string | undefined, projectId: string) =>
    labels.get(key || owners.get(projectId) || '') ?? 'Unassigned';
  const machine = (a: ReturnType<typeof machines.get>) =>
    a
      ? {
          phase: a.phase,
          profile: a.profile,
          provider: a.provider,
          usdPerHour: a.usdPerHour ?? null,
        }
      : null;
  const project = (id: string) => ({ id, name: names.get(id) ?? id });

  // Unordered: the page puts what needs someone first.
  const rows: AdminWorkRow[] = [
    ...work.map((unit) => {
      const { visit = null, usage = null } = visits?.get(unit.id) ?? {};
      const found = standalone?.get(unit.id);
      return {
        id: unit.id,
        kind: unit.workflow,
        type: types?.get(unit.id),
        title: lenses?.get(unit.id)?.name ?? unit.name,
        parent: lenses?.get(unit.id)?.reflectionId,
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
          ...unit.blockers.map(({ code, message }) => ({
            reason: 'blocker' as const,
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
        cost: usage,
        requestId: found?.requestId,
      };
    }),
    ...[...turns.values()].map((turn) => ({
      id: turn.conversationId,
      kind: 'pi',
      title: turn.title,
      project: project(turn.projectId),
      person: member(identity(turn.source) ?? byActor.get(turn.source.actorId), turn.projectId),
      state: turn.status,
      terminal: !turn.live,
      attention: [],
      machine: machine(machines.get(turn.runtimeId)),
      lastActivity: turn.completedAt ?? turn.startedAt ?? turn.createdAt,
      createdAt: turn.createdAt,
    })),
  ];
  return { rows, at };
}

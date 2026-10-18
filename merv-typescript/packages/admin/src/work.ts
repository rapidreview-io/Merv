import type { Context } from 'cordis';
import type { DelegationSource, RunningPhrase } from '@merv/contracts';
import type { AdminEnv, AdminRoutes } from './index.js';
import type { AdminIdentity } from './models.js';

/**
 * The work table: every unit of work running anywhere, and every unit that ended in the last
 * day, joined in memory from each owner's platform read. Every fact keeps its owner's rule:
 * terminal states are each version's own, blockers are what their providers published (a
 * dispatch hold and a code base's state among them), a customer's move is Customer
 * Experiments', an agent's need is Sessions'. Intentionally global: never expose it through
 * project-scoped tools or machine keys.
 */

/** What the table calls each workflow's units; any other workflow keeps its own name. */
const KINDS: Record<string, string> = {
  service_experiment: 'standalone experiment',
  'reflection.lens': 'reflection lens',
  research: 'research cycle',
};
/** What the table says of the moves it names itself, by code, else by reason. */
const SAYS: Record<string, string> = {
  allowance: 'Waits for an admin to allow another round',
  approval: 'Waits for the customer to approve the plan',
  payment: 'Waits for the customer to pay',
};
const said = (reason: AdminAttention['reason'], code: string | null | undefined) =>
  code ? [{ reason, code, message: SAYS[code] ?? SAYS[reason]! }] : [];

/** Why a unit may need someone: an owner's blocker, an admin's allowance, a customer, an agent. */
export interface AdminAttention {
  reason: 'blocker' | 'allowance' | 'customer' | 'agent';
  /** The blocker's publisher. */
  provider?: string;
  code: string;
  /** The owner's words: an agent's need is a phrase Sessions writes, as the Running page shows. */
  message: string | RunningPhrase;
}
export interface AdminPerson {
  /** `issuer|subject` for a signed-in identity, else `email:` or `guest:`. */
  key: string;
  label: string;
  active: number;
  total: number;
}
export interface AdminWorkRow {
  id: string;
  kind: string;
  /** The owner's type name, where it has one (`task.work`). */
  type: string | null;
  title: string;
  project: { id: string; name: string };
  person: { key: string; label: string };
  state: string;
  terminal: boolean;
  attention: AdminAttention[];
  /** The live work visit at the unit's revision. */
  agent: { role: string; status: string } | null;
  machine: {
    phase: string;
    profile: string | null;
    provider: string | null;
    sandboxId: string | null;
    usdPerHour: number | null;
  } | null;
  lastActivity: string;
  createdAt: string;
  /** Its last transition. */
  updatedAt: string;
  /** Its closed work visits; runners report tokens unverified, and no visit reports a price. */
  cost: {
    sessions: number;
    reportedSessions: number;
    wallMs: number;
    inputTokens: number;
    outputTokens: number;
  } | null;
}
export interface AdminWork {
  rows: AdminWorkRow[];
  /** Every signed-in identity, with or without work, and every customer on a row. */
  people: AdminPerson[];
  at: string;
  /** The owners not loaded here, whose facts the table lacks. */
  unavailable: string[];
}

const uuid = /[a-f0-9]{8}-[a-f0-9-]{27}/i;
const short = (id: string) => (id.match(uuid)?.[0] ?? id.replace(/^[a-z]+_/, '')).slice(0, 4);
const opaque = (name: string) => uuid.test(name) || /^(actor|user|wf|ce)_[a-z0-9_-]+$/i.test(name);

export async function adminWork(
  ctx: Pick<Context, 'get'>,
  admins: readonly AdminIdentity[],
): Promise<AdminWork> {
  const at = new Date().toISOString();
  const since = new Date(Date.parse(at) - 86_400_000).toISOString();
  const unavailable: string[] = [];
  const get = <K extends keyof Context & string>(name: K): Context[K] | undefined =>
    ctx.get(name) ?? void unavailable.push(name);
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
  const { people: members, projects } = (await scope?.directory()) ?? { people: [], projects: [] };
  const names = new Map(projects.map(({ id, name }) => [id, name]));

  // A person's label: the one configured for an admin, else a name one of their project actors
  // goes by, else the first characters of their subject.
  const people = new Map<string, AdminPerson>();
  const byActor = new Map<string, string>();
  const person = (key: string, label: string) =>
    people.get(key) ?? people.set(key, { key, label, active: 0, total: 0 }).get(key)!;
  for (const { issuer, subject, actors } of members) {
    const key = `${issuer}|${subject}`;
    const label =
      admins.find((a) => a.issuer === issuer && a.subject === subject)?.label ??
      actors.find(({ name }) => name !== subject && !opaque(name))?.name;
    people.set(key, { key, label: label ?? short(subject), active: 0, total: 0 });
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
    person(key || owners.get(projectId) || 'nobody', 'Unassigned');
  const starter = ({ startedBy, projectId }: (typeof work)[number]) =>
    member(startedBy ? byActor.get(startedBy) : undefined, projectId);
  const customer = (unit: (typeof work)[number]) => {
    const found = standalone?.get(unit.id);
    if (!found) return starter(unit);
    if (found.issuer) return person(`${found.issuer}|${found.subject}`, found.email ?? 'Customer');
    if (found.email) return person(`email:${found.email.toLowerCase()}`, found.email);
    return person(`guest:${found.requestId}`, `Guest · ${short(found.requestId)}`);
  };
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
      const owner = customer(unit);
      return {
        id: unit.id,
        kind: KINDS[unit.workflow] ?? unit.workflow,
        type: types?.get(unit.id) ?? null,
        title: lenses?.get(unit.id) ?? unit.name,
        project: project(unit.projectId),
        person: { key: owner.key, label: owner.label },
        state: unit.state,
        terminal: unit.terminal,
        attention: [
          ...unit.blockers.map(({ provider, code, message }) => ({
            reason: 'blocker' as const,
            provider,
            code,
            message,
          })),
          ...said('allowance', unit.allowance ? unit.state : null),
          ...said('customer', standalone?.get(unit.id)?.waits),
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
      };
    }),
    ...turns.map((turn) => {
      const owner = member(
        identity(turn.source) ?? byActor.get(turn.source.actorId),
        turn.projectId,
      );
      const moved = turn.completedAt ?? turn.startedAt ?? turn.createdAt;
      return {
        id: turn.id,
        kind: 'pi turn',
        type: null,
        title: turn.title,
        project: project(turn.projectId),
        person: { key: owner.key, label: owner.label },
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
  for (const row of rows) {
    const counted = people.get(row.person.key)!;
    counted.total++;
    if (!row.terminal) counted.active++;
  }
  return {
    rows: rows.sort(
      (a, b) =>
        Number(a.terminal) - Number(b.terminal) || b.lastActivity.localeCompare(a.lastActivity),
    ),
    people: [...people.values()].sort(
      (a, b) => b.active - a.active || b.total - a.total || a.label.localeCompare(b.label),
    ),
    at,
    unavailable,
  };
}

export const workRoutes = (env: AdminEnv): AdminRoutes => ({
  'GET /admin/work': async () => await adminWork(env.ctx, env.admins),
});

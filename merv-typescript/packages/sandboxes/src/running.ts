import {
  clip,
  runningKey,
  runningKeyPattern,
  type Json,
  type RunningAction,
  type RunningAttention,
  type RunningFact,
  type RunningMoney,
  type RunningNode,
  type RunningNodes,
  type RunningPanelPart,
  type RunningPhrase,
  type RunningSection,
  type RunningSummary,
  type RunningValue,
} from '@merv/contracts';
import type { SandboxMachines, SandboxRow } from './types.js';

/**
 * The Running page's sandboxes: what each machine is, what it is doing, what it costs, and
 * when it needs a person, read from the rows and records SandboxService holds in memory.
 * Nothing here reads merv-sandboxes, so a board read never waits on it. Red is decided here
 * rather than taken from the service's own attention text, because on this page red is a
 * move a person can make.
 */

/** The machine list the Hardware lane draws: the service reads it on its own timer. */
export const machinesRoute = '/v1/sandboxes';

/** A failed machine is news for an hour, then history. */
const FAILED_FOR_MS = 3_600_000;
/** Under a running job, a lease this close to its end needs a person to extend it or let it go. */
const LEASE_SHORT_MS = 15 * 60_000;
/** Who ends every red wait here: the tools' own write permission. */
const WHO = 'A producer or operator extends or releases it.';
/** The check runner names its machines so (checks.ts); Code keeps and reclaims them itself. */
const CHECK_MACHINE = 'merv-check-';
const DRAWN = new Set(['provisioning', 'ready', 'unknown', 'deleting', 'failed']);
const LEASED = new Set(['provisioning', 'ready', 'unknown']);
const RELEASABLE = new Set(['provisioning', 'ready', 'unknown', 'failed']);
/** The service's verdicts for a job in hand, in a person's words. */
const WORKING = new Map([
  ['running', 'Running'],
  ['starting', 'Starting'],
  ['cancelling', 'Cancelling'],
]);
const LOOKS: Record<string, RunningNode['look']> = { provisioning: 'dashed', deleting: 'quiet' };
const JOB_ENDS = new Set(['succeeded', 'failed', 'timed_out', 'cancelled']);

type Loose = Record<string, unknown>;
const object = (value: unknown): Loose =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Loose) : {};
const text = (value: unknown, max = 200) =>
  typeof value === 'string' && value.trim() ? clip(value.trim(), max) : undefined;
const number = (value: unknown) => {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : undefined;
};
const instant = (value: unknown) =>
  typeof value === 'string' && value.length <= 64 && !Number.isNaN(Date.parse(value))
    ? value
    : undefined;
/** Money as the service sends it, a decimal amount and a currency; anything else is unknown. */
function money(value: unknown): RunningMoney | null {
  const { amount, currency } = object(value);
  const figure = typeof amount === 'number' && Number.isFinite(amount) ? String(amount) : amount;
  return typeof figure === 'string' &&
    /^-?\d{1,15}(\.\d{1,12})?$/.test(figure) &&
    typeof currency === 'string' &&
    /^[A-Z]{3}$/.test(currency)
    ? { amount: figure, currency }
    : null;
}
/** Long machine text keeps its head and says it was cut. */
const cut = (value: string, max: number) =>
  value.length > max ? `${clip(value, max - 1)}…` : value;

/** One sandbox, as the lane and its sidebar read it. */
interface Machine {
  id: string;
  key: string;
  name?: string;
  state: string;
  verdict?: string;
  /** The service's middle clause: the provisioning step, or why it failed. */
  clause?: string;
  /** Since when the standing holds: the job's start, idle since, or the provisioning step. */
  at?: string;
  lease?: string;
  leaseSeconds?: number;
  cost: RunningMoney | null;
  rate: RunningMoney | null;
  gpu?: string;
  gpus: number;
  cpu?: number;
  memoryMb?: number;
  provider?: string;
  region?: string;
  /** Code's check machine: Code keeps it and gives it back, so no one else is asked to. */
  check: boolean;
}

function machineOf(value: unknown): Machine | null {
  const row = object(value);
  const id = typeof row.id === 'string' ? row.id : '';
  const key = runningKey('sandbox', id);
  if (!runningKeyPattern.test(key)) return null;
  const activity = object(row.activity);
  const resources = object(row.resources);
  const name = text(row.name);
  const gpus = number(resources.gpu_count);
  return {
    id,
    key,
    ...(name ? { name } : {}),
    state: text(row.state, 40) ?? '',
    verdict: text(activity.verdict, 40),
    clause: text(activity.clause),
    at: instant(activity.at),
    lease: instant(row.lease_expires_at),
    leaseSeconds: number(row.lease_seconds),
    cost: money(row.cost_so_far),
    rate: money(row.hourly_price),
    gpu: text(resources.gpu, 60),
    gpus: gpus && gpus > 0 ? Math.floor(gpus) : 0,
    cpu: number(resources.cpu),
    memoryMb: number(resources.memory_mb),
    provider: text(row.plugin, 60),
    region: text(object(row.offer).region, 60),
    check: !!name?.startsWith(CHECK_MACHINE),
  };
}

/** What the machine is, the way a person names it: '8× H100', 'A100', 'CPU · 16 vCPU'. */
function accelerator(machine: Machine): string {
  if (machine.gpus > 0)
    return machine.gpus === 1 && machine.gpu
      ? machine.gpu
      : `${machine.gpus}× ${machine.gpu ?? 'GPU'}`;
  return machine.cpu ? `CPU · ${machine.cpu} vCPU` : 'CPU';
}

/** The job in hand on a ready machine, in words; undefined while the machine is idle. */
const working = (machine: Machine) =>
  machine.state === 'ready' ? WORKING.get(machine.verdict ?? '') : undefined;
/** A job that holds the machine: running, or starting to. One being cancelled is letting go. */
const jobRunning = (machine: Machine) =>
  machine.state === 'ready' && (machine.verdict === 'running' || machine.verdict === 'starting');
/** Words, then how long they have held when the service said since when: 'Running 22m'. */
const held = (word: string, at?: string): RunningPhrase =>
  at ? [`${word} `, { since: at }] : [word];
/** Facts read in order with the page's one separator; a fact nobody sent is left out. */
const line = (...parts: (RunningValue | undefined)[]): RunningPhrase =>
  parts
    .filter((part) => part !== undefined)
    .flatMap((part, at): RunningValue[] => (at ? [' · ', part] : [part]));

/** The face's standing: 'Running 22m', 'Idle 6m', 'Provisioning 4m', 'Releasing'. */
function standing(machine: Machine): RunningPhrase {
  switch (machine.state) {
    case 'provisioning':
      return held('Provisioning', machine.at);
    case 'deleting':
      return ['Releasing'];
    case 'stopped':
      return ['Released'];
    case 'failed':
      return ['Failed'];
    case 'unknown':
      return ['Connection lost'];
    default:
      return held(working(machine) ?? 'Idle', machine.at);
  }
}

/**
 * The sidebar's standing: the verdict with its clock, and the service's clause only where the
 * rest of the sidebar does not already say it, the provisioning step or why it failed.
 */
function status(machine: Machine): RunningPhrase {
  const since = machine.at ? { since: machine.at } : undefined;
  switch (machine.state) {
    case 'provisioning':
      return line('Provisioning', machine.clause, since);
    case 'failed':
      return line('Failed', machine.clause, machine.at ? { ago: machine.at } : undefined);
    case 'ready':
      return line(working(machine) ?? 'Idle', since);
    default:
      return standing(machine);
  }
}

/** A job still holds the machine while its lease runs short, or after it has run out. */
function leaseEnding(machine: Machine, now: number): boolean {
  return (
    !machine.check &&
    jobRunning(machine) &&
    !!machine.lease &&
    Date.parse(machine.lease) - now < LEASE_SHORT_MS
  );
}

/**
 * Red only where a person has a move: a machine that failed in the last hour, one the service
 * cannot reach, and a running job whose lease runs out. An idle machine still bills, but the
 * list cannot see an open shell on it, so idle is never red. Code's check machines are Code's
 * to reclaim, so they are never red here.
 */
function attentionOf(machine: Machine, now: number): RunningAttention | undefined {
  if (machine.check) return undefined;
  if (machine.state === 'failed')
    return { says: machine.at ? ['Failed ', { ago: machine.at }] : ['Failed'], who: WHO };
  if (machine.state === 'unknown') return { says: ['Connection lost'], who: WHO };
  if (!leaseEnding(machine, now)) return undefined;
  return Date.parse(machine.lease!) <= now
    ? { says: ['Lease ended ', { ago: machine.lease! }], who: WHO }
    : { says: ['Lease ends in ', { until: machine.lease! }], who: WHO };
}

/** Machines in flight: stopped ones never, failed ones for an hour after they failed. */
const drawn = (machines: SandboxMachines, now: number): Machine[] =>
  machines.rows
    .map(machineOf)
    .filter(
      (machine): machine is Machine =>
        !!machine &&
        DRAWN.has(machine.state) &&
        (machine.state !== 'failed' ||
          (!!machine.at && now - Date.parse(machine.at) < FAILED_FOR_MS)),
    );

/** Working machines first, then those still arriving, then idle ones, then those leaving. */
function rankOf(machine: Machine): number {
  if (machine.state === 'provisioning') return 1;
  if (machine.state !== 'ready') return 3;
  return working(machine) ? 0 : 2;
}

function nodeOf(machine: Machine, now: number): RunningNode {
  const attention = attentionOf(machine, now);
  return {
    key: machine.key,
    lane: 'hardware',
    title: accelerator(machine),
    ...(machine.name ? { name: machine.name } : {}),
    lines: [standing(machine), ...(machine.rate ? [[{ money: null, rate: machine.rate }]] : [])],
    look: LOOKS[machine.state] ?? 'solid',
    ...(attention ? { attention } : {}),
    // One cell per accelerator, or one for a CPU machine; filled while a job is in hand.
    units: { count: Math.min(Math.max(machine.gpus, 1), 64), busy: !!working(machine) },
    rank: rankOf(machine),
  };
}

/**
 * The Hardware lane's sandboxes. Nothing is known until the cache has answered once, which is
 * not the same as nothing running; after that the rows carry when they were read and how long
 * that stays current, and a refresh that failed says the rows are from before it.
 */
export function machineNodes(machines: SandboxMachines | null, now: number): RunningNodes {
  if (!machines) return { nodes: [], pending: true };
  return {
    nodes: drawn(machines, now).map((machine) => nodeOf(machine, now)),
    ...(machines.observedAt ? { asOf: machines.observedAt, freshForMs: machines.freshForMs } : {}),
    ...(machines.failed ? { failed: true } : {}),
  };
}

/** The lane's own line: what the drawn sandboxes cost an hour together, in their one currency. */
export function machinesSummary(
  machines: SandboxMachines | null,
  now: number,
): RunningSummary | null {
  if (!machines) return null;
  const rates = drawn(machines, now)
    .map(({ rate }) => rate)
    .filter((rate) => rate !== null);
  const currency = rates[0]?.currency;
  if (!currency || rates.some((rate) => rate.currency !== currency)) return null;
  const total = rates.reduce((sum, rate) => sum + Number(rate.amount), 0);
  return {
    lane: 'hardware',
    says: ['Sandboxes ', { money: null, rate: { amount: total.toFixed(4), currency } }],
    actions: [],
  };
}

/** The Sandboxes row's record page for one machine: the row that publishes the machine list. */
export function recordRoute(rows: readonly SandboxRow[], id: string): string | undefined {
  const row = rows.find((candidate) => object(candidate.view.spec).read === machinesRoute);
  return row && `${row.path}/${encodeURIComponent(id)}`;
}

export interface MachinePanelInput {
  id: string;
  machines: SandboxMachines | null;
  /** The machine's record, once a watched read of it has answered. */
  record: Json | null;
  /** The tools' own permission, as this caller holds it. */
  allowed: boolean;
  /** Set when another node took this machine in: only what still says something there. */
  absorbedBy?: string;
  route?: string;
  now: number;
}

/**
 * One machine's sidebar: what it costs and how long its lease has left, what runs on it, what
 * holds it open, and what it is. The record, read every few seconds while the sidebar is open,
 * is newer than the list row and speaks first where both do; until it has answered, the
 * sections that only it can fill are absent. Folded into a Code check, the machine keeps only
 * its cost and what it is: the check's own clock replaces the lease, and the job is the check's.
 */
export function machinePanel(input: MachinePanelInput): RunningPanelPart | null {
  const row = input.machines?.rows.find((candidate) => object(candidate).id === input.id);
  if (!row && !input.record) return null;
  const record = object(input.record);
  const machine = machineOf({ ...object(row), ...record });
  if (!machine) return null;
  const absorbed = input.absorbedBy !== undefined;
  const attention = attentionOf(machine, input.now);
  const ending = !absorbed && leaseEnding(machine, input.now);
  const jobs = Array.isArray(record.jobs) ? record.jobs.map(object) : [];
  // Newest first: the job in hand, or else the last one that ended with an exit code.
  const live = jobs.find((job) => !JOB_ENDS.has(String(job.state)) && !instant(job.finished_at));
  const last = jobs.find((job) => number(job.exit_code) !== undefined);
  const command = text(live?.command, 10_000);
  const open = Array.isArray(record.sessions)
    ? record.sessions.filter((session) => object(session).outcome === 'open').length
    : 0;

  const now: RunningFact[] = [];
  if (machine.cost)
    now.push({
      label: 'Cost so far',
      value: [{ money: machine.cost, ...(machine.rate ? { rate: machine.rate } : {}) }],
    });
  else if (machine.rate) now.push({ label: 'Rate', value: [{ money: null, rate: machine.rate }] });
  if (!absorbed && machine.lease && LEASED.has(machine.state))
    now.push({
      label: 'Lease left',
      value: [
        { until: machine.lease, ...(machine.leaseSeconds ? { of: machine.leaseSeconds } : {}) },
      ],
      ...(ending ? { attention: true } : {}),
    });

  const running: RunningFact[] = [];
  if (live) {
    if (command) running.push({ label: 'Command', value: [{ mono: cut(command, 400) }] });
  } else if (last) {
    const finished = instant(last.finished_at);
    running.push({
      label: 'Last exit',
      value: [`exit ${number(last.exit_code)}`, ...(finished ? [' · ', { ago: finished }] : [])],
    });
  }
  // Nothing in Merv records who uses a sandbox; the connections open on it are what is known.
  const used: RunningFact[] = open
    ? [{ label: 'Connections', value: [{ count: open }, ' open'] }]
    : [];

  const memory =
    machine.memoryMb === undefined
      ? undefined
      : machine.memoryMb >= 1024
        ? `${(machine.memoryMb / 1024).toFixed(1)} GB`
        : `${machine.memoryMb} MiB`;
  const size = [
    machine.gpus > 0 ? `${machine.gpus}× ${machine.gpu ?? 'GPU'}` : undefined,
    machine.cpu === undefined ? undefined : `${machine.cpu} vCPU`,
    memory,
  ].filter((part) => part !== undefined);
  const where = [machine.provider, machine.region].filter((part) => part !== undefined);
  const hardware: RunningFact[] = [];
  if (size.length) hardware.push({ label: 'Size', value: [size.join(' · ')] });
  if (where.length) hardware.push({ label: 'Provider', value: [where.join(' · ')] });

  const facts = (
    title: string,
    place: RunningSection['place'],
    rows: RunningFact[],
    red = false,
  ): RunningSection[] =>
    rows.length ? [{ title, place, kind: 'facts', rows, ...(red ? { attention: true } : {}) }] : [];
  // The sidebar has room for why a machine failed, which its card leaves out.
  const head =
    attention && machine.state === 'failed' ? { ...attention, says: status(machine) } : attention;
  return {
    header: {
      kind: 'Sandbox',
      title: machine.name ?? accelerator(machine),
      says: status(machine),
      ...(head ? { attention: head } : {}),
    },
    sections: [
      ...facts('Now', 'activity', now, ending),
      ...(absorbed
        ? []
        : [...facts('Running', 'activity', running), ...facts('Used by', 'relations', used)]),
      ...facts('Machine', 'machine', hardware),
    ],
    actions: absorbed ? [] : actionsOf(machine, command, input.allowed),
    ...(input.route ? { route: input.route } : {}),
    live: ['provisioning', 'deleting', 'unknown'].includes(machine.state) || !!working(machine),
  };
}

/**
 * Extend lease on a ready machine and Release machine on any the service still holds, under
 * the tools' own write permission. A Code check machine is offered neither: releasing it fails
 * the check, and Code gives its machines back itself.
 */
function actionsOf(
  machine: Machine,
  command: string | undefined,
  allowed: boolean,
): RunningAction[] {
  if (machine.check) return [];
  const actions: RunningAction[] = [];
  const input = { id: machine.id };
  if (machine.state === 'ready')
    actions.push({
      label: 'Extend lease',
      verb: 'extend',
      tool: 'sandbox.extend',
      input: { ...input, seconds: 3600 },
      allowed,
    });
  if (!RELEASABLE.has(machine.state)) return actions;
  const where = machine.provider ? ` at ${machine.provider}` : '';
  const stops = command
    ? `, and ${cut(command, 160)} stops with it`
    : jobRunning(machine)
      ? ', and the job running on it stops with it'
      : '';
  actions.push({
    label: 'Release machine',
    verb: 'release',
    tool: 'sandbox.release',
    input,
    allowed,
    guard: {
      title: 'Release this machine?',
      consequence: `Deletes this ${accelerator(machine)}${where} now${stops}. Retained job logs stay readable.`,
    },
  });
  return actions;
}

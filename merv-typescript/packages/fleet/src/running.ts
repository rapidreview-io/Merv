import {
  keyId,
  runningKey,
  runningKeyPattern,
  type RunningAttention,
  type RunningFact,
  type RunningKey,
  type RunningNode,
  type RunningPanelPart,
  type RunningPhrase,
  type RunningSection,
} from '@merv/contracts';
import type { RunningContribution } from '@merv/ui/types';
import type { Fleet, FleetAllocation, FleetPhase } from './types.js';

/**
 * Fleet's words, which its own page and the Running page both read, and Fleet's part of the
 * Running page. Every open allocation is a machine in the sessions lane until a session binds
 * it; then the session's node absorbs it and the Fleet machine section follows the session's
 * sidebar. Fleet adds no controls there, and no size or price.
 */

/** A person's word for a phase: waiting has no machine yet; starting is preparing one. */
const words: Partial<Record<FleetPhase, string>> = {
  queued: 'waiting',
  provisioning: 'starting',
  uncertain: 'retrying',
};
/** A Pi host is one person's agent machine in one project, shared by their conversations. */
const titles: Record<string, string> = { 'pi-host': 'Agent machine', workflow: 'Workflow agent' };

export const titleOf = (a: FleetAllocation): string => titles[a.owner.kind] ?? 'Hosted agent';
export const statusOf = (a: FleetAllocation): string =>
  a.phase !== 'released'
    ? { run: words[a.phase] ?? a.phase, drain: 'finishing', stop: 'stopping' }[a.intent]
    : a.error === 'runtime_refused' || a.error === 'wallet_refused'
      ? 'refused'
      : 'stopped';
/** Fleet keeps a launched machine, and its worker admission, while its lease lasts. */
const kept = (a: FleetAllocation) =>
  !!a.runtime && (a.phase === 'starting' || a.phase === 'running');
/**
 * Retries back off to a minute; only a live request failing that long needs a person. A
 * machine Fleet still keeps is working: then only the service is not answering about it.
 */
export const failing = (a: FleetAllocation): string | null =>
  a.phase !== 'released' && a.intent !== 'stop' && a.error && a.failures >= 5
    ? kept(a)
      ? 'The sandbox service is not answering about this machine'
      : `${a.runtime ? 'This machine is not answering' : 'No machine yet'}: the sandbox service keeps failing`
    : null;

/** On its way: no machine yet, or one not yet taking work. */
const STARTING = new Set(['waiting', 'starting', 'launching', 'retrying']);
/** Going away: finishing its work, or stopping. */
const ENDING = new Set(['finishing', 'stopping', 'releasing']);
/** The provider's own word, shown only where it explains trouble. */
const TROUBLE = new Set(['unknown', 'failed', 'deleting', 'stopped']);
const who = "An operator checks the project's sandbox connection";

const open = (a: FleetAllocation) => a.phase !== 'released';
const failures = (n: number): RunningPhrase => [{ count: n }, n === 1 ? ' failure' : ' failures'];

/** What refused a request before any machine existed; without a connection Fleet asks nobody. */
const refusal = (a: FleetAllocation): string | null =>
  a.error === 'wallet_refused'
    ? 'Refused · spending limit · '
    : a.error !== 'runtime_refused'
      ? null
      : a.createAttempted === false
        ? 'Refused · no sandbox connection · '
        : 'Refused by the sandbox service · ';

/** The status word, then how long it has stood, or how often the service has failed it. */
function standing(a: FleetAllocation): RunningPhrase {
  const status = statusOf(a);
  const said = `${status.charAt(0).toUpperCase()}${status.slice(1)} · `;
  if (!open(a)) return [refusal(a) ?? said, { ago: a.updatedAt }];
  return a.failures > 0 && a.intent !== 'stop'
    ? [said, ...failures(a.failures)]
    : [said, { since: a.updatedAt }];
}

/**
 * A request the service keeps failing. While Fleet keeps its machine working, that is said in
 * ink. A refusal is not red: the next request for the same work may already be running.
 */
function attention(a: FleetAllocation): RunningAttention | undefined {
  const failure = failing(a);
  if (!failure) return undefined;
  return kept(a) ? { says: [failure], quiet: true } : { says: [failure], who };
}

/** The step a workflow rented for: its owner id is `<instanceId>:<revision>`. */
function rentedFor(a: FleetAllocation): RunningKey | null {
  const id = a.owner.kind === 'workflow' ? /^(.+):\d+$/.exec(a.owner.id)?.[1] : undefined;
  const key = id && runningKey('work', id);
  return key && runningKeyPattern.test(key) ? key : null;
}

/** An open allocation's node in the sessions lane. */
export function fleetNode(a: FleetAllocation): RunningNode {
  const status = statusOf(a);
  const need = attention(a);
  const work = rentedFor(a);
  // Sandboxes hides Fleet's machines; should one show there after all, it is drawn here, once.
  const machine = a.runtime && runningKey('sandbox', a.runtime.sandboxId);
  return {
    key: runningKey('fleet', a.id),
    lane: 'sessions',
    title: titleOf(a),
    // Only a machine the service made is a VM; before that there is only the request.
    lines: a.runtime ? [standing(a), ['on a Fleet VM']] : [standing(a)],
    look: STARTING.has(status) ? 'dashed' : ENDING.has(status) ? 'quiet' : 'solid',
    ...(STARTING.has(status) ? { dot: 'starting' as const } : {}),
    ...(need ? { attention: need } : {}),
    // Why it was rented, not what it will run: its runner takes whichever work comes first.
    ...(work ? { links: [{ to: work, verb: 'rented for' as const, waiting: true }] } : {}),
    ...(machine && runningKeyPattern.test(machine) ? { aliases: [machine] } : {}),
  };
}

/**
 * An allocation's sidebar. Absorbed by the session it runs, only the Fleet machine section
 * is kept, without what the session already says: that it runs, and when it was asked for.
 */
export function fleetPanel(a: FleetAllocation, absorbedBy?: string): RunningPanelPart {
  const status = statusOf(a);
  const need = attention(a);
  const red = need?.quiet ? undefined : need;
  const rows: RunningFact[] = [];
  if (!(absorbedBy && status === 'running'))
    rows.push({ label: 'Status', value: [{ state: status }] });
  if (open(a) && a.intent !== 'stop')
    rows.push({
      label: a.phase === 'queued' ? 'Gives up' : 'Time remaining',
      value: [{ until: a.deadlineAt }],
    });
  if (need?.quiet) rows.push({ label: 'Sandbox service', value: ['not answering'] });
  else if (need) rows.push({ label: 'Needs you', value: need.says, attention: true });
  if (open(a) && a.failures > 0) rows.push({ label: 'Retries', value: failures(a.failures) });
  if (a.runtime && TROUBLE.has(a.runtime.state))
    rows.push({ label: 'Provider', value: [{ state: a.runtime.state }] });
  if (!absorbedBy) rows.push({ label: 'Requested', value: [{ ago: a.createdAt }] });
  const sections: RunningSection[] = [
    {
      title: 'Fleet machine',
      place: 'machine',
      kind: 'facts',
      rows,
      ...(red ? { attention: true } : {}),
    },
  ];
  // Once a session holds the machine, the session's own work is the truth.
  const work = !absorbedBy && rentedFor(a);
  if (work)
    sections.push({
      title: 'Rented for',
      place: 'relations',
      kind: 'links',
      rows: [{ to: { key: work }, name: 'Open the work' }],
    });
  return {
    header: {
      kind: 'Fleet machine',
      title: titleOf(a),
      says: standing(a),
      ...(red ? { attention: red } : {}),
    },
    sections,
    actions: [],
    route: `/fleet/${encodeURIComponent(a.id)}`,
    live: open(a),
  };
}

/** Fleet's part of the Running page, read through the service's own permission checks. */
export const fleetRunning = (fleet: Fleet): RunningContribution => ({
  owner: 'fleet',
  kinds: ['fleet'],
  lanes: ['sessions'],
  // Open allocations only: none of the ended history.
  nodes: async (read) => ({
    nodes: (await fleet.list(read.caller, 0)).filter(open).map(fleetNode),
  }),
  panel: async (read, key, absorbedBy) =>
    fleetPanel(await fleet.inspect(read.caller, keyId(key)), absorbedBy),
});

import type { CodeBaseRecord, CodeUnit } from '@merv/contracts/code-units';
import type { CodeCommandRecord, CodeProjectStatus } from '@merv/contracts/code';
import type { CodePublication } from '@merv/contracts/types';
import type { RecordNames } from '../markdown';
import { status as publicationWord } from './github-publications';

/**
 * What Git holds for this project, as one object graph: the trunk, one lane per unit
 * of work, a confluence mark where accepted commits were merged, and a ring for every
 * publication. Everything here is derived from a record — a lane is a unit, an edge is
 * a field one record carries about another, a relation no field expresses is left out
 * rather than guessed — and nothing is authored by an agent.
 *
 * It is one model with two readings: the drawing places it, and the page too narrow to
 * draw places the same nodes as a list, so the two cannot disagree. Pure, and free of
 * React and of the DOM, which is what lets it be read in a test.
 *
 * Joins are by commit equality, never by re-derivation: a pin names the commit it was
 * cut from, a base names the accepted commits it was made of, and a unit still waiting
 * carries that same member set — so the browser asks the server for no second name and
 * prints no digest.
 */

export type GitNodeKind = 'main' | 'unit' | 'base' | 'publication';
export interface GitNode {
  id: string;
  kind: GitNodeKind;
  /** The kind whose colour it wears, from the route the names map leads to. */
  colour: string;
  name: string;
  /** Absent where the node is not a record anyone can open. */
  to?: string;
  /** Nothing may be built on this again, so it is drawn hollow rather than said. */
  hollow: boolean;
  /** Its place down the page: 0 is the trunk, and a half is between two lanes. */
  row: number;
}

/** A verb one record's own field says about another; no other relation is drawn. */
export type GitVerb =
  | 'member of'
  | 'pinned to'
  | 'waiting on'
  | 'based on'
  | 'merged from'
  | 'resolved by'
  | 'published from'
  | 'merged into';
export interface GitEdge {
  from: string;
  to: string;
  verb: GitVerb;
  /** What has not happened yet is dashed; what happened is solid. */
  dashed?: boolean;
  /** A conflict and its remedy are the one relation drawn in the refusal's colour. */
  refusal?: boolean;
}

export interface GitLane {
  id: string;
  /** The node it was cut from, by commit equality: the trunk, another lane, or a base. */
  from: string;
  /**
   * The commits it runs through. A unit that committed through `code.commit` has one
   * stop per receipt with its diffstat; a unit that never did has the one stop its
   * canonical head is, which is the whole class the earlier drawing dropped.
   */
  stops: { oid: string; stat: { add: number; del: number } | null; title: string }[];
  /** How many stops the mirror has published; the rest of the lane is drawn hollow. */
  mirrored: number;
  /** A filled square at an acceptance, an open dot at a head, nothing at a declaration. */
  tip: 'accepted' | 'head' | 'none';
}

export interface GitModel {
  nodes: GitNode[];
  edges: GitEdge[];
  lanes: GitLane[];
  /** Columns are topological, not a clock: a server-made merge has no honest time. */
  ranks: ReadonlyMap<string, number>;
  /** The one standing word each node reads, which the status tones then colour. */
  word: ReadonlyMap<string, string>;
}

/** The trunk is one node whatever its commit is, so nothing joins to a bare oid. */
export const MAIN = 'main';

/** The route a name leads to says what kind a unit is, and so what colour it wears. */
const COLOUR: [string, string][] = [
  ['/tasks/', 'tasks'],
  ['/experiments/', 'experiments'],
  ['/reflections/', 'reflections'],
  ['/consolidation/', 'consolidation'],
  ['/research/', 'research'],
  ['/reviews/', 'reviews'],
];
const colourOf = (to: string | undefined) =>
  (to && COLOUR.find(([prefix]) => to.startsWith(prefix))?.[1]) || 'code';

/** Two member sets name the same merge when they hold the same commits. */
export const sameMerge = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && [...left].sort().join() === [...right].sort().join();

/** The accepted commits a unit's base was or will be made from; empty where it is one. */
const mergeOf = (unit: CodeUnit): string[] =>
  unit.baseStatus && 'merge' in unit.baseStatus ? (unit.baseStatus.merge ?? []) : [];

/**
 * Nothing this unit holds may be reused: either its own capture was refused, or the base
 * it was to be built on was quarantined and the taint reaches it through the lineage.
 */
const refused = (unit: CodeUnit) =>
  !!unit.quarantine ||
  (unit.baseStatus?.status === 'blocked' &&
    unit.baseStatus.blockers.some((blocker) => blocker.code === 'code_quarantined'));

/**
 * How a unit stands, in one word. A unit that is not accepted reads what is keeping it
 * from being: quarantine first, because nothing it holds may be reused again.
 */
function unitWord(unit: CodeUnit, conflicted: boolean): string {
  if (refused(unit)) return 'quarantined';
  if (unit.acceptance) return 'accepted';
  if (!unit.baseStatus) return 'ended';
  if (unit.baseStatus.status === 'blocked') return conflicted ? 'conflicted' : 'blocked';
  if (unit.baseStatus.status !== 'pinned') return unit.baseStatus.status;
  if (unit.writerState === 'recovery_required') return 'held';
  return unit.generation > 0 ? 'working' : 'ready';
}

/**
 * A unit is a lane once there is anything to draw of it: a base it took, the code it
 * was accepted at, a writer that wrote, or a base it is waiting for. A unit that is
 * none of those has not reached Code at all.
 */
const drawn = (unit: CodeUnit) =>
  !!unit.base || !!unit.acceptance || unit.generation > 0 || !!unit.baseStatus;

/** The receipts of each unit, oldest first: only a succeeded commit on a lasting branch. */
function receiptsOf(commands: CodeCommandRecord[]): Map<string, CodeCommandRecord[]> {
  const made = new Map<string, CodeCommandRecord[]>();
  for (const record of commands) {
    const space = record.command.workspace;
    if (!record.receipt || record.status !== 'succeeded') continue;
    if (space.mode !== 'persistent' || !space.branch) continue;
    const list = made.get(record.command.instanceId);
    if (list) list.push(record);
    else made.set(record.command.instanceId, [record]);
  }
  for (const list of made.values())
    list.sort((a, b) => Date.parse(a.command.createdAt) - Date.parse(b.command.createdAt));
  return made;
}

/**
 * Rows are lanes, in the order work was declared, with the one exception that makes
 * the drawing a drawing: a base is placed where its last member arrives, the task that
 * resolves it comes directly under it, and the units it was handed to follow — so a
 * conflict and its remedy read as one shape rather than two rows apart.
 */
function order(
  units: CodeUnit[],
  bases: CodeBaseRecord[],
  /** The lanes each base was made of, joined once for the project and read here and below. */
  membersOf: ReadonlyMap<string, string[]>,
  baseByResult: ReadonlyMap<string, CodeBaseRecord>,
): Map<string, number> {
  const rows = new Map<string, number>();
  const left = new Set(bases.map((base) => base.key));
  /** A merge made from an earlier merge waits for it, so the plan reads downwards. */
  const beneath = (base: CodeBaseRecord) =>
    (base.parents ?? []).some((commit) => {
      const parent = commit ? baseByResult.get(commit) : undefined;
      return !!parent && parent.key !== base.key && left.has(parent.key);
    });
  let row = 0;
  const lane = (unit: CodeUnit | undefined) => {
    if (!unit || rows.has(unit.unitId)) return;
    rows.set(unit.unitId, ++row);
    for (const base of bases) {
      if (!left.has(base.key)) continue;
      const members = membersOf.get(base.key)!;
      if (!members.length || !members.every((id) => rows.has(id)) || beneath(base)) continue;
      left.delete(base.key);
      rows.set(base.key, row + 0.5);
      lane(units.find((item) => item.unitId === base.resolutionTaskId));
      for (const item of units)
        if (
          (base.result && item.base?.reference === base.result.commit) ||
          sameMerge(mergeOf(item), base.members)
        )
          lane(item);
    }
  };
  for (const unit of units) lane(unit);
  // A base no drawn unit is a member of still happened, so it is placed at the end.
  for (const base of bases) if (left.has(base.key)) rows.set(base.key, ++row + 0.5);
  return rows;
}

/** rank(node) = 1 + the deepest thing it was made from; the trunk is 0. */
function ranksOf(inputs: Map<string, string[]>): Map<string, number> {
  const ranks = new Map<string, number>([[MAIN, 0]]);
  const open = new Set<string>();
  const rank = (id: string): number => {
    const known = ranks.get(id);
    if (known !== undefined) return known;
    // A cycle cannot arise from records pinned before they were merged, but a depth
    // that answered itself would hang the page, so it is stopped rather than trusted.
    if (open.has(id)) return 0;
    open.add(id);
    const value = 1 + Math.max(0, ...(inputs.get(id) ?? []).map(rank));
    open.delete(id);
    ranks.set(id, value);
    return value;
  };
  for (const id of inputs.keys()) rank(id);
  return ranks;
}

export function gitModel(
  status: CodeProjectStatus | undefined,
  commands: CodeCommandRecord[],
  publications: CodePublication[],
  names: RecordNames,
): GitModel {
  const units = (status?.units ?? []).filter(drawn);
  const bases = status?.bases ?? [];
  const receipts = receiptsOf(commands);
  const byCommit = new Map(
    units.flatMap((unit) =>
      unit.acceptance?.reference ? [[unit.acceptance.reference, unit] as const] : [],
    ),
  );
  const baseByResult = new Map(
    bases.flatMap((base) => (base.result ? [[base.result.commit, base] as const] : [])),
  );
  const membersOf = new Map(
    bases.map((base) => [
      base.key,
      base.members.flatMap((commit) => {
        const unit = byCommit.get(commit);
        return unit ? [unit.unitId] : [];
      }),
    ]),
  );
  const rows = order(units, bases, membersOf, baseByResult);
  const nodes: GitNode[] = [
    {
      id: MAIN,
      kind: 'main',
      colour: 'code',
      // The trunk is called whatever the page can call it: the GitHub base branch.
      name: names.get(MAIN)?.name ?? MAIN,
      hollow: false,
      row: 0,
    },
  ];
  const edges: GitEdge[] = [];
  const lanes: GitLane[] = [];
  const word = new Map<string, string>();
  const inputs = new Map<string, string[]>();

  for (const unit of units) {
    const named = names.get(unit.unitId);
    const pin = unit.base;
    const merge = mergeOf(unit);
    const behind = merge.length ? bases.find((base) => sameMerge(base.members, merge)) : undefined;
    const from =
      pin?.kind === 'accepted'
        ? (byCommit.get(pin.reference)?.unitId ?? MAIN)
        : pin?.kind === 'merged'
          ? (baseByResult.get(pin.reference)?.key ?? MAIN)
          : MAIN;
    nodes.push({
      id: unit.unitId,
      kind: 'unit',
      colour: colourOf(named?.to),
      // A lane a list cannot name is still a fact about the repository, so it is drawn
      // as the branch the mirror publishes it under rather than left out.
      name: named?.name ?? unit.branch,
      ...(named?.to ? { to: named.to } : {}),
      hollow: refused(unit),
      row: rows.get(unit.unitId) ?? 0,
    });
    word.set(unit.unitId, unitWord(unit, !!behind?.conflict));
    const stops: GitLane['stops'] = (receipts.get(unit.unitId) ?? []).map((record) => ({
      oid: record.receipt!.headOid,
      stat: { add: record.receipt!.stats.insertions, del: record.receipt!.stats.deletions },
      title: `${record.command.message} · ${record.receipt!.headOid}`,
    }));
    const head = unit.canonicalHead;
    if (head && !stops.some((stop) => stop.oid === head))
      stops.push({ oid: head, stat: null, title: head });
    // A head the mirror has not reached leaves the rest of the lane hollow; a head the
    // mirror names but no receipt does leaves the whole lane hollow, which is the truth.
    const level = !head || head === unit.mirroredHead;
    lanes.push({
      id: unit.unitId,
      from,
      stops,
      mirrored: level
        ? stops.length
        : unit.mirroredHead
          ? stops.findIndex((stop) => stop.oid === unit.mirroredHead) + 1
          : 0,
      tip: unit.acceptance?.reference ? 'accepted' : head ? 'head' : 'none',
    });
    inputs.set(unit.unitId, [from, ...(behind ? [behind.key] : [])]);
    if (pin?.kind === 'accepted')
      for (const source of pin.sources)
        if (source.unitId !== unit.unitId && rows.has(source.unitId))
          edges.push({ from: source.unitId, to: unit.unitId, verb: 'based on' });
    if (behind) edges.push({ from: behind.key, to: unit.unitId, verb: 'waiting on', dashed: true });
  }

  for (const base of bases) {
    const members = membersOf.get(base.key)!;
    // A parent that resolves to a lone member is already that unit's acceptance dot.
    const parents = (base.parents ?? []).flatMap((commit) => {
      const parent = commit ? baseByResult.get(commit) : undefined;
      return parent && parent.key !== base.key ? [parent.key] : [];
    });
    nodes.push({
      id: base.key,
      kind: 'base',
      colour: 'code',
      // A base key is a digest that names nothing to a person, so it is never printed.
      name: `A merge of ${base.members.length}`,
      hollow: base.quarantined,
      row: rows.get(base.key) ?? 0,
    });
    // Quarantine outranks the state it reached, as it does on a unit: it is the fact that
    // nothing may be built on this again, and the hollow shape alone cannot be read aloud.
    word.set(base.key, base.quarantined ? 'quarantined' : base.state);
    inputs.set(base.key, [...members, ...parents]);
    for (const member of members) edges.push({ from: member, to: base.key, verb: 'member of' });
    for (const parent of parents) edges.push({ from: parent, to: base.key, verb: 'merged from' });
    if (base.result)
      for (const unit of units)
        if (unit.base?.kind === 'merged' && unit.base.reference === base.result.commit)
          edges.push({ from: base.key, to: unit.unitId, verb: 'pinned to' });
    if (base.resolutionTaskId && rows.has(base.resolutionTaskId))
      edges.push({ from: base.key, to: base.resolutionTaskId, verb: 'resolved by', refusal: true });
  }

  for (const published of publications) {
    const from = rows.has(published.instanceId) ? published.instanceId : MAIN;
    nodes.push({
      id: published.proposalId,
      kind: 'publication',
      colour: 'consolidation',
      name: published.title,
      hollow: !!published.incident,
      // Every ring sits just off the trunk; only one that merged is joined to it.
      row: 0.4,
    });
    word.set(published.proposalId, publicationWord(published));
    inputs.set(published.proposalId, [from]);
    edges.push({ from, to: published.proposalId, verb: 'published from' });
    if (published.merge?.commitSha ?? published.pull?.mergeCommitSha)
      edges.push({ from: published.proposalId, to: MAIN, verb: 'merged into' });
  }

  return { nodes, edges, lanes, ranks: ranksOf(inputs), word };
}

/**
 * The units still waiting for this exact merge. A waiting unit carries the accepted
 * commits its base will be made from and a base carries the ones it was made from, so
 * the join is the member set itself: the browser asks the server for no second name and
 * prints no digest. A base made of nothing answers nobody.
 */
export const waitersOf = (base: CodeBaseRecord, units: readonly CodeUnit[]): string[] =>
  base.members.length
    ? units.filter((unit) => sameMerge(mergeOf(unit), base.members)).map((unit) => unit.unitId)
    : [];

/** One filter: the work a group of blockers is about, and the nodes it names. */
export interface GitChip {
  label: string;
  count: number;
  lights: ReadonlySet<string>;
}
/**
 * A blocker's code says which of four things is holding work up; anything else Code
 * publishes is work waiting on the server, which is what every remaining code says in
 * its own words. Nothing here prints a blocker: the chip is a filter, and the node's
 * own state word is what says why it stands where it does.
 */
const GROUPS: [string, RegExp][] = [
  ['Conflicted', /conflict/],
  // Quarantine is the strongest word this vocabulary has: nothing may ever be built on
  // it again. A writer stuck mid-generation is recoverable and waits with the rest.
  ['Quarantined', /quarantin/],
  ['To publish', /publish|publication/],
];
const ORDER = ['Conflicted', 'Waiting', 'Quarantined', 'To publish'];

export function chipsOf(
  blockers: NonNullable<CodeProjectStatus['blockers']>,
  model: GitModel,
): GitChip[] {
  const drawn = new Set(model.nodes.map((node) => node.id));
  const held = new Map<string, { work: Set<string>; lights: Set<string> }>();
  for (const blocker of blockers) {
    // Blockers are every one the project holds while the drawing keeps a window of units,
    // so a chip counts only what pressing it can light: a filter never names what it
    // cannot then show.
    if (!drawn.has(blocker.instanceId)) continue;
    const label = GROUPS.find(([, code]) => code.test(blocker.code))?.[0] ?? 'Waiting';
    const group = held.get(label) ?? { work: new Set<string>(), lights: new Set<string>() };
    held.set(label, group);
    // One unit held up is one thing to look at, however many opinions say so.
    group.work.add(blocker.instanceId);
    for (const id of [blocker.instanceId, ...blocker.related.map((item) => item.id)])
      if (drawn.has(id)) group.lights.add(id);
  }
  // The base a lit unit is waiting behind is what the reader is being sent to look at,
  // so the square and the lanes converging on it light together.
  for (const group of held.values())
    for (const edge of model.edges)
      if (edge.verb === 'waiting on' && group.lights.has(edge.to)) group.lights.add(edge.from);
  return ORDER.flatMap((label) => {
    const group = held.get(label);
    // A chip of zero is a filter with nothing behind it, so it is not drawn at all.
    return group?.work.size ? [{ label, count: group.work.size, lights: group.lights }] : [];
  });
}

/**
 * Which end of an edge is its sentence's subject. Lines are drawn from cause to effect,
 * but most of these verbs are said by the record the arrow points at: a unit waits on a
 * base, a base was never waiting on the unit it holds up.
 */
const SAID_BY_HEAD = new Set<GitVerb>([
  'pinned to',
  'waiting on',
  'based on',
  'merged from',
  'published from',
]);

/**
 * What each node says about another, in words, where the page is too narrow to draw the
 * lines. One pass over the edges, so a list of nodes costs one reading and not one each.
 */
export function relationsOf(model: GitModel): ReadonlyMap<string, string[]> {
  const named = new Map(model.nodes.map((node) => [node.id, node.name]));
  const said = new Map<string, string[]>();
  for (const edge of model.edges) {
    const head = SAID_BY_HEAD.has(edge.verb);
    const other = named.get(head ? edge.from : edge.to);
    if (other === undefined) continue;
    const subject = head ? edge.to : edge.from;
    said.set(subject, [...(said.get(subject) ?? []), `${edge.verb} ${other}`]);
  }
  return said;
}

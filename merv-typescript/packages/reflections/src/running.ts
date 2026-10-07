import { leaseRows } from '@merv/workflows/lease-rows';
import { reviewWord, unitHistory, type UnitStateWords } from '@merv/reviews/unit-history';
import { reviewAttention, reviewCard } from '@merv/reviews/running';
import {
  ellipsis,
  inTransaction,
  keyId,
  keyKind,
  mapAsync,
  MervError,
  runningKey,
  type Artifact,
  type Caller,
  type ReviewRequest,
  type RunningAttention,
  type RunningKey,
  type RunningNode,
  type RunningPanelPart,
  type RunningPhrase,
  type RunningRow,
  type RunningSection,
  type RunningUnit,
  type RunningUnitEntry,
  type RunningUnitKey,
  type Transaction,
  type WorkRoute,
} from '@merv/contracts';
import type { ProcessGraph, WorkflowSnapshot } from '@merv/workflows/models';
import type { ChangeSpec, Reflection } from './types.js';
import type { ReflectionsContext } from './index.js';
import { lensName } from './names.js';

/**
 * A reflection wave on the Running page. The open wave is one node at the head of the work
 * lane, because while it is open no new task or experiment may start. Its lenses are workflow
 * instances of their own, but the wave absorbs their keys, so a session on a lens lands on the
 * wave and the Lenses table says which lens is where. Every word here is read from the wave's
 * record, its lease rows and its review limit, in the reader's snapshot; nothing is written.
 */

/** One lease on a wave or lens. A lease's id is the id of the session that holds it. */
export interface WaveLease {
  id: string;
  instanceId: string;
  revision: number;
  releasedAt: string | null;
}
export interface WaveFacts {
  wave: Reflection;
  /** Every lease ever taken on the wave or on one of its current lenses. */
  leases: WaveLease[];
  /** Every review of the wave, for its history; read for its sidebar only. */
  reviews?: readonly ReviewRequest[];
  /** The files those reviews pinned, by id: which of them is the synthesis. */
  pinned?: ReadonlyMap<string, Pick<Artifact, 'id' | 'title' | 'mediaType'>>;
}

/** Where one step stands: the wave's own synthesis or review, or one lens. */
interface Step {
  /** The live lease on it, at its current revision. */
  held?: WaveLease;
  /**
   * Since when it has waited: its last move, or the last lease let go of it, whichever is
   * later. A lease let go does not move the revision, so the move alone would overstate it.
   */
  since: string;
}
function stepOf(leases: readonly WaveLease[], workflow: WorkflowSnapshot): Step {
  const own = leases.filter((lease) => lease.instanceId === workflow.id);
  const held = own.find(
    (lease) => lease.releasedAt === null && lease.revision === workflow.revision,
  );
  const since = own.reduce(
    (at, { releasedAt }) =>
      releasedAt && Date.parse(releasedAt) > Date.parse(at) ? releasedAt : at,
    workflow.updatedAt,
  );
  return { ...(held ? { held } : {}), since };
}

/** The board draws at most 200 characters of a name, and a wave's title may run to 300. */
const counted = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
const OPEN = new Set(['reflecting', 'synthesizing', 'in_review']);
const lensKeys = (wave: Reflection) => wave.lenses.map((lens) => runningKey('work', lens.id));

/** The one line the node and the sidebar's head share, and whether anyone has the wave. */
function face({ wave, leases }: WaveFacts): { says: RunningPhrase; look: RunningNode['look'] } {
  const own = stepOf(leases, wave.workflow);
  switch (wave.workflow.state) {
    case 'reflecting': {
      const submitted = wave.lenses.filter((lens) => lens.artifact).length;
      const lenses: RunningPhrase = ['Lenses ', { count: submitted, of: wave.lenses.length }];
      const open = wave.lenses
        .filter((lens) => !lens.artifact)
        .map((lens) => stepOf(leases, lens.workflow));
      const held = open.filter((step) => step.held).length;
      if (held)
        return {
          says: [...lenses, ' · ', held === 1 ? '1 with an agent' : `${held} with agents`],
          look: 'solid',
        };
      // The lens that has waited longest says how long the wave has.
      const since = open.length
        ? open.map((step) => step.since).reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a))
        : own.since;
      return { says: [...lenses, ' · waiting ', { since }], look: 'dashed' };
    }
    case 'synthesizing':
      return own.held
        ? { says: ['Synthesis · with an agent'], look: 'solid' }
        : { says: ['Synthesis · waiting ', { since: own.since }], look: 'dashed' };
    case 'in_review': {
      // A leased reviewer is an agent, whose name is never drawn; a person claims it by hand.
      // The wait counts from when the wave last moved or its reviewer let it go.
      const card = reviewCard(wave.review, {
        gate: 'Review',
        leased: !!own.held,
        since: own.since,
      });
      return { says: card.line, look: card.look };
    }
    case 'approved':
      return { says: ['Approved'], look: 'quiet' };
    default:
      return { says: ['Ended'], look: 'quiet' };
  }
}

/**
 * The wave's red. A review no eligible reviewer may take waits for an operator to provide one:
 * Reviews tells only an operator so (`waiting`), as it does for a task, and its Review section
 * says why in ink. Returns used up are Workflows' mark on the card, in the words every owner's
 * work shares.
 */
function attention({ wave }: WaveFacts): RunningAttention | undefined {
  return wave.workflow.state === 'in_review' ? reviewAttention(wave.review) : undefined;
}

export function waveNode(facts: WaveFacts): RunningNode {
  const { says, look } = face(facts);
  const red = attention(facts);
  return {
    key: runningKey('work', facts.wave.id),
    lane: 'work',
    kind: 'Reflection',
    title: ellipsis(facts.wave.title, 200),
    lines: [says],
    look,
    ...(red ? { attention: red } : {}),
    aliases: lensKeys(facts.wave),
    // An open wave pauses every new task and experiment, so it heads the lane.
    rank: -1,
    started: facts.wave.createdAt,
  };
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const document = (artifact: Pick<Artifact, 'id' | 'title'>) => ({
  id: artifact.id,
  title: ellipsis(artifact.title, 200),
});
/** What a structured plan's item is called: a task's title, an experiment's name. */
const itemTitle = (item: ChangeSpec['items'][number]) =>
  item.kind === 'task' ? item.title : item.name;

/** What the shell and a wave's history say of its states: crossing into review is a synthesis. */
export const WAVE_STATES: Readonly<Record<string, UnitStateWords>> = {
  in_review: { submitted: 'Submitted the synthesis' },
};

/**
 * The wave as a unit: each lens's report and every round of its synthesis's review as its
 * history, and the one thing to read now. While it reflects that is its lenses, one opened at
 * a time; from its synthesis on, the synthesis report; once approved, the next wave's plan,
 * item by item where it is structured.
 */
export function waveUnit(
  { wave, reviews = [], pinned = new Map() }: WaveFacts,
  graph: ProcessGraph,
): RunningUnit {
  // What a synthesis handed in: the report, never the change specification beside it.
  const synthesis = (review: ReviewRequest) => {
    const handed = review.artifactIds.map((id) => pinned.get(id)).filter((item) => !!item);
    const report =
      handed.find((item) => item.id === wave.report?.id) ??
      handed.find((item) => /^text\/(markdown|plain)/.test(item.mediaType));
    return report && document(report);
  };
  const lenses: RunningUnitEntry[] = wave.lenses
    .filter((lens) => lens.artifact)
    .map((lens) => ({
      role: 'producer',
      // A lens is written in its own program's one working state.
      stage: 'reflecting',
      instance: lens.id,
      ...(lens.producerId ? { actor: lens.producerId } : {}),
      at: lens.artifact!.createdAt,
      said: `${capital(lensName(lens.perspective))} lens`,
      artifact: document(lens.artifact!),
    }));
  const own = unitHistory({
    graph,
    reviews,
    states: WAVE_STATES,
    document: synthesis,
  });
  // The lenses' reports stand among the wave's own moves by when each was written.
  const history = [...lenses, ...own.filter((entry) => entry.at)]
    .sort((a, b) => a.at!.localeCompare(b.at!))
    .concat(own.filter((entry) => !entry.at));
  const verdict = reviewWord(wave.review);
  const parts: RunningUnitKey = {
    label: 'Lenses',
    parts: wave.lenses.map((lens) => ({
      title: capital(lensName(lens.perspective)),
      ...(lens.artifact ? { state: 'submitted' } : {}),
      ...(lens.producerId ? { actor: lens.producerId } : {}),
      ...(lens.artifact ? { artifact: document(lens.artifact) } : {}),
    })),
  };
  const report = wave.report && {
    label: 'Synthesis',
    ...(verdict ? { state: verdict } : {}),
    artifact: document(wave.report),
  };
  const plan: RunningUnitKey | undefined = wave.plan
    ? {
        label: 'Next-wave plan',
        state: wave.plan.next.decision,
        items: wave.plan.items.map((item) => ({
          key: item.key,
          kind: item.kind,
          title: ellipsis(itemTitle(item), 300),
          dependsOn: item.dependsOn,
        })),
      }
    : wave.changeSpec
      ? { label: 'Next-wave plan', artifact: document(wave.changeSpec) }
      : undefined;
  const { state } = wave.workflow;
  const key =
    state === 'reflecting'
      ? parts
      : state === 'approved'
        ? (plan ?? report ?? parts)
        : (report ?? parts);
  // Each lens is a record of its own, and its agents are the wave's too, named by their lens.
  const instances = wave.lenses.map((lens) => lens.id);
  const names = Object.fromEntries(
    wave.lenses.map((lens) => [lens.id, `${capital(lensName(lens.perspective))} lens`]),
  );
  return { key, history, ...(instances.length ? { instances, names } : {}) };
}

function lensTable({ wave, leases }: WaveFacts): RunningSection {
  const rows = wave.lenses.map((lens): RunningRow => {
    const perspective = [lensName(lens.perspective)];
    if (lens.artifact) return { cells: [perspective, ['Submitted']] };
    const { held, since } = stepOf(leases, lens.workflow);
    return held
      ? { cells: [perspective, ['With an agent']], to: { key: runningKey('session', held.id) } }
      : { cells: [perspective, ['Waiting ', { since }]] };
  });
  return {
    title: 'Lenses',
    place: 'content',
    kind: 'table',
    aside: [{ count: wave.lenses.filter((lens) => lens.artifact).length, of: wave.lenses.length }],
    columns: ['Perspective', 'Standing'],
    rows,
  };
}

/** What a structured plan proposes next; a text change specification proposes nothing here. */
function planned({ next, items }: ChangeSpec): string {
  if (next.decision === 'stop') return `Stop · ${next.reason.replaceAll('_', ' ')}`;
  const tasks = items.filter((item) => item.kind === 'task').length;
  return [
    'Continue',
    ...(tasks ? [counted(tasks, 'task')] : []),
    ...(items.length > tasks ? [counted(items.length - tasks, 'experiment')] : []),
  ].join(' · ');
}

/**
 * A wave's sidebar: its stages, while it reflects which lens is where, once submitted what it
 * concluded, and while it is open the work it holds up. The review is Reviews' to add and its
 * sessions are Sessions', through the lens keys it absorbs.
 */
export function wavePanel(
  facts: WaveFacts,
  graph: ProcessGraph,
  route: WorkRoute = () => undefined,
): RunningPanelPart {
  const { wave } = facts;
  const { state } = wave.workflow;
  const red = attention(facts);
  const sections: RunningSection[] = [
    { title: 'Stages', place: 'progress', kind: 'ladder', graph },
  ];
  if (state === 'reflecting') sections.push(lensTable(facts));
  if (wave.report && (state === 'in_review' || state === 'approved'))
    sections.push({
      title: 'Result',
      place: 'content',
      kind: 'facts',
      rows: [
        {
          label: 'Report',
          value: [
            {
              link: { route: `/artifacts/${encodeURIComponent(wave.report.id)}` },
              text: ellipsis(wave.report.title, 200),
            },
          ],
        },
        ...(wave.plan ? [{ label: 'Plan', value: [planned(wave.plan)] }] : []),
      ],
    });
  // REFLECTION_WORKFLOW.blocksStarts: no task or experiment starts while a wave is open.
  if (OPEN.has(state))
    sections.push({
      title: 'Holds up',
      place: 'relations',
      kind: 'facts',
      rows: [{ label: 'New tasks and experiments', value: ['Paused'] }],
    });
  return {
    header: {
      kind: 'Reflection',
      title: ellipsis(wave.title, 200),
      says: face(facts).says,
      ...(red ? { attention: red } : {}),
    },
    sections,
    actions: [],
    route: route('reflection', wave.id),
    live: [wave.workflow, ...wave.lenses.map((lens) => lens.workflow)].some(
      (workflow) => stepOf(facts.leases, workflow).held,
    ),
    aliases: lensKeys(wave),
    ...(facts.reviews ? { unit: waveUnit(facts, graph) } : {}),
  };
}

// The Running page's reads of a wave. Each runs on ReflectionService (index.ts) as its
// ReflectionsContext.
/** What the Running page says of one wave: its record, every lease on it, its review limit. */
export async function runningFacts(
  ctx: ReflectionsContext,
  caller: Caller,
  id: string,
  tx: Transaction,
): Promise<WaveFacts> {
  const wave = await ctx.wave(caller, id, tx, true);
  const ids = [wave.id, ...wave.lenses.map((lens) => lens.id)];
  const leases = await leaseRows(tx, { projectId: caller.projectId, instanceIds: ids });
  return {
    wave,
    leases: leases.map((lease) => ({
      id: lease.id,
      instanceId: lease.instance_id,
      revision: Number(lease.revision),
      releasedAt: lease.released_at,
    })),
  };
}
export async function running(
  ctx: ReflectionsContext,
  caller: Caller,
  include: Iterable<RunningKey> = [],
  transaction?: Transaction,
): Promise<RunningNode[]> {
  caller = structuredClone(caller);
  // A mark may name the wave, or one of its lenses, which the wave draws.
  const held = [...include].filter((key) => keyKind(key) === 'work').map(keyId);
  const listed = held.map(() => '?').join(',');
  return await inTransaction(ctx.state, transaction, async (tx) => {
    await ctx.read(caller, tx);
    const waves = await tx.all<{ id: string }>(
      `SELECT id FROM reflections WHERE project_id=? AND (approved IS NULL AND abandoned IS NULL${
        held.length
          ? ` OR id IN (${listed}) OR id IN (SELECT reflection_id FROM reflection_lenses WHERE project_id=? AND id IN (${listed}))`
          : ''
      }) ORDER BY _merv_rowid`,
      caller.projectId,
      ...(held.length ? [...held, caller.projectId, ...held] : []),
    );
    // A wave whose record names something no longer there is left off on its own; the
    // other waves are drawn.
    const nodes = await mapAsync(waves, async ({ id }) => {
      try {
        return waveNode(await runningFacts(ctx, caller, id, tx));
      } catch (error) {
        if (error instanceof MervError && error.status === 404) return null;
        throw error;
      }
    });
    return nodes.filter((node) => node !== null);
  });
}
export async function runningPanel(
  ctx: ReflectionsContext,
  caller: Caller,
  id: string,
  route?: WorkRoute,
): Promise<RunningPanelPart | null> {
  caller = structuredClone(caller);
  // One snapshot, so the wave, its ladder and its reviews are read as of one moment.
  return await ctx.state.snapshot(async () => {
    const facts = await ctx.state.transaction(async (tx) => {
      await ctx.read(caller, tx);
      // Any other work key is another owner's, and a lens is drawn by its wave.
      const wave = await tx.get<{ id: string }>(
        'SELECT id FROM reflections WHERE id=? AND project_id=?',
        id,
        caller.projectId,
      );
      return wave ? await runningFacts(ctx, caller, id, tx) : null;
    });
    if (!facts) return null;
    // Workflows reads the ladder, where the wave stands, so no action's check runs to draw it,
    // and Reviews every round of the synthesis's review, with the files each one pinned.
    const graph = await ctx.workflows.process(caller, id, { checks: false });
    const reviews = await ctx.reviews.list(caller, { subjectId: id });
    const ids = [...new Set(reviews.flatMap((review) => review.artifactIds))];
    const pinned = ids.length
      ? await ctx.state.transaction(async (tx) => await ctx.artifacts.find(caller, ids, tx))
      : new Map<string, Artifact>();
    return wavePanel({ ...facts, reviews, pinned }, graph, route);
  });
}

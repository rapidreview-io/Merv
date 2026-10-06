import { leaseRows } from '@merv/workflows/lease-rows';
import {
  ellipsis,
  inTransaction,
  keyId,
  keyKind,
  mapAsync,
  MervError,
  runningKey,
  type Caller,
  type ProcessGraph,
  type RunningAttention,
  type RunningKey,
  type RunningNode,
  type RunningPanelPart,
  type RunningPhrase,
  type RunningRow,
  type RunningSection,
  type Transaction,
  type WorkflowSnapshot,
  type WorkRoute,
} from '@merv/contracts';
import type { ChangeSpec, Reflection } from './types.js';
import type { ReflectionService } from './index.js';
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
  /** In review again after as many returns as its limit allows: nothing will lease a reviewer. */
  exhausted: boolean;
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
    case 'in_review':
      // A leased reviewer is an agent, whose name is never drawn; a person claims it by hand.
      if (own.held) return { says: ['Review · with an agent'], look: 'solid' };
      return wave.review?.status === 'started' && wave.review.reviewerId
        ? {
            says: [
              'Review · ',
              { actor: wave.review.reviewerId, prefix: 'with ', unnamed: 'claimed' },
            ],
            look: 'solid',
          }
        : { says: ['Review · waiting for a reviewer ', { since: own.since }], look: 'dashed' };
    case 'approved':
      return { says: ['Approved'], look: 'quiet' };
    default:
      return { says: ['Ended'], look: 'quiet' };
  }
}

/**
 * The wave's red. A wave in review after its last allowed return is never leased a reviewer,
 * so it waits for a person: a reviewer who takes the review by hand, or its ending. Once
 * someone has claimed that review the move is being made, and the line names them. A review
 * no eligible reviewer may take waits for an operator to provide one: Reviews tells only an
 * operator so (`waiting`), as it does for a task, and its Review section says why in ink.
 */
function attention({ wave, exhausted }: WaveFacts): RunningAttention | undefined {
  const review = wave.review && {
    to: { route: `/reviews/${encodeURIComponent(wave.review.id)}`, text: 'Open the review' },
  };
  if (exhausted && wave.review?.status !== 'started')
    return {
      says: ['Review returns used up'],
      who: 'An independent reviewer reviews it by hand, or its owner or an operator ends it.',
      ...review,
    };
  if (wave.workflow.state === 'in_review' && wave.review?.waiting)
    return {
      says: ['No independent reviewer can take it'],
      who: 'An operator provides one.',
      ...review,
    };
  return undefined;
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
  };
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
  };
}

// The Running page's reads of a wave, which ReflectionService (index.ts) runs as its own methods.
/** What the Running page says of one wave: its record, every lease on it, its review limit. */
export async function runningFacts(
  this: ReflectionService,
  caller: Caller,
  id: string,
  tx: Transaction,
): Promise<WaveFacts> {
  const wave = await this.wave(caller, id, tx, true);
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
    // The returns are counted from review, so only a wave in review can have used them up.
    exhausted:
      wave.workflow.state === 'in_review' &&
      !!(await this.workflows.limitStatusOf(caller, [id], 'review_returns', tx)).get(id)?.exhausted,
  };
}
export async function running(
  this: ReflectionService,
  caller: Caller,
  include: Iterable<RunningKey> = [],
  transaction?: Transaction,
): Promise<RunningNode[]> {
  caller = structuredClone(caller);
  // A mark may name the wave, or one of its lenses, which the wave draws.
  const held = [...include].filter((key) => keyKind(key) === 'work').map(keyId);
  const listed = held.map(() => '?').join(',');
  return await inTransaction(this.state, transaction, async (tx) => {
    await this.read(caller, tx);
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
        return waveNode(await this.runningFacts(caller, id, tx));
      } catch (error) {
        if (error instanceof MervError && error.status === 404) return null;
        throw error;
      }
    });
    return nodes.filter((node) => node !== null);
  });
}
export async function runningPanel(
  this: ReflectionService,
  caller: Caller,
  id: string,
  route?: WorkRoute,
): Promise<RunningPanelPart | null> {
  caller = structuredClone(caller);
  const facts = await this.state.transaction(async (tx) => {
    await this.read(caller, tx);
    // Any other work key is another owner's, and a lens is drawn by its wave.
    const wave = await tx.get<{ id: string }>(
      'SELECT id FROM reflections WHERE id=? AND project_id=?',
      id,
      caller.projectId,
    );
    return wave ? await this.runningFacts(caller, id, tx) : null;
  });
  // Workflows reads the ladder in a transaction of its own, as it does for Tasks.process.
  return facts && wavePanel(facts, await this.workflows.process(caller, id), route);
}

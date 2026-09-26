import {
  runningKey,
  workRoute,
  type ProcessGraph,
  type RunningAttention,
  type RunningNode,
  type RunningPanelPart,
  type RunningPhrase,
  type RunningRow,
  type RunningSection,
  type WorkflowSnapshot,
} from '@merv/contracts';
import { REFLECTION_WORKFLOW_ENDABLE } from './definitions.js';
import type { ChangeSpec, Reflection } from './types.js';

/**
 * A reflection wave on the Running page. The open wave is one node at the head of the work
 * lane, because while it is open no new task or experiment may start. Its lenses are workflow
 * instances of their own, but the wave absorbs their keys, so a session on a lens lands on the
 * wave and the Lenses table says which lens is where. Every word here is read from the wave's
 * record, its lease rows and its review limit, in the reader's snapshot; nothing is written.
 */

/** One reflection_leases row. A lease's id is the id of the session that holds it. */
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
const clip = (text: string, max = 200) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
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
 * The wave's one red. A wave in review after its last allowed return is never leased a
 * reviewer, so it waits for a person: a reviewer who takes the review by hand, or its ending.
 * Only version 4 can be ended; a wave begun before it waits instead for another round.
 * Once someone has claimed that review the move is being made, and the line names them.
 */
function attention({ wave, exhausted }: WaveFacts): RunningAttention | undefined {
  if (!exhausted || wave.review?.status === 'started') return undefined;
  return {
    says: ['Review returns used up'],
    who:
      wave.workflow.version >= REFLECTION_WORKFLOW_ENDABLE.version
        ? 'An independent reviewer reviews it by hand, or its owner or an operator ends it.'
        : 'An independent reviewer reviews it by hand, or an operator allows another round.',
    ...(wave.review
      ? {
          to: {
            route: `/reviews/${encodeURIComponent(wave.review.id)}`,
            text: 'Open the review',
          },
        }
      : {}),
  };
}

export function waveNode(facts: WaveFacts): RunningNode {
  const { says, look } = face(facts);
  const red = attention(facts);
  return {
    key: runningKey('work', facts.wave.id),
    lane: 'work',
    kind: 'Reflection',
    title: clip(facts.wave.title),
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
    const perspective = [lens.perspective.replaceAll('_', ' ')];
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
export function wavePanel(facts: WaveFacts, graph: ProcessGraph): RunningPanelPart {
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
              text: clip(wave.report.title),
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
      title: clip(wave.title),
      says: face(facts).says,
      ...(red ? { attention: red } : {}),
    },
    sections,
    actions: [],
    route: workRoute('reflection', wave.id),
    live: [wave.workflow, ...wave.lenses.map((lens) => lens.workflow)].some(
      (workflow) => stepOf(facts.leases, workflow).held,
    ),
    aliases: lensKeys(wave),
  };
}

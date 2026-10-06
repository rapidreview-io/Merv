import {
  clip,
  runningKey,
  type ProcessGraph,
  type ReviewRequest,
  type RunningAttention,
  type RunningNode,
  type RunningNodeLink,
  type RunningPanelPart,
  type RunningPhrase,
  type RunningSection,
  type WorkflowDependency,
  type WorkflowHistoryEntry,
  type WorkRoute,
} from '@merv/contracts';
import { dependencyRows } from '@merv/workflows/dependency-rows';
import type { Experiment } from './models.js';
import { EXPERIMENT_WORKFLOW } from './program.js';

/**
 * What the Running page shows of experiments: one work card per experiment on its way to a
 * result, and a sidebar for each. Everything here is composed from facts the service read;
 * nothing reads, and no gate is evaluated, because a submission's checks read the bytes it
 * would submit.
 */

/** Where an experiment stands, as the service read it for one card. */
export interface ExperimentStanding {
  id: string;
  name: string;
  state: string;
  updatedAt: string;
  /** Since when nobody has held it: the later of its last move and its last lease ending. */
  idleSince: string;
  /** It has been in this state before: a review sent it back, or its run was retried. */
  again: boolean;
  /** Another plugin published why it cannot go on, so no agent is offered it. */
  blocked: boolean;
  /** A lease holds it at this revision, and whether its worker has begun. */
  lease: { started: boolean } | null;
  dependencies: WorkflowDependency[];
  /** The review it waits on, read only in a review state. */
  review: ReviewRequest | null;
  /** Every return this review state allows is used. */
  exhausted: boolean;
}

const ENDED: Record<string, string> = {
  complete: 'Complete',
  abandoned: 'Abandoned',
  failed: 'Failed',
};
const GATE: Record<string, string> = {
  design_review: 'Design review',
  experiment_review: 'Results review',
};
const WORK: Record<string, string> = { planned: 'Designing', running: 'Running' };
const ROLES = ['plan', 'feasibility', 'result', 'report', 'exhibit'];
const EVIDENCE_ROWS = 20;

/** The domain's own order of evidence; a role it no longer writes goes last. */
const roleOrder = (role: string) => {
  const at = ROLES.indexOf(role);
  return at < 0 ? ROLES.length : at;
};
const timed = (phrase: RunningPhrase) =>
  phrase.some((part) => typeof part === 'object' && ('since' in part || 'ago' in part));

/**
 * Whether the record has been in `state` before, counted the way its ladder counts entries:
 * crossings of a definition edge into it, so the initial state begins with none. A new
 * attempt is not a return by itself: a design sent back and then approved runs once.
 */
export function enteredAgain(history: readonly WorkflowHistoryEntry[], state: string): boolean {
  const arrivals = history.filter(
    (row) =>
      row.toState === state &&
      EXPERIMENT_WORKFLOW.edges.some(
        (edge) => edge.action === row.action && edge.from === row.fromState && edge.to === state,
      ),
  ).length;
  return arrivals > (state === EXPERIMENT_WORKFLOW.initial ? 0 : 1);
}

function face(standing: ExperimentStanding): {
  line: RunningPhrase;
  look: RunningNode['look'];
  rank: number;
} {
  const ended = ENDED[standing.state];
  if (ended) return { line: [ended], look: 'quiet', rank: 4 };
  const open = standing.dependencies.filter((item) => !item.settled && !item.failed);
  if (open.length)
    return {
      line: [
        'Waits on ',
        open[0]!.name,
        ...(open.length > 1 ? [` and ${open.length - 1} more`] : []),
      ],
      look: 'dashed',
      rank: 3,
    };
  const gate = GATE[standing.state];
  if (gate) {
    const review = standing.review;
    // A lease in a review state is a reviewer agent's; a person's claim is named by the shell.
    if (standing.lease) return { line: [`${gate} · with an agent`], look: 'solid', rank: 1 };
    if (review?.status === 'started' && review.reviewerId)
      return {
        line: [`${gate} · `, { actor: review.reviewerId, prefix: 'with ', unnamed: 'claimed' }],
        look: 'solid',
        rank: 1,
      };
    if (review?.status === 'requested')
      return {
        line: [`${gate} · unclaimed · `, { since: review.createdAt }],
        look: 'dashed',
        rank: 2,
      };
    return { line: [gate], look: 'solid', rank: 2 };
  }
  const work = `${WORK[standing.state] ?? standing.state}${standing.again ? ' again' : ''}`;
  if (standing.lease)
    return {
      line: [standing.lease.started ? work : `${work} · starting`],
      look: 'solid',
      rank: 1,
    };
  // Nothing is offered work whose prerequisite failed: the card's red says why it stopped.
  if (standing.dependencies.some((item) => item.failed))
    return { line: [work], look: 'solid', rank: 2 };
  // Another plugin holds it back, so no agent comes for it; a person's move there is that
  // plugin's own mark on the board.
  if (standing.blocked) return { line: ['Waiting'], look: 'dashed', rank: 3 };
  return {
    line: ['Waiting for an agent · ', { since: standing.idleSince }],
    look: 'dashed',
    rank: 2,
  };
}

/** Only what a person must do: a failed prerequisite, the rounds used up, no reviewer left. */
function attention(standing: ExperimentStanding): RunningAttention | undefined {
  if (ENDED[standing.state]) return undefined;
  const failed = standing.dependencies.find((item) => item.failed);
  if (failed)
    return {
      says: ['Stopped: ', failed.name, ' failed'],
      who: 'The owner ends the experiment, or its cycle replans it.',
    };
  if (standing.exhausted)
    return {
      says: ['Out of review rounds'],
      who: 'An independent reviewer reviews it by hand, or an operator allows another round.',
    };
  if (standing.review?.waiting)
    return { says: ['No independent reviewer can take it'], who: 'An operator provides one.' };
  return undefined;
}

/**
 * The experiment's card. Its live dot is the board's to draw, from the sessions on it. A
 * prerequisite is linked while it is open; one that failed is the card's red instead.
 */
export function experimentNode(standing: ExperimentStanding): RunningNode {
  const { line, look, rank } = face(standing);
  const red = attention(standing);
  const links: RunningNodeLink[] = ENDED[standing.state]
    ? []
    : standing.dependencies.map((item) => ({
        to: runningKey('work', item.id),
        verb: 'waits on',
        ...(!item.settled && !item.failed ? { waiting: true } : {}),
      }));
  return {
    key: runningKey('work', standing.id),
    lane: 'work',
    kind: 'Experiment',
    title: standing.name,
    lines: [line],
    look,
    ...(red ? { attention: red } : {}),
    ...(links.length ? { links } : {}),
    rank,
  };
}

/**
 * The experiment's sidebar: where it stands in its workflow, what it waits on and holds up,
 * its question and its evidence, and whose it is. Review and Code add their
 * own sections; Sessions adds the agents on it.
 */
export function experimentPanel(input: {
  standing: ExperimentStanding;
  experiment: Experiment;
  graph: ProcessGraph;
  route: WorkRoute;
}): RunningPanelPart {
  const { standing, experiment, graph, route } = input;
  const { line } = face(standing);
  const red = attention(standing);
  const ended = !!ENDED[standing.state];
  const says: RunningPhrase = ended
    ? [...line, ' · ', { ago: standing.updatedAt }]
    : timed(line)
      ? line
      : [...line, ' · ', { since: standing.updatedAt }];
  const { waitsOn, unblocks } = dependencyRows(
    graph.dependencies.filter((item) => item.direction === 'depends_on'),
    graph.dependencies.filter((item) => item.direction === 'required_by'),
    route,
  );
  const evidence = experiment.evidence
    .filter((item) => item.current && item.attemptIndex === experiment.attempt.index)
    .sort((a, b) => roleOrder(a.role) - roleOrder(b.role) || a.sequence - b.sequence);
  const files = evidence.slice(0, EVIDENCE_ROWS);
  const count = (drawn: number, total: number): RunningPhrase =>
    drawn < total ? [{ count: drawn, of: total }] : [{ count: total }];
  const sections: RunningSection[] = [
    { title: 'Stage', place: 'progress', kind: 'ladder', graph },
    ...(waitsOn.length
      ? [
          {
            title: 'Waits on',
            place: 'relations' as const,
            kind: 'links' as const,
            rows: waitsOn,
            // A failed prerequisite is why the card is red, so its section leads.
            ...(waitsOn.some((row) => row.attention) ? { attention: true } : {}),
          },
        ]
      : []),
    ...(unblocks.length
      ? [{ title: 'Unblocks', place: 'relations' as const, kind: 'links' as const, rows: unblocks }]
      : []),
    { title: 'Question', place: 'content', kind: 'text', text: experiment.intent, clamp: 4 },
    ...(files.length
      ? [
          {
            title: 'Evidence',
            place: 'content' as const,
            kind: 'links' as const,
            ...(files.length < evidence.length
              ? { aside: count(files.length, evidence.length) }
              : {}),
            rows: files.map((item) => ({
              to: { route: `/artifacts/${encodeURIComponent(item.artifactId)}` },
              kind: item.role[0]!.toUpperCase() + item.role.slice(1),
              name: clip(item.path.split('/').pop()!, 200),
              says: [{ ago: item.createdAt }],
            })),
          },
        ]
      : []),
    {
      title: 'Details',
      place: 'details',
      kind: 'facts',
      rows: [{ label: 'Owner', value: [{ actor: experiment.ownerId }] }],
    },
  ];
  return {
    header: {
      kind: 'Experiment',
      title: standing.name,
      says,
      ...(red ? { attention: red } : {}),
    },
    sections,
    actions: [],
    route: route('experiment', standing.id),
    live: !!standing.lease,
  };
}

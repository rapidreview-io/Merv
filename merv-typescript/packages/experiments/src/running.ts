import {
  clip,
  runningKey,
  type ReviewRequest,
  type RunningAttention,
  type RunningNode,
  type RunningPanelPart,
  type RunningPhrase,
  type RunningSection,
  type RunningUnit,
  type RunningUnitEntry,
  type RunningUnitKey,
  type WorkRoute,
} from '@merv/contracts';
import type {
  ProcessGraph,
  WorkflowDependency,
  WorkflowHistoryEntry,
} from '@merv/workflows/models';
import {
  dependencyLinks,
  dependencySections,
  prerequisiteNames,
} from '@merv/workflows/dependency-rows';
import {
  reviewWord,
  unitFileList,
  type UnitFiles,
  unitHistory,
  type UnitStateWords,
} from '@merv/reviews/unit-history';
import { reviewAttention, reviewCard } from '@merv/reviews/running';
import type { Experiment, ExperimentSubmission } from './models.js';
import { roleRank } from './rules.js';
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
  /** When the experiment was created: the live card counts from it. */
  started?: string;
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
const EVIDENCE_ROWS = 20;

const timed = (phrase: RunningPhrase) =>
  phrase.some((part) => typeof part === 'object' && ('since' in part || 'ago' in part));

/**
 * Whether the record has been in `state` before, counted the way its ladder counts entries:
 * crossings of a definition edge into it, so the initial state begins with none. A new
 * attempt is not a return by itself: a design sent back and then approved runs once.
 */
export function enteredAgain(
  moves: readonly (Pick<WorkflowHistoryEntry, 'action' | 'fromState' | 'toState'> & {
    count?: number;
  })[],
  state: string,
): boolean {
  let arrivals = 0;
  for (const row of moves)
    if (
      row.toState === state &&
      EXPERIMENT_WORKFLOW.edges.some(
        (edge) => edge.action === row.action && edge.from === row.fromState && edge.to === state,
      )
    )
      arrivals += row.count ?? 1;
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
      line: ['Waits on ', ...prerequisiteNames(open.map((item) => item.name))],
      look: 'dashed',
      rank: 3,
    };
  const gate = GATE[standing.state];
  if (gate) {
    // A lease in a review state is a reviewer agent's; a person's claim is named by the shell.
    const card = reviewCard(standing.review, { gate, leased: !!standing.lease });
    return { line: card.line, look: card.look, rank: card.held ? 1 : 2 };
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

/**
 * Only what a person must do: a failed prerequisite, or no reviewer left. Rounds used up are
 * Workflows' mark on the card, in the words every owner's work shares.
 */
function attention(standing: ExperimentStanding): RunningAttention | undefined {
  if (ENDED[standing.state]) return undefined;
  const failed = standing.dependencies.find((item) => item.failed);
  if (failed)
    return {
      says: ['Stopped: ', failed.name, ' failed'],
      who: 'The owner ends the experiment, or its cycle replans it.',
    };
  return reviewAttention(standing.review);
}

/**
 * The experiment's card. Its live dot is the board's to draw, from the sessions on it. A
 * prerequisite is linked while it is open; one that failed is the card's red instead.
 */
export function experimentNode(standing: ExperimentStanding): RunningNode {
  const { line, look, rank } = face(standing);
  const red = attention(standing);
  const links = ENDED[standing.state] ? [] : dependencyLinks(standing.dependencies);
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
    ...(standing.started ? { started: standing.started } : {}),
  };
}

/**
 * What the shell and an experiment's history say of its states: planning is before any of the
 * experiment's work, and each review answers a submission.
 */
export const EXPERIMENT_STATES: Readonly<Record<string, UnitStateWords>> = {
  planned: { idle: true },
  design_review: { submitted: 'Submitted the design' },
  experiment_review: { submitted: 'Submitted the results' },
};
/** The document each kind of submission hands in. */
const HANDED: Record<ExperimentSubmission['stage'], 'plan' | 'report'> = {
  design: 'plan',
  results: 'report',
};
const named = (item: { artifactId: string; path: string }) => ({
  id: item.artifactId,
  title: clip(item.path.split('/').pop()!, 200),
});

/** The files an experiment's panel read: those it names by id, and those its sessions made. */
export type ExperimentFiles = UnitFiles;

/** Every file an experiment's record names: its evidence, its figures, and what its reviews cite. */
export function experimentFileIds(
  experiment: Experiment,
  reviews: readonly ReviewRequest[],
): { ids: string[]; sessions: string[] } {
  const evidence = [
    ...experiment.evidence,
    ...experiment.submissions.flatMap((item) => item.evidence),
  ];
  const ids = [
    ...evidence.flatMap((item) => [item.artifactId, ...item.figureIds]),
    ...experiment.submissions.flatMap((item) => item.figureIds),
    ...reviews.flatMap((review) => review.findings.flatMap((finding) => finding.evidenceIds)),
  ];
  const sessions = [...evidence, ...experiment.submissions].flatMap((item) =>
    item.sessionId ? [item.sessionId] : [],
  );
  return { ids: [...new Set(ids)], sessions: [...new Set(sessions)] };
}

/** The one document a submission handed in for its stage. */
const handed = (submission: ExperimentSubmission | undefined) => {
  const item = submission?.evidence.find((each) => each.role === HANDED[submission.stage]);
  return item && named(item);
};

/** An experiment's history: each submission with what it handed in, each verdict and return. */
export function experimentHistory(
  experiment: Experiment,
  graph: ProcessGraph,
  reviews: readonly ReviewRequest[],
): RunningUnitEntry[] {
  const byReview = new Map(experiment.submissions.map((item) => [item.reviewId, item]));
  return unitHistory({
    graph,
    reviews,
    states: EXPERIMENT_STATES,
    document: (review) => handed(byReview.get(review.id)),
  });
}

/**
 * The experiment as a unit: its history, the one thing to read now, and its files. While it is
 * designed and its design reviewed, the thing to read is the newest design submitted, or the
 * draft plan before any was; while it runs, the design that was approved; from its results on,
 * the report. Its files are what its producer attached and its producing sessions made, what
 * the server pinned beside them, and what its reviewers cited besides.
 */
export function experimentUnit(
  experiment: Experiment,
  graph: ProcessGraph,
  reviews: readonly ReviewRequest[],
  files: ExperimentFiles = { found: new Map() },
): RunningUnit {
  const history = experimentHistory(experiment, graph, reviews);
  const verdicts = new Map(reviews.map((review) => [review.id, review]));
  const word = (submission: ExperimentSubmission) => reviewWord(verdicts.get(submission.reviewId));
  // Only the current attempt's: a plan revised starts again from its draft.
  const newest = (stage: ExperimentSubmission['stage'], approved = false) =>
    experiment.submissions
      .filter(
        (item) =>
          item.stage === stage &&
          item.attemptIndex === experiment.attempt.index &&
          (!approved || word(item) === 'pass'),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .at(-1);
  const of = (label: string, submission: ExperimentSubmission | undefined, state?: string) => {
    const artifact = handed(submission);
    return artifact
      ? {
          label,
          artifact,
          ...((state ?? word(submission!)) ? { state: state ?? word(submission!) } : {}),
        }
      : undefined;
  };
  const draft = experiment.evidence
    .filter(
      (item) =>
        item.current && item.role === 'plan' && item.attemptIndex === experiment.attempt.index,
    )
    .at(-1);
  const plan = (): RunningUnitKey | undefined =>
    of('Current plan', newest('design')) ??
    (draft ? { label: 'Current plan', state: 'draft', artifact: named(draft) } : undefined);
  const key: RunningUnitKey | undefined =
    experiment.workflow.state === 'planned' || experiment.workflow.state === 'design_review'
      ? plan()
      : experiment.workflow.state === 'running'
        ? (of('Current plan', newest('design', true), 'approved') ?? plan())
        : (of('Report', newest('results')) ?? plan());
  const evidence = [
    ...experiment.evidence,
    ...experiment.submissions.flatMap((item) => item.evidence),
  ];
  // What the system generated (an exhibit) is nobody's own.
  const artifacts = unitFileList(graph, files, {
    producer: [
      ...evidence.filter((item) => !item.systemGenerated).map((item) => item.artifactId),
      ...[...evidence, ...experiment.submissions].flatMap((item) => item.figureIds),
    ],
    reviewer: reviews.flatMap((review) =>
      review.findings.flatMap((finding) => finding.evidenceIds),
    ),
    other: evidence.filter((item) => item.systemGenerated).map((item) => item.artifactId),
  });
  return {
    key: key ?? { label: 'Question', text: experiment.intent },
    history,
    ...(artifacts.length ? { artifacts } : {}),
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
  reviews?: readonly ReviewRequest[];
  files?: ExperimentFiles;
}): RunningPanelPart {
  const { standing, experiment, graph, route, reviews } = input;
  const unit = reviews && experimentUnit(experiment, graph, reviews, input.files);
  const { line } = face(standing);
  const red = attention(standing);
  const ended = !!ENDED[standing.state];
  const says: RunningPhrase = ended
    ? [...line, ' · ', { ago: standing.updatedAt }]
    : timed(line)
      ? line
      : [...line, ' · ', { since: standing.updatedAt }];
  const evidence = experiment.evidence
    .filter((item) => item.current && item.attemptIndex === experiment.attempt.index)
    .sort((a, b) => roleRank(a.role) - roleRank(b.role) || a.sequence - b.sequence);
  const files = evidence.slice(0, EVIDENCE_ROWS);
  const count = (drawn: number, total: number): RunningPhrase =>
    drawn < total ? [{ count: drawn, of: total }] : [{ count: total }];
  const sections: RunningSection[] = [
    { title: 'Stage', place: 'progress', kind: 'ladder', graph },
    // A failed prerequisite is why the card is red, so its section leads.
    ...dependencySections(
      graph.dependencies.filter((item) => item.direction === 'depends_on'),
      graph.dependencies.filter((item) => item.direction === 'required_by'),
      route,
      true,
    ),
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
    ...(unit ? { unit } : {}),
  };
}

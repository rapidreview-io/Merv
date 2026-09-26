import {
  clip,
  dependencyRows,
  runningKey,
  workRoute,
  type ProcessGraph,
  type ReviewRequest,
  type RunningAttention,
  type RunningLinkRow,
  type RunningNode,
  type RunningPanelPart,
  type RunningPhrase,
  type RunningSection,
  type TaskRecord,
  type WorkflowDependency,
} from '@merv/contracts';

/**
 * A task on the Running page: its card in the work lane and its sidebar, composed from facts
 * TaskService reads in one snapshot, so the card and the sidebar say one thing in the same
 * words. Nothing here evaluates guidance, which is per reader: what holds the task, what it
 * waits on and whether it needs a person are read from the record, its lease, its review and
 * the blockers other plugins published. A card's dot is the board's, lent by the sessions on
 * the task, so the card names only what holds it.
 */

/** What a task's card and sidebar are drawn from. */
export interface TaskStanding {
  id: string;
  title: string;
  state: string;
  /** What the live lease at the current revision holds the task for. */
  lease: 'work' | 'review' | null;
  /** The current review, while the task is in review. `waiting` is told to operators only. */
  review: Pick<ReviewRequest, 'id' | 'status' | 'reviewerId' | 'createdAt' | 'waiting'> | null;
  dependencies: WorkflowDependency[];
  /** Every return review_rounds allows from the current state has been used. */
  roundsUsed: boolean;
  /** Another plugin published why the task cannot go on. */
  blocked: boolean;
}

const ENDED: Record<string, string> = { done: 'Done', failed: 'Failed' };
const ended = (state: string) => Object.hasOwn(ENDED, state);
/** How the server titles the brief it composes from the title, the goal and the checks. */
const COMPOSED = 'Task brief: ';

/** Where a task stands, in the order its card is read: the first that holds wins. */
type Holding =
  | { at: 'ended' }
  | { at: 'suspended' }
  | { at: 'producer' }
  | { at: 'reviewing'; reviewerId: string | null }
  | { at: 'unclaimed'; since: string }
  | { at: 'waits'; names: string[] }
  | { at: 'waiting' }
  | { at: 'ready' };

function holding(task: TaskStanding): Holding {
  if (ended(task.state)) return { at: 'ended' };
  if (task.state === 'suspended') return { at: 'suspended' };
  if (task.lease === 'work') return { at: 'producer' };
  // A leased review names only that it is in review: the reviewer's session says who.
  if (task.lease === 'review') return { at: 'reviewing', reviewerId: null };
  if (task.state === 'in_review')
    return task.review?.status === 'requested'
      ? { at: 'unclaimed', since: task.review.createdAt }
      : { at: 'reviewing', reviewerId: task.review?.reviewerId ?? null };
  // Waiting is read from the prerequisites themselves, the same for every reader.
  const open = task.dependencies.filter((dependency) => !dependency.settled);
  if (open.length)
    return {
      at: 'waits',
      names: [...open.filter((d) => !d.failed), ...open.filter((d) => d.failed)].map((d) => d.name),
    };
  // Another plugin holds it back, so it is not ready for anyone; a person's move there is
  // that plugin's own mark on the board.
  return task.blocked ? { at: 'waiting' } : { at: 'ready' };
}

/** What needs a person, strongest first, and who ends the wait. */
function need(task: TaskStanding): RunningAttention | undefined {
  if (ended(task.state)) return undefined;
  const review = task.review && {
    route: `/reviews/${encodeURIComponent(task.review.id)}`,
    text: 'Open the review',
  };
  const failed =
    task.state === 'in_progress'
      ? task.dependencies.find((dependency) => dependency.failed)
      : undefined;
  if (failed)
    return {
      says: [short(failed.name), ' failed'],
      who: 'The producer ends this task, or its cycle replans it',
    };
  // A producer can never review its own work, so the hand review is an independent one.
  if (task.roundsUsed)
    return {
      says: ['Every review round is used'],
      who: 'An independent reviewer reviews it by hand, or an operator allows another round',
      ...(review ? { to: review } : {}),
    };
  if (task.state === 'suspended')
    return { says: ['Suspended'], who: 'A signed-in operator allows another review round' };
  if (task.state === 'in_review' && task.review?.waiting)
    return {
      says: ['No independent reviewer can take it'],
      who: 'An operator provides one',
      ...(review ? { to: review } : {}),
    };
  return undefined;
}

/** The card's one line. */
function face(at: Holding): RunningPhrase {
  switch (at.at) {
    case 'ended':
      return [];
    case 'suspended':
      return ['Suspended'];
    case 'producer':
      return ['Producer on it'];
    case 'reviewing':
      return at.reviewerId
        ? ['In review · ', { actor: at.reviewerId, prefix: 'with ', unnamed: 'claimed' }]
        : ['In review'];
    case 'unclaimed':
      return ['Review unclaimed · ', { since: at.since }];
    case 'waits':
      return ['Waits on ', ...more(at.names)];
    case 'waiting':
      return ['Waiting'];
    case 'ready':
      return ['Ready'];
  }
}

/**
 * The sidebar head's clause after the state word. Who reviews it, and since when, is the
 * Review section's to say, so the head does not say it a second time.
 */
function clause(at: Holding): RunningPhrase {
  switch (at.at) {
    case 'producer':
      return [' · producer on it'];
    case 'unclaimed':
      return [' · unclaimed'];
    case 'waits':
      return [' · waits on ', ...more(at.names)];
    case 'waiting':
      return [' · waiting'];
    case 'ready':
      return [' · ready'];
    default:
      return [];
  }
}

const more = (names: string[]): RunningPhrase => [
  short(names[0]!),
  ...(names.length > 1 ? [` and ${names.length - 1} more`] : []),
];

/** A name as long as the page holds one. */
const short = (name: string, max = 200) =>
  name.length > max ? `${clip(name, max - 1).trimEnd()}…` : name;

/** Needs a person, then held by a lease, then ready, then waiting; an ended task last. */
const RANK: Record<Holding['at'], number> = {
  producer: 1,
  reviewing: 1,
  suspended: 2,
  unclaimed: 2,
  ready: 2,
  waits: 3,
  waiting: 3,
  ended: 4,
};

/**
 * A task's card. An ended task is drawn only while another owner holds its key, and then
 * the mark that holds it takes the first line, above the word it ended with.
 */
export function taskNode(task: TaskStanding): RunningNode {
  const at = holding(task);
  const attention = need(task);
  return {
    key: runningKey('work', task.id),
    lane: 'work',
    kind: 'Task',
    title: short(task.title),
    lines: at.at === 'ended' ? [[], [ENDED[task.state]!]] : [face(at)],
    look:
      at.at === 'ended' ? 'quiet' : at.at === 'waits' || at.at === 'waiting' ? 'dashed' : 'solid',
    ...(attention ? { attention } : {}),
    ...(task.dependencies.length
      ? {
          links: task.dependencies.map((dependency) => ({
            to: runningKey('work', dependency.id),
            verb: 'waits on' as const,
            ...(dependency.settled ? {} : { waiting: true }),
          })),
        }
      : {}),
    rank: attention ? 0 : RANK[at.at],
  };
}

/**
 * A task's sidebar: where it stands in its workflow, what it waits on and holds up, what was
 * asked and what the delivery claims, and whose it is. Its review, its sessions and its code
 * are their owners' sections.
 */
export function taskPanel(
  task: TaskStanding,
  record: TaskRecord,
  graph: ProcessGraph,
  brief: { id: string; title: string } | null,
): RunningPanelPart {
  const at = holding(task);
  const attention = need(task);
  const named = (row: RunningLinkRow): RunningLinkRow => ({ ...row, name: short(row.name) });
  const { waitsOn, unblocks } = dependencyRows(record.dependencies, record.dependents);
  // A delivery's claims belong to it: once a review sends the work back they are withdrawn.
  const claimed = task.state === 'in_review' || task.state === 'done';
  const claims = new Map(
    record.deliveryConfirmations.map((confirmation) => [
      confirmation.checkNumber,
      confirmation.status,
    ]),
  );
  const delivered = graph.edges
    .filter((edge) => edge.action === 'submit_delivery')
    .flatMap((edge) => edge.traversals.map((traversal) => traversal.at))
    .sort()
    .at(-1);
  const sections: RunningSection[] = [
    { title: 'Progress', place: 'progress', kind: 'ladder', graph },
    ...(waitsOn.length
      ? [
          {
            title: 'Waits on',
            place: 'relations' as const,
            kind: 'links' as const,
            rows: waitsOn.map(named),
            // A failed prerequisite is why the task needs a person.
            ...(waitsOn.some((row) => row.attention) ? { attention: true } : {}),
          },
        ]
      : []),
    ...(unblocks.length
      ? [
          {
            title: 'Unblocks',
            place: 'relations' as const,
            kind: 'links' as const,
            rows: unblocks.map(named),
          },
        ]
      : []),
    { title: 'Goal', place: 'content', kind: 'text', text: record.goal, clamp: 4 },
    // A brief somebody wrote can say more than the goal and the checks; the one the server
    // composes only repeats them, so it is not offered.
    ...(brief && !brief.title.startsWith(COMPOSED)
      ? [
          {
            title: 'Pinned brief',
            place: 'content' as const,
            kind: 'links' as const,
            rows: [
              {
                to: { route: `/artifacts/${encodeURIComponent(brief.id)}` },
                name: short(brief.title),
              },
            ],
          },
        ]
      : []),
    {
      title: 'Checks',
      place: 'content',
      kind: 'table',
      columns: claimed ? ['Check', 'Claim'] : ['Check'],
      rows: record.acceptanceChecks.map(({ number, text }) => {
        const claim = claims.get(number);
        const check: RunningPhrase = [short(`${number} · ${text}`, 1000)];
        return { cells: claimed ? [check, claim ? [{ state: claim }] : []] : [check] };
      }),
      ...(claimed && delivered ? { aside: ['Delivered ', { ago: delivered }] } : {}),
    },
    {
      title: 'Details',
      place: 'details',
      kind: 'facts',
      rows: [
        { label: 'Producer', value: [{ actor: record.producerId }] },
        { label: 'Created', value: [{ ago: record.createdAt }] },
      ],
    },
  ];
  const route = workRoute('task', task.id);
  return {
    header: {
      kind: 'Task',
      title: short(task.title),
      says: [{ state: task.state }, ...clause(at)],
      ...(attention ? { attention } : {}),
    },
    sections,
    actions: [],
    ...(route ? { route } : {}),
    live: task.lease !== null,
  };
}

import type { TaskRecord } from './types.js';
import {
  ellipsis,
  keyId,
  keyKind,
  mapAsync,
  MervError,
  runningKey,
  type Caller,
  type ProcessGraph,
  type ReviewRequest,
  type RunningAttention,
  type RunningLinkRow,
  type RunningNode,
  type RunningPanelPart,
  type RunningPhrase,
  type RunningSection,
  type Transaction,
  type WorkflowDependency,
  type WorkflowLimitStatus,
  type WorkRoute,
} from '@merv/contracts';
import { dependencyRows } from '@merv/workflows/dependency-rows';
import { leaseRows } from '@merv/workflows/lease-rows';
import { composedBrief } from './evidence.js';
import type { TaskLeaseRow, TaskRow, TaskService } from './index.js';
import { roundsFrom, TASK_WORKFLOW, taskVersions } from './workflow.js';

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

/** A failed prerequisite needs a person only while the task is being worked on. */
const failedPrerequisite = (task: TaskStanding) =>
  task.state === 'in_progress'
    ? task.dependencies.find((dependency) => dependency.failed)
    : undefined;

/** What needs a person, strongest first, and who ends the wait. */
function need(task: TaskStanding): RunningAttention | undefined {
  if (ended(task.state)) return undefined;
  const review = task.review && {
    route: `/reviews/${encodeURIComponent(task.review.id)}`,
    text: 'Open the review',
  };
  const failed = failedPrerequisite(task);
  if (failed)
    return {
      says: [short(failed.name), ' failed'],
      who: 'The producer ends this task, or its cycle replans it',
    };
  // A producer can never review its own work, so the hand review is an independent one, and it
  // can only fail the task. Once a reviewer has claimed it by hand the move is made, and the card
  // says who has it.
  const byHand = task.review?.status === 'started' && task.lease === null;
  if (task.roundsUsed && !byHand)
    return {
      says: ['Every review round is used'],
      who: 'An operator allows another round, or an independent reviewer fails it by hand',
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
const short = (name: string, max = 200) => ellipsis(name, max);

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
  route: WorkRoute,
): RunningPanelPart {
  const at = holding(task);
  const attention = need(task);
  const named = (row: RunningLinkRow): RunningLinkRow => ({ ...row, name: short(row.name) });
  const { waitsOn, unblocks } = dependencyRows(record.dependencies, record.dependents, route);
  // A failed prerequisite is why the task needs a person, but only while it is worked on: the
  // row still says failed after that, without the red.
  const failing = !!failedPrerequisite(task);
  const waits = waitsOn.map(({ attention: red, ...row }) =>
    named(failing && red ? { ...row, attention: red } : row),
  );
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
    ...(waits.length
      ? [
          {
            title: 'Waits on',
            place: 'relations' as const,
            kind: 'links' as const,
            rows: waits,
            ...(waits.some((row) => row.attention) ? { attention: true } : {}),
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
    ...(brief && !composedBrief(brief)
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
  const page = route('task', task.id);
  return {
    header: {
      kind: 'Task',
      title: short(task.title),
      says: [{ state: task.state }, ...clause(at)],
      ...(attention ? { attention } : {}),
    },
    sections,
    actions: [],
    ...(page ? { route: page } : {}),
    live: task.lease !== null,
  };
}

// TaskService's reads for the board and the sidebar, which it runs as its own methods.

/** A record another plugin answers 404 for is simply not there to speak of. */
const absent = (error: unknown): null => {
  if (error instanceof MervError && error.status === 404) return null;
  throw error;
};

/** A task as the Running page's work lane reads it, with where its workflow stands. */
interface RunningTaskRow {
  id: string;
  title: string;
  review_id: string | null;
  version: number;
  state: string;
  revision: number;
}

/**
 * Every task still in flight, and each ended one another owner holds on the board, read in
 * one snapshot that refuses writes. Guidance is never evaluated here: it is per reader, where
 * a card says the same to everyone, and it would cost an evaluation per task on every poll.
 * The board draws only what a task waits on, so what waits on it is left to its sidebar, and
 * the prerequisites and review rounds of every task are each read once for all of them.
 */
export async function running(
  this: TaskService,
  caller: Caller,
  include: Iterable<string> = [],
): Promise<RunningNode[]> {
  caller = structuredClone(caller);
  const held = [...new Set([...include].filter((key) => keyKind(key) === 'work').map(keyId))];
  return await this.state.snapshot(
    async () =>
      await this.state.transaction(async (tx) => {
        await this.scope.require(caller, 'read', tx);
        const ids = [
          ...(await this.workflows.open('task', caller.projectId, tx)).map((w) => w.id),
          ...held,
        ];
        const at = await this.workflows.revisions(caller.projectId, ids, tx);
        const rows = (
          await tx.all<Pick<RunningTaskRow, 'id' | 'title' | 'review_id'>>(
            `SELECT id,title,review_id FROM tasks WHERE project_id=? AND id IN (${ids.map(() => '?').join(',') || 'NULL'}) ORDER BY created_at,id`,
            caller.projectId,
            ...ids,
          )
        ).flatMap((row) => {
          const w = at.get(row.id);
          return w ? [{ ...row, version: w.version, state: w.state, revision: w.revision }] : [];
        });
        const leases = await this.liveLeases(caller, tx);
        const blocked = new Set(
          (await this.workflows.blockers(caller, undefined, tx)).map(
            (blocker) => blocker.instanceId,
          ),
        );
        const waitsOn = await this.workflows.prerequisites(
          caller,
          rows.map((row) => row.id),
          tx,
        );
        const rounds = await this.workflows.limitStatusOf(
          caller,
          rows
            .filter((row) => taskVersions[row.version] && row.state === roundsFrom(row.version))
            .map((row) => row.id),
          'review_rounds',
          tx,
        );
        return await mapAsync(
          rows.filter((row) => taskVersions[row.version] || held.includes(row.id)),
          async (row) =>
            taskNode(
              await this.standing(
                caller,
                row,
                waitsOn.get(row.id) ?? [],
                leases,
                blocked.has(row.id),
                tx,
                rounds,
              ),
            ),
        );
      }),
  );
}

/** A task's Running sidebar, whatever its state, so an open sidebar outlives the card. */
export async function runningPanel(
  this: TaskService,
  caller: Caller,
  taskId: string,
  route: WorkRoute = () => undefined,
): Promise<RunningPanelPart | null> {
  caller = structuredClone(caller);
  return await this.state.snapshot(async () => {
    const read = await this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'read', tx);
      const row = await tx.get<TaskRow>(
        'SELECT * FROM tasks WHERE id=? AND project_id=?',
        taskId,
        caller.projectId,
      );
      if (!row) return null;
      const record = await this.projectRecord(caller, row, tx);
      const { version, state, revision } = record.workflow;
      const standing = await this.standing(
        caller,
        { id: row.id, title: row.title, review_id: row.review_id, version, state, revision },
        record.dependencies,
        await this.liveLeases(caller, tx, taskId),
        (await this.workflows.blockers(caller, taskId, tx)).length > 0,
        tx,
      );
      const brief = await this.artifacts.get(caller, record.briefId, tx).catch((error) => {
        if (error instanceof MervError && error.status === 404) return null;
        throw error;
      });
      return { record, standing, brief };
    });
    if (!read) return null;
    // The ladder is Workflows' own read of this snapshot, so it runs after the one above.
    const graph = await this.process(caller, taskId);
    return taskPanel(read.standing, read.record, graph, read.brief, route);
  });
}

/** The purpose of each live lease, by task and the revision it was offered for. */
export async function liveLeases(
  this: TaskService,
  caller: Caller,
  tx: Transaction,
  taskId?: string,
): Promise<Map<string, 'work' | 'review'>> {
  const rows = await leaseRows<TaskLeaseRow['details']>(tx, {
    projectId: caller.projectId,
    ...(taskId === undefined ? { workflows: [TASK_WORKFLOW.name] } : { instanceIds: [taskId] }),
    active: true,
  });
  return new Map(rows.map((row) => [`${row.instance_id}@${row.revision}`, row.details.purpose]));
}

/**
 * One task's facts. `counted` is the board's one read of review rounds for every task; the
 * sidebar, reading one task, counts its own. A review the task names and Reviews does not
 * hold leaves the task drawn without it, rather than taking every other task with it.
 */
export async function standing(
  this: TaskService,
  caller: Caller,
  row: RunningTaskRow,
  dependencies: TaskStanding['dependencies'],
  leases: Awaited<ReturnType<TaskService['liveLeases']>>,
  blocked: boolean,
  tx: Transaction,
  counted?: ReadonlyMap<string, WorkflowLimitStatus>,
): Promise<TaskStanding> {
  // Only the limit leaving the current state stops anything, as the gate reads it.
  const rounds =
    !taskVersions[row.version] || row.state !== roundsFrom(row.version)
      ? null
      : counted
        ? (counted.get(row.id) ?? null)
        : (await this.workflows.limitStatusOf(caller, [row.id], 'review_rounds', tx)).get(row.id)!;
  const review =
    row.state === 'in_review' && row.review_id
      ? await this.reviews.get(caller, row.review_id, tx).catch(absent)
      : null;
  return {
    id: row.id,
    title: row.title,
    state: row.state,
    // A lease of an earlier revision holds nothing the task still is.
    lease: leases.get(`${row.id}@${row.revision}`) ?? null,
    review: review && {
      id: review.id,
      status: review.status,
      reviewerId: review.reviewerId,
      createdAt: review.createdAt,
      ...(review.waiting ? { waiting: review.waiting } : {}),
    },
    dependencies,
    roundsUsed: !!rounds?.exhausted,
    blocked,
  };
}

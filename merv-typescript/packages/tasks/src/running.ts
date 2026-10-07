import type { TaskRecord } from './types.js';
import {
  ellipsis,
  keyId,
  keyKind,
  mapAsync,
  MAX_ARTIFACT_IDS,
  MervError,
  runningKey,
  type Caller,
  type Artifact,
  type ReviewRequest,
  type RunningAttention,
  type RunningLinkRow,
  type RunningNode,
  type RunningPanelPart,
  type RunningPhrase,
  type RunningSection,
  type RunningUnit,
  type Transaction,
  type WorkRoute,
} from '@merv/contracts';
import type { ProcessGraph, WorkflowDependency } from '@merv/workflows/models';
import { dependencyRows } from '@merv/workflows/dependency-rows';
import { leaseRows } from '@merv/workflows/lease-rows';
import {
  reviewWord,
  unitArtifacts,
  unitHistory,
  type UnitFile,
  type UnitStateWords,
} from '@merv/reviews/unit-history';
import { composedBrief } from './evidence.js';
import type { TaskRow, TasksContext } from './index.js';
import { TASK_WORKFLOW, taskVersions } from './workflow.js';

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
  /** Another plugin published why the task cannot go on. */
  blocked: boolean;
  /** When the task was created: the live card counts from it. */
  started?: string;
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
  // Rounds used up, and a suspended task waiting for another round, are Workflows' mark on the
  // card, in the words every owner's work shares.
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
    ...(task.started ? { started: task.started } : {}),
  };
}

/**
 * Every file a task's record names, `delivered` being what its producer handed in or cited,
 * and the session that delivered it.
 */
export function taskFileIds(record: TaskRecord, reviews: readonly ReviewRequest[]) {
  const delivered = [
    ...record.deliveryIds,
    ...(record.deliveryCodeArtifactId ? [record.deliveryCodeArtifactId] : []),
    ...record.deliveryConfirmations.flatMap((item) => item.evidenceIds),
  ];
  const ids = [
    record.briefId,
    ...delivered,
    ...reviews.flatMap((review) => [
      ...review.artifactIds,
      ...review.findings.flatMap((finding) => finding.evidenceIds),
    ]),
  ];
  return {
    ids: [...new Set(ids)],
    delivered,
    sessions: record.deliveryCode ? [record.deliveryCode.sessionId] : [],
  };
}

/** What the shell and a task's history say of its states: crossing into review is a delivery. */
export const TASK_STATES: Readonly<Record<string, UnitStateWords>> = {
  in_review: { submitted: 'Delivered' },
};

/**
 * The task as a unit: its history, and the one thing to read. Before anything is delivered
 * that is the goal, with the checks still open under it; once something is, the report the
 * producer delivered, with each check met or not as the newest verdict found it, or as the
 * delivery claimed it until a verdict has.
 */
export function taskUnit(
  record: TaskRecord,
  graph: ProcessGraph,
  reviews: readonly ReviewRequest[],
  artifacts: ReadonlyMap<
    string,
    Pick<Artifact, 'id' | 'title' | 'mediaType'> & Partial<Pick<Artifact, 'size' | 'createdAt'>>
  >,
  made: readonly UnitFile['artifact'][] = [],
): RunningUnit {
  // What a delivery handed in: its report, not the brief it was pinned beside or its code record.
  const document = (review: ReviewRequest) => {
    const handed = review.artifactIds
      .filter((id) => id !== record.briefId)
      .map((id) => artifacts.get(id))
      .filter((artifact) => artifact !== undefined);
    const report =
      handed.find((artifact) => /^text\/(markdown|plain)/.test(artifact.mediaType)) ?? handed[0];
    return report && { id: report.id, title: short(report.title) };
  };
  const history = unitHistory({ graph, reviews, states: TASK_STATES, document });
  const delivered = [...history].reverse().find((entry) => entry.artifact);
  const newest = [...reviews]
    .filter((review) => review.subjectId === record.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1);
  const word = reviewWord(newest);
  const judged = word && word !== 'in_review' ? newest : undefined;
  const found = new Map(judged?.findings.map((item) => [item.criterionNumber, item.status]));
  // A delivery's claims stand while its review is open; a review superseded withdraws them.
  const claimed = new Map(
    word === 'in_review'
      ? record.deliveryConfirmations.map((item) => [item.checkNumber, item.status])
      : [],
  );
  const checks = record.acceptanceChecks.map(({ number, text }) => {
    const status = delivered ? (judged ? found.get(number) : claimed.get(number)) : undefined;
    return { text: short(text, 1000), ...(status ? { met: status === 'met' } : {}) };
  });
  // Its files: what each delivery handed in and cited, what its delivering session made, what
  // its reviewers cited besides, and the brief it was asked with.
  const file = (id: string, role?: UnitFile['role']): UnitFile[] => {
    const artifact = artifacts.get(id);
    const { size, createdAt } = artifact ?? {};
    return artifact && size !== undefined && createdAt
      ? [{ artifact: { ...artifact, size, createdAt }, ...(role ? { role } : {}) }]
      : [];
  };
  const files = unitArtifacts(graph, [
    ...taskFileIds(record, []).delivered.flatMap((id) => file(id, 'producer')),
    ...reviews
      .flatMap((review) => review.artifactIds)
      .filter((id) => id !== record.briefId)
      .flatMap((id) => file(id, 'producer')),
    ...made.map((artifact): UnitFile => ({ artifact, role: 'producer' })),
    ...reviews
      .flatMap((review) => review.findings.flatMap((finding) => finding.evidenceIds))
      .flatMap((id) => file(id, 'reviewer')),
    ...file(record.briefId),
  ]);
  return {
    ...(files.length ? { artifacts: files } : {}),
    key: delivered?.artifact
      ? {
          label: 'Delivery',
          state: word ?? graph.state,
          artifact: delivered.artifact,
        }
      : { label: 'Goal', text: record.goal },
    checks,
    history,
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
  unit?: RunningUnit,
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
    // A unit says its goal and its checks itself, so they are sections only without one.
    ...(unit
      ? []
      : [
          {
            title: 'Goal',
            place: 'content' as const,
            kind: 'text' as const,
            text: record.goal,
            clamp: 4,
          },
        ]),
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
    ...(unit
      ? []
      : [
          {
            title: 'Checks',
            place: 'content' as const,
            kind: 'table' as const,
            columns: claimed ? ['Check', 'Claim'] : ['Check'],
            rows: record.acceptanceChecks.map(({ number, text }) => {
              const claim = claims.get(number);
              const check: RunningPhrase = [short(`${number} · ${text}`, 1000)];
              return { cells: claimed ? [check, claim ? [{ state: claim }] : []] : [check] };
            }),
            ...(claimed && delivered
              ? { aside: ['Delivered ', { ago: delivered }] as RunningPhrase }
              : {}),
          },
        ]),
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
    ...(unit ? { unit } : {}),
  };
}

// TaskService's reads for the board and the sidebar, each run on it as its TasksContext.

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
  created_at?: string;
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
  ctx: TasksContext,
  caller: Caller,
  include: Iterable<string> = [],
): Promise<RunningNode[]> {
  caller = structuredClone(caller);
  const held = [...new Set([...include].filter((key) => keyKind(key) === 'work').map(keyId))];
  return await ctx.state.snapshot(
    async () =>
      await ctx.state.transaction(async (tx) => {
        await ctx.scope.require(caller, 'read', tx);
        const ids = [
          ...(await ctx.workflows.open('task', caller.projectId, tx)).map((w) => w.id),
          ...held,
        ];
        const at = await ctx.workflows.revisions(caller.projectId, ids, tx);
        const rows = (
          await tx.all<Pick<RunningTaskRow, 'id' | 'title' | 'review_id' | 'created_at'>>(
            `SELECT id,title,review_id,created_at FROM tasks WHERE project_id=? AND id IN (${ids.map(() => '?').join(',') || 'NULL'}) ORDER BY created_at,id`,
            caller.projectId,
            ...ids,
          )
        ).flatMap((row) => {
          const w = at.get(row.id);
          return w ? [{ ...row, version: w.version, state: w.state, revision: w.revision }] : [];
        });
        const leases = await liveLeases(ctx, caller, tx);
        const blocked = new Set(
          (await ctx.workflows.blockers(caller, undefined, tx)).map(
            (blocker) => blocker.instanceId,
          ),
        );
        const waitsOn = await ctx.workflows.prerequisites(
          caller,
          rows.map((row) => row.id),
          tx,
        );
        return await mapAsync(
          rows.filter((row) => taskVersions[row.version] || held.includes(row.id)),
          async (row) =>
            taskNode(
              await standing(
                ctx,
                caller,
                row,
                waitsOn.get(row.id) ?? [],
                leases,
                blocked.has(row.id),
                tx,
              ),
            ),
        );
      }),
  );
}

/** A task's Running sidebar, whatever its state, so an open sidebar outlives the card. */
export async function runningPanel(
  ctx: TasksContext,
  caller: Caller,
  taskId: string,
  route: WorkRoute = () => undefined,
): Promise<RunningPanelPart | null> {
  caller = structuredClone(caller);
  return await ctx.state.snapshot(async () => {
    const read = await ctx.state.transaction(async (tx) => {
      await ctx.scope.require(caller, 'read', tx);
      const row = await tx.get<TaskRow>(
        'SELECT * FROM tasks WHERE id=? AND project_id=?',
        taskId,
        caller.projectId,
      );
      if (!row) return null;
      const record = await ctx.projectRecord(caller, row, tx);
      const { version, state, revision } = record.workflow;
      const facts = await standing(
        ctx,
        caller,
        { id: row.id, title: row.title, review_id: row.review_id, version, state, revision },
        record.dependencies,
        await liveLeases(ctx, caller, tx, taskId),
        (await ctx.workflows.blockers(caller, taskId, tx)).length > 0,
        tx,
      );
      const brief = await ctx.artifacts.get(caller, record.briefId, tx).catch((error) => {
        if (error instanceof MervError && error.status === 404) return null;
        throw error;
      });
      return { record, standing: facts, brief };
    });
    if (!read) return null;
    // The ladder is Workflows' own read of this snapshot, so it runs after the one above.
    const graph = await ctx.process(caller, taskId);
    // Every round of review, and the files each one pinned, for the history and its documents.
    const reviews = await ctx.reviews.list(caller, { subjectId: taskId });
    const named = taskFileIds(read.record, reviews);
    const { artifacts, made } = await ctx.state.transaction(async (tx) => {
      const made: Artifact[] = [];
      for (const session of named.sessions)
        made.push(...(await ctx.artifacts.list(caller, { session, limit: 200 }, tx)));
      return {
        artifacts: await ctx.artifacts.find(caller, named.ids.slice(0, MAX_ARTIFACT_IDS), tx),
        made,
      };
    });
    const unit = taskUnit(read.record, graph, reviews, artifacts, made);
    return taskPanel(read.standing, read.record, graph, read.brief, route, unit);
  });
}

/** The purpose of each live lease, by task and the revision it was offered for. */
export async function liveLeases(
  ctx: TasksContext,
  caller: Caller,
  tx: Transaction,
  taskId?: string,
): Promise<Map<string, 'work' | 'review'>> {
  const rows = await leaseRows(
    tx,
    {
      projectId: caller.projectId,
      ...(taskId === undefined ? { workflows: [TASK_WORKFLOW.name] } : { instanceIds: [taskId] }),
      active: true,
    },
    { detail: 'purpose' },
  );
  return new Map(
    rows.map((row) => [`${row.instance_id}@${row.revision}`, row.detail as 'work' | 'review']),
  );
}

/**
 * One task's facts. A review the task names and Reviews does not hold leaves the task drawn
 * without it, rather than taking every other task with it.
 */
export async function standing(
  ctx: TasksContext,
  caller: Caller,
  row: RunningTaskRow,
  dependencies: TaskStanding['dependencies'],
  leases: Awaited<ReturnType<typeof liveLeases>>,
  blocked: boolean,
  tx: Transaction,
): Promise<TaskStanding> {
  const review =
    row.state === 'in_review' && row.review_id
      ? await ctx.reviews.get(caller, row.review_id, tx).catch(absent)
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
    blocked,
    ...(row.created_at ? { started: new Date(row.created_at).toISOString() } : {}),
  };
}

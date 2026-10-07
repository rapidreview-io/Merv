import type { ProcessGraph } from '@merv/workflows/models';
import { MAX_ARTIFACT_IDS } from '@merv/contracts';
import type {
  Artifact,
  Artifacts,
  Caller,
  ReviewRequest,
  RunningUnitArtifact,
  RunningUnitEntry,
  Transaction,
} from '@merv/contracts';
import { reviewStanding } from './rules.js';

/**
 * A unit's history as its owner tells it on the Work page and its record page: every recorded
 * crossing of the record's own process graph, oldest first. A crossing into one of the owner's
 * review gates is its producer's submission, with the document it submitted; the verdict that
 * carried the record out again is the reviewer's, followed by the return it was when it landed
 * earlier in the program than the gate it left; anything else only moved the record and is one
 * quiet line. A record standing at a gate ends on the review still open there.
 *
 * A submission is answered by the review it requested, pinned at the revision the crossing
 * made, so the k-th submission meets the k-th review. Each entry names the thread that did it
 * by its role and the stage that thread stands at: a producer's at the state it submitted
 * from, a reviewer's at the gate. Nothing here knows any program's states: the owner passes
 * the words its UI row declares for them, and a state a submission crosses into is a review
 * gate. How a review stands is Reviews' own `reviewStanding`.
 */
export interface UnitStateWords {
  /** Work not yet begun. */
  idle?: true;
  /** At a review gate: what crossing into it says its producer did, e.g. 'Delivered'. */
  submitted?: string;
}
export interface UnitHistoryInput {
  graph: ProcessGraph;
  /** The reviews of this record, in any order. */
  reviews: readonly ReviewRequest[];
  /** The owner's words for its states, as its UI row declares them. */
  states: Readonly<Record<string, UnitStateWords>>;
  /** The document a submission handed in, read from the review it requested. */
  document?(review: ReviewRequest): { id: string; title: string } | undefined;
  /** Every other file it handed in. */
  files?(review: ReviewRequest): { id: string; title: string }[];
}

/**
 * The one word a unit says of the review of what it handed in: its verdict, `in_review` while
 * it is open, and nothing once it was superseded or ended without one.
 */
export function reviewWord(
  review: Parameters<typeof reviewStanding>[0] | null | undefined,
): string | undefined {
  const standing = review ? reviewStanding(review) : null;
  if (!standing || standing.word === 'superseded') return undefined;
  return standing.word === 'unclaimed' || standing.word === 'claimed' ? 'in_review' : standing.word;
}

const words = (state: string) => state.replaceAll('_', ' ');

/** The line a review still open at its gate stands on; nothing for one that is not open. */
function waiting(review: ReviewRequest, stage: string): RunningUnitEntry[] {
  const standing = reviewStanding(review);
  if (standing?.word !== 'unclaimed' && standing?.word !== 'claimed') return [];
  return [
    {
      role: 'reviewer',
      stage,
      said: standing.word === 'unclaimed' ? 'Review unclaimed' : 'In review',
      ...(standing.word === 'claimed' && standing.reviewerId ? { actor: standing.reviewerId } : {}),
      review: review.id,
      ...(review.waiting ? { attention: true } : {}),
    },
  ];
}

/**
 * The verdict a review posted when the record left its gate: its word, how many checks it found
 * met of all it judged, and its sentence. Nothing for a review that reached no verdict.
 */
function verdict(review: ReviewRequest, stage: string, at: string): RunningUnitEntry[] {
  const standing = reviewStanding(review);
  if (!standing || !('exceptions' in standing)) return [];
  const short = standing.exceptions.reduce((sum, each) => sum + each.criteria.length, 0);
  const of = standing.of || review.criteria.length;
  const text = review.synopsis ?? review.notes;
  return [
    {
      role: 'reviewer',
      stage,
      ...(review.reviewerId ? { actor: review.reviewerId } : {}),
      at,
      verdict: { word: standing.word, met: standing.of - short, of, ...(text ? { text } : {}) },
      review: review.id,
    },
  ];
}

export function unitHistory({ graph, reviews, states, document, files }: UnitHistoryInput) {
  const gate = (state: string) => states[state]?.submitted !== undefined;
  const rounds = reviews
    .filter((review) => review.subjectId === graph.instanceId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const order = graph.nodes.map((node) => node.state);
  const crossings = graph.edges
    .flatMap((edge) => edge.traversals.map((step) => ({ ...step, from: edge.from, to: edge.to })))
    .sort((a, b) => a.at.localeCompare(b.at) || a.revision - b.revision);
  const entries: RunningUnitEntry[] = [];
  let open: ReviewRequest | undefined;
  for (const step of crossings) {
    const into = gate(step.to);
    const out = gate(step.from);
    const decided = out && !into && open ? verdict(open, step.from, step.at) : [];
    open = into ? rounds.find((review) => review.subjectRevision === step.revision) : undefined;
    if (into && !out) {
      const handed = open && document?.(open);
      const rest = (open && files?.(open)) || [];
      entries.push({
        role: 'producer',
        stage: step.from,
        actor: step.actorId,
        at: step.at,
        said: states[step.to]!.submitted,
        ...(handed ? { artifact: handed } : {}),
        ...(rest.length ? { files: rest } : {}),
      });
    } else if (decided.length) {
      entries.push(...decided);
      if (order.indexOf(step.to) < order.indexOf(step.from))
        entries.push({ at: step.at, said: `Returned to ${words(step.to)}` });
    } else
      entries.push({
        actor: step.actorId,
        at: step.at,
        said: words(step.to).replace(/^./, (first) => first.toUpperCase()),
      });
  }
  if (gate(graph.state) && open) entries.push(...waiting(open, graph.state));
  return entries;
}

/** Where the record stood at `at`: the state its last crossing before then led into. */
export function stageAt(graph: ProcessGraph, at: string): string {
  const crossings = graph.edges
    .flatMap((edge) =>
      edge.traversals.map((step) => ({ at: step.at, from: edge.from, to: edge.to })),
    )
    .sort((a, b) => a.at.localeCompare(b.at));
  if (!crossings.length) return graph.state;
  return crossings.filter((step) => step.at < at).at(-1)?.to ?? crossings[0]!.from;
}

/** A file of the unit's, and the role of whoever made it where the owner knows it. */
export interface UnitFile {
  artifact: Pick<Artifact, 'id' | 'title' | 'mediaType' | 'size' | 'createdAt'>;
  role?: 'producer' | 'reviewer';
}

/**
 * The unit's files for its Artifacts tab, newest first: each listed once, under the role the
 * owner names first for it, at the stage the record stood in when the file was made.
 */
export function unitArtifacts(graph: ProcessGraph, files: readonly UnitFile[]) {
  const seen = new Map<string, UnitFile>();
  for (const file of files) if (!seen.has(file.artifact.id)) seen.set(file.artifact.id, file);
  return [...seen.values()]
    .sort(
      (a, b) =>
        b.artifact.createdAt.localeCompare(a.artifact.createdAt) ||
        b.artifact.id.localeCompare(a.artifact.id),
    )
    .map(({ artifact, role }): RunningUnitArtifact => ({
      id: artifact.id,
      title: artifact.title.slice(0, 200),
      mediaType: artifact.mediaType,
      size: artifact.size,
      at: artifact.createdAt,
      stage: stageAt(graph, artifact.createdAt),
      ...(role ? { role } : {}),
    }));
}

/** A unit's files as its sidebar read them: those its record names, and what its sessions made. */
export interface UnitFiles {
  found: ReadonlyMap<
    string,
    Pick<Artifact, 'id' | 'title' | 'mediaType'> & Partial<Pick<Artifact, 'size' | 'createdAt'>>
  >;
  made?: readonly UnitFile['artifact'][];
}

/** How many files a unit's sessions made its sidebar reads, newest first, in all. */
export const UNIT_MADE_LIMIT = 500;
/**
 * Reads a unit's files in the sidebar's transaction, in two statements: the first
 * MAX_ARTIFACT_IDS its record names, and the newest UNIT_MADE_LIMIT its sessions made.
 */
export async function unitFiles(
  artifacts: Pick<Artifacts, 'find' | 'list'>,
  caller: Caller,
  named: { ids: readonly string[]; sessions: readonly string[] },
  tx: Transaction,
): Promise<{ found: Map<string, Artifact>; made: Artifact[] }> {
  const found = await artifacts.find(caller, named.ids.slice(0, MAX_ARTIFACT_IDS), tx);
  const made = named.sessions.length
    ? await artifacts.list(caller, { sessions: named.sessions, limit: UNIT_MADE_LIMIT }, tx)
    : [];
  return { found, made };
}

/**
 * The unit's Artifacts tab from its files (`unitArtifacts`): what the system generated, which
 * is nobody's own even when a session made it or a reviewer cited it, then what its producer
 * handed in or made, then what its reviewers cited, then any other file its record names, such
 * as its brief. A file named twice is listed under the first of these.
 */
export function unitFileList(
  graph: ProcessGraph,
  files: UnitFiles,
  named: {
    generated?: readonly string[];
    producer: readonly string[];
    reviewer: readonly string[];
    other?: readonly string[];
  },
): RunningUnitArtifact[] {
  const file = (role?: UnitFile['role']) => (id: string) => {
    const artifact = files.found.get(id);
    const { size, createdAt } = artifact ?? {};
    return artifact && size !== undefined && createdAt
      ? [{ artifact: { ...artifact, size, createdAt }, ...(role ? { role } : {}) }]
      : [];
  };
  return unitArtifacts(graph, [
    ...(named.generated ?? []).flatMap(file()),
    ...named.producer.flatMap(file('producer')),
    ...(files.made ?? []).map((artifact): UnitFile => ({ artifact, role: 'producer' })),
    ...named.reviewer.flatMap(file('reviewer')),
    ...(named.other ?? []).flatMap(file()),
  ]);
}

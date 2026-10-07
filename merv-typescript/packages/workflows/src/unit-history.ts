import type {
  Artifact,
  ProcessGraph,
  ReviewRequest,
  RunningUnitArtifact,
  RunningUnitEntry,
} from '@merv/contracts';

/**
 * A unit's history as its owner tells it on the Work page: every recorded crossing of the
 * record's own process graph, oldest first. A crossing into one of the owner's review gates is
 * its producer's submission, with the document it submitted; the verdict that carried the
 * record out again is the reviewer's, followed by the return it was when it landed earlier in
 * the program than the gate it left; anything else only moved the record and is one quiet
 * line. A record standing at a gate ends on the review still open there.
 *
 * A submission is answered by the review it requested, pinned at the revision the crossing
 * made, so the k-th submission meets the k-th review. Each entry names the thread that did it
 * by its role and the stage that thread stands at: a producer's at the state it submitted
 * from, a reviewer's at the gate. Nothing here knows any program's states: the owner names its
 * gates and what crossing into each says.
 */
export interface UnitGate {
  /** What crossing into the gate says its producer did: 'Delivered', 'Submitted the design'. */
  submitted: string;
}
export interface UnitHistoryInput {
  graph: ProcessGraph;
  /** The reviews of this record, in any order. */
  reviews: readonly ReviewRequest[];
  /** The owner's review gates, by state. */
  gates: Readonly<Record<string, UnitGate>>;
  /** The document a submission handed in, read from the review it requested. */
  document?(review: ReviewRequest): { id: string; title: string } | undefined;
}

const words = (state: string) => state.replaceAll('_', ' ');
const sentence = (state: string) => words(state).replace(/^./, (first) => first.toUpperCase());

/** How many of a verdict's checks it found met, of all it judged. */
export const metOf = (review: Pick<ReviewRequest, 'findings' | 'criteria'>) => ({
  met: review.findings.filter((finding) => finding.status === 'met').length,
  of: review.findings.length || review.criteria.length,
});

/** The line a review still open at its gate stands on. */
function waiting(review: ReviewRequest, stage: string): RunningUnitEntry {
  return {
    role: 'reviewer',
    stage,
    said: review.status === 'requested' ? 'Review unclaimed' : 'In review',
    ...(review.status === 'started' && review.reviewerId ? { actor: review.reviewerId } : {}),
    review: review.id,
    ...(review.waiting ? { attention: true } : {}),
  };
}

function verdict(review: ReviewRequest, stage: string, at: string): RunningUnitEntry {
  const text = review.synopsis ?? review.notes;
  return {
    role: 'reviewer',
    stage,
    ...(review.reviewerId ? { actor: review.reviewerId } : {}),
    at,
    verdict: { word: review.verdict!, ...metOf(review), ...(text ? { text } : {}) },
    review: review.id,
  };
}

export function unitHistory({ graph, reviews, gates, document }: UnitHistoryInput) {
  const gate = (state: string) => Object.hasOwn(gates, state);
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
    const decided = out && !into && open?.verdict ? open : undefined;
    open = into ? rounds.find((review) => review.subjectRevision === step.revision) : undefined;
    if (into && !out) {
      const handed = open && document?.(open);
      entries.push({
        role: 'producer',
        stage: step.from,
        actor: step.actorId,
        at: step.at,
        said: gates[step.to]!.submitted,
        ...(handed ? { artifact: handed } : {}),
      });
    } else if (decided) {
      entries.push(verdict(decided, step.from, step.at));
      if (order.indexOf(step.to) < order.indexOf(step.from))
        entries.push({ at: step.at, said: `Returned to ${words(step.to)}` });
    } else entries.push({ actor: step.actorId, at: step.at, said: sentence(step.to) });
  }
  if (gate(graph.state) && open && !open.verdict) entries.push(waiting(open, graph.state));
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

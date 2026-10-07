import type { ProcessGraph } from '@merv/workflows/models';
import type { ReviewRequest, RunningUnitArtifact, RunningUnitEntry } from '@merv/contracts';
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

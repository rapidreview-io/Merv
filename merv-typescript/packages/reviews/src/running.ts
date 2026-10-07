import { firstSentence } from '@merv/contracts/text';
import { reviewExceptions, reviewStanding } from './rules.js';
import type {
  ReviewRequest,
  RunningAttention,
  RunningFact,
  RunningLinkRow,
  RunningPhrase,
  RunningSection,
} from '@merv/contracts';

/**
 * One subject's reviews as the Running sidebar reads them. Reviews owns the claim, the
 * independence rule and the verdict, so every owning domain's subject says how its review
 * stands in these words. The domain names the gate a review was read at, where it reviews a
 * subject at more than one.
 */
interface ReviewRounds {
  /** The review that speaks for the subject now, as get() serves it to this reader. */
  current: ReviewRequest;
  /** The gate it is read at, where the owning domain reviews its records at more than one. */
  gate?: string;
  /** When the open claim was taken, and whether a leased agent took it. Only while started. */
  claim?: { at: string; agent: boolean };
  /** The subject's other reviews, newest first, each with its gate where it has one. */
  earlier: (Pick<ReviewRequest, 'id' | 'status' | 'verdict' | 'createdAt'> & { gate?: string })[];
}

/** The newest earlier rounds listed; the count beside the heading holds them all. */
export const EARLIER = 50;

const route = (reviewId: string) => `/reviews/${encodeURIComponent(reviewId)}`;

/** A round's word on its own line: what it came back with, or what became of it. */
const ROUND: Record<string, string> = {
  pass: 'Pass',
  needs_changes: 'Needs changes',
  fail: 'Fail',
  superseded: 'Superseded',
  requested: 'Unclaimed',
  started: 'Claimed',
};

/** After a gate the clause runs on in lower case, as 'Design · with Ada' reads. */
const after = (gate: string | undefined, word: string) =>
  gate ? word.charAt(0).toLowerCase() + word.slice(1) : word;

/**
 * Nobody has it, somebody has it, or the word it came back with, opened by the gate it is
 * read at. A claim is its reviewer, whom the shell names for an operator; where no name can
 * be shown, a claim an agent took with its review lease reads as an agent's, and any other
 * as claimed.
 */
function standing({ current, gate, claim }: ReviewRounds): RunningPhrase {
  const said = reviewStanding(current);
  const clause: RunningPhrase =
    said?.word === 'unclaimed'
      ? [after(gate, 'Unclaimed')]
      : said?.word === 'claimed'
        ? said.reviewerId
          ? [
              {
                actor: said.reviewerId,
                prefix: after(gate, 'With '),
                unnamed: after(gate, claim?.agent ? 'With an agent' : 'Claimed'),
              },
            ]
          : [after(gate, 'Claimed')]
        : [{ state: current.verdict ?? current.status }];
  return gate ? [`${gate} · `, ...clause] : clause;
}

/**
 * The line an owner's card stands on while its work waits at a review gate, in the words every
 * owner's card shares: an agent holding the review lease (whose name is never drawn), the person
 * who claimed it, or nobody yet, since the review was asked for (or since `since`, where the
 * owner counts the wait from elsewhere). `held` says somebody has it.
 */
export function reviewCard(
  review: Pick<ReviewRequest, 'status' | 'reviewerId' | 'createdAt'> | null | undefined,
  {
    gate = 'In review',
    leased = false,
    since,
  }: { gate?: string; leased?: boolean; since?: string },
): { line: RunningPhrase; look: 'solid' | 'dashed'; held: boolean } {
  if (leased) return { line: [`${gate} · with an agent`], look: 'solid', held: true };
  if (review?.status === 'started' && review.reviewerId)
    return {
      line: [`${gate} · `, { actor: review.reviewerId, prefix: 'with ', unnamed: 'claimed' }],
      look: 'solid',
      held: true,
    };
  if (review?.status === 'requested')
    return {
      line: [`${gate} · unclaimed · `, { since: since ?? review.createdAt }],
      look: 'dashed',
      held: false,
    };
  return { line: [gate], look: 'solid', held: false };
}

/**
 * A card's red while no eligible reviewer may take its review: Reviews tells only an operator
 * so (`waiting`), and the Review section says why in ink.
 */
export function reviewAttention(
  review: Pick<ReviewRequest, 'id' | 'waiting'> | null | undefined,
): RunningAttention | undefined {
  return review?.waiting
    ? {
        says: ['No independent reviewer can take it'],
        who: 'An operator provides one.',
        to: { route: route(review.id), text: 'Open the review' },
      }
    : undefined;
}

/** What a verdict let through or held back, as a pass built on waivers must still say. */
function exceptions(findings: ReviewRequest['findings']): RunningPhrase {
  return reviewExceptions(findings).flatMap(({ status, criteria }, at): RunningPhrase => [
    ...(at ? [' · '] : []),
    { count: criteria.length, of: findings.length },
    ` ${status.replace('_', ' ')}`,
  ]);
}

/**
 * The Review section, and Earlier rounds once the work has been sent back or reissued. The
 * way to the verdict page is a row of its own, a link that stands alone; claiming the review
 * stays on that page, where its guard is.
 */
export function reviewSections(rounds: ReviewRounds): RunningSection[] {
  const { current, claim, earlier } = rounds;
  const rows: RunningFact[] = [{ label: 'Standing', value: standing(rounds) }];
  // get() says this to operators alone. The work's own card carries the red and whose move
  // it is; this row says why, in ink.
  if (current.waiting)
    rows.push({
      label: 'No reviewer',
      value: ['Every eligible reviewer contributed to this work'],
    });
  rows.push({ label: 'Requested', value: [{ ago: current.createdAt }] });
  if (current.status === 'started' && claim)
    rows.push({ label: 'Claimed for', value: [{ since: claim.at }] });
  if (current.verdict) {
    const sentence = firstSentence(current.synopsis) ?? firstSentence(current.notes);
    if (sentence) rows.push({ label: 'Verdict', value: [sentence] });
    const checks = exceptions(current.findings);
    if (checks.length) rows.push({ label: 'Checks', value: checks });
  }
  rows.push({
    label: 'Verdict page',
    value: [{ link: { route: route(current.id) }, text: 'Open the review' }],
  });
  const sections: RunningSection[] = [{ title: 'Review', place: 'review', kind: 'facts', rows }];
  if (earlier.length)
    sections.push({
      title: 'Earlier rounds',
      place: 'review',
      kind: 'links',
      aside: [{ count: earlier.length }],
      // One line per round: the gate it was read at, the word it came back with, and when.
      rows: earlier.slice(0, EARLIER).map((review): RunningLinkRow => {
        const word = ROUND[review.verdict ?? review.status];
        return {
          to: { route: route(review.id) },
          name: review.gate && word ? `${review.gate} · ${after(review.gate, word)}` : word,
          says: [{ ago: review.createdAt }],
        };
      }),
    });
  return sections;
}

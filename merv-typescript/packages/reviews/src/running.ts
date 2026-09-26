import type {
  ReviewRequest,
  RunningFact,
  RunningLinkRow,
  RunningPhrase,
  RunningSection,
} from '@merv/contracts';

/**
 * One subject's reviews as the Running sidebar reads them. Reviews owns the claim, the
 * independence rule and the verdict, so a task, an experiment and a reflection wave all say
 * how their review stands in these words; the subject's own ladder draws the gate.
 */
export interface ReviewRounds {
  /** The review that speaks for the subject now, as get() serves it to this reader. */
  current: ReviewRequest;
  /** When the open claim was taken, and whether a leased agent took it. Only while started. */
  claim?: { at: string; agent: boolean };
  /** The subject's other reviews, newest first. */
  earlier: Pick<ReviewRequest, 'id' | 'status' | 'verdict' | 'createdAt'>[];
}

/** The newest earlier rounds listed; the count beside the heading holds them all. */
const EARLIER = 50;

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

/** The first clause of a recorded sentence, in its own words, as the review list reads it. */
function firstSentence(text: string | null | undefined, limit = 140): string | null {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return null;
  const stop = trimmed.search(/[.!?](\s|$)|\n/);
  const first = (stop >= 0 ? trimmed.slice(0, stop + 1) : trimmed).trim();
  return first.length > limit ? `${first.slice(0, limit - 1)}…` : first;
}

/**
 * Nobody has it, somebody has it, or the word it came back with. A claim is its reviewer,
 * whom the shell names for an operator; where no name can be shown, a claim an agent took
 * with its review lease reads as an agent's, and any other as claimed.
 */
function standing({ current, claim }: ReviewRounds): RunningPhrase {
  if (current.status === 'requested') return ['Unclaimed'];
  if (current.status === 'started')
    return current.reviewerId
      ? [
          {
            actor: current.reviewerId,
            prefix: 'With ',
            unnamed: claim?.agent ? 'With an agent' : 'Claimed',
          },
        ]
      : ['Claimed'];
  return [{ state: current.verdict ?? current.status }];
}

/** What a verdict let through or held back, as a pass built on waivers must still say. */
function exceptions(findings: ReviewRequest['findings']): RunningPhrase {
  const phrase: RunningPhrase = [];
  for (const [status, words] of [
    ['not_met', ' not met'],
    ['waived', ' waived'],
    ['not_verified', ' not verified'],
  ] as const) {
    const count = findings.filter((finding) => finding.status === status).length;
    if (!count) continue;
    if (phrase.length) phrase.push(' · ');
    phrase.push({ count, of: findings.length }, words);
  }
  return phrase;
}

/**
 * The Review section, and Earlier rounds once the work has been sent back or reissued. The
 * way to the verdict page ends the standing; claiming it stays on that page, where its guard is.
 */
export function reviewSections(rounds: ReviewRounds): RunningSection[] {
  const { current, claim, earlier } = rounds;
  const rows: RunningFact[] = [
    {
      label: 'Standing',
      value: [
        ...standing(rounds),
        ' · ',
        { link: { route: route(current.id) }, text: 'Open the review' },
      ],
    },
  ];
  // get() says this to operators alone.
  if (current.waiting)
    rows.push({
      label: 'No reviewer',
      value: ['Every eligible reviewer contributed to this work · An operator provides one'],
      attention: true,
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
  const sections: RunningSection[] = [
    {
      title: 'Review',
      place: 'review',
      kind: 'facts',
      rows,
      ...(current.waiting ? { attention: true } : {}),
    },
  ];
  if (earlier.length)
    sections.push({
      title: 'Earlier rounds',
      place: 'review',
      kind: 'links',
      aside: [{ count: earlier.length }],
      rows: earlier.slice(0, EARLIER).map((review): RunningLinkRow => ({
        to: { route: route(review.id) },
        name: ROUND[review.verdict ?? review.status],
        says: [{ ago: review.createdAt }],
      })),
    });
  return sections;
}

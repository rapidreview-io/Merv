import type { Data, ReviewRequest } from '@merv/contracts';

/** Complete fixture evidence for tests whose subject is another task gate. */
export function confirmedDelivery<T extends { artifactIds: string[] }>(input: T, checkCount = 1) {
  return {
    ...input,
    confirmations: Array.from({ length: checkCount }, (_, index) => ({
      checkNumber: index + 1,
      status: 'met' as const,
      evidenceIds: [...input.artifactIds],
      notes: `Fixture evidence records verification of acceptance check ${index + 1}.`,
    })),
  };
}

/** Complete review fixtures when a test is exercising another gate or transaction. */
export function reviewedFindings(
  review: Pick<ReviewRequest, 'formatVersion' | 'criteria' | 'artifactIds'>,
): Data {
  if (review.formatVersion !== 2) return {};
  const evidenceIds =
    review.artifactIds.length > 2 ? review.artifactIds.slice(1, -1) : review.artifactIds;
  return {
    synopsis:
      'The fixture evidence was checked independently against every pinned acceptance criterion.',
    findings: review.criteria.map((_, index) => ({
      criterionNumber: index + 1,
      status: 'met' as const,
      evidenceIds: [...evidenceIds],
      notes: `Fixture evidence records independent verification of criterion ${index + 1}.`,
    })),
  };
}

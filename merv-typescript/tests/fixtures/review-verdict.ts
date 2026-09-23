import type { ReviewFinding, ReviewRequest } from '@merv/contracts';

/**
 * A complete assessment in the only verdict format, for a test exercising another gate: a plain
 * synopsis and one finding per numbered criterion. A `met` finding cites every pinned artifact;
 * any other status cites none.
 */
export function assessment(
  review: Pick<ReviewRequest, 'criteria' | 'artifactIds'>,
  status: ReviewFinding['status'] = 'met',
): { synopsis: string; findings: ReviewFinding[] } {
  return {
    synopsis:
      'The fixture review checked every pinned artifact against each numbered criterion in turn.',
    findings: review.criteria.map((_, index) => ({
      criterionNumber: index + 1,
      status,
      evidenceIds: status === 'met' ? [...review.artifactIds] : [],
      notes: `The fixture review assessed criterion ${index + 1} against the pinned evidence.`,
    })),
  };
}

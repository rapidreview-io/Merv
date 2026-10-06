import {
  newId,
  recorded,
  type Caller,
  type ReviewFinding,
  type ReviewRequest,
  type Reviews,
  type State,
  type Transaction,
} from '@merv/contracts';

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

/**
 * A stand-in domain for reviews a test requests itself: Reviews claims only a review exactly one
 * domain owns. It owns what `owns` names (every review by default) and keeps verdicts as they are.
 */
export function ownReviews(
  reviews: Reviews,
  owns: (review: Readonly<ReviewRequest>, tx: Transaction) => boolean | Promise<boolean> = () =>
    true,
  id = 'fixture',
): () => void {
  return reviews.registerSubmitOwner({
    id,
    owns: async (review, tx) => await owns(review, tx),
    submit: async (caller, input, tx) => await reviews.submit(caller, input, tx),
  });
}

/** Claims a review no domain owns yet, as a stand-in owner that withdraws once it is claimed. */
export async function claimUnowned(
  reviews: Reviews,
  caller: Caller,
  reviewId: string,
): Promise<ReviewRequest> {
  const drop = ownReviews(reviews, (review) => review.id === reviewId, 'claim-fixture');
  try {
    return await reviews.start(caller, reviewId);
  } finally {
    drop();
  }
}

/**
 * Claims a review the way Reviews did before reviews@14 kept the claim's event on its row, for a
 * test that runs storage older than that: the row's claim and its review.started event only.
 */
export async function legacyStart(
  state: State,
  reviews: Reviews,
  caller: Caller,
  reviewId: string,
): Promise<ReviewRequest> {
  const claimId = newId('claim');
  await state.transaction(async (tx) => {
    await tx.run(
      "UPDATE reviews SET status='started',reviewer_id=?,claim_id=?,claim_generation=claim_generation+1 WHERE id=? AND status='requested'",
      caller.actorId,
      claimId,
      reviewId,
    );
    await recorded(state, tx, caller, 'review.started', reviewId, { claimId, claimGeneration: 1 });
  });
  return await reviews.get(caller, reviewId);
}

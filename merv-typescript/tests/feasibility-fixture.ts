import type { ReviewRequest } from '@merv/contracts';
import type { FeasibilityStatement } from '@merv/experiments/evidence';
import type { Experiment } from '@merv/experiments/types';

/** A statement whose own figures admit the design, for fixtures that are not about feasibility. */
export const feasibilityStatement = (change: Partial<FeasibilityStatement> = {}): string =>
  JSON.stringify({
    formatVersion: 1,
    resources: [
      {
        kind: 'data',
        name: 'evaluation set',
        unit: 'examples',
        required: 200,
        available: 973,
        basis: 'Row count of the retained evaluation inventory.',
      },
      {
        kind: 'time',
        name: 'runner time',
        unit: 'hours',
        required: 2,
        available: 8,
        basis: 'Measured throughput of one pilot batch on the assigned runner.',
      },
    ],
    dependencies: [{ name: 'baseline', present: true, basis: 'Retained with the project.' }],
    blockers: [],
    ...change,
  } satisfies FeasibilityStatement);

/**
 * What a fixture reviewer cites for one criterion: the first pinned artifact, and for a criterion
 * the review requires, the feasibility statement a passing design review must have read.
 */
export const citedEvidence = (
  experiment: Experiment,
  review: ReviewRequest,
  criterionNumber: number,
): string[] => {
  const statement = experiment.evidence.find(
    (evidence) =>
      evidence.current &&
      evidence.role === 'feasibility' &&
      evidence.attemptIndex === experiment.attempt.index,
  );
  return review.requiredCriteria?.includes(criterionNumber) && statement
    ? [statement.artifactId]
    : [review.artifactIds[0]!];
};

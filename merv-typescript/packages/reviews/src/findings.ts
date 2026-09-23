import { types as nodeTypes } from 'node:util';
import {
  visible,
  check,
  plain,
  type Data,
  type Limits,
  type ReviewFinding,
  type ReviewRequest,
  type ReviewSubmit,
} from '@merv/contracts';
import { synopsisSchema } from './input.js';

/** Evidence bounds; refusing nested undefined keeps `{ value: undefined }` from reading as `{}`. */
export const evidenceLimits = {
  depth: 32,
  nodes: 64000,
  bytes: 64000,
  undefined: 'reject',
} as const satisfies Limits;

/** Keep structured observations finite and portable before command hashing or persistence. */
export function validateEvidence(value: unknown): Data {
  if (value === undefined) return {};
  check(
    value && typeof value === 'object' && !nodeTypes.isProxy(value) && !Array.isArray(value),
    'invalid_evidence',
    'Review evidence must be a JSON object',
  );
  const encoded = JSON.stringify(plain(value, 'invalid_evidence', evidenceLimits));
  check(
    Buffer.byteLength(encoded, 'utf8') <= 64000,
    'invalid_evidence',
    'Review evidence must not exceed 64000 encoded bytes',
  );
  const evidence = JSON.parse(encoded) as Data;
  check(
    evidence.outcome === undefined ||
      (typeof evidence.outcome === 'string' && visible(evidence.outcome)),
    'invalid_evidence',
    'Review evidence.outcome must be a nonempty string when supplied',
  );
  return evidence;
}

/** Checks the shape and provenance of an assessment, never the truth of its findings. */
export function validateAssessment(
  review: Pick<ReviewRequest, 'criteria' | 'artifactIds' | 'requiredCriteria'>,
  input: Pick<ReviewSubmit, 'verdict' | 'synopsis' | 'findings' | 'evidence'>,
): { synopsis: string; findings: ReviewFinding[]; evidence: Data } {
  const evidence = validateEvidence(input.evidence);
  check(
    synopsisSchema.safeParse(input.synopsis).success,
    'invalid_synopsis',
    'Supply a plain single-paragraph synopsis of 40–420 characters, without entity IDs or Markdown, explaining the overall verdict',
  );
  const synopsis = input.synopsis!.trim();
  const value: unknown = input.findings;
  check(
    Array.isArray(value),
    'invalid_findings',
    'Supply one finding for every numbered review criterion',
  );
  const seen = new Set<number>();
  for (const item of value) {
    check(
      item &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        Object.keys(item).every((key) =>
          ['criterionNumber', 'status', 'evidenceIds', 'notes'].includes(key),
        ),
      'invalid_findings',
      'Findings must contain criterionNumber, status, evidenceIds and notes only',
    );
    check(
      Number.isSafeInteger(item.criterionNumber) &&
        item.criterionNumber >= 1 &&
        item.criterionNumber <= review.criteria.length &&
        !seen.has(item.criterionNumber),
      'invalid_findings',
      `Each criterion from 1 through ${review.criteria.length} must appear exactly once`,
    );
    seen.add(item.criterionNumber);
    check(
      ['met', 'not_met', 'not_verified', 'waived'].includes(item.status),
      'invalid_findings',
      'Finding status must be met, not_met, not_verified, or waived',
    );
    check(
      typeof item.notes === 'string' && visible(item.notes) && item.notes.length <= 16000,
      'invalid_findings',
      `Criterion ${item.criterionNumber} needs assessment notes (1–16000 characters)`,
    );
    check(
      Array.isArray(item.evidenceIds) &&
        new Set(item.evidenceIds).size === item.evidenceIds.length &&
        item.evidenceIds.every(
          (id: unknown) => typeof id === 'string' && review.artifactIds.includes(id),
        ),
      'invalid_findings',
      `Criterion ${item.criterionNumber} must refer only to distinct pinned artifact IDs`,
    );
    check(
      item.status !== 'met' || item.evidenceIds.length > 0,
      'invalid_findings',
      `Criterion ${item.criterionNumber} claims met and requires retained evidence`,
    );
  }
  check(
    seen.size === review.criteria.length,
    'invalid_findings',
    `Missing findings for criteria: ${review.criteria
      .map((_, index) => index + 1)
      .filter((number) => !seen.has(number))
      .join(', ')}`,
  );
  check(
    input.verdict !== 'pass' ||
      value.every((item) => item.status === 'met' || item.status === 'waived'),
    'invalid_findings',
    'A passing verdict requires every criterion to be met or explicitly waived with a reason',
  );
  // The requesting domain depends on these criteria, so a reviewer's waiver cannot stand in
  // for them; needs_changes is the way out when one cannot be met.
  const unmet = (review.requiredCriteria ?? []).find(
    (number) => value.find((item) => item.criterionNumber === number)?.status !== 'met',
  );
  check(
    input.verdict !== 'pass' || unmet === undefined,
    'criterion_not_waivable',
    `Criterion ${unmet} is required: a passing verdict needs it met with retained evidence, and it cannot be waived. Return needs_changes if it is not met`,
  );
  return {
    synopsis,
    evidence,
    findings: (value as ReviewFinding[])
      .map((item) => ({
        criterionNumber: item.criterionNumber,
        status: item.status,
        evidenceIds: [...item.evidenceIds],
        notes: item.notes.trim(),
      }))
      .sort((a, b) => a.criterionNumber - b.criterionNumber),
  };
}

import {
  visible,
  check,
  type Data,
  type ReviewFinding,
  type ReviewRequest,
  type ReviewSubmit,
} from '@merv/contracts';

/** Keep structured observations finite and portable before command hashing or persistence. */
export function validateEvidence(value: unknown): Data {
  if (value === undefined) return {};
  check(
    value && typeof value === 'object' && !Array.isArray(value),
    'invalid_evidence',
    'Review evidence must be a JSON object',
  );
  const ancestors = new Set<object>();
  let nodes = 0;
  const visit = (item: unknown, depth: number): void => {
    check(++nodes <= 64000 && depth <= 32, 'invalid_evidence', 'Review evidence is too complex');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number') {
      check(
        Number.isFinite(item),
        'invalid_evidence',
        'Review evidence must contain only finite JSON values',
      );
      return;
    }
    check(
      item && typeof item === 'object' && !ancestors.has(item),
      'invalid_evidence',
      'Review evidence must contain only acyclic JSON values',
    );
    check(
      Array.isArray(item) ||
        Object.getPrototypeOf(item) === Object.prototype ||
        Object.getPrototypeOf(item) === null,
      'invalid_evidence',
      'Review evidence must contain only plain JSON objects',
    );
    check(
      Object.getOwnPropertySymbols(item).length === 0,
      'invalid_evidence',
      'Review evidence must contain only JSON keys',
    );
    ancestors.add(item);
    if (Array.isArray(item)) {
      check(
        Object.keys(item).length === item.length,
        'invalid_evidence',
        'Review evidence arrays must have a value at every index',
      );
      for (const child of item) visit(child, depth + 1);
    } else {
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(item))) {
        check(
          'value' in descriptor && descriptor.enumerable,
          'invalid_evidence',
          'Review evidence must contain only ordinary JSON properties',
        );
        visit(descriptor.value, depth + 1);
      }
    }
    ancestors.delete(item);
  };
  visit(value, 0);
  const encoded = JSON.stringify(value);
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
  review: Pick<ReviewRequest, 'formatVersion' | 'criteria' | 'artifactIds'>,
  input: Pick<ReviewSubmit, 'verdict' | 'synopsis' | 'findings' | 'evidence'>,
): { synopsis: string | null; findings: ReviewFinding[]; evidence: Data } {
  const evidence = validateEvidence(input.evidence);
  let synopsis: string | null = null;
  if (review.formatVersion === 2 || input.synopsis !== undefined) {
    check(
      typeof input.synopsis === 'string' &&
        visible(input.synopsis) &&
        input.synopsis.trim().length >= 40 &&
        input.synopsis.trim().length <= 420 &&
        !/[\r\n\u2028\u2029`]|\*\*|__|\]\(|<\/?[a-z]+>/iu.test(input.synopsis) &&
        !/^\s*(?:#|[-*+]\s|\d+[.)]\s|>)/u.test(input.synopsis) &&
        !/\b(?:wf|art|review|actor|project|context|exp|task|claim|res|rver|syn|rev|lit|paper)_[A-Za-z0-9]/u.test(
          input.synopsis,
        ),
      'invalid_synopsis',
      'Supply a plain single-paragraph synopsis of 40–420 characters, without entity IDs or Markdown, explaining the overall verdict',
    );
    synopsis = input.synopsis.trim();
  }
  if (review.formatVersion === 1 && input.findings === undefined)
    return { synopsis, findings: [], evidence };

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

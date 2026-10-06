import { types as nodeTypes } from 'node:util';
import { assessmentProblem, synopsisProblem } from './rules.js';
import {
  check,
  MervError,
  plain,
  visible,
  type Data,
  type ReviewFinding,
  type ReviewRequest,
  type ReviewSubmit,
} from '@merv/contracts';

/** Keep structured observations finite and portable before command hashing or persistence. */
function validateEvidence(value: unknown): Data {
  if (value === undefined) return {};
  check(
    value && typeof value === 'object' && !nodeTypes.isProxy(value) && !Array.isArray(value),
    'invalid_evidence',
    'Review evidence must be a JSON object',
  );
  const encoded = JSON.stringify(
    plain(value, 'invalid_evidence', {
      depth: 32,
      nodes: 64000,
      bytes: 64000,
      keys: 'any',
      strings: 'json',
      undefined: 'reject',
    }),
  );
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

/**
 * One field of an ordinary input object, read without invoking an accessor or a proxy trap: an
 * input that is no plain object, or a field that is no enumerable data property, is refused.
 */
export function ownField(input: unknown, name: string, code: string, what: string): unknown {
  check(
    input &&
      typeof input === 'object' &&
      !nodeTypes.isProxy(input) &&
      !Array.isArray(input) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(input)),
    code,
    `${what} must be an ordinary object`,
  );
  const field = Object.getOwnPropertyDescriptor(input, name);
  check(
    !field || (Object.hasOwn(field, 'value') && field.enumerable),
    code,
    `${name} must be an ordinary data field`,
  );
  return field?.value;
}

/** Read the optional evidence field without invoking a getter on the submission itself. */
export function evidenceFrom(input: { evidence?: unknown }): Data {
  return validateEvidence(ownField(input, 'evidence', 'invalid_evidence', 'Review evidence'));
}

/** Checks the shape and provenance of an assessment, never the truth of its findings. */
export function validateAssessment(
  review: Pick<ReviewRequest, 'criteria' | 'artifactIds' | 'requiredCriteria'>,
  input: Pick<ReviewSubmit, 'verdict' | 'synopsis' | 'findings' | 'evidence'>,
): { synopsis: string; findings: ReviewFinding[]; evidence: Data } {
  const evidence = evidenceFrom(input);
  check(
    !synopsisProblem(input.synopsis),
    'invalid_synopsis',
    'Supply a plain single-paragraph synopsis of 40–420 characters, without entity IDs or Markdown, explaining the overall verdict',
  );
  const synopsis = (input.synopsis as string).trim();
  const problem = assessmentProblem(review, input);
  if (problem) throw new MervError(problem.code, problem.message);
  return {
    synopsis,
    evidence,
    findings: (input.findings as ReviewFinding[])
      .map((item) => ({
        criterionNumber: item.criterionNumber,
        status: item.status,
        evidenceIds: [...item.evidenceIds],
        notes: item.notes.trim(),
      }))
      .sort((a, b) => a.criterionNumber - b.criterionNumber),
  };
}

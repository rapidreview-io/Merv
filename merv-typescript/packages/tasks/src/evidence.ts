import { visible, check, type TaskConfirmation } from '@merv/contracts';
import type { CodeCapture } from '@merv/code-research/types';

export const acceptanceChecks = (checks: string[]) =>
  checks.map((text, index) => ({ number: index + 1, text }));

/** `git` adds the one sentence a Git task's producer needs; every other brief stays byte-identical. */
export function renderBrief(
  input: { title: string; goal: string; checks: string[] },
  git = false,
): string {
  return [
    `# ${input.title}`,
    '',
    '## Goal',
    '',
    input.goal,
    '',
    '## Acceptance checks',
    '',
    ...acceptanceChecks(input.checks).map(({ number, text }) => `${number}. ${text}`),
    '',
    '## Delivery',
    '',
    'Retain evidence as artifacts. In task.submit_delivery, supply one confirmation per numbered check. ' +
      'Each confirmation records checkNumber, status (met or not_met), evidenceIds and notes explaining what you checked and found. ' +
      'A met claim requires evidence from the submitted artifactIds. Report unmet checks honestly. ' +
      'The server validates coverage and evidence references; an independent reviewer determines whether the goal was achieved.' +
      (git
        ? ' This is a Git task: work in the private Git checkout provided, record the work with code.commit, and deliver that operation’s commandId in task.submit_delivery; artifactIds may then be empty, and a met claim that cites no evidenceIds is backed by the delivered commit.'
        : ''),
    '',
  ].join('\n');
}

/** Validates producer declarations, never the truth of a completion claim. */
export function validateConfirmations(
  value: unknown,
  checks: string[],
  artifactIds: string[],
  /** A Git task always delivers a commit, which backs a met claim that cites no file. */
  commit = false,
): TaskConfirmation[] {
  check(
    Array.isArray(value),
    'invalid_confirmations',
    'Supply a confirmation for every numbered acceptance check',
  );
  const seen = new Set<number>();
  for (const item of value) {
    check(
      item &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        Object.keys(item).every((key) =>
          ['checkNumber', 'status', 'evidenceIds', 'notes'].includes(key),
        ),
      'invalid_confirmations',
      'Confirmations must contain checkNumber, status, evidenceIds and notes only',
    );
    check(
      Number.isInteger(item.checkNumber) &&
        item.checkNumber >= 1 &&
        item.checkNumber <= checks.length &&
        !seen.has(item.checkNumber),
      'invalid_confirmations',
      `Each check from 1 through ${checks.length} must appear exactly once`,
    );
    seen.add(item.checkNumber);
    check(
      ['met', 'not_met'].includes(item.status),
      'invalid_confirmations',
      'Confirmation status must be met or not_met',
    );
    check(
      typeof item.notes === 'string' && visible(item.notes) && item.notes.length <= 2000,
      'invalid_confirmations',
      `Check ${item.checkNumber} needs notes explaining the evidence or unmet condition (1–2000 characters)`,
    );
    check(
      Array.isArray(item.evidenceIds) &&
        new Set(item.evidenceIds).size === item.evidenceIds.length &&
        item.evidenceIds.every((id: unknown) => typeof id === 'string' && artifactIds.includes(id)),
      'invalid_confirmations',
      `Check ${item.checkNumber} must refer only to distinct submitted artifact IDs`,
    );
    check(
      item.status !== 'met' || commit || item.evidenceIds.length > 0,
      'invalid_confirmations',
      `Check ${item.checkNumber} claims met and requires retained evidence`,
    );
  }
  check(
    seen.size === checks.length,
    'invalid_confirmations',
    `Missing confirmations for checks: ${acceptanceChecks(checks)
      .filter(({ number }) => !seen.has(number))
      .map(({ number }) => number)
      .join(', ')}`,
  );
  return structuredClone(value as TaskConfirmation[]).sort((a, b) => a.checkNumber - b.checkNumber);
}

/**
 * The record of a delivered commit that the review pins. It is deterministic, and it prints the
 * receipt in full because the task record keeps only the identifiers a later check compares.
 */
export function renderDeliveredCommit(
  title: string,
  capture: Pick<CodeCapture, 'ref' | 'provenance' | 'parentOid'> & {
    workspace: NonNullable<CodeCapture['workspace']>;
  },
): string {
  const { workspace, provenance } = capture;
  return [
    `# Delivered commit: ${title}`,
    '',
    `- Commit: ${workspace.headOid}`,
    `- Tree: ${workspace.treeOid ?? 'not recorded'}`,
    `- Parent: ${capture.parentOid ?? 'not recorded'}`,
    `- Base: ${workspace.baseOid}`,
    `- Repository: ${workspace.repositoryId}`,
    `- Workspace: ${workspace.workspaceId}`,
    `- Branch: ${workspace.branch ?? 'detached'}`,
    `- Code operation: ${capture.ref.kind === 'code-commit' ? capture.ref.commandId : 'none'}`,
    `- Producing session: ${provenance.sessionId}`,
    `- Changes: ${JSON.stringify(workspace.stats)}`,
    '',
    'The reviewer’s read-only checkout is pinned to exactly this commit. It exists only on a machine whose runner repository holds these objects.',
    '',
  ].join('\n');
}

export function renderAssessment(checks: string[], confirmations: TaskConfirmation[]): string {
  return [
    '# Delivery confirmations',
    '',
    'These are the producer’s declarations. An independent reviewer must inspect the pinned evidence and judge the goal.',
    '',
    ...confirmations.flatMap((item) => [
      `## Check ${item.checkNumber}: ${checks[item.checkNumber - 1]}`,
      '',
      `Producer claim: ${item.status}`,
      '',
      item.notes,
      '',
      `Evidence: ${item.evidenceIds.length ? item.evidenceIds.join(', ') : 'None supplied (unmet check)'}`,
      '',
    ]),
  ].join('\n');
}

import { createHash } from 'node:crypto';
import {
  check,
  CODE_CHECK_SLACK_SECONDS,
  CODE_CHECK_SOURCE_MAX_BYTES,
  type CodeBaseCheck,
  type CodeBaseRecord,
  type CodeCheckSpec,
} from '@merv/contracts';
import type {
  SandboxCheckHandle,
  SandboxCheckPlan,
  SandboxCheckVerdict,
} from '@merv/sandboxes/types';
import type { ServerGit } from './git.js';

/**
 * The project check of one base, on the Code side. A base that merged cleanly is not sealed
 * until the project's configured command has run once against the merged tree, in a machine
 * this server rents and never on this server. Everything here is what Code owes that run:
 * the source it ships, and the record it keeps of what came back.
 */

/**
 * The durable handle: the sandbox side's own, plus the epoch it belongs to and how many
 * times the service has refused to take the machine back, so a refusal that never stops
 * being a refusal is eventually named to an operator instead of retried forever.
 */
export type CheckHandle = SandboxCheckHandle & { epoch: number; releaseAttempts?: number };

const ARCHIVE_TIMEOUT_MS = 120_000;

/**
 * The merged tree as one gzipped tar, and its digest. The commit is archived rather than its
 * tree because `git archive` dates a bare tree's entries from the clock, and a source whose
 * bytes changed between two attempts of the same epoch could not be re-uploaded under the
 * same idempotency key. The archive carries no `.git`: a check judges what was merged, not
 * how it got there.
 */
export async function archiveCommit(
  git: ServerGit,
  env: Record<string, string>,
  commit: string,
): Promise<{ bytes: Buffer; sha256: string }> {
  const bytes = await git.ok(['archive', '--format=tar.gz', commit], {
    env,
    timeoutMs: ARCHIVE_TIMEOUT_MS,
    // One byte of headroom, so a tree over the limit is refused by the named check below
    // rather than by the runner's generic "said more than it may", which reads to an
    // operator as a Git malfunction and is retried as though it were transient.
    maxBuffer: CODE_CHECK_SOURCE_MAX_BYTES + 1,
  });
  check(
    bytes.byteLength <= CODE_CHECK_SOURCE_MAX_BYTES,
    'code_check_source_too_large',
    `The merged tree is larger than the ${CODE_CHECK_SOURCE_MAX_BYTES} bytes one check may ship`,
    413,
  );
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** The machine and command the sandbox plugin is asked for; the bytes join it on the first step. */
export function checkPlan(spec: CodeCheckSpec, key: string, epoch: number): SandboxCheckPlan {
  return {
    provider: spec.image.provider,
    offerId: spec.image.offerId,
    snapshotId: spec.image.snapshotId,
    command: spec.command,
    timeoutSeconds: spec.timeoutSeconds,
    // The lease covers the command and everything around it; a shorter one would end the
    // machine under a command that is still inside the time the operator gave it.
    leaseSeconds: spec.timeoutSeconds + CODE_CHECK_SLACK_SECONDS,
    // Derived from the base and its epoch, so repeating an interrupted step finds the same
    // object, the same machine and the same job instead of renting a second one.
    idempotencyKey: `chk:${key}:${epoch}`,
  };
}

const bounded = (value: string, limit: number) =>
  value.length <= limit ? value : `${value.slice(0, limit)}\n[Truncated.]`;

/** The write-once receipt: what ran, where, what it cost, and what it could not isolate. */
export function checkReceipt(
  spec: CodeCheckSpec,
  handle: CheckHandle,
  verdict: SandboxCheckVerdict,
  at: string,
): CodeBaseCheck {
  const timedOut = verdict.state === 'timed_out';
  return {
    state: !timedOut && verdict.result?.exit === 0 ? 'passed' : 'failed',
    spec,
    receipt: {
      sandboxId: handle.sandboxId ?? '',
      jobId: handle.jobId ?? '',
      objectId: handle.objectId ?? '',
      exitCode: verdict.result ? verdict.result.exit : null,
      timedOut,
      startedAt: verdict.startedAt,
      finishedAt: verdict.finishedAt,
      output: {
        head: bounded(verdict.result?.head ?? '', 8000),
        tail: bounded(verdict.result?.tail ?? '', 8000),
        bytes: verdict.result?.bytes ?? 0,
      },
      environment: handle.environment,
      usage: verdict.usage,
      isolation: handle.isolation,
    },
    reason: timedOut
      ? `The command exceeded its ${spec.timeoutSeconds} second timeout and its process group was terminated.`
      : null,
    at,
  };
}

/** A check that never ran against a tree: no command, or nothing new was merged. */
export const checkSkipped = (reason: string, at: string): CodeBaseCheck => ({
  state: 'skipped',
  spec: null,
  receipt: null,
  reason,
  at,
});

/**
 * A failing check is a conflict with no paths, so the one reviewed task that resolves a Git
 * conflict resolves this too. Its evidence is one bounded string, which is the shape the
 * conflict record and the resolution brief already carry.
 */
export function checkConflict(verdict: CodeBaseCheck): { paths: string[]; messages: string } {
  const receipt = verdict.receipt;
  const outcome = receipt?.timedOut
    ? 'timed out'
    : receipt?.exitCode === null || receipt?.exitCode === undefined
      ? 'produced no result'
      : `exited ${receipt.exitCode}`;
  const machine = receipt?.environment
    ? `${receipt.environment.provider} ${receipt.environment.offerId}${receipt.environment.snapshotId ? ` from snapshot ${receipt.environment.snapshotId}` : ''}`
    : 'an unrecorded machine';
  return {
    paths: [],
    messages: bounded(
      [
        `The project check \`${verdict.spec?.command ?? ''}\` ${outcome} on ${machine}.`,
        ...(verdict.reason ? [verdict.reason] : []),
        '',
        receipt ? printed(receipt) : '',
      ].join('\n'),
      3800,
    ),
  };
}

/** The head and tail of what the command printed, with the gap between them named. */
const printed = (receipt: NonNullable<CodeBaseCheck['receipt']>) => {
  const kept = receipt.output.head.length + receipt.output.tail.length;
  const gap =
    receipt.output.bytes > kept ? `\n… ${receipt.output.bytes - kept} bytes omitted …\n` : '\n';
  return `${receipt.output.head}${gap}${receipt.output.tail}`;
};

/**
 * The two sections a failing project check puts in the resolution brief in place of Git's,
 * or null when Git is what conflicted. Both headings would otherwise lie: a check failure
 * has no conflicting paths and Git said nothing about it.
 */
export function checkBriefSections(base: CodeBaseRecord): [string, string] | null {
  const verdict = base.checkState === 'failed' ? base.check : null;
  const receipt = verdict?.receipt;
  if (!verdict || !receipt || base.conflict?.paths.length) return null;
  const machine = receipt.environment
    ? `${receipt.environment.provider} ${receipt.environment.offerId}`
    : 'a rented machine';
  const outcome = receipt.timedOut
    ? `timed out after ${verdict.spec?.timeoutSeconds ?? 0} seconds`
    : `exited ${receipt.exitCode}`;
  return [
    `Project check:\n\`${verdict.spec?.command ?? ''}\` ${outcome} on ${machine}. The merge itself was clean; this command has to pass on the merged tree.`,
    `Check output:\n${bounded(printed(receipt), 4000)}`,
  ];
}

/** What the worker who resolves a failing check is asked to have done. */
export function checkResolutionCheck(base: CodeBaseRecord): string | null {
  const verdict = base.checkState === 'failed' ? base.check : null;
  if (!verdict?.receipt) return null;
  return `The project check \`${verdict.spec?.command ?? ''}\` ${verdict.receipt.timedOut ? 'timed out' : `failed with exit ${verdict.receipt.exitCode}`}. Make it pass on the merged tree, and retain the command and its result as review evidence.`;
}

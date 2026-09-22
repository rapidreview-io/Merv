import { check, MervError } from '@merv/contracts';
import { SandboxClient, sandboxRoute } from './client.js';
import type {
  SandboxCheckHandle,
  SandboxCheckPlan,
  SandboxCheckSpec,
  SandboxCheckVerdict,
  SandboxChecks,
  SandboxConnection,
} from './types.js';

/**
 * Running one project check on a rented machine. Code hands over bytes and a digest and
 * never hears the word tree; this ships them to the service's object store, rents the
 * machine the project named, runs the command inside a wrapper it generates itself, and
 * reads one verdict back. Every call is a single bounded round trip, because the caller
 * advances a check one step per pass rather than waiting on a machine.
 */

/** Setup steps of the wrapper, by the exit code each one uses when it fails. */
const SETUP: Record<number, string> = {
  121: 'the machine had no writable workspace directory',
  122: 'the source could not be downloaded onto the machine',
  123: 'the downloaded source did not match its digest',
  124: 'the source archive could not be unpacked',
  125: 'the machine gave the job no result path',
};

/**
 * How much longer than the command's own timeout the whole job is given. The service applies
 * one timeout to the entire script and kills its process group, so a job bounded by the
 * operator's timeout alone would have the download and unpack eat that timeout and report a
 * command that never ran as one that overran. This covers curl's own cap and the unpack; the
 * command is bounded separately, inside the wrapper, where an overrun is a written result.
 */
export const CHECK_SETUP_SECONDS = 600;

/** What `timeout` exits with when it terminates the command it was given. */
const COMMAND_TIMEOUT_EXIT = 124;

/**
 * What this adapter can and cannot promise, in its own words. Code copies these onto the
 * base record verbatim: only the plugin that speaks to the service knows what that service
 * does, and a reader of a verdict must see what the machine did not isolate beside it.
 */
const ISOLATION: SandboxCheckHandle['isolation'] = {
  network: 'on',
  sourceReadOnly: false,
  imagePinned: 'offer',
  facts: [
    'The check had outbound network access; this adapter has no egress control, and the machine needs it to fetch the source.',
    'The source was copied into the machine and was writable by the check; this adapter has no read-only mount.',
    'The command ran as the machine login user; this adapter has no unprivileged-execution, capability or seccomp control.',
    'Scratch space was the whole offer disk; only the recorded output was bounded.',
    'The environment was pinned by provider offer and snapshot, not by an image digest.',
    'The check saw the merged tree only; the machine held no Git history.',
    'The source download URL was signed by the sandboxes service for a lifetime that service chooses.',
    'No Merv credential reached the machine, and the command was given no environment.',
    'The command was stopped at its timeout by terminating its whole process group.',
  ],
};

const object = (id: string) => sandboxRoute('/v1/storage/objects/{id}', id);
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const required = (value: unknown, what: string): string => {
  check(typeof value === 'string' && !!value, 'sandbox_unavailable', what, 502);
  return value as string;
};
/** A shell single-quoted literal: the only quoting that needs no escape table. */
const quoted = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const decode = (value: unknown) =>
  typeof value === 'string' ? Buffer.from(value, 'base64').toString('utf8') : '';

/**
 * The script the machine runs. The operator's command is wrapped, never trusted to report
 * itself: the wrapper always exits 0 once it has written a result, so a verdict lives in
 * that result and no command exiting 123 can impersonate a failed setup step. A setup
 * failure exits one of the reserved codes and writes no result at all.
 */
export function checkScript(
  command: string,
  url: string,
  sha256: string,
  timeoutSeconds: number,
): string {
  return [
    'set -u',
    // Without a path to write, the wrapper could only abort at its last line and read as a
    // job that rented a machine and judged nothing. It is named as its own setup step.
    '[ -n "${SBX_RESULT_PATH:-}" ] || exit 125',
    // The service guarantees the job's own directory under $HOME and nothing above it;
    // creating a top-level directory would depend on whichever image the offer booted.
    'd="$HOME/merv-check"',
    'mkdir -p "$d" || exit 121',
    'cd "$d" || exit 121',
    `curl -fsS --retry 3 --max-time 300 -o src.tgz ${quoted(url)} || exit 122`,
    `printf '%s  src.tgz' ${quoted(sha256)} | sha256sum -c - >/dev/null 2>&1 || exit 123`,
    'tar -xzf src.tgz || exit 124',
    'rm -f src.tgz',
    // The command's own clock, so an overrun is a written result — exit 124 — and therefore
    // a verdict, while the job's timeout can only mean setup outran its separate allowance.
    `timeout ${timeoutSeconds} sh -c ${quoted(command)} >out.log 2>&1; code=$?`,
    `printf '{"exit":%s,"bytes":%s,"head64":"%s","tail64":"%s"}' "$code" "$(wc -c <out.log | tr -d ' ')" "$(head -c 8000 out.log | base64 | tr -d '\\n')" "$(tail -c 8000 out.log | base64 | tr -d '\\n')" > "$SBX_RESULT_PATH"`,
    'exit 0',
  ].join('\n');
}

export class SandboxCheckRunner implements SandboxChecks {
  constructor(
    private readonly client: SandboxClient,
    private readonly connectionFor: (projectId: string) => SandboxConnection,
  ) {}

  async start(projectId: string, spec: SandboxCheckSpec): Promise<SandboxCheckHandle> {
    const entry = this.connectionFor(projectId);
    const begun = record(
      await this.client.write(entry, 'POST', '/v1/storage/objects', {
        name: `${spec.idempotencyKey.replaceAll(':', '/')}.tar.gz`,
        sha256: spec.source.sha256,
        size_bytes: spec.source.bytes.byteLength,
        content_type: 'application/gzip',
        idempotency_key: spec.idempotencyKey,
        // The source outlives the machine that reads it by exactly the lease, and no longer:
        // release deletes it, and this retention is only what covers a crash before that.
        expires_in_seconds: spec.leaseSeconds,
      }),
    );
    const objectId = required(record(begun.object).id, 'The object store returned no object id');
    // The same key after a crash replays onto the object the first attempt made, and the
    // store answers about that object rather than about a fresh upload: no parts at all once
    // the bytes are there, and only the parts still owed when some of them are. Resuming is
    // the whole reason the step is idempotent, so its answer is read, not refused.
    const state = text(record(begun.object).state);
    if (state !== 'available' && state !== 'completing') {
      const parts = Array.isArray(begun.parts) ? begun.parts.map(record) : [];
      const stored = Array.isArray(begun.completed_parts) ? begun.completed_parts.length : 0;
      const partSize = Number(begun.part_size);
      // Paging the rest of a part list needs a query string, which this plugin's route
      // allowlist does not admit. A source this design accepts always fits one page, so a
      // list that still does not cover the object is infrastructure's trouble and is said
      // plainly rather than worked around.
      check(
        parts.length + stored === Number(begun.part_count),
        'sandbox_unavailable',
        'The object store offered a part list this transfer cannot complete in one page',
        502,
      );
      for (const part of parts) {
        const number = Number(part.part_number);
        const size = Number(part.size_bytes);
        // Where a part sits is its own number times the part size, never a running total: a
        // resumed list skips what is already stored, and accumulating would send part 2's
        // URL the bytes of part 1.
        const from = (number - 1) * partSize;
        check(
          Number.isSafeInteger(number) &&
            number >= 1 &&
            Number.isSafeInteger(partSize) &&
            partSize > 0 &&
            Number.isSafeInteger(size) &&
            size > 0 &&
            from + size <= spec.source.bytes.byteLength,
          'sandbox_unavailable',
          'The object store described a part outside the source',
          502,
        );
        await this.client.upload(
          required(part.url, 'The object store returned a part without a URL'),
          Object.fromEntries(
            Object.entries(record(part.headers)).map(([key, value]) => [key, String(value)]),
          ),
          spec.source.bytes.subarray(from, from + size),
        );
      }
    }
    // Only the backend can complete: multipart ETags are not the file's hash, so the part
    // answers are nothing Merv could hand back as proof of what it sent.
    await this.client.write(entry, 'POST', `${object(objectId)}/complete`, {});
    const sandbox = record(
      await this.client.write(entry, 'POST', '/v1/sandboxes', {
        provider: spec.provider,
        offer_id: spec.offerId,
        lease_seconds: spec.leaseSeconds,
        name: `merv-check-${spec.idempotencyKey.split(':')[1]?.slice(0, 12) ?? 'base'}`,
        idempotency_key: spec.idempotencyKey,
      }),
    );
    return {
      objectId,
      sandboxId: required(sandbox.id, 'The sandbox service returned no sandbox id'),
      jobId: null,
      restoreJobId: null,
      sha256: spec.source.sha256,
      ready: false,
      environment: null,
      isolation: ISOLATION,
    };
  }

  async step(
    projectId: string,
    spec: SandboxCheckPlan,
    handle: SandboxCheckHandle,
  ): Promise<SandboxCheckHandle> {
    const entry = this.connectionFor(projectId);
    const sandboxId = required(handle.sandboxId, 'This check has no machine to advance');
    if (!handle.ready && handle.restoreJobId) {
      const restore = record(
        await this.client.read(entry, sandboxRoute('/v1/jobs/{id}', handle.restoreJobId)),
      );
      const state = text(restore.state);
      if (state === 'succeeded') return { ...handle, ready: true };
      check(
        state === null || ['queued', 'launching', 'running'].includes(state),
        'sandbox_unavailable',
        `The snapshot could not be restored onto the machine (${state})`,
        502,
      );
      return handle;
    }
    if (!handle.ready) {
      const machine = record(
        await this.client.read(entry, sandboxRoute('/v1/sandboxes/{id}', sandboxId)),
      );
      const state = text(machine.state);
      check(
        state === null || !['failed', 'stopped', 'deleting'].includes(state),
        'sandbox_unavailable',
        `The rented machine reached ${state} instead of ready`,
        502,
      );
      if (state !== 'ready') return handle;
      const environment = {
        provider: text(machine.plugin) ?? spec.provider,
        offerId: text(record(machine.offer).instance_type) ?? spec.offerId,
        snapshotId: spec.snapshotId,
      };
      if (!spec.snapshotId) return { ...handle, ready: true, environment };
      const restore = record(
        await this.client.write(
          entry,
          'POST',
          `${sandboxRoute('/v1/sandboxes/{id}', sandboxId)}/restore`,
          {
            snapshot_id: spec.snapshotId,
          },
        ),
      );
      return {
        ...handle,
        environment,
        restoreJobId: required(restore.id, 'The restore returned no job id'),
      };
    }
    if (handle.jobId) return handle;
    const download = record(
      await this.client.read(
        entry,
        `${object(required(handle.objectId, 'This check shipped no source'))}/download`,
      ),
    );
    // The signed URL is passed into the command and never fetched here: the machine reads
    // the source, and Merv never becomes the fetcher of a URL the service chose.
    const job = record(
      await this.client.write(
        entry,
        'POST',
        `${sandboxRoute('/v1/sandboxes/{id}', sandboxId)}/jobs`,
        {
          name: 'merv-check',
          command: checkScript(
            spec.command,
            required(download.url, 'The object store returned no download URL'),
            required(handle.sha256, 'This check shipped no digest'),
            spec.timeoutSeconds,
          ),
          // The job's clock covers the wrapper's setup as well as the command; the command's
          // own clock is inside the wrapper. A single clock would spend the operator's
          // timeout on a slow download and seal that as a failing verdict.
          timeout_seconds: spec.timeoutSeconds + CHECK_SETUP_SECONDS,
          idempotency_key: spec.idempotencyKey,
        },
      ),
    );
    return { ...handle, jobId: required(job.id, 'The job submission returned no job id') };
  }

  async follow(projectId: string, handle: SandboxCheckHandle): Promise<SandboxCheckVerdict> {
    const entry = this.connectionFor(projectId);
    const status = record(
      await this.client.read(
        entry,
        sandboxRoute('/v1/jobs/{id}', required(handle.jobId, 'This check has no job to follow')),
      ),
    );
    const state = text(status.state) ?? 'running';
    const terminal = ['succeeded', 'failed', 'timed_out', 'cancelled'].includes(state);
    const result = record(status.result);
    const exit = Number(result.exit);
    const written = Number.isSafeInteger(exit);
    const usage = record(status.cost);
    // The command's own timeout is enforced by the wrapper, so an overrun arrives as a
    // written result. Only this adapter knows that, so only this adapter names it: the job
    // itself succeeded, and the service's own `timed_out` can now only mean setup overran.
    const overran = written && exit === COMMAND_TIMEOUT_EXIT;
    return {
      state: overran ? 'timed_out' : terminal ? (state as SandboxCheckVerdict['state']) : 'running',
      result: written
        ? {
            exit,
            bytes: Number(result.bytes) || 0,
            head: decode(result.head64),
            tail: decode(result.tail64),
          }
        : null,
      // A reserved exit code names which setup step failed; anything else with no result is
      // simply a job that produced none, and the caller reports that as infrastructure.
      setup: written ? null : (SETUP[Number(status.exit_code)] ?? null),
      startedAt: text(status.started_at),
      finishedAt: text(status.finished_at),
      usage:
        typeof usage.amount === 'string' && typeof usage.currency === 'string'
          ? { amount: usage.amount, currency: usage.currency }
          : null,
    };
  }

  /** Every call is safe twice and safe after a crash, so reclamation never needs a receipt. */
  async release(projectId: string, handle: SandboxCheckHandle): Promise<void> {
    const entry = this.connectionFor(projectId);
    const gone = (error: unknown) => {
      if (!(error instanceof MervError) || error.code !== 'sandbox_not_found') throw error;
    };
    if (handle.jobId)
      await this.client
        .write(entry, 'POST', `${sandboxRoute('/v1/jobs/{id}', handle.jobId)}/cancel`, {})
        .catch(gone);
    if (handle.sandboxId)
      await this.client
        .write(entry, 'DELETE', sandboxRoute('/v1/sandboxes/{id}', handle.sandboxId), {
          confirm_retained: true,
        })
        .catch(gone);
    // The source is deleted with the machine rather than left against the namespace's
    // storage quota until its retention runs out.
    if (handle.objectId)
      await this.client.write(entry, 'DELETE', object(handle.objectId), {}).catch(gone);
  }
}

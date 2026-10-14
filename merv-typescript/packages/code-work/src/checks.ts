import { check, MervError } from '@merv/contracts';
import type { Context } from 'cordis';
import { mervRefusals } from '@sandboxes/merv-host/errors';
import type {} from '@sandboxes/merv-host/types';
import type {} from '@sandboxes/pipelines';
import { isTerminalJobState, shellQuote } from '@sandboxes/jobs';
import { NotFoundError, type Principal } from '@sandboxes/kernel';
import { createSandboxRequest } from '@sandboxes/registry';
import { uploadRequest } from '@sandboxes/storage';
import type {} from '@sandboxes/storage/snapshots';
import type {
  SandboxCheckCleanup,
  SandboxCheckHandle,
  SandboxCheckPlan,
  SandboxCheckSpec,
  SandboxCheckVerdict,
  SandboxChecks,
} from './check-types.js';

const refusals = mervRefusals(MervError);

const SETUP: Record<number, string> = {
  121: 'the machine had no writable workspace directory',
  122: 'the source could not be downloaded onto the machine',
  123: 'the downloaded source did not match its digest',
  124: 'the source archive could not be unpacked',
  125: 'the machine gave the job no result path',
};

// The outer job clock includes setup; the wrapper gives the command its own full timeout.
const CHECK_SETUP_SECONDS = 600;

const decode = (value: unknown) =>
  typeof value === 'string' ? Buffer.from(value, 'base64').toString('utf8') : '';

// Setup failures write no result, so command exits cannot impersonate them. A command that ignores
// TERM at its timeout is killed 10 s later; it timed out only if `timeout` stopped it then (124, or
// 137 after KILL), never by its own exit 124.
const wrapped = (command: string, timeoutSeconds: number): string[] => [
  'output="$HOME/merv-check.log"; started=$(date +%s); timedout=false',
  `timeout -k 10 ${timeoutSeconds} sh -c ${shellQuote(command)} >"$output" 2>&1; code=$?`,
  `case $code in 124|137) [ $(($(date +%s) - started)) -lt ${timeoutSeconds} ] || timedout=true;; esac`,
  `printf '{"exit":%s,"timedOut":%s,"bytes":%s,"head64":"%s","tail64":"%s"}' "$code" "$timedout" "$(wc -c <"$output" | tr -d ' ')" "$(head -c 8000 "$output" | base64 | tr -d '\\n')" "$(tail -c 8000 "$output" | base64 | tr -d '\\n')" > "$SBX_RESULT_PATH"`,
  'exit 0',
];

export function checkScript(
  command: string,
  url: string,
  sha256: string,
  timeoutSeconds: number,
): string {
  return [
    'set -u',
    '[ -n "${SBX_RESULT_PATH:-}" ] || exit 125',
    'd="$HOME/merv-check"',
    'mkdir -p "$d" || exit 121',
    'cd "$d" || exit 121',
    `curl -fsS --retry 3 --max-time 300 -o "$d.tgz" ${shellQuote(url)} || exit 122`,
    `printf '%s  %s' ${shellQuote(sha256)} "$d.tgz" | sha256sum -c - >/dev/null 2>&1 || exit 123`,
    'tar -xzf "$d.tgz" || exit 124',
    'rm -f "$d.tgz"',
    ...wrapped(command, timeoutSeconds),
  ].join('\n');
}

export class SandboxCheckRunner implements SandboxChecks {
  constructor(
    private readonly ctx: Pick<
      Context,
      | 'scope'
      | 'sbxMerv'
      | 'sbxObjects'
      | 'sbxPipelines'
      | 'sbxRegistry'
      | 'sbxJobs'
      | 'sbxSnapshots'
    >,
  ) {}

  private call<T>(projectId: string, work: (principal: Principal) => Promise<T>): Promise<T> {
    return refusals.call(async () => {
      const caller = await this.ctx.scope.serviceActor('code-work', projectId);
      return work(await this.ctx.sbxMerv.principal(caller, 'write'));
    });
  }

  start(projectId: string, spec: SandboxCheckSpec): Promise<SandboxCheckHandle> {
    return this.call(projectId, async (principal) => {
      const { namespace, member_id: memberId } = principal;
      const objects = this.ctx.sbxObjects;
      const upload = await objects.beginUpload(
        namespace,
        uploadRequest({
          name: `${spec.idempotencyKey.replaceAll(':', '/')}.tar.gz`,
          sha256: spec.source.sha256,
          size_bytes: spec.source.bytes.byteLength,
          content_type: 'application/gzip',
          idempotency_key: spec.idempotencyKey,
          expires_in_seconds: spec.leaseSeconds,
        }),
        { memberId },
      );
      for (const part of upload.parts) {
        const from = (part.part_number - 1) * upload.part_size;
        const response = await fetch(part.url, {
          method: 'PUT',
          headers: part.headers,
          body: new Blob([
            Uint8Array.from(spec.source.bytes.subarray(from, from + part.size_bytes)),
          ]),
          redirect: 'error',
          signal: AbortSignal.timeout(15_000 + Math.ceil(part.size_bytes / 128)),
        });
        await response.body?.cancel();
        check(response.ok, 'sandbox_unavailable', 'The source upload failed', 502);
      }
      // Completion verifies the stored bytes, including parts uploaded before a crash.
      await objects.completeUpload(namespace, upload.object.id, { memberId });
      const [, base, epoch] = spec.idempotencyKey.split(':');
      const sandbox = await this.ctx.sbxPipelines.createSandbox({
        namespace,
        principal,
        request: createSandboxRequest({
          provider: spec.provider,
          offer_id: spec.offerId,
          lease_seconds: spec.leaseSeconds,
          name: `merv-check-${base.slice(0, 12)}-${epoch}`,
          idempotency_key: spec.idempotencyKey,
        }),
      });
      return {
        objectId: upload.object.id,
        sandboxId: sandbox.id,
        jobId: null,
        restoreJobId: null,
        ready: false,
        environment: null,
      };
    });
  }

  step(
    projectId: string,
    spec: SandboxCheckPlan,
    handle: SandboxCheckHandle,
  ): Promise<SandboxCheckHandle> {
    return this.call(projectId, async (principal) => {
      const { namespace } = principal;
      const sandboxId = handle.sandboxId;
      if (!handle.ready && handle.restoreJobId) {
        const restore = await this.ctx.sbxJobs.get({ namespace, jobId: handle.restoreJobId });
        if (restore.state === 'succeeded') return { ...handle, ready: true };
        check(
          !isTerminalJobState(restore.state),
          'sandbox_unavailable',
          `The snapshot could not be restored onto the machine (${restore.state})`,
          502,
        );
        return handle;
      }
      if (!handle.ready) {
        const machine = await this.ctx.sbxRegistry.get(namespace, sandboxId);
        check(
          !['failed', 'stopped', 'deleting'].includes(machine.state),
          'sandbox_unavailable',
          `The rented machine reached ${machine.state} instead of ready`,
          502,
        );
        if (machine.state !== 'ready') return handle;
        const environment = {
          provider: machine.plugin,
          offerId: machine.offer.instance_type,
          snapshotId: spec.snapshotId,
        };
        if (!spec.snapshotId) return { ...handle, ready: true, environment };
        const restore = await this.ctx.sbxSnapshots.restore(namespace, sandboxId, spec.snapshotId, {
          principal,
          idempotencyKey: `${spec.idempotencyKey}:restore`,
        });
        return { ...handle, environment, restoreJobId: restore.id };
      }
      const download = await this.ctx.sbxObjects.download(namespace, handle.objectId, {
        memberId: principal.member_id,
      });
      const job = await this.ctx.sbxJobs.run({
        namespace,
        sandboxId,
        principal,
        request: {
          name: 'merv-check',
          command: checkScript(
            spec.command,
            download.url,
            download.object.sha256,
            spec.timeoutSeconds,
          ),
          timeout_seconds: spec.timeoutSeconds + CHECK_SETUP_SECONDS,
          idempotency_key: spec.idempotencyKey,
        },
      });
      return { ...handle, jobId: job.id };
    });
  }

  follow(projectId: string, handle: SandboxCheckHandle): Promise<SandboxCheckVerdict> {
    return this.call(projectId, async ({ namespace }) => {
      const status = await this.ctx.sbxJobs.status({
        namespace,
        jobId: handle.jobId!,
      });
      const terminal = isTerminalJobState(status.state);
      const result = status.result;
      const exit = result?.exit;
      const written = typeof exit === 'number' && Number.isSafeInteger(exit);
      return {
        state:
          written && result?.timedOut === true
            ? 'timed_out'
            : terminal
              ? (status.state as SandboxCheckVerdict['state'])
              : 'running',
        result: written
          ? {
              exit,
              bytes: Number(result?.bytes) || 0,
              head: decode(result?.head64),
              tail: decode(result?.tail64),
            }
          : null,
        setup: written ? null : (SETUP[status.exit_code ?? 0] ?? null),
        startedAt: status.started_at?.toJSON() ?? null,
        finishedAt: status.finished_at?.toJSON() ?? null,
        usage: status.cost,
      };
    });
  }

  release(projectId: string, handle: SandboxCheckCleanup): Promise<void> {
    return this.call(projectId, async (principal) => {
      const gone = (error: unknown) => {
        if (!(error instanceof NotFoundError)) throw error;
      };
      const { namespace } = principal;
      if (handle.jobId)
        await this.ctx.sbxJobs.cancel({ namespace, jobId: handle.jobId }).catch(gone);
      if (handle.sandboxId)
        await this.ctx.sbxRegistry
          .requestDelete(namespace, handle.sandboxId, 'caller', principal)
          .catch(gone);
      if (handle.objectId)
        await this.ctx.sbxObjects
          .delete(namespace, handle.objectId, { memberId: principal.member_id })
          .catch(gone);
    });
  }
}

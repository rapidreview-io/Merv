import { check, digest, MervError, type Json } from '@merv/contracts';
import { SandboxClient, sandboxRoute } from './client.js';
import { ship, wrapped } from './checks.js';
import { computeOutputsSchema } from './compute-outputs.js';
import type {
  SandboxCompute,
  SandboxComputeRun,
  SandboxComputeSpec,
  SandboxComputeOutput,
  SandboxConnection,
  SandboxRental,
  SandboxRentalInput,
} from './types.js';

const object = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {};
const identifier = (value: unknown): string => {
  check(
    typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value),
    'sandbox_unavailable',
    'Sandboxes returned an invalid run identifier',
    502,
  );
  return value as string;
};
const decode = (value: unknown): string =>
  typeof value === 'string' ? Buffer.from(value, 'base64').toString('utf8') : '';
// Provider-owned metadata selects the protocol, never the command's custom result JSON.
const nativeJobName = 'merv-compute-v2';
const quoted = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
const money = (
  value: unknown,
  basis: NonNullable<SandboxComputeRun['cost']>['basis'],
): SandboxComputeRun['cost'] => {
  const row = object(value);
  return typeof row.amount === 'string' && typeof row.currency === 'string'
    ? { amount: row.amount, currency: row.currency, basis }
    : null;
};

export class SandboxComputeAdapter implements SandboxCompute {
  private readonly client: SandboxClient;
  private readonly config: {
    namespace: string;
    tokenEnv: string;
    since: string;
    storageOrigins: string[];
  };
  private readonly options = new Map<string, { at: number; value: Json }>();

  constructor(
    origin: string,
    timeoutMs: number,
    refreshMs: number,
    config: { namespace: string; tokenEnv: string; since: string; storageOrigins: string[] },
  ) {
    this.client = new SandboxClient(origin, timeoutMs, config.storageOrigins);
    this.config = config;
    this.refreshMs = refreshMs;
  }
  private readonly refreshMs: number;
  get since(): string {
    return this.config.since;
  }
  private entry(projectId: string): SandboxConnection {
    return {
      projectId,
      namespace: this.config.namespace,
      tokenEnv: this.config.tokenEnv,
      subject: projectId,
    };
  }
  async offers(projectId: string): Promise<Json> {
    const cached = this.options.get(projectId);
    if (cached && Date.now() - cached.at < this.refreshMs) return cached.value;
    const response = object(await this.client.read(this.entry(projectId), '/v1/options'));
    const offers = Array.isArray(response.offers)
      ? response.offers.filter((offer) => object(offer).resources?.gpu_count > 0)
      : [];
    const value = { offers } as Json;
    this.options.set(projectId, { at: Date.now(), value });
    return value;
  }
  async allowance(projectId: string): Promise<Json> {
    const response = object(await this.client.read(this.entry(projectId), '/v1/spend'));
    return {
      month_to_date: response.month_to_date ?? [],
      cap: object(response.cap).monthly_cap ?? null,
    } as Json;
  }
  async submit(projectId: string, spec: SandboxComputeSpec): Promise<string> {
    const outputs = spec.outputs ? computeOutputsSchema.parse(spec.outputs) : undefined;
    const entry = this.entry(projectId);
    const objectId = spec.source
      ? await ship(this.client, entry, spec.idempotencyKey, spec.source, spec.minutes * 60 + 660)
      : null;
    const nodes: Json[] = [
      {
        id: 'provision',
        ...(spec.rentalSandboxId
          ? { kind: 'use_vm', sandbox_id: spec.rentalSandboxId }
          : { kind: 'provision', request: { provider: spec.provider!, offer_id: spec.offerId! } }),
      },
    ];
    const directory = spec.rentalSandboxId ? `merv-run/${digest(spec.idempotencyKey)}` : 'merv-run';
    const sourcePath = spec.rentalSandboxId ? `/tmp/${directory}/src.tgz` : '/tmp/merv/src.tgz';
    const inputs = objectId ? [{ object_id: objectId, path: sourcePath }] : [];
    if (inputs.length)
      nodes.push({
        id: 'stage',
        kind: 'stage',
        vm: 'provision',
        depends_on: ['provision'],
        inputs,
      });
    const setup = [
      `d="$HOME/${directory}"`,
      'mkdir -p "$d" || exit 121',
      'cd "$d" || exit 121',
      ...(objectId ? [`tar -xzf ${sourcePath} || exit 124`] : []),
    ];
    const script = [
      'set -u',
      ...setup,
      `exec timeout ${spec.minutes * 60} sh -c ${quoted(spec.command)}`,
    ].join('\n');
    nodes.push({
      id: 'run',
      kind: 'run',
      vm: 'provision',
      depends_on: [inputs.length ? 'stage' : 'provision'],
      main: true,
      job: { name: nativeJobName, command: script, timeout_seconds: spec.minutes * 60 + 300 },
    });
    if (outputs)
      nodes.push({
        id: 'capture',
        kind: 'capture',
        vm: 'provision',
        job: 'run',
        depends_on: ['run'],
        when: 'always',
        outputs: outputs.files.map((file) => ({ ...file, kind: 'file', required: true })),
        output_bytes: outputs.maxBytes,
      });
    if (!spec.rentalSandboxId)
      nodes.push({
        id: 'release',
        kind: 'release',
        vm: 'provision',
        depends_on: [outputs ? 'capture' : 'run'],
        when: 'always',
      });
    const request = {
      name: spec.experimentId,
      idempotency_key: spec.idempotencyKey,
      timeout_seconds: spec.minutes * 60 + 600,
      capture_grace_seconds: outputs ? 600 : 60,
      max_cost: spec.maxUsd,
      nodes,
    };
    try {
      return identifier(
        object(await this.client.write(entry, 'POST', '/v1/workflows', request)).id,
      );
    } catch (error) {
      if (
        spec.rentalSandboxId ||
        !(error instanceof MervError && error.code === 'sandbox_idempotency_conflict')
      )
        throw error;
      // A pre-upgrade admission may have succeeded just before its reply was lost. Recover
      // that same key with its exact former payload; never rent a second job under a new key.
      const legacyScript = [
        'set -u',
        '[ -n "${SBX_RESULT_PATH:-}" ] || exit 125',
        ...setup,
        ...wrapped(spec.command, spec.minutes * 60),
      ].join('\n');
      object(nodes.find((node) => object(node).id === 'run')).job = {
        command: legacyScript,
        timeout_seconds: spec.minutes * 60 + 300,
      };
      return identifier(
        object(await this.client.write(entry, 'POST', '/v1/workflows', request)).id,
      );
    }
  }
  async get(projectId: string, runId: string): Promise<SandboxComputeRun> {
    const workflow = object(
      await this.client.read(this.entry(projectId), sandboxRoute('/v1/workflows/{id}', runId)),
    );
    const nodes = object(workflow.nodes);
    const run = object(nodes.run);
    const failed = Object.entries(nodes).find(([, value]) => object(value).error);
    const error = object((failed && object(failed[1]).error) ?? workflow.error);
    const reason =
      object(error.details).reason ?? error.reason ?? error.message ?? error.code ?? null;
    const jobId = object(run.result).job_id;
    let result: SandboxComputeRun['result'] = null;
    let cost = money(workflow.reserved_cost, 'full_lease_quote');
    if (
      typeof jobId === 'string' &&
      ['completed', 'failed', 'cancelled'].includes(String(workflow.state))
    ) {
      const job = object(
        await this.client.read(this.entry(projectId), sandboxRoute('/v1/jobs/{id}', jobId)),
      );
      const output = object(job.result);
      if (job.name === nativeJobName) {
        if (Number.isInteger(job.exit_code)) result = { exit: job.exit_code };
      } else if (Number.isInteger(output.exit))
        result = {
          exit: output.exit,
          bytes: Number(output.bytes) || 0,
          head: decode(output.head64),
          tail: decode(output.tail64),
        };
      cost ??= money(job.cost, 'job_runtime_estimate');
    }
    const capture = object(nodes.capture);
    const captured = object(capture.result);
    const entries = Object.entries(object(captured.outputs));
    check(
      entries.length <= 8,
      'sandbox_unavailable',
      'Capture returned too many output files',
      502,
    );
    const outputs = await Promise.all(
      entries.map(async ([name, value]): Promise<SandboxComputeOutput> => {
        const objectId = identifier(value);
        const record = object(
          await this.client.read(
            this.entry(projectId),
            sandboxRoute('/v1/storage/objects/{id}', objectId),
          ),
        );
        check(
          record.id === objectId &&
            record.producer_pipeline_id === runId &&
            record.kind === 'file' &&
            record.state === 'available' &&
            Number.isSafeInteger(record.size_bytes) &&
            record.size_bytes >= 0 &&
            typeof record.sha256 === 'string' &&
            /^[a-f0-9]{64}$/.test(record.sha256),
          'sandbox_unavailable',
          'Captured output metadata is unavailable or invalid',
          502,
        );
        return {
          name,
          objectId,
          sizeBytes: record.size_bytes,
          sha256: record.sha256,
          expiresAt: typeof record.expires_at === 'string' ? record.expires_at : null,
        };
      }),
    );
    return {
      id: runId,
      state: String(workflow.state),
      reason: typeof reason === 'string' ? reason.slice(0, 2000) : null,
      cost,
      result,
      ...(nodes.capture
        ? {
            outputs,
            outputState: String(captured.output_state ?? capture.state ?? 'pending'),
          }
        : {}),
      ...(failed ? { failureStage: failed[0] } : {}),
    };
  }
  /** Latest bounded stdout/stderr, fetched only on demand; never copied into work context. */
  async logs(projectId: string, runId: string): Promise<Json> {
    const entry = this.entry(projectId);
    const workflow = object(
      await this.client.read(entry, sandboxRoute('/v1/workflows/{id}', runId)),
    );
    const jobId = object(object(object(workflow.nodes).run).result).job_id;
    if (typeof jobId !== 'string') return { state: String(workflow.state), mode: 'pending' };
    const job = object(await this.client.read(entry, sandboxRoute('/v1/jobs/{id}', jobId)));
    const native = job.name === nativeJobName;
    const streams = await Promise.all(
      (['stdout', 'stderr'] as const).map(async (stream) => {
        const extent = object(
          (Array.isArray(job.outputs) ? job.outputs : []).find(
            (item) => object(item).stream === stream,
          ),
        );
        const total = extent.total_length;
        const available = extent.available_start;
        if (
          !Number.isSafeInteger(total) ||
          !Number.isSafeInteger(available) ||
          available < 0 ||
          total < available
        )
          return [stream, { unavailable: 'Output metadata is not available yet.' }] as const;
        const start = Math.max(available, total - 8000);
        try {
          const text = await this.client.output(entry, jobId, stream, start, total);
          return [
            stream,
            {
              text,
              start,
              end: total,
              totalBytes: total,
              truncated: start > 0 || extent.truncated === true,
              complete: extent.complete === true,
            },
          ] as const;
        } catch (error) {
          if (!(error instanceof MervError)) throw error;
          // Output can expire between the extent read and this read. It is not an empty log
          // or a failed command; the next on-demand call obtains fresh extents.
          return [stream, { unavailable: error.message }] as const;
        }
      }),
    );
    return {
      state: String(job.state),
      mode: native ? 'native' : 'legacy',
      streams: Object.fromEntries(streams),
      ...(!native
        ? {
            notice:
              'This older job buffers command output until completion. Read its final result in compute status.',
          }
        : {}),
    } as Json;
  }
  async download(
    projectId: string,
    objectId: string,
  ): Promise<{ url: string; expiresAt?: string }> {
    const response = object(
      await this.client.read(
        this.entry(projectId),
        `${sandboxRoute('/v1/storage/objects/{id}', objectId)}/download`,
      ),
    );
    const record = object(response.object);
    check(
      record.id === objectId && record.kind === 'file' && record.state === 'available',
      'sandbox_unavailable',
      'Captured file is no longer available',
      502,
    );
    let url: URL | undefined;
    try {
      url = new URL(response.url);
    } catch {
      /* Refuse malformed provider output. */
    }
    check(
      url &&
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        this.config.storageOrigins.some((origin) => new URL(origin).origin === url.origin),
      'sandbox_unavailable',
      'Captured output download is outside configured storage origins',
      502,
    );
    // Preserve the provider's ordinary link lifetime (one hour in production), including
    // when a capture is an input to a later GPU job. Report the signed expiry when available.
    const issued = url.searchParams
      .get('X-Amz-Date')
      ?.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
    const seconds = Number(url.searchParams.get('X-Amz-Expires'));
    const time = issued
      ? Date.parse(`${issued[1]}-${issued[2]}-${issued[3]}T${issued[4]}:${issued[5]}:${issued[6]}Z`)
      : NaN;
    return {
      url: url.href,
      ...(Number.isFinite(time) && seconds > 0 && seconds <= 86400
        ? { expiresAt: new Date(time + seconds * 1000).toISOString() }
        : {}),
    };
  }
  async cancel(projectId: string, runId: string): Promise<void> {
    try {
      await this.client.write(
        this.entry(projectId),
        'POST',
        `${sandboxRoute('/v1/workflows/{id}', runId)}/cancel`,
        {},
      );
    } catch (error) {
      if (!(error instanceof MervError && error.status === 404)) throw error;
    }
  }

  async retain(projectId: string, objectId: string): Promise<void> {
    const record = object(
      await this.client.write(
        this.entry(projectId),
        'PATCH',
        `${sandboxRoute('/v1/storage/objects/{id}', objectId)}/retention`,
        { expires_at: null },
      ),
    );
    check(
      record.id === objectId && record.state === 'available' && record.expires_at === null,
      'sandbox_unavailable',
      'Captured file retention was not confirmed',
      502,
    );
  }
  private rental(value: unknown): SandboxRental {
    const record = object(value);
    check(
      record.request?.protected_runtime !== true,
      'forbidden',
      'Hosted workers are not research compute',
      403,
    );
    return {
      sandboxId: identifier(record.id),
      state: String(record.state),
      leaseExpiresAt: typeof record.lease_expires_at === 'string' ? record.lease_expires_at : null,
      hourlyPrice: record.hourly_price ?? null,
      reason:
        typeof record.last_error?.message === 'string'
          ? record.last_error.message.slice(0, 2000)
          : null,
    };
  }
  async findRental(projectId: string, key: string): Promise<SandboxRental | null> {
    // Replay lookup precedes offer resolution: the offer can disappear after a successful
    // create whose response was lost. The provider's ordinary create resolves that offer first.
    const existing = object(
      await this.client.read(this.entry(projectId), '/v1/sandboxes', { include_stopped: true }),
    );
    check(
      Array.isArray(existing.sandboxes),
      'sandbox_unavailable',
      'Cannot reconcile existing GPU rentals',
      502,
    );
    const found = existing.sandboxes.find(
      (item: unknown) => object(object(item).request).idempotency_key === key,
    );
    return found ? this.rental(found) : null;
  }
  async rent(projectId: string, input: SandboxRentalInput): Promise<SandboxRental> {
    return this.rental(
      await this.client.write(this.entry(projectId), 'POST', '/v1/sandboxes', {
        provider: input.provider,
        offer_id: input.offerId,
        lease_seconds: input.minutes * 60,
        idempotency_key: input.key,
        name: `merv-${input.key.slice(0, 40)}`,
      }),
    );
  }
  async inspectRental(projectId: string, sandboxId: string): Promise<SandboxRental> {
    return this.rental(
      await this.client.read(this.entry(projectId), sandboxRoute('/v1/sandboxes/{id}', sandboxId)),
    );
  }
  async extendRental(
    projectId: string,
    sandboxId: string,
    minutes: number,
  ): Promise<SandboxRental> {
    check(
      Number.isInteger(minutes) && minutes >= 1 && minutes <= 1380,
      'invalid_compute_input',
      'Extension minutes must be between 1 and 1380',
      400,
    );
    const entry = this.entry(projectId);
    const route = sandboxRoute('/v1/sandboxes/{id}', sandboxId);
    const record = object(await this.client.read(entry, route));
    this.rental(record); // Refuse protected worker runtimes before mutation.
    check(
      Number.isSafeInteger(record.revision) && record.revision >= 0,
      'sandbox_revision_unavailable',
      'Safe extension requires a provider revision',
      502,
    );
    const expires = Date.parse(String(record.lease_expires_at ?? ''));
    const left = Number.isNaN(expires) ? 0 : Math.max(0, Math.ceil((expires - Date.now()) / 1000));
    return this.rental(
      await this.client.write(entry, 'POST', `${route}/renew`, {
        lease_seconds: left + minutes * 60,
        expected_revision: record.revision,
      }),
    );
  }
  async releaseRental(projectId: string, sandboxId: string): Promise<SandboxRental> {
    return this.rental(
      await this.client.write(
        this.entry(projectId),
        'DELETE',
        sandboxRoute('/v1/sandboxes/{id}', sandboxId),
        {},
      ),
    );
  }
  async ssh(projectId: string, sandboxId: string, publicKey: string): Promise<Json> {
    const result = object(
      await this.client.write(this.entry(projectId), 'POST', '/v1/access/certificates', {
        sandbox_id: sandboxId,
        public_key: publicKey,
        ttl_seconds: 300,
      }),
    );
    check(
      typeof result.certificate === 'string' &&
        typeof result.expires_at === 'string' &&
        typeof result.gateway?.host === 'string' &&
        Number.isInteger(result.gateway?.port),
      'sandbox_unavailable',
      'SSH access information is unavailable',
      502,
    );
    return {
      sandboxId,
      certificate: result.certificate,
      expiresAt: result.expires_at,
      gateway: result.gateway,
      username: sandboxId,
    };
  }
}

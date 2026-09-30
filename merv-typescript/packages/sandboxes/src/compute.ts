import { check, MervError, type Json } from '@merv/contracts';
import { SandboxClient, sandboxRoute } from './client.js';
import { ship, wrapped } from './checks.js';
import { computeOutputsSchema } from './compute-outputs.js';
import type {
  SandboxCompute,
  SandboxComputeRun,
  SandboxComputeSpec,
  SandboxComputeOutput,
  SandboxConnection,
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
const money = (value: unknown): SandboxComputeRun['cost'] => {
  const row = object(value);
  return typeof row.amount === 'string' && typeof row.currency === 'string'
    ? { amount: row.amount, currency: row.currency }
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
        kind: 'provision',
        request: {
          provider: spec.provider,
          offer_id: spec.offerId,
        },
      },
    ];
    const inputs = objectId ? [{ object_id: objectId, path: '/tmp/merv/src.tgz' }] : [];
    if (inputs.length)
      nodes.push({
        id: 'stage',
        kind: 'stage',
        vm: 'provision',
        depends_on: ['provision'],
        inputs,
      });
    const setup = [
      'd="$HOME/merv-run"',
      'mkdir -p "$d" || exit 121',
      'cd "$d" || exit 121',
      ...(objectId ? ['tar -xzf /tmp/merv/src.tgz || exit 124'] : []),
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
      if (!(error instanceof MervError && error.code === 'sandbox_idempotency_conflict'))
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
    let cost = money(workflow.reserved_cost);
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
      cost ??= money(job.cost);
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
  async download(projectId: string, objectId: string): Promise<{ url: string }> {
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
    return { url: url.href };
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
}

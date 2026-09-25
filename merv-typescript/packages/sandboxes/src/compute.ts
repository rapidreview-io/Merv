import { check, MervError, type Json } from '@merv/contracts';
import { SandboxClient, sandboxRoute } from './client.js';
import { ship, wrapped } from './checks.js';
import type {
  SandboxCompute,
  SandboxComputeRun,
  SandboxComputeSpec,
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
    const inputs = [
      ...(objectId ? [{ object_id: objectId, path: '/tmp/merv/src.tgz' }] : []),
      ...(spec.objectInputs ?? []).map((item) => ({
        object_id: item.objectId,
        path: `/tmp/merv/inputs/${item.path}`,
      })),
    ];
    if (inputs.length)
      nodes.push({
        id: 'stage',
        kind: 'stage',
        vm: 'provision',
        depends_on: ['provision'],
        inputs,
      });
    const script = [
      'set -u',
      '[ -n "${SBX_RESULT_PATH:-}" ] || exit 125',
      'd="$HOME/merv-run"',
      'mkdir -p "$d" || exit 121',
      'cd "$d" || exit 121',
      ...(objectId ? ['tar -xzf /tmp/merv/src.tgz || exit 124'] : []),
      ...wrapped(spec.command, spec.minutes * 60),
    ].join('\n');
    nodes.push({
      id: 'run',
      kind: 'run',
      vm: 'provision',
      depends_on: [inputs.length ? 'stage' : 'provision'],
      main: true,
      job: { command: script, timeout_seconds: spec.minutes * 60 + 300 },
    });
    nodes.push({
      id: 'release',
      kind: 'release',
      vm: 'provision',
      depends_on: ['run'],
      when: 'always',
    });
    const result = object(
      await this.client.write(entry, 'POST', '/v1/workflows', {
        name: spec.experimentId,
        idempotency_key: spec.idempotencyKey,
        timeout_seconds: spec.minutes * 60 + 600,
        capture_grace_seconds: 60,
        max_cost: spec.maxUsd,
        nodes,
      }),
    );
    return identifier(result.id);
  }
  async get(projectId: string, runId: string): Promise<SandboxComputeRun> {
    const workflow = object(
      await this.client.read(this.entry(projectId), sandboxRoute('/v1/workflows/{id}', runId)),
    );
    const nodes = object(workflow.nodes);
    const provision = object(nodes.provision);
    const run = object(nodes.run);
    const error = object(provision.error ?? workflow.error);
    const reason = object(error.details).reason ?? error.reason ?? null;
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
      if (Number.isInteger(output.exit))
        result = {
          exit: output.exit,
          bytes: Number(output.bytes) || 0,
          head: decode(output.head64),
          tail: decode(output.tail64),
        };
      cost ??= money(job.cost);
    }
    return {
      id: runId,
      state: String(workflow.state),
      reason: typeof reason === 'string' ? reason : null,
      cost,
      result,
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
}

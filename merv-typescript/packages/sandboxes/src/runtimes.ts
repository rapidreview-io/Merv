import { createHash } from 'node:crypto';
import { check, MervError, type Json } from '@merv/contracts';
import { SandboxClient, sandboxRoute } from './client.js';
import type {
  SandboxConnection,
  SandboxRuntimeHandle,
  SandboxRuntimeLaunch,
  SandboxRuntimeProfile,
  SandboxRuntimeState,
  SandboxRuntimes,
} from './types.js';

const sandboxPath = '/v1/sandboxes/{id}';
const runtimePath = '/v1/sandboxes/{id}/runtime';
const launchPath = '/v1/runtime/launches/{id}';
const states = new Set<SandboxRuntimeState>([
  'provisioning',
  'ready',
  'unknown',
  'deleting',
  'failed',
  'stopped',
]);
const launchStates = new Set<SandboxRuntimeLaunch['state']>([
  'pending',
  'consumed',
  'revoked',
  'expired',
]);
const deliveryStates = new Set<SandboxRuntimeLaunch['deliveryState']>([
  'pending',
  'uncertain',
  'launched',
]);

function object(value: Json): Record<string, Json> {
  check(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'sandbox_runtime_unavailable',
    'The sandbox service returned an invalid runtime record',
    502,
  );
  return value as Record<string, Json>;
}

function name(value: Json | undefined): string {
  check(
    typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value),
    'sandbox_runtime_unavailable',
    'The sandbox service returned an invalid identifier',
    502,
  );
  return value;
}

function receipt(value: Json, sandboxId: string, releaseId: string): SandboxRuntimeLaunch {
  const row = object(value);
  const state = row.state;
  const delivery = row.delivery_state;
  check(
    row.sandbox_id === sandboxId &&
      row.release_id === releaseId &&
      typeof state === 'string' &&
      launchStates.has(state as SandboxRuntimeLaunch['state']) &&
      typeof delivery === 'string' &&
      deliveryStates.has(delivery as SandboxRuntimeLaunch['deliveryState']) &&
      typeof row.operation_key === 'string' &&
      row.operation_key.length > 0 &&
      typeof row.expires_at === 'string' &&
      !Number.isNaN(Date.parse(row.expires_at)),
    'sandbox_runtime_unavailable',
    'The sandbox service returned an invalid launch receipt',
    502,
  );
  return {
    sandboxId,
    launchId: name(row.launch_id),
    operationKey: row.operation_key as string,
    releaseId,
    jobId: name(row.job_id),
    state: state as SandboxRuntimeLaunch['state'],
    deliveryState: delivery as SandboxRuntimeLaunch['deliveryState'],
    expiresAt: row.expires_at as string,
  };
}

function handle(
  value: Json,
  profile: SandboxRuntimeProfile | null,
  launch: SandboxRuntimeLaunch | null,
): SandboxRuntimeHandle {
  const row = object(value);
  const request = object(row.request as Json);
  const state = row.state;
  check(
    typeof state === 'string' &&
      states.has(state as SandboxRuntimeState) &&
      request.protected_runtime === true &&
      (!profile || (row.provider === profile.provider && request.offer_id === profile.offerId)) &&
      typeof row.revision === 'number' &&
      Number.isSafeInteger(row.revision) &&
      row.revision >= 0 &&
      (row.lease_expires_at === null ||
        row.lease_expires_at === undefined ||
        (typeof row.lease_expires_at === 'string' &&
          !Number.isNaN(Date.parse(row.lease_expires_at)))),
    'sandbox_runtime_unavailable',
    'The sandbox does not match the protected runtime profile',
    502,
  );
  const sandboxId = name(row.id);
  check(
    !launch || launch.sandboxId === sandboxId,
    'sandbox_runtime_unavailable',
    'The launch receipt belongs to another sandbox',
    502,
  );
  const leaseExpiresAt = typeof row.lease_expires_at === 'string' ? row.lease_expires_at : null;
  const access =
    row.access_mode === 'tunnel'
      ? row.agent_connected_at !== null && row.agent_connected_at !== undefined
      : row.endpoint !== null && row.endpoint !== undefined;
  return {
    sandboxId,
    state: state as SandboxRuntimeState,
    ready:
      state === 'ready' &&
      access &&
      (leaseExpiresAt === null || Date.parse(leaseExpiresAt) > Date.now()),
    deleted: state === 'stopped',
    leaseExpiresAt,
    revision: row.revision as number,
    launch,
  };
}

/** Bounded server-side consumer of the protected runtime admission routes. */
export class SandboxRuntimeRunner implements Omit<SandboxRuntimes, 'connected'> {
  readonly profileId: string;
  readonly #profile: SandboxRuntimeProfile & { ttlSeconds: number };

  constructor(
    readonly client: SandboxClient,
    readonly connectionFor: (projectId: string) => SandboxConnection,
    profile: SandboxRuntimeProfile,
  ) {
    this.#profile = { ...profile, ttlSeconds: profile.ttlSeconds ?? 300 };
    this.profileId = `srp_${createHash('sha256')
      .update(
        JSON.stringify([
          this.#profile.provider,
          this.#profile.offerId,
          this.#profile.releaseId,
          this.#profile.leaseSeconds,
          this.#profile.ttlSeconds,
        ]),
      )
      .digest('hex')}`;
  }

  async provision(projectId: string, operationKey: string): Promise<SandboxRuntimeHandle> {
    check(
      typeof operationKey === 'string' && operationKey.length >= 1 && operationKey.length <= 128,
      'invalid_runtime_operation',
      'A runtime operation key must be 1..128 characters',
    );
    const connection = this.connectionFor(projectId);
    // The same logical Fleet operation always gives the service the same create key.
    const idempotencyKey = `runtime:${createHash('sha256')
      .update(JSON.stringify([projectId, operationKey]))
      .digest('hex')}`;
    const row = await this.client.write(connection, 'POST', '/v1/sandboxes', {
      provider: this.#profile.provider,
      offer_id: this.#profile.offerId,
      lease_seconds: this.#profile.leaseSeconds,
      idempotency_key: idempotencyKey,
      protected_runtime: true,
    });
    return handle(row, this.#profile, null);
  }

  async inspect(projectId: string, current: SandboxRuntimeHandle): Promise<SandboxRuntimeHandle> {
    return this.#inspect(projectId, current, false);
  }

  async #inspect(
    projectId: string,
    current: SandboxRuntimeHandle,
    requireCurrentProfile: boolean,
  ): Promise<SandboxRuntimeHandle> {
    const connection = this.connectionFor(projectId);
    const path = sandboxRoute(sandboxPath, current.sandboxId);
    const row = await this.client.read(connection, path);
    check(
      object(row).id === current.sandboxId,
      'sandbox_runtime_unavailable',
      'The sandbox service returned another sandbox',
      502,
    );
    const launch = current.launch
      ? receipt(
          await this.client.read(connection, sandboxRoute(launchPath, current.launch.launchId)),
          current.sandboxId,
          current.launch.releaseId,
        )
      : null;
    return handle(row, requireCurrentProfile ? this.#profile : null, launch);
  }

  async launch(
    projectId: string,
    current: SandboxRuntimeHandle,
    operationKey: string,
    bootstrap: string,
  ): Promise<SandboxRuntimeHandle> {
    check(
      typeof operationKey === 'string' && operationKey.length >= 1 && operationKey.length <= 128,
      'invalid_runtime_operation',
      'A runtime operation key must be 1..128 characters',
    );
    check(
      typeof bootstrap === 'string' &&
        Buffer.byteLength(bootstrap, 'utf8') > 0 &&
        Buffer.byteLength(bootstrap, 'utf8') <= 65536,
      'invalid_runtime_bootstrap',
      'The runtime bootstrap must contain 1..65536 bytes',
    );
    const fresh = await this.#inspect(projectId, current, true);
    check(fresh.ready, 'sandbox_runtime_not_ready', 'The protected sandbox is not ready', 409);
    const connection = this.connectionFor(projectId);
    let row: Json;
    try {
      row = await this.client.write(
        connection,
        'POST',
        sandboxRoute(runtimePath, fresh.sandboxId),
        {
          operation_key: operationKey,
          release_id: this.#profile.releaseId,
          bootstrap,
          ttl_seconds: this.#profile.ttlSeconds,
        },
      );
    } catch (error) {
      // A transport or remote validation message must never echo the one-use bootstrap.
      if (error instanceof MervError)
        throw new MervError(error.code, 'Protected runtime launch was refused', error.status);
      throw new MervError('sandbox_runtime_launch_failed', 'Protected runtime launch failed', 502);
    }
    return { ...fresh, launch: receipt(row, fresh.sandboxId, this.#profile.releaseId) };
  }

  async stop(projectId: string, current: SandboxRuntimeHandle): Promise<SandboxRuntimeHandle> {
    const fresh = await this.inspect(projectId, current);
    if (fresh.deleted) return fresh;
    const connection = this.connectionFor(projectId);
    const path = fresh.launch
      ? sandboxRoute(launchPath, fresh.launch.launchId)
      : sandboxRoute(sandboxPath, fresh.sandboxId);
    await this.client.write(connection, 'DELETE', path, {});
    // The DELETE is only an intent; read provider state before reporting release.
    return await this.inspect(projectId, fresh);
  }

  async acknowledge(
    projectId: string,
    current: SandboxRuntimeHandle,
  ): Promise<SandboxRuntimeHandle> {
    const launch = current.launch;
    check(
      launch?.sandboxId === current.sandboxId &&
        launch.deliveryState === 'launched' &&
        ['pending', 'consumed'].includes(launch.state),
      'sandbox_runtime_unavailable',
      'A launched protected runtime receipt is required',
      409,
    );
    const row = await this.client.write(
      this.connectionFor(projectId),
      'POST',
      `${sandboxRoute(launchPath, launch.launchId)}/exchange`,
      { job_id: launch.jobId },
    );
    const confirmed = receipt(row, current.sandboxId, launch.releaseId);
    check(
      confirmed.launchId === launch.launchId &&
        confirmed.jobId === launch.jobId &&
        confirmed.operationKey === launch.operationKey &&
        confirmed.state === 'consumed' &&
        confirmed.deliveryState === 'launched',
      'sandbox_runtime_unavailable',
      'The sandbox service returned another runtime exchange',
      502,
    );
    return { ...current, launch: confirmed };
  }

  async renew(projectId: string, current: SandboxRuntimeHandle): Promise<SandboxRuntimeHandle> {
    const fresh = await this.#inspect(projectId, current, true);
    check(
      ['provisioning', 'ready', 'unknown'].includes(fresh.state),
      'sandbox_runtime_not_live',
      'The protected sandbox cannot be renewed',
      409,
    );
    const row = await this.client.write(
      this.connectionFor(projectId),
      'POST',
      sandboxRoute('/v1/sandboxes/{id}/renew', fresh.sandboxId),
      { lease_seconds: this.#profile.leaseSeconds },
    );
    return handle(row, this.#profile, fresh.launch);
  }
}

import { Instant } from '@sandboxes/kernel';
import { MervError } from '@merv/contracts';
import {
  launchIds,
  SecretString,
  type RuntimeLaunchRequest,
  type RuntimeBootstrap,
} from '@sandboxes/runtimes';
import { SessionReadBroker, type ReadBrokerBinding } from './read-broker.js';

/** Trusted server-owned deployment record, not MCP/job arguments. Each role has a separate sandbox. */
export interface ReadBrokerDeployment {
  binding: Omit<ReadBrokerBinding, 'launchId' | 'jobId'>;
  operationKey: string;
  releaseId: string;
  ttlSeconds: number;
}
export interface ReadBrokerProvisioning {
  /** Must atomically claim an approved, unused deployment. Repeated claims fail closed. */
  claim(deploymentId: string): Promise<ReadBrokerDeployment>;
  /** Operator-authorized RuntimeLaunchService adapter, with normal namespace caps. */
  launch(sandboxId: string, request: RuntimeLaunchRequest): Promise<RuntimeBootstrap>;
  /** Persist sanitized receipt; never bootstrap/token. */
  record(deploymentId: string, grantId: string, receipt: RuntimeBootstrap): Promise<void>;
  /** Persist a safe failure marker; claimed deployment remains unusable even if this write fails. */
  failed(deploymentId: string, grantId: string | undefined, revoked: boolean): Promise<void>;
}

/** Not registered as a route/tool. A new operation is required after an uncertain attempt. */
export async function provisionReadBroker(
  broker: SessionReadBroker,
  provisioning: ReadBrokerProvisioning,
  deploymentId: string,
): Promise<{ grantId: string; launchId: string; jobId: string }> {
  let grantId: string | undefined;
  let claimed = false;
  try {
    const deployment = await provisioning.claim(deploymentId);
    claimed = true;
    const { binding, operationKey, releaseId, ttlSeconds } = deployment;
    const ids = launchIds(binding.namespace, operationKey);
    const issued = await broker.issue({ ...binding, ...ids }, ttlSeconds);
    grantId = issued.grantId;
    const bootstrap = new SecretString(
      JSON.stringify({
        version: 1,
        releaseId,
        grantId,
        token: issued.token,
        expiresAt: issued.expiresAt,
        peer: {
          namespace: binding.namespace,
          sandboxId: binding.sandboxId,
          ...ids,
          role: binding.role,
        },
      }),
    );
    const receipt = await provisioning.launch(binding.sandboxId, {
      operation_key: operationKey,
      release_id: releaseId,
      bootstrap,
      ttl_seconds: ttlSeconds,
    });
    if (
      receipt.namespace !== binding.namespace ||
      receipt.sandbox_id !== binding.sandboxId ||
      receipt.launch_id !== ids.launchId ||
      receipt.job_id !== ids.jobId ||
      receipt.release_id !== releaseId ||
      receipt.operation_key !== operationKey ||
      receipt.delivery_state !== 'launched' ||
      receipt.state !== 'pending'
    )
      throw new Error('unconfirmed runtime delivery');
    await provisioning.record(deploymentId, grantId, {
      namespace: binding.namespace,
      sandbox_id: binding.sandboxId,
      launch_id: ids.launchId,
      job_id: ids.jobId,
      operation_key: operationKey,
      release_id: releaseId,
      // Only bounded, valid timestamps from the transport may enter persisted diagnostics.
      created_at: Instant.fromMicros(receipt.created_at.micros),
      expires_at: Instant.fromMicros(receipt.expires_at.micros),
      state: 'pending',
      delivery_state: 'launched',
    });
    return { grantId, ...ids };
  } catch {
    // An uncertain receiver may have started: revoke its read authority, never relaunch blindly.
    let revoked = !grantId;
    try {
      if (grantId) await broker.revoke(grantId);
      revoked = true;
    } catch {
      /* No raw upstream error. */
    }
    try {
      if (claimed) await provisioning.failed(deploymentId, grantId, revoked);
    } catch {
      /* Claim remains fenced. */
    }
    throw new MervError(
      'read_broker_provision_denied',
      'Public authority runtime provisioning was refused',
      403,
    );
  }
}

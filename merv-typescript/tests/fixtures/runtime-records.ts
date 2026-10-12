import { Instant, OfferSchema } from '@sandboxes/kernel';
import type { SandboxRecord } from '@sandboxes/registry';
import type { RuntimeBootstrap } from '@sandboxes/runtimes';
import type { RuntimeLauncher } from '@sandboxes/runtimes/launcher';
import type { FakeRuntimes } from './runtimes.js';
import type { FleetMachine, FleetRuntimeHandle, FleetRuntimeLaunch } from '@merv/fleet/types';
import { sha256Hex } from '@merv/contracts';

export const profiles = [
  {
    key: 'standard',
    provider: 'fake',
    offerId: 'standard',
    releaseId: `rt1_${'a'.repeat(64)}`,
    leaseSeconds: 600,
  },
  {
    key: 'large',
    provider: 'fake',
    offerId: 'large',
    releaseId: `rt1_${'b'.repeat(64)}`,
    leaseSeconds: 600,
  },
];
export const createKey = (projectId: string, key: string) =>
  `runtime:${sha256Hex(JSON.stringify([projectId, key]))}`;
export function sandbox(handle: FleetRuntimeHandle): SandboxRecord {
  return {
    id: handle.sandboxId,
    state: handle.state,
    revision: handle.revision,
    access_mode: 'tunnel',
    agent_connected_at: handle.ready ? Instant.fromMillis(Date.now()) : null,
    lease_expires_at: handle.leaseExpiresAt ? Instant.parseIso(handle.leaseExpiresAt) : null,
  } as SandboxRecord;
}
export function receipt(launch: FleetRuntimeLaunch): RuntimeBootstrap {
  return {
    namespace: 'test',
    sandbox_id: 'sandbox',
    launch_id: launch.launchId,
    operation_key: 'operation',
    release_id: profiles[0].releaseId,
    job_id: launch.jobId,
    state: launch.state,
    delivery_state: launch.deliveryState,
    created_at: Instant.fromMillis(Date.now()),
    expires_at: Instant.parseIso('2099-01-01T00:00:00Z'),
  };
}
export function offer(machine: FleetMachine | null) {
  return OfferSchema.parse({
    provider: 'fake',
    plugin: 'fake',
    offer_id: machine?.key ?? 'missing',
    instance_type: 'fake',
    region: 'test',
    description: `${machine?.vcpu ?? 1} vCPU`,
    resources: {
      cpu: Math.ceil(machine?.vcpu ?? 1),
      memory_mb: (machine?.memoryGiB ?? 1) * 1024,
      disk_gb: machine?.diskGB ?? 1,
    },
    hourly_price: machine ? { currency: 'USD', amount: String(machine.maxHourlyUsd) } : null,
  });
}

export const link = (projectId: string) => ({
  namespace: projectId,
  account_id: 'account',
  member_id: 'payer',
});
export function launcher(
  fake: Pick<
    FakeRuntimes,
    'describe' | 'provision' | 'inspect' | 'launch' | 'acknowledge' | 'stop' | 'renew'
  >,
  projectId: string,
): RuntimeLauncher {
  const handle = (sandboxId: string) => ({ sandboxId }) as FleetRuntimeHandle;
  return {
    describe: async (_provider, offerId) => offer(await fake.describe(projectId, offerId)),
    provision: async (input) => sandbox(await fake.provision(projectId, input.operationKey)),
    inspect: async (id, launchId) => {
      const h = await fake.inspect(projectId, handle(id));
      return { sandbox: sandbox(h), launch: launchId && h.launch ? receipt(h.launch) : null };
    },
    launch: async (id, input) =>
      receipt(
        (
          await fake.launch(
            projectId,
            handle(id),
            input.operation_key,
            input.bootstrap.getSecretValue(),
          )
        ).launch!,
      ),
    acknowledge: async (id) => receipt((await fake.acknowledge(projectId, handle(id))).launch!),
    stop: async (id) => sandbox(await fake.stop(projectId, handle(id))),
    renew: async (id) => sandbox(await fake.renew(projectId, handle(id))),
  };
}

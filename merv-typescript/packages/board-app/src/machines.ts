import { Instant, OfferSchema } from '@sandboxes/kernel';
import type { SbxMerv } from '@sandboxes/merv-host';
import type { RuntimeBootstrap } from '@sandboxes/runtimes';
import type { RuntimeLauncher } from '@sandboxes/runtimes/launcher';
import type { SandboxRecord } from '@sandboxes/registry';
import { runPiWorker } from '@merv/pi/worker';

/** What Fleet rents here: one kind of machine, which is this process. */
export const profiles = [
  {
    key: 'standard',
    provider: 'here',
    offerId: 'standard',
    releaseId: `rt1_${'0'.repeat(64)}`,
    leaseSeconds: 3600,
  },
];
const FOREVER = '2099-01-01T00:00:00Z';

interface Machine {
  id: string;
  operation: string;
  state: 'ready' | 'stopped';
  revision: number;
  /** The worker running here, and what Fleet was told of its launch. */
  worker?: AbortController;
  launch?: { id: string; state: 'pending' | 'consumed' };
}

/**
 * Pi's machines without Sandboxes: Fleet rents by asking this class, and a machine is a worker in
 * this process. A worker only waits on the model and on this server, and its profile has no
 * terminal, so nothing it does needs a machine of its own. Turns run under the person's permissions
 * as they do on a rented machine. `fetchImpl` answers the worker's calls: the demo's scripted model
 * goes there.
 */
export class HereMachines {
  fetchImpl: typeof fetch = fetch;
  private readonly machines = new Map<string, Machine>();
  linked = async (projectId: string) => ({
    namespace: projectId,
    account_id: 'here',
    member_id: 'here',
  });
  runtimes = (): RuntimeLauncher => ({
    describe: async () =>
      OfferSchema.parse({
        provider: 'here',
        plugin: 'here',
        offer_id: 'standard',
        instance_type: 'here',
        region: 'here',
        description: '1 vCPU',
        resources: { cpu: 1, memory_mb: 1024, disk_gb: 1 },
        hourly_price: { currency: 'USD', amount: '0' },
      }),
    provision: async ({ operationKey }) => {
      const known = [...this.machines.values()].find((m) => m.operation === operationKey);
      const machine = known ?? {
        id: `sbx_${this.machines.size + 1}`,
        operation: operationKey,
        state: 'ready' as const,
        revision: 1,
      };
      this.machines.set(machine.id, machine);
      return record(machine);
    },
    inspect: async (id, launchId) => {
      const machine = this.machine(id);
      return { sandbox: record(machine), launch: launchId ? receipt(machine) : null };
    },
    launch: async (id, input) => {
      const machine = this.machine(id);
      if (!machine.worker) {
        machine.worker = new AbortController();
        machine.launch = { id: `rln_${machine.id}`, state: 'pending' };
        void runPiWorker(JSON.parse(input.bootstrap.getSecretValue()), {
          signal: machine.worker.signal,
          fetchImpl: (...call) => this.fetchImpl(...call),
        }).catch(() => undefined);
      }
      return receipt(machine)!;
    },
    acknowledge: async (id) => {
      const machine = this.machine(id);
      machine.launch!.state = 'consumed';
      return receipt(machine)!;
    },
    stop: async (id) => {
      const machine = this.machine(id);
      machine.worker?.abort();
      machine.state = 'stopped';
      machine.revision++;
      return record(machine);
    },
    renew: async (id) => record(this.machine(id)),
  });
  private machine(id: string) {
    const machine = this.machines.get(id);
    if (!machine) throw new Error('This machine is gone');
    return machine;
  }
  close() {
    for (const { worker } of this.machines.values()) worker?.abort();
  }
}

const record = (machine: Machine) =>
  ({
    id: machine.id,
    state: machine.state,
    revision: machine.revision,
    access_mode: 'tunnel',
    agent_connected_at: machine.state === 'ready' ? Instant.fromMillis(Date.now()) : null,
    lease_expires_at: Instant.parseIso(FOREVER),
  }) as SandboxRecord;

const receipt = ({ id, launch }: Machine): RuntimeBootstrap | null =>
  launch
    ? {
        namespace: 'here',
        sandbox_id: id,
        launch_id: launch.id,
        operation_key: 'here',
        release_id: profiles[0]!.releaseId,
        job_id: `job_${id}`,
        state: launch.state,
        delivery_state: 'launched',
        created_at: Instant.fromMillis(Date.now()),
        expires_at: Instant.parseIso(FOREVER),
      }
    : null;

export type { SbxMerv };

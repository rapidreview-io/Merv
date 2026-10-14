import assert from 'node:assert/strict';
import type { FleetRuntimeHandle, FleetMachine } from '@merv/fleet/types';
import { link, launcher } from './runtime-records.js';

/** Offers as Sandboxes describes Cloudflare standard-1 and standard-3. */
export const offers: Record<string, FleetMachine | null> = {
  standard: { key: 'standard', vcpu: 0.5, memoryGiB: 4, diskGB: 8, maxHourlyUsd: 0.074 },
  large: { key: 'large', vcpu: 2, memoryGiB: 8, diskGB: 16, maxHourlyUsd: 0.22 },
};

export class FakeRuntimes {
  linked = async (projectId: string) => (this.connected(projectId) ? link(projectId) : null);
  runtimes = ({ projectId }: { projectId: string }) => launcher(this, projectId);

  describe = async (_projectId: string, key: string) => offers[key] ?? null;
  connected: (projectId: string) => boolean = () => true;
  readonly handles = new Map<string, FleetRuntimeHandle>();
  readonly launched: string[] = [];
  readonly stopped: string[] = [];
  /** How many of the next machines made never become ready: their agent never connects. */
  stuck = 0;

  private find(sandboxId: string): FleetRuntimeHandle {
    const handle = [...this.handles.values()].find((item) => item.sandboxId === sandboxId);
    assert.ok(handle);
    return handle;
  }
  async provision(_projectId: string, key: string): Promise<FleetRuntimeHandle> {
    let handle = this.handles.get(key);
    if (!handle) {
      const ready = !this.stuck || !this.stuck--;
      handle = {
        sandboxId: `sbx_${this.handles.size + 1}`,
        state: ready ? 'ready' : 'provisioning',
        ready,
        leaseExpiresAt: '2099-01-01T00:00:00Z',
        revision: 1,
        launch: null,
      };
      this.handles.set(key, handle);
    }
    return structuredClone(handle);
  }
  async inspect(_projectId: string, current: FleetRuntimeHandle): Promise<FleetRuntimeHandle> {
    return structuredClone(this.find(current.sandboxId));
  }
  async launch(
    _projectId: string,
    current: FleetRuntimeHandle,
    key: string,
    _bootstrap?: string,
  ): Promise<FleetRuntimeHandle> {
    const handle = this.find(current.sandboxId);
    this.launched.push(key);
    handle.launch ??= {
      launchId: `rln_${handle.sandboxId}`,
      jobId: `job_${handle.sandboxId}`,
      state: 'pending',
      deliveryState: 'launched',
    };
    return structuredClone(handle);
  }
  async acknowledge(_projectId: string, current: FleetRuntimeHandle): Promise<FleetRuntimeHandle> {
    const handle = this.find(current.sandboxId);
    assert.ok(handle.launch);
    handle.launch.state = 'consumed';
    return structuredClone(handle);
  }
  async stop(_projectId: string, current: FleetRuntimeHandle): Promise<FleetRuntimeHandle> {
    const handle = this.find(current.sandboxId);
    this.stopped.push(handle.sandboxId);
    handle.state = 'deleting';
    handle.ready = false;
    handle.revision++;
    return structuredClone(handle);
  }
  async renew(_projectId: string, current: FleetRuntimeHandle) {
    return this.inspect(_projectId, current);
  }
  release(sandboxId: string) {
    const handle = this.find(sandboxId);
    handle.state = 'stopped';
    handle.ready = false;
    handle.revision++;
  }
}

import assert from 'node:assert/strict';
import type { SandboxRuntimeHandle, SandboxRuntimes } from '@merv/sandboxes';

/** Offers as Sandboxes describes Cloudflare standard-1 and standard-3. */
export const offers: Record<string, Awaited<ReturnType<SandboxRuntimes['describe']>>> = {
  standard: { key: 'standard', vcpu: 0.5, memoryGiB: 4, diskGB: 8, maxHourlyUsd: 0.074 },
  large: { key: 'large', vcpu: 2, memoryGiB: 8, diskGB: 16, maxHourlyUsd: 0.22 },
};

export class FakeRuntimes implements SandboxRuntimes {
  profileId = 'pi-test-profile';
  leaseSeconds = 600;
  get profiles() {
    return [
      { key: 'standard', id: this.profileId, leaseSeconds: this.leaseSeconds },
      { key: 'large', id: 'pi-test-large', leaseSeconds: this.leaseSeconds },
    ];
  }
  describe = async (_projectId: string, key: string) => offers[key] ?? null;
  connected: (projectId: string) => boolean = () => true;
  readonly handles = new Map<string, SandboxRuntimeHandle>();
  readonly launched: string[] = [];
  readonly stopped: string[] = [];

  private find(sandboxId: string): SandboxRuntimeHandle {
    const handle = [...this.handles.values()].find((item) => item.sandboxId === sandboxId);
    assert.ok(handle);
    return handle;
  }
  async provision(_projectId: string, key: string): Promise<SandboxRuntimeHandle> {
    let handle = this.handles.get(key);
    if (!handle) {
      handle = {
        sandboxId: `sbx_${this.handles.size + 1}`,
        state: 'ready',
        ready: true,
        deleted: false,
        leaseExpiresAt: '2099-01-01T00:00:00Z',
        revision: 1,
        launch: null,
      };
      this.handles.set(key, handle);
    }
    return structuredClone(handle);
  }
  async inspect(_projectId: string, current: SandboxRuntimeHandle): Promise<SandboxRuntimeHandle> {
    return structuredClone(this.find(current.sandboxId));
  }
  async launch(
    _projectId: string,
    current: SandboxRuntimeHandle,
    key: string,
  ): Promise<SandboxRuntimeHandle> {
    const handle = this.find(current.sandboxId);
    this.launched.push(key);
    handle.launch ??= {
      sandboxId: handle.sandboxId,
      launchId: `rln_${handle.sandboxId}`,
      operationKey: key,
      releaseId: 'pi-test-release',
      jobId: `job_${handle.sandboxId}`,
      state: 'pending',
      deliveryState: 'launched',
      expiresAt: '2099-01-01T00:00:00Z',
    };
    return structuredClone(handle);
  }
  async acknowledge(
    _projectId: string,
    current: SandboxRuntimeHandle,
  ): Promise<SandboxRuntimeHandle> {
    const handle = this.find(current.sandboxId);
    assert.ok(handle.launch);
    handle.launch.state = 'consumed';
    return structuredClone(handle);
  }
  async stop(_projectId: string, current: SandboxRuntimeHandle): Promise<SandboxRuntimeHandle> {
    const handle = this.find(current.sandboxId);
    this.stopped.push(handle.sandboxId);
    handle.state = 'deleting';
    handle.ready = false;
    handle.revision++;
    return structuredClone(handle);
  }
  async renew(_projectId: string, current: SandboxRuntimeHandle) {
    return this.inspect(_projectId, current);
  }
  release(sandboxId: string) {
    const handle = this.find(sandboxId);
    handle.state = 'stopped';
    handle.deleted = true;
    handle.ready = false;
    handle.revision++;
  }
}

import type { Context } from 'cordis';
import { z } from 'zod';
import { check, MervError } from '@merv/contracts';
import type { Tools } from '@merv/api/types';
import type { CredentialProvider } from '@merv/credentials/types';
import type { AccessPolicy } from '@merv/access/types';
import type { MountConfig, Mounts, MountsConfig, MountStatus } from './types.js';
import { MountRuntime } from './runtime.js';

export type { MountConfig, Mounts, MountsConfig, MountStatus } from './types.js';

const exactId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const mountSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    url: z.string().refine((value) => {
      try {
        const url = new URL(value);
        return (
          ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash
        );
      } catch {
        return false;
      }
    }, 'Mount endpoint must be HTTP(S) without user information or a fragment'),
    tools: z
      .array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/))
      .min(1)
      .max(100)
      .refine((tools) => new Set(tools).size === tools.length, 'Selected tools must be distinct'),
    discovery: z.object({ actorId: exactId, projectId: exactId }).strict().optional(),
    timeoutMs: z.number().int().min(25).max(60000).optional(),
    reconnectMs: z.number().int().min(25).max(60000).optional(),
  })
  .strict();
const configuration = z
  .object({ mounts: z.array(mountSchema).default([]) })
  .strict()
  .refine(
    (config) => new Set(config.mounts.map((mount) => mount.id)).size === config.mounts.length,
    'Mount IDs must be distinct',
  )
  .default({ mounts: [] });

/** Optional connections own their catalogs and never alter native component admission. */
export class MountManager implements Mounts {
  private readonly runtimes = new Map<string, MountRuntime>();
  private stopping = false;
  private closing?: Promise<void>;

  constructor(
    tools: Tools,
    credentials: CredentialProvider,
    access: AccessPolicy,
    config: MountsConfig = { mounts: [] },
  ) {
    const parsed = configuration.safeParse(config);
    check(parsed.success, 'invalid_mount_config', 'Mount configuration is invalid');
    try {
      for (const mount of parsed.data.mounts)
        this.runtimes.set(mount.id, new MountRuntime(tools, credentials, access, mount));
    } catch {
      // Constructor allocations contain no admitted calls, but release every acquired namespace.
      for (const runtime of this.runtimes.values()) void runtime.stop().catch(() => undefined);
      throw new MervError('invalid_mount_config', 'A configured mount namespace is unavailable');
    }
  }

  async start(): Promise<void> {
    await Promise.allSettled([...this.runtimes.values()].map((runtime) => runtime.refresh(true)));
  }
  status(): MountStatus[] {
    return [...this.runtimes.values()]
      .map((runtime) => runtime.status())
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  reconnect(id: string): Promise<void> {
    if (this.stopping)
      return Promise.reject(new MervError('mounts_stopped', 'Mounts are stopped', 503));
    const runtime = this.runtimes.get(id);
    if (!runtime)
      return Promise.reject(new MervError('mount_not_found', 'Mount is not configured', 404));
    return runtime.refresh(true);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopping = true;
    // Each stop performs withdrawal synchronously before its first await. Start all of them now.
    const stopped = [...this.runtimes.values()].map((runtime) => runtime.stop());
    this.closing = Promise.allSettled(stopped).then((results) => {
      if (results.some((result) => result.status === 'rejected'))
        throw new MervError('mount_cleanup_failed', 'Mount resource cleanup failed', 503);
    });
    return this.closing;
  }
}

export const mountsPlugin = {
  name: 'merv-mounts',
  Config: configuration,
  inject: ['tools', 'credentials', 'access'],
  async apply(ctx: Context, config: MountsConfig = { mounts: [] }) {
    const manager = new MountManager(ctx.tools, ctx.credentials, ctx.access, config);
    // Keep catalog withdrawal independent of consumers draining the public status service.
    ctx.effect(() => () => manager.close());
    ctx.provide('mounts', manager);
    await manager.start();
  },
};
export default mountsPlugin;

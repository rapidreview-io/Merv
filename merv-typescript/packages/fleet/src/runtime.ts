import { z } from 'zod';
import { sha256Hex } from '@merv/contracts';
import type { Offer } from '@sandboxes/kernel';
import type { SandboxRecord } from '@sandboxes/registry';
import type { RuntimeBootstrap } from '@sandboxes/runtimes';
import type { FleetMachine, FleetRuntimeHandle, FleetRuntimeLaunch } from './types.js';

export const runtimeProfiles = z
  .array(
    z
      .object({
        key: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
        provider: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
        offerId: z.string().min(1).max(256),
        releaseId: z.string().regex(/^rt1_[0-9a-f]{64}$/),
        leaseSeconds: z.number().int().min(60).max(86_400),
        ttlSeconds: z.number().int().min(1).max(3600).default(300),
      })
      .strict(),
  )
  .min(1)
  .max(8)
  .refine((all) => new Set(all.map((p) => p.key)).size === all.length, 'Profile keys repeat');

export function runtimeProfileId(profile: z.output<typeof runtimeProfiles>[number]): string {
  return `srp_${sha256Hex(
    JSON.stringify([
      profile.provider,
      profile.offerId,
      profile.releaseId,
      profile.leaseSeconds,
      profile.ttlSeconds,
    ]),
  )}`;
}

export function runtimeLaunch(row: RuntimeBootstrap): FleetRuntimeLaunch {
  return {
    launchId: row.launch_id,
    jobId: row.job_id,
    state: row.state as FleetRuntimeLaunch['state'],
    deliveryState: row.delivery_state as FleetRuntimeLaunch['deliveryState'],
  };
}

export function runtimeHandle(
  row: SandboxRecord,
  launch: FleetRuntimeLaunch | null,
  now: number,
): FleetRuntimeHandle {
  const leaseExpiresAt = row.lease_expires_at?.toJSON() ?? null;
  const access =
    row.access_mode === 'tunnel' ? row.agent_connected_at !== null : row.endpoint !== null;
  return {
    sandboxId: row.id,
    state: row.state,
    ready:
      row.state === 'ready' &&
      access &&
      (leaseExpiresAt === null || Date.parse(leaseExpiresAt) > now),
    leaseExpiresAt,
    revision: row.revision,
    launch,
  };
}

export function runtimeOffer(key: string, offer: Offer): FleetMachine | null {
  const { resources, hourly_price: price } = offer;
  if (price?.currency !== 'USD' || !resources.cpu || !resources.memory_mb || !resources.disk_gb)
    return null;
  return {
    key,
    vcpu: Number(/^(\d+(?:\.\d+)?) vCPU\b/.exec(offer.description)?.[1] ?? resources.cpu),
    memoryGiB: resources.memory_mb / 1024,
    diskGB: resources.disk_gb,
    maxHourlyUsd: Number(price.amount),
  };
}

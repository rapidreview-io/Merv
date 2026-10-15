import type { MountHandler } from '@merv/api/types';
import type { RequestRecord } from './store.js';

/**
 * TODO(cx3 merge): placeholder until the identity binding module lands. The real
 * requireCustomer also verifies X-Merv-Identity against the request's bound identity. This stub
 * checks nothing beyond the customer capability its caller already authorized.
 */
export async function requireCustomer(
  _record: RequestRecord,
  _req: Parameters<MountHandler>[0],
): Promise<void> {}

import type { RequestRecord } from './store.js';

/** TODO(cx3 merge): stub until the identity piece lands. The caller has already authorised the
 *  customer capability for `record`; the real check also verifies X-Merv-Identity against the
 *  request's bound identity. */
export async function requireCustomer(
  record: RequestRecord,
  req: { headers: Record<string, string | string[] | undefined> },
): Promise<void> {
  void record;
  void req;
}

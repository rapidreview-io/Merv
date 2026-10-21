import { timingSafeEqual, createHash } from 'node:crypto';
import { MervError } from './index.js';

/** Immutable process policy. Changing it requires a restart, never a dispatch-setting write. */
export function readBootMaintenance(env: NodeJS.ProcessEnv) {
  const value = env.MERV_BOOT_MAINTENANCE;
  if (value !== undefined && value !== '0' && value !== '1')
    throw new MervError('invalid_config', 'MERV_BOOT_MAINTENANCE must be 0 or 1');
  const active = value === '1';
  const token = env.MERV_MAINTENANCE_OPERATOR_TOKEN;
  if (token !== undefined && token.length < 32)
    throw new MervError(
      'invalid_config',
      'Maintenance operator token must contain at least 32 characters',
    );
  const hash = (s: string) => createHash('sha256').update(s).digest();
  return Object.freeze({
    active,
    operator(header: string | string[] | undefined): boolean {
      return (
        active &&
        !!token &&
        typeof header === 'string' &&
        timingSafeEqual(hash(header), hash(token))
      );
    },
  });
}

// Read before plugins or stored secret overrides load; no HTTP or tool can change this policy.
export const bootMaintenance = readBootMaintenance(process.env);
export function maintenanceRefusal(): never {
  throw new MervError('maintenance', 'Merv is in maintenance; this request did not run', 503);
}
export function maintenancePublicRead(method: string | undefined, path: string): boolean {
  return (
    method === 'GET' && (path === '/health' || path === '/ui/' || path.startsWith('/ui/assets/'))
  );
}

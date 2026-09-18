import { check } from '@merv/contracts';

/** A future canonical UTC timestamp (YYYY-MM-DDTHH:MM:SS.sssZ) or null for no expiry. */
export function expiry(value: string | null | undefined, time: string): string | null {
  if (value === undefined || value === null) return null;
  check(
    typeof value === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value &&
      value > time,
    'invalid_expiry',
    'Expiry must be a future canonical UTC timestamp (YYYY-MM-DDTHH:MM:SS.sssZ) or null',
  );
  return value;
}

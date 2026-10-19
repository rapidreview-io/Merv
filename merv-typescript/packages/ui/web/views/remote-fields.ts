import { stamp } from '../components';

/**
 * Reading a remote row's data. The service's JSON arrives as-is, so every fact
 * is reached by the dot path the manifest named and a missing field renders
 * nothing — never a zero, never a placeholder.
 */
export type Json = Record<string, unknown>;

/** One dot path into the row a read returned. */
export function at(data: Json | undefined, path: string | undefined | null): unknown {
  if (!data || !path) return undefined;
  let value: unknown = data;
  for (const step of path.split('.')) {
    if (!value || typeof value !== 'object') return undefined;
    value = (value as Json)[step];
  }
  return value ?? undefined;
}

export const str = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : '';
export const list = (value: unknown): Json[] =>
  Array.isArray(value) ? value.filter((item) => !!item && typeof item === 'object') : [];

/** The list a read returned: an array of records, or the one array an object wraps them in. */
export const records = (data: unknown): Json[] => {
  if (Array.isArray(data)) return list(data);
  if (data && typeof data === 'object')
    for (const value of Object.values(data as Json)) if (Array.isArray(value)) return list(value);
  return [];
};

/** A detail's value: an instant as a stamp, anything else as the service sent it. */
export const unit = (value: unknown, kind?: 'instant'): string =>
  kind === 'instant' && str(value) ? stamp(str(value)) : str(value);

/**
 * What it has cost so far — against its cap, where it has one — over what it costs per
 * hour, and the one word for a rate of zero: `$2.10 of $8.00 · $2.49/h`, or `free`.
 */
export function formatMoney(
  total: number | undefined,
  rate: number | undefined,
  currency = 'USD',
  of?: number,
): string {
  if (rate === 0 && !total) return 'free';
  // Sub-cent rates are real on metered compute, and rounding one to a cent overstates it; an
  // amount is in cents, and one under a cent says so: `<$0.01`.
  const cash = (value: number, cents = true): string =>
    cents && value > 0 && value < 0.01
      ? `<${cash(0.01)}`
      : value.toLocaleString('en-US', {
          style: 'currency',
          currency,
          minimumFractionDigits: 2,
          maximumFractionDigits: !cents && value && Math.abs(value) < 0.1 ? 3 : 2,
        });
  return [
    total !== undefined && `${cash(total)}${of === undefined ? '' : ` of ${cash(of)}`}`,
    rate !== undefined && `${cash(rate, false)}/h`,
  ]
    .filter(Boolean)
    .join(' · ');
}
/** Dollars as every page states them (`formatMoney`), whole ones without their cents. */
export const usd = (value: string | number) =>
  formatMoney(Number(value), undefined).replace(/\.00$/, '');

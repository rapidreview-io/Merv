import type { UiColumn, UiPhrasePart } from '@merv/contracts/ui-manifest';
import { stamp } from '../components';
import { elapsed } from '../liveness';
import { bytes } from './artifacts';

/**
 * Reading a remote row's data. The service's JSON arrives as-is, so every fact
 * is reached by the dot path the manifest named and a missing field renders
 * nothing — never a zero, never a placeholder. Units are the service's; the
 * words for them are ours, and they are written in exactly one place.
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
/** A number, including the decimal strings money arrives as ("0.007"); null and NaN are absent. */
export const num = (value: unknown): number | undefined => {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : undefined;
};
export const list = (value: unknown): Json[] =>
  Array.isArray(value) ? value.filter((item) => !!item && typeof item === 'object') : [];

/** The list a read returned: an array of records, or the one array an object wraps them in. */
export const records = (data: unknown): Json[] => {
  if (Array.isArray(data)) return list(data);
  if (data && typeof data === 'object')
    for (const value of Object.values(data as Json)) if (Array.isArray(value)) return list(value);
  return [];
};

export type Unit = 'bytes' | 'mib' | 'gb' | 'count' | 'seconds' | 'instant';

const UNITS: Record<string, (measure: number) => string> = {
  bytes,
  mib: (measure) => (measure >= 1024 ? `${(measure / 1024).toFixed(1)} GB` : `${measure} MiB`),
  gb: (measure) => `${measure} GB`,
  count: (measure) => `${measure}×`,
  seconds: (measure) => elapsed(measure * 1000),
};

/** A number in the unit the service sent it in, read the way a person says it. */
export function unit(value: unknown, kind?: Unit): string {
  if (kind === 'instant') return str(value) ? stamp(str(value)) : '';
  const measure = num(value);
  if (measure === undefined) return str(value);
  return (kind && UNITS[kind])?.(measure) ?? String(measure);
}

/** One phrase from several fields — hardware, location — with absent parts skipped. */
export const phrase = (data: Json, parts: UiPhrasePart[], separator = ' · ') =>
  parts
    .map((part) => {
      if (typeof part === 'string') return part;
      const value = at(data, part.field);
      if (value === undefined || value === '') return '';
      return `${part.prefix ?? ''}${unit(value, part.unit)}${part.suffix ?? ''}`;
    })
    .filter(Boolean)
    .join(separator);

const SYMBOL: Record<string, string> = { USD: '$', EUR: '€', GBP: '£' };

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
  // Sub-cent rates are real on metered compute, and rounding one to a cent overstates it.
  const cash = (value: number) =>
    `${SYMBOL[currency] ?? `${currency} `}${value.toFixed(value && value < 0.1 ? 3 : 2)}`;
  return [
    total !== undefined && `${cash(total)}${of === undefined ? '' : ` of ${cash(of)}`}`,
    rate !== undefined && `${cash(rate)}/h`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** A remote row's money column, read through the same words. */
export const money = (data: Json, column: Extract<UiColumn, { type: 'money' }>): string =>
  formatMoney(num(at(data, column.total)), num(at(data, column.rate)), column.currency ?? 'USD');

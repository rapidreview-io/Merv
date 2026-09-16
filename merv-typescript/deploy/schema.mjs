/** Restrict deployment schemas to Merv's isolated namespace, never public/pg_catalog. */
export function deploymentSchema(value = process.env.MERV_TS_DB_SCHEMA ?? 'merv_ts') {
  if (!/^merv_ts(?:_[A-Za-z0-9_]+)?$/.test(value) || value.length > 63) {
    throw new Error('Invalid MERV_TS_DB_SCHEMA');
  }
  return value;
}

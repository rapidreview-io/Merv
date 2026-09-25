/** Restrict deployment schemas to Merv's isolated namespace, never public/pg_catalog. */
export function deploymentSchema(value = process.env.MERV_TS_DB_SCHEMA ?? 'merv_ts') {
  if (!/^merv_ts(?:_[A-Za-z0-9_]+)?$/.test(value) || value.length > 63) {
    throw new Error('Invalid MERV_TS_DB_SCHEMA');
  }
  return value;
}

/**
 * One sandbox connection per project, as a JSON array of { projectId, namespace, tokenEnv }.
 * `tokenEnv` names the environment variable holding that project's `sbxt_` consumer grant: a
 * literal grant is refused here as well as by the plugin, so deployment configuration — which
 * is written to a file and checksummed — can never carry one. The named variable must hold a
 * grant of the plugin's shape now, not fail the first send after a healthy start.
 */
export function sandboxConnections(value = process.env.MERV_SANDBOXES_CONNECTIONS) {
  let entries;
  try {
    entries = JSON.parse(value ?? '');
  } catch {
    throw new Error('MERV_SANDBOXES_CONNECTIONS must be a JSON array');
  }
  if (!Array.isArray(entries) || !entries.length || entries.length > 256) {
    throw new Error('MERV_SANDBOXES_CONNECTIONS must hold 1-256 connections');
  }
  const connections = entries.map((entry) => {
    const { projectId, namespace, tokenEnv, ...rest } = entry ?? {};
    if (
      Object.keys(rest).length ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(projectId ?? '') ||
      !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(namespace ?? '') ||
      !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(tokenEnv ?? '')
    ) {
      throw new Error('Invalid MERV_SANDBOXES_CONNECTIONS entry');
    }
    if (!/^sbxt_[A-Za-z0-9_-]{4,512}$/.test(process.env[tokenEnv] ?? '')) {
      throw new Error(`Missing or invalid ${tokenEnv}`);
    }
    return { projectId, namespace, tokenEnv };
  });
  if (new Set(connections.map((entry) => entry.projectId)).size !== connections.length) {
    throw new Error('Each project has at most one sandbox connection');
  }
  return connections;
}

/**
 * The machines Fleet may rent, the default first, as entries of
 * { key, label, slots, agent?, provider, offerId, releaseId, leaseSeconds, ttlSeconds? }. Each is
 * one Sandboxes runtime profile and one machine a person may run Pi on: `label` is what the picker
 * shows, `slots` how many turns share it at once, `agent` whether the agent may move itself there.
 * `name` is the variable the entries came from, for the error.
 */
export function fleetRuntimes(entries, name) {
  const text = (value, pattern) => typeof value === 'string' && pattern.test(value);
  const whole = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
  if (!Array.isArray(entries) || !entries.length || entries.length > 8) {
    throw new Error(`${name} must hold 1-8 machines`);
  }
  const runtimes = entries.map((entry) => {
    const {
      key,
      label,
      slots,
      agent = false,
      provider,
      offerId,
      releaseId,
      leaseSeconds,
      ttlSeconds,
      ...rest
    } = entry ?? {};
    if (
      Object.keys(rest).length ||
      !text(key, /^[a-z][a-z0-9-]{0,31}$/) ||
      !text(label, /^\S(?:.{0,38}\S)?$/) ||
      !whole(slots, 1, 8) ||
      typeof agent !== 'boolean' ||
      !text(provider, /^[a-z][a-z0-9_-]{0,63}$/) ||
      !text(offerId, /^.{1,256}$/) ||
      !text(releaseId, /^rt1_[0-9a-f]{64}$/) ||
      !whole(leaseSeconds, 60, 86_400) ||
      (ttlSeconds !== undefined && !whole(ttlSeconds, 1, 3600))
    ) {
      throw new Error(`Invalid ${name} entry`);
    }
    return { key, label, slots, agent, provider, offerId, releaseId, leaseSeconds, ttlSeconds };
  });
  if (new Set(runtimes.map((entry) => entry.key)).size !== runtimes.length) {
    throw new Error(`${name} repeats a machine key`);
  }
  return runtimes;
}

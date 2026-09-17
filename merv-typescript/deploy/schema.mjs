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
 * is written to a file and checksummed — can never carry one.
 */
export function sandboxConnections(value = process.env.MERV_SANDBOXES_CONNECTIONS) {
  let entries;
  try {
    entries = JSON.parse(value ?? '');
  } catch {
    throw new Error('MERV_SANDBOXES_CONNECTIONS must be a JSON array');
  }
  if (!Array.isArray(entries) || !entries.length || entries.length > 32) {
    throw new Error('MERV_SANDBOXES_CONNECTIONS must hold 1-32 connections');
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
    return { projectId, namespace, tokenEnv };
  });
  if (new Set(connections.map((entry) => entry.projectId)).size !== connections.length) {
    throw new Error('Each project has at most one sandbox connection');
  }
  return connections;
}

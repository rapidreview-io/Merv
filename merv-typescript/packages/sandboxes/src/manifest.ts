import { check, uiManifestSchema, type UiManifestRow } from '@merv/contracts';

/**
 * The tools this package ships. A control the manifest binds to anything else is dropped
 * before the row reaches the registry: the browser never renders what it cannot dispatch.
 */
export const sandboxTools = ['sandbox.extend', 'sandbox.release'];

/**
 * The service writes an unavailable value as JSON null, so a null in the manifest means the
 * same as an absent key and is dropped before validation. Row data keeps its nulls: there an
 * absent field renders nothing, which is exactly what null means.
 */
function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== null)
      .map(([key, entry]) => [key, withoutNulls(entry)]),
  );
}

/**
 * Validate a published manifest against the contract (`@merv/contracts/ui-manifest`) and drop
 * every control bound to a tool this package does not ship: an act control the browser cannot
 * dispatch must never be rendered at all.
 */
export function parseManifest(value: unknown): UiManifestRow[] {
  const parsed = uiManifestSchema.safeParse(withoutNulls(value));
  const reason = parsed.success ? '' : (parsed.error.issues[0]?.message ?? 'invalid manifest');
  check(
    parsed.success,
    'invalid_sandbox_manifest',
    `The published manifest is not one this build accepts: ${reason}`,
    502,
  );
  return parsed.data.rows.map((row) =>
    row.record
      ? {
          ...row,
          record: {
            ...row.record,
            act: (row.record.act ?? []).filter((entry) => sandboxTools.includes(entry.tool)),
          },
        }
      : row,
  );
}

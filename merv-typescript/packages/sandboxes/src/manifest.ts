import { check } from '@merv/contracts';
import { z } from 'zod';

/**
 * The published contract (`@merv/contracts/ui-manifest`) expressed as a schema. A manifest
 * arrives from outside this process, so everything it can steer is checked here: field paths
 * are dot paths, reads are plain `/v1` routes, the console link is https, and a column type
 * this build does not know rejects the whole manifest rather than reaching the browser.
 * Unknown keys are dropped, never forwarded, so a newer service stays readable.
 *
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
const text = (max: number) => z.string().min(1).max(max);
const field = z
  .string()
  .max(120)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/, 'A field must be a dot path');
const route = z
  .string()
  .max(200)
  .regex(/^\/v1\/[A-Za-z0-9._~/-]*$/, 'A read must be a plain /v1 route');
const recordRoute = z
  .string()
  .max(200)
  .regex(/^\/v1\/[A-Za-z0-9._~/-]*\{id\}[A-Za-z0-9._~/-]*$/, 'A record read must contain {id}');
const values = z.array(text(40)).max(16);
const unit = z.enum(['bytes', 'mib', 'gb', 'count']);
const when = z.object({ field, in: values });
const phrasePart = z.union([
  text(24),
  z.object({
    field,
    prefix: text(16).optional(),
    suffix: text(16).optional(),
    unit: unit.optional(),
  }),
]);
const common = { label: text(40), width: text(12).optional() };
const column = z.discriminatedUnion('type', [
  z.object({ ...common, type: z.literal('text'), field }),
  z.object({ ...common, type: z.literal('name'), field }),
  z.object({ ...common, type: z.literal('state'), field }),
  z.object({ ...common, type: z.literal('ago'), field }),
  z.object({ ...common, type: z.literal('link'), field }),
  z.object({ ...common, type: z.literal('countdown'), field, granted: field.optional() }),
  z.object({
    ...common,
    type: z.literal('money'),
    total: field.optional(),
    rate: field.optional(),
    currency: text(8).optional(),
  }),
  z.object({
    ...common,
    type: z.literal('phrase'),
    fields: z.array(phrasePart).min(1).max(10),
    separator: text(4).optional(),
  }),
]);
const columns = z.array(column).min(1).max(5);
const liveness = z.object({ verdict: field, clause: field.optional(), clock: field.optional() });
const detail = z.object({
  label: text(40),
  field,
  mono: z.boolean().optional(),
  unit: z.enum(['bytes', 'mib', 'gb', 'seconds', 'instant']).optional(),
});
const section = z.discriminatedUnion('kind', [
  z.object({ title: text(40), kind: z.literal('text'), field }),
  z.object({ title: text(40), kind: z.literal('kv'), rows: z.array(detail).max(24) }),
  z.object({ title: text(40), kind: z.literal('list'), field, columns: z.array(column).max(8) }),
  z.object({ title: text(40), kind: z.literal('ladder'), field, step: field, state: field }),
]);
const action = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  label: text(40),
  verb: z.enum(['new', 'start', 'claim', 'submit', 'halt', 'edit', 'extend', 'release']),
  tool: z
    .string()
    .regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/)
    .max(64),
  args: z.record(z.union([z.string().max(200), z.number(), z.boolean()])).optional(),
  guard: z.object({ title: text(80), consequence: text(200) }).optional(),
  when: when.optional(),
});
const collection = z.object({
  noun: z.object({ singular: text(24), plural: text(24) }),
  read: route,
  key: field,
  title: field,
  search: z.array(field).max(8).optional(),
  states: z
    .object({ field, open: values, live: values.optional(), failed: values.optional() })
    .optional(),
  attention: z.object({ field }).optional(),
  columns,
  liveness: liveness.optional(),
  empty: z.object({ title: text(60), hint: text(200) }),
  cadence: z
    .object({
      liveMs: z.number().int().min(1000).max(600_000),
      idleMs: z.number().int().min(1000).max(3_600_000),
      liveWhen: when,
    })
    .optional(),
});
const record = z.object({
  read: recordRoute,
  title: field,
  state: field.optional(),
  standing: liveness.optional(),
  act: z.array(action).max(8).optional(),
  content: section.optional(),
  history: z.array(section).max(6).optional(),
  related: section.optional(),
  details: z.array(detail).max(24).optional(),
  console: z
    .object({
      label: text(60),
      // The one link out. Rendered as an anchor, so https or a path on the service itself,
      // which the browser resolves against the `console_origin` a record read carries.
      href: z
        .string()
        .max(300)
        .regex(/^(?:https:\/\/[A-Za-z0-9.-]+(?::\d{2,5})?)?\/[A-Za-z0-9._~/{}-]*$/),
    })
    .optional(),
});
const manifestSchema = z.object({
  version: z.literal(1),
  rows: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z][a-z0-9-]{0,40}$/),
        label: text(40),
        group: z.enum(['research', 'work', 'operations', 'activity', 'system']),
        order: z.number().int().min(-999).max(999),
        icon: z
          .string()
          .regex(/^[a-z][a-z0-9-]{0,31}$/)
          .optional(),
        collection,
        record: record.optional(),
      }),
    )
    .max(8),
});

export type ManifestRow = z.infer<typeof manifestSchema>['rows'][number];

/**
 * Validate a published manifest and drop every control bound to a tool this process does not
 * register: an act control the browser cannot dispatch must never be rendered at all.
 */
export function parseManifest(
  value: unknown,
  registered: (tool: string) => boolean,
): ManifestRow[] {
  const parsed = manifestSchema.safeParse(withoutNulls(value));
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
            act: (row.record.act ?? []).filter((entry) => registered(entry.tool)),
          },
        }
      : row,
  );
}

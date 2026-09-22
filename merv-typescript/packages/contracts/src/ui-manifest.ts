import { z } from 'zod';

/**
 * Remote rows. A service outside this process (merv-sandboxes first) publishes a
 * manifest describing rows it wants in the sidebar; a plugin in this process
 * registers them and proxies their reads; the browser renders them with Merv's
 * own list and record anatomy. The manifest says WHAT a row holds, never how it
 * looks: every column is one of Merv's types, identifiers are never displayed,
 * and a count only ever means open work.
 *
 * Field paths are dot paths into the row object the read returns
 * (`resources.gpu_count`). A missing field renders nothing, never a placeholder.
 *
 * The schema is the contract, and the browser's types are inferred from it. A manifest
 * arrives from outside this process, so everything it can steer is checked: field paths are
 * dot paths, reads are plain `/v1` routes, the console link is https, and a column type this
 * build does not know rejects the whole manifest rather than reaching the browser. Unknown
 * keys are dropped, never forwarded, so a newer service stays readable.
 */
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
const group = z.enum(['research', 'work', 'operations', 'activity', 'system']);
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
  /** The row's name; links into the record when one exists. */
  z.object({ ...common, type: z.literal('name'), field }),
  z.object({ ...common, type: z.literal('state'), field }),
  z.object({ ...common, type: z.literal('ago'), field }),
  /** A link to something else by name; the field holds `{ name, href }`. */
  z.object({ ...common, type: z.literal('link'), field }),
  /** Remaining time to `field` (an instant); with `granted` (seconds) it reads
   *  "6m left · of 4h". */
  z.object({ ...common, type: z.literal('countdown'), field, granted: field.optional() }),
  /** Money: `total` so far over `rate` per hour; "free" when the rate is zero. */
  z.object({
    ...common,
    type: z.literal('money'),
    total: field.optional(),
    rate: field.optional(),
    currency: text(8).optional(),
  }),
  /** One phrase composed from several fields, absent parts skipped: hardware, location. */
  z.object({
    ...common,
    type: z.literal('phrase'),
    fields: z.array(phrasePart).min(1).max(10),
    separator: text(4).optional(),
  }),
]);
const liveness = z.object({
  /** Field holding the verdict word (running, idle, provisioning, unreachable, stopped). */
  verdict: field,
  /** Field holding the clause (the command in flight, the phase, the end reason). */
  clause: field.optional(),
  /** Field holding the instant the clock counts from. */
  clock: field.optional(),
});
const detail = z.object({
  label: text(40),
  field,
  /** Rendered as machine text with a copy control. */
  mono: z.boolean().optional(),
  unit: z.enum(['bytes', 'mib', 'gb', 'seconds', 'instant']).optional(),
});
const section = z.discriminatedUnion('kind', [
  z.object({ title: text(40), kind: z.literal('text'), field }),
  z.object({ title: text(40), kind: z.literal('kv'), rows: z.array(detail).max(24) }),
  z.object({ title: text(40), kind: z.literal('list'), field, columns: z.array(column).max(8) }),
  /** Steps in order with a state each: done, here, next. */
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
  /** Static arguments merged with `{ id }`. */
  args: z.record(z.union([z.string().max(200), z.number(), z.boolean()])).optional(),
  /** A guarded control states its consequence and names what is under it before acting. */
  guard: z.object({ title: text(80), consequence: text(200) }).optional(),
  /** Shown only while the record's field is one of these values. */
  when: when.optional(),
});
const collection = z.object({
  noun: z.object({ singular: text(24), plural: text(24) }),
  /** What the plugin reads to list rows: a plain service route (`/v1/sandboxes`). */
  read: route,
  /** Field holding the record key. Used for routes and prefix search only; never shown. */
  key: field,
  /** Field holding the row's name. */
  title: field,
  /** Fields matched by search, besides the key's prefix. */
  search: z.array(field).max(8).optional(),
  /** The state field, and which of its values count as open work (the row's only count). */
  states: z
    .object({ field, open: values, live: values.optional(), failed: values.optional() })
    .optional(),
  /** A field holding a short reason when the row needs a person, else null or absent. */
  attention: z.object({ field }).optional(),
  columns: z.array(column).min(1).max(5),
  /** The second line of the row; silent when its fields are absent. */
  liveness: liveness.optional(),
  empty: z.object({ title: text(60), hint: text(200) }),
  /** Poll cadence derived from the data; the tab-hidden gate applies on top. */
  cadence: z
    .object({
      liveMs: z.number().int().min(1000).max(600_000),
      idleMs: z.number().int().min(1000).max(3_600_000),
      liveWhen: when,
    })
    .optional(),
});
const record = z.object({
  /** What the plugin reads for one record; `{id}` is replaced by the key. */
  read: recordRoute,
  title: field,
  state: field.optional(),
  standing: liveness.optional(),
  /** Controls in the Act slot, each bound to a tool this process registers; a control whose
   *  tool is not registered is not rendered. */
  act: z.array(action).max(8).optional(),
  content: section.optional(),
  history: z.array(section).max(6).optional(),
  related: section.optional(),
  /** The Details block: the one place machine text is allowed, as copy targets. */
  details: z.array(detail).max(24).optional(),
  /** The one link out, for everything the remote console owns; `{id}` is replaced. */
  console: z
    .object({
      label: text(60),
      // Rendered as an anchor, so https or a path on the service itself, which the browser
      // resolves against the `console_origin` a record read carries.
      href: z
        .string()
        .max(300)
        .regex(/^(?:https:\/\/[A-Za-z0-9.-]+(?::\d{2,5})?)?\/[A-Za-z0-9._~/{}-]*$/),
    })
    .optional(),
});
const row = z.object({
  /** Stable id; the sidebar path is derived from it (`/<pluginId>-<id>` is the plugin's choice). */
  id: z.string().regex(/^[a-z][a-z0-9-]{0,40}$/),
  label: text(40),
  group,
  order: z.number().int().min(-999).max(999),
  /** One of the browser's icon names (home, now, research, paper, knowledge, tasks,
   *  experiments, reviews, reflections, people, sessions, code, connections,
   *  artifacts, feed, settings); unknown names fall back to the generic glyph. */
  icon: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,31}$/)
    .optional(),
  collection,
  record: record.optional(),
});
export const uiManifestSchema = z.object({ version: z.literal(1), rows: z.array(row).max(8) });

export type UiManifest = z.infer<typeof uiManifestSchema>;
export type UiManifestRow = z.infer<typeof row>;
export type UiManifestGroup = z.infer<typeof group>;
export type UiCollectionSpec = z.infer<typeof collection>;
export type UiColumn = z.infer<typeof column>;
export type UiPhrasePart = z.infer<typeof phrasePart>;
export type UiLivenessSpec = z.infer<typeof liveness>;
export type UiRecordSpec = z.infer<typeof record>;
export type UiAction = z.infer<typeof action>;
export type UiSection = z.infer<typeof section>;
export type UiDetail = z.infer<typeof detail>;

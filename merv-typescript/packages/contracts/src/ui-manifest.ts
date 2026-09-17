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
 */

export type UiManifestGroup = 'research' | 'work' | 'operations' | 'activity' | 'system';

export interface UiManifest {
  version: 1;
  rows: UiManifestRow[];
}

export interface UiManifestRow {
  /** Stable id; the sidebar path is derived from it (`/<pluginId>-<id>` is the plugin's choice). */
  id: string;
  label: string;
  group: UiManifestGroup;
  order: number;
  /** One of the browser's icon names (home, now, research, claims, paper, knowledge, tasks,
   *  experiments, reviews, reflections, consolidation, people, sessions, code, connections,
   *  artifacts, feed, settings); unknown names fall back to the generic glyph. */
  icon?: string;
  collection: UiCollectionSpec;
  record?: UiRecordSpec;
}

export interface UiCollectionSpec {
  noun: { singular: string; plural: string };
  /** What the plugin reads to list rows: a service route (`/v1/sandboxes`) or a tool name. */
  read: string;
  /** Field holding the record key. Used for routes and prefix search only; never shown. */
  key: string;
  /** Field holding the row's name. */
  title: string;
  /** Fields matched by search, besides the key's prefix. */
  search?: string[];
  /** The state field, and which of its values count as open work (the row's only count). */
  states?: { field: string; open: string[]; live?: string[]; failed?: string[] };
  /** A field holding a short reason when the row needs a person, else null or absent. */
  attention?: { field: string };
  /** At most five. */
  columns: UiColumn[];
  /** The second line of the row; silent when its fields are absent. */
  liveness?: UiLivenessSpec;
  empty: { title: string; hint: string };
  /** Poll cadence derived from the data; the tab-hidden gate applies on top. */
  cadence?: { liveMs: number; idleMs: number; liveWhen: { field: string; in: string[] } };
}

export type UiColumn = { label: string; width?: string } & (
  | { type: 'text'; field: string }
  /** The row's name; links into the record when one exists. */
  | { type: 'name'; field: string }
  | { type: 'state'; field: string }
  | { type: 'ago'; field: string }
  /** Remaining time to `field` (an instant); with `granted` (seconds) it reads "6m left · of 4h". */
  | { type: 'countdown'; field: string; granted?: string }
  /** Money: `total` so far over `rate` per hour; "free" when the rate is zero. */
  | { type: 'money'; total?: string; rate?: string; currency?: string }
  /** One phrase composed from several fields, absent parts skipped: hardware, location. */
  | { type: 'phrase'; fields: UiPhrasePart[]; separator?: string }
  /** A link to something else by name; the field holds `{ name, href }`. */
  | { type: 'link'; field: string }
);

export type UiPhrasePart =
  | string
  | { field: string; suffix?: string; prefix?: string; unit?: 'bytes' | 'mib' | 'gb' | 'count' };

export interface UiLivenessSpec {
  /** Field holding the verdict word (running, idle, provisioning, unreachable, stopped). */
  verdict: string;
  /** Field holding the clause (the command in flight, the phase, the end reason). */
  clause?: string;
  /** Field holding the instant the clock counts from. */
  clock?: string;
}

export interface UiRecordSpec {
  /** What the plugin reads for one record; `{id}` is replaced by the key. */
  read: string;
  title: string;
  state?: string;
  standing?: UiLivenessSpec;
  /** Controls in the Act slot, each bound to a tool this process registers; a control whose
   *  tool is not registered is not rendered. */
  act?: UiAction[];
  content?: UiSection;
  history?: UiSection[];
  related?: UiSection;
  /** The Details block: the one place machine text is allowed, as copy targets. */
  details?: UiDetail[];
  /** The one link out, for everything the remote console owns; `{id}` is replaced. */
  console?: { label: string; href: string };
}

export interface UiAction {
  id: string;
  label: string;
  verb: 'new' | 'start' | 'claim' | 'submit' | 'halt' | 'edit' | 'extend' | 'release';
  tool: string;
  /** Static arguments merged with `{ id }`. */
  args?: Record<string, string | number | boolean>;
  /** A guarded control states its consequence and names what is under it before acting. */
  guard?: { title: string; consequence: string };
  /** Shown only while the record's field is one of these values. */
  when?: { field: string; in: string[] };
}

export type UiSection =
  | { title: string; kind: 'text'; field: string }
  | { title: string; kind: 'kv'; rows: UiDetail[] }
  | { title: string; kind: 'list'; field: string; columns: UiColumn[] }
  /** Steps in order with a state each: done, here, next. */
  | { title: string; kind: 'ladder'; field: string; step: string; state: string };

export interface UiDetail {
  label: string;
  field: string;
  /** Rendered as machine text with a copy control. */
  mono?: boolean;
  unit?: 'bytes' | 'mib' | 'gb' | 'seconds' | 'instant';
}

/**
 * Remote rows: a row a plugin (Fleet) describes by what it holds, never how it looks, and the
 * browser renders with Merv's own list and record anatomy (packages/ui/web/views/remote.tsx).
 * Every column is one of Merv's types, identifiers are never displayed, and a count only ever
 * means open work.
 *
 * Field paths are dot paths into the row object the read returns (`runtime.sandboxId`). A
 * missing field renders nothing, never a placeholder. Type aliases, not interfaces, so a spec
 * passes as the JSON a row's view carries.
 */
type When = {
  field: string;
  in: string[];
};
export type UiColumn = {
  /** `name` is the row's name, linking into the record; `countdown` the time left to an instant. */
  type: 'name' | 'state' | 'ago' | 'countdown';
  label: string;
  field: string;
};
export type UiLivenessSpec = {
  /** Field holding the verdict word (running, idle, provisioning, unreachable, stopped). */
  verdict: string;
  /** Field holding the clause (the command in flight, the phase, the end reason). */
  clause?: string;
  /** Field holding the instant the clock counts from. */
  clock?: string;
};
export type UiDetail = {
  label: string;
  field: string;
  /** Rendered as machine text with a copy control. */
  mono?: boolean;
  unit?: 'instant';
};
export type UiAction = {
  id: string;
  label: string;
  verb: 'new' | 'start' | 'claim' | 'submit' | 'halt' | 'edit' | 'extend' | 'release';
  tool: string;
  /** Static arguments merged with `{ id }`. */
  args?: Record<string, string | number | boolean>;
  /** A guarded control states its consequence and names what is under it before acting. */
  guard?: { title: string; consequence: string };
  /** Shown only while the record's field is one of these values. */
  when?: When;
};
export type UiCollectionSpec = {
  noun: { singular: string; plural: string };
  /** What the plugin reads to list rows: a plain service route (`/v1/fleet`). */
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
  columns: UiColumn[];
  empty: { title: string };
  /** Poll cadence derived from the data; the tab-hidden gate applies on top. */
  cadence?: { liveMs: number; idleMs: number; liveWhen: When };
};
export type UiRecordSpec = {
  /** What the plugin reads for one record; `{id}` is replaced by the key. */
  read: string;
  title: string;
  state?: string;
  standing?: UiLivenessSpec;
  /** Controls in the Act slot, each bound to a tool this process registers; a control whose
   *  tool is not registered is not rendered. */
  act?: UiAction[];
  /** The Details block: the one place machine text is allowed, as copy targets. */
  details?: UiDetail[];
};

import type {
  Caller,
  Json,
  RunningLaneName,
  RunningMark,
  RunningNodes,
  RunningPanelPart,
  RunningSection,
  RunningSummary,
} from '@merv/contracts';
import type {} from 'cordis';

/** Live state a row owner reports alongside its navigation entry. */
export interface UiRowStatus {
  state?: 'ready' | 'degraded' | 'unavailable';
  count?: number;
  detail?: string;
}

/** One sidebar row. Rows are data: the browser bundle renders `view.kind`, never plugin code. */
export interface UiRow {
  id: string;
  label: string;
  /** Sidebar section. `settings` rows render in the foot. */
  group: string;
  order: number;
  /** Browser route under /ui, beginning with a slash. */
  path: string;
  view: { kind: string; [key: string]: Json };
  status?(caller: Caller): UiRowStatus | Promise<UiRowStatus>;
  /** Row-owned read-only data for views without a domain tool, served through ui.read. */
  /** The owning row validates any pagination or lookup parameters. */
  read?(caller: Caller, params?: Record<string, unknown>): Json | Promise<Json>;
}

export interface UiRowDescription extends Omit<UiRow, 'status' | 'read'> {
  status: UiRowStatus;
  readable: boolean;
}

/** One answer's read, as a contribution sees it. */
export interface RunningRead {
  caller: Caller;
  /**
   * Keys another owner marked. Return these nodes even where your own rule would not, e.g.
   * a done task whose code Code still holds for a person. Empty on a panel read.
   */
  include: ReadonlySet<string>;
  /**
   * One value per contribution per answer. When marks, nodes and a summary come from one
   * read (Sessions' stuck analysis), that read runs once. Nothing is kept between answers.
   */
  once<T>(name: string, read: () => Promise<T>): Promise<T>;
}

/**
 * One plugin's part of the Running page. The plugin that owns the logic registers it from its
 * own ui adapter, inside `ctx.effect` so it leaves with the adapter. Every member is optional
 * and every member only reads. Members run inside the read-only tool's PostgreSQL snapshot,
 * so none may write, and none may wait on a service outside this process: read a cache that
 * the service refreshes on its own timer instead. On the board, a part refused with 403 or 404
 * is simply absent; any other failure names the owner in its lanes, and the rest stands.
 */
export interface RunningContribution {
  /** The owning plugin, e.g. 'tasks' or 'sessions'. Unique while registered: /^[a-z][a-z0-9-]{0,31}$/. */
  owner: string;
  /** Key kinds whose sidebars this owner answers ('work', 'session', 'compute'). */
  kinds?: readonly string[];
  /** Lanes this owner draws in. A part that fails is reported in these lanes. */
  lanes?: readonly RunningLaneName[];
  /** Attention on keys other owners draw. Read first, so marked keys reach every nodes() as `include`. */
  marks?(read: RunningRead): Promise<RunningMark[]>;
  nodes?(read: RunningRead): Promise<RunningNodes>;
  summary?(read: RunningRead): Promise<RunningSummary | null>;
  /**
   * The sidebar of a key this owner draws, or null (or a 404) for a key it does not own; any
   * other refusal is the sidebar's answer. With `absorbedBy`, the node has been folded into
   * another owner's node: return only the sections that still say something there. Header
   * and actions are dropped.
   */
  panel?(read: RunningRead, key: string, absorbedBy?: string): Promise<RunningPanelPart | null>;
  /** Sections for a key another owner draws, or for any of the keys it absorbed. [] when it knows nothing of them. */
  sections?(read: RunningRead, keys: readonly string[]): Promise<RunningSection[]>;
}

export interface Ui {
  /** Registers a row until the returned disposer runs; ids are unique while registered. */
  register(row: UiRow): () => void;
  rows(): UiRow[];
  /** Adds one owner's part of the Running page until the returned disposer runs. */
  contribute(contribution: RunningContribution): () => void;
  /** Registered contributions, ordered by owner. That order is the board's tie-break everywhere. */
  contributions(): RunningContribution[];
}

declare module 'cordis' {
  interface Context {
    ui: Ui;
  }
}

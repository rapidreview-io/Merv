import type {
  Caller,
  Json,
  RunningLaneName,
  RunningMark,
  RunningNodes,
  RunningPanelPart,
  RunningSection,
  RunningSummary,
  WorkRoute,
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
  /**
   * Where the rail places the row: `lead` just under Home, `top` under that, `settings` in the
   * foot, `hidden` nowhere (its routes and its read still serve); any other group is the
   * section it is listed under.
   */
  group: string;
  order: number;
  /** Browser route under /ui, beginning with a slash. */
  path: string;
  /** The workflow whose records this row lists: each opens at `${path}/${id}`, on every page. */
  workflow?: string;
  /**
   * Workflows whose records live inside this row's records, as a lens lives in its wave: each
   * opens at `${path}/${id}` too, and the page finds the record that holds it.
   */
  holds?: readonly string[];
  /** Deeper addresses are rooms of this one page, not records, so the shell still titles them. */
  rooms?: true;
  /** The rail lists the row only while its status counts something: an empty archive is no place. */
  whenCounted?: true;
  view: { kind: string; [key: string]: Json };
  status?(caller: Caller): UiRowStatus | Promise<UiRowStatus>;
  /** The owning row validates any pagination or lookup parameters. */
  read?(caller: Caller, params?: Record<string, unknown>): Json | Promise<Json>;
  /**
   * This row's part of ui.home, the one read Home and the rail poll, under the row's id: the
   * read-only tool that lists its records, and the fields of each record those pages read.
   * `list`, when given, is read in the tool's place: those records with at least those fields.
   */
  home?: { tool?: string; keep: readonly string[]; list?(caller: Caller): Promise<unknown> };
  /** How Needs you says a record of `home` is the reader's move, in the owner's words. */
  needs?: UiRowNeeds;
  /** What the shell says of `workflow`'s states that its deployed definition does not. */
  states?: Record<string, UiStateWords>;
}

/**
 * One state of a row's workflow, in the owner's words. The catalog already says the rest: a
 * state left through review.submit is a review gate, and an end is an end.
 */
export interface UiStateWords {
  /** Work not yet begun: its stage reads grey, before any of the program's work. */
  idle?: true;
  /** At a review gate: what crossing into it says its producer did, e.g. 'Delivered'. */
  submitted?: string;
}

/**
 * The words Needs you says a row's records in: the shell has none of its own for any workflow.
 * Whose move a record is, and the sentence asking it, are its gate's (`yours`), as its program
 * describes the record to Workflows.
 */
export interface UiRowNeeds {
  /** The fields of a `home` record that name it and whose it is. */
  name: string;
  owner: string;
  /** What a reviewer is asked, by the state the record waits in. */
  reads?: Record<string, string>;
  /** Blocker codes on which the record stopped on its last failed prerequisite; others stop nothing. */
  stops?: string[];
  /** The records only name the reviews of them, and are never a move of their own. */
  subjectOnly?: true;
}

export interface UiRowDescription extends Omit<UiRow, 'status' | 'read' | 'home'> {
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
  /** The page of a work record, by its workflow, as the registered rows declare it. */
  route: WorkRoute;
}

/**
 * One plugin's part of the Running page. The plugin that owns the logic registers it from its
 * own ui adapter, inside `ctx.effect` so it leaves with the adapter. Every member is optional
 * and every member only reads. Members run inside the read-only tool's PostgreSQL snapshot,
 * so none may write, and none may wait on a service outside this process: read a cache that
 * the service refreshes on its own timer instead. Members are read one at a time, each behind
 * its own savepoint, so a statement that fails costs only that member; leave no read running
 * when a member returns. On the board, a part refused with 403 or 404 is simply absent; any
 * other failure names the owner in its lanes, and the rest stands.
 */
export interface RunningContribution {
  /** The owning plugin, e.g. 'tasks' or 'sessions'. Unique while registered: /^[a-z][a-z0-9-]{0,31}$/. */
  owner: string;
  /** Key kinds whose sidebars this owner answers ('work', 'session', 'compute'). */
  kinds?: readonly string[];
  /**
   * The workflows of the work records whose sidebars this owner answers ('task'). A `work:`
   * key's sidebar is asked only of the owners that declare its record's workflow.
   */
  workflows?: readonly string[];
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

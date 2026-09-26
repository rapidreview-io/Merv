import type { Json } from './data.js';
import type { ProcessGraph, WorkflowDependency } from './workflow-guidance.js';

/**
 * The Running page shows everything in flight, in three lanes: the work, the agent sessions
 * on it, and the machines they use. The plugin that owns a thing says what its node and its
 * sidebar hold, using this vocabulary and nothing else. The shell owns how they look. No
 * plugin ships markup, so a task's sidebar and a sandbox's read the same way, and an owner
 * adds a node without touching the browser.
 *
 * A key is `<kind>:<id>` and names one thing on the board. Tasks, experiments and reflection
 * waves all use `work:<instanceId>`, because Sessions, Reviews, Code and Fleet know a record
 * only by its instance id. The other kinds are `session:<sessionId>`, `fleet:<allocationId>`,
 * `sandbox:<sandboxId>`, `check:<baseKey>` and `compute:<digest>`. The id is used for
 * lookups, routes and tool input, and is never printed.
 */
export type RunningLaneName = 'work' | 'sessions' | 'hardware';
export type RunningKey = string;

/** A lowercase kind, a colon, then an id of URL-safe characters. */
export const runningKeyPattern = /^[a-z][a-z-]{0,23}:[A-Za-z0-9._~:-]{1,200}$/;
export const runningKey = (kind: string, id: string): RunningKey => `${kind}:${id}`;
export const keyKind = (key: RunningKey): string => key.slice(0, key.indexOf(':'));
export const keyId = (key: RunningKey): string => key.slice(key.indexOf(':') + 1);

/** Money as the services send it: a decimal string, so a sub-cent rate is not rounded away. */
export interface RunningMoney {
  amount: string;
  currency: string;
}

/**
 * Where a link goes. A key selects that node when it is on the board and follows its route
 * when it is not. A route is a page of this app. An href is https and opens outside the app.
 * The shell draws the arrow that ends a link, so no owner writes one.
 */
export type RunningTarget =
  { key: RunningKey; route?: string } | { route: string } | { href: string };

/**
 * One fact, in the types a remote row's columns already use (views/remote.tsx): words, a
 * state, a time ago, a running clock, a countdown, a count, money and a link. The shell
 * writes the words for each and ticks every clock on the server's time, so an owner sends
 * instants and never '3 min ago'.
 */
export type RunningValue =
  /** Words, as written. */
  | string
  /** Machine text such as a branch or a tool name. In a facts row it gets a copy control. */
  | { mono: string }
  /** A state word; `in_review` reads 'in review'. Drawn in ink; red only on a row that needs a person. */
  | { state: string }
  /** How long ago ('6 min ago'), with the moment in its title. */
  | { ago: string }
  /** How long since, ticking ('22m'). With `of` seconds it reads against a cap ('12m of 60m'). */
  | { since: string; of?: number }
  /** Time left ('34m left'). With `of` seconds granted it reads '34m left · of 4h'. */
  | { until: string; of?: number }
  /** A count. With `of` it reads out of a whole ('2 of 4'). */
  | { count: number; of?: number }
  /** Spent so far, against a cap and per hour ('$2.10 of $8 · $2.49/h'). A rate of zero reads 'free'. */
  | { money: RunningMoney | null; of?: RunningMoney | null; rate?: RunningMoney | null }
  /**
   * A person or an agent. The shell names it with the one actor-name rule (actor.list, which
   * only an operator may read). `prefix` goes before a name ('with '). `unnamed` stands in
   * when the reader cannot see one ('claimed'). With neither, an unnamed actor renders
   * nothing. The id is only for the lookup and is never printed.
   */
  | { actor: string; prefix?: string; unnamed?: string }
  /** Words that go somewhere. */
  | { link: RunningTarget; text: string };

/** Words and facts read in order. The owner writes its own separators (' · '). */
export type RunningPhrase = RunningValue[];

/** What needs a person, and who ends the wait. This is the only red on the page. */
export interface RunningAttention {
  says: RunningPhrase;
  /** 'A signed-in operator', 'The producer'. Printed under the sentence in the sidebar. */
  who?: string;
  /**
   * The one way to the move, drawn as a link under the sentence in the sidebar's head:
   * `{ route: '/code', text: 'Merge reviewed proposal' }` reads 'Merge reviewed proposal →'.
   */
  to?: RunningTarget & { text: string };
  /**
   * Not a person's move, only what the drawing owner cannot see: the words replace the
   * node's first line in ink, without the red, and are not counted as needing anyone
   * ('Ready · launch failed 2 times, retrying'). Any red attention outranks a quiet one.
   */
  quiet?: true;
}

/**
 * Attention an owner raises on a key it does not draw: Code's pull request waiting for a
 * merge, or Sessions' held dispatch. A mark also keeps its key on the board, because the
 * drawing owner is asked for that node even where its own rule would drop it. That is how
 * a done task whose code still needs a person stays. A node's own attention outranks every
 * mark.
 */
export interface RunningMark extends RunningAttention {
  key: RunningKey;
}

/** How one node relates to another. Each fact is declared once, by the node that holds it. */
export type RunningVerb =
  /** work → work: a prerequisite. `waiting` while it is unsettled. */
  | 'waits on'
  /** session → work, as producer, reviewer or reader. */
  | 'works on'
  | 'reviews'
  | 'reads'
  /** fleet → work: why the machine was rented, not necessarily what it runs. */
  | 'rented for'
  /** compute → work. */
  | 'runs for'
  /** check → work: accepted work the check machine is proving. */
  | 'checks';

export interface RunningNodeLink {
  to: RunningKey;
  verb: RunningVerb;
  /** Drawn dashed: the relation has not happened yet (an unsettled prerequisite, a machine starting). */
  waiting?: boolean;
}

/**
 * One card. A work card shows its kind, title and one line. A session shows its role, what
 * it is doing and where it runs. A machine shows what it is, what it is doing and what it
 * costs.
 */
export interface RunningNode {
  key: RunningKey;
  lane: RunningLaneName;
  /** The small word above the title in the work lane ('Task', 'Experiment', 'Reflection'). */
  kind?: string;
  title: string;
  /** Accessible name and hover title, where the title is not the thing's name (a sandbox titled '8× H100' is named 'aurora-sweep'). */
  name?: string;
  /** At most two lines under the title. Attention replaces the first. */
  lines: RunningPhrase[];
  /** solid: in hand. dashed: waiting on a prerequisite, a worker or a machine. quiet: ending. */
  look: 'solid' | 'dashed' | 'quiet';
  /**
   * Green only where something moves. `moving` breathes: a call is in flight right now.
   * `live` is still: a lease holds it. `starting` is a hollow grey ring. Absent: no dot.
   * A work node's dot is the board's to draw, from the sessions working on it or reviewing
   * it, so an owner of work leaves it unset.
   */
  dot?: 'moving' | 'live' | 'starting';
  attention?: RunningAttention;
  /** Hardware only: one cell per accelerator (at most 8 drawn), filled while a job runs. */
  units?: { count: number; busy: boolean };
  links?: RunningNodeLink[];
  /**
   * Keys of other owners' nodes that this node absorbs. A session bound to a Fleet machine
   * absorbs `fleet:<allocationId>`, a Code check absorbs its `sandbox:<id>`, and a reflection
   * wave absorbs its lenses' `work:<lensId>`. The absorbed node leaves its lane, links to it
   * land here, and its owner's sections follow this node's in the sidebar, without their
   * controls. What an absorbed node absorbs comes along with it. On the board's answer this
   * is every key the node absorbed, so the shell can open this node for any of them.
   */
  aliases?: RunningKey[];
  /** Order within one owner's nodes, lowest first. Attention sorts ahead of any rank. */
  rank?: number;
  /** Stamped by the board: the contribution that drew it. */
  owner?: string;
}

/** What one owner draws, and how old it is when it comes from a cache. */
export interface RunningNodes {
  nodes: RunningNode[];
  /** When a cached source was last read (Sandboxes). Absent for a PostgreSQL read. */
  asOf?: string;
  /** True when the cache's last refresh failed and these rows are from before it. */
  failed?: boolean;
  /**
   * The cache behind these nodes has never been filled. Nothing is known yet, which is not
   * the same as nothing running: the lane's count reads '—', never 0.
   */
  pending?: true;
  /** How long a read of the cache stays current: the owner's own refresh cadence × 2, in ms. */
  freshForMs?: number;
}

/** A control. The owner sends the whole tool input and decides whether this caller may use it. */
export interface RunningAction {
  /** Words from the verb table: 'Halt lease', 'Pause dispatch', 'Start dispatch', 'Extend lease', 'Release machine'. */
  label: string;
  verb: 'start' | 'pause' | 'halt' | 'extend' | 'release';
  tool: string;
  /** Sent as is. Never merged with a key: `session.halt` without `sessionId` halts every lease. */
  input: Record<string, Json>;
  /** The owner's own rule for this caller. A control that is not allowed is not sent. */
  allowed: boolean;
  /** Wears the accent. Only a start may; never a pause, a halt or a release. */
  primary?: boolean;
  /** A guarded control names its consequence before acting. */
  guard?: { title: string; consequence: string };
  /**
   * What the answer must hold for the act to count as done. Below `min` the guard stays
   * open with `nothing` under it, and nothing is refreshed as if it had worked: a lease that
   * closed between the read and the click halts nothing
   * (`{ field: 'halted', min: 1, nothing: 'Nothing was halted.' }`).
   */
  expect?: { field: string; min: number; nothing: string };
}

/** A lane's own line, beside its heading. For Sessions: dispatch and machines. */
export interface RunningSummary {
  lane: RunningLaneName;
  says: RunningPhrase;
  attention?: RunningAttention;
  actions: RunningAction[];
  owner?: string;
}

/**
 * Where a section stands in a sidebar, so sections from several owners read in one order:
 * where the thing is in its workflow, what is happening to it now, its review, what it
 * waits on and holds up, its code, what it is, its machine, and who. Within a place the
 * node's owner comes first, then the owners of what it absorbed, then other owners. A
 * section that says why the node needs a person comes before all of them.
 */
export type RunningPlace =
  'progress' | 'activity' | 'review' | 'relations' | 'code' | 'content' | 'machine' | 'details';

interface RunningSectionFrame {
  title: string;
  place: RunningPlace;
  /** Beside the heading: a count, or a count and a total ('50 of 347', '3 · $6.30'). */
  aside?: RunningPhrase;
  /** The section says why the node needs a person, so its heading takes the refusal colour. */
  attention?: boolean;
  /** Starts as a closed fold under its title, e.g. a brief the page has already summarised. */
  folded?: boolean;
  /** Stamped by the panel read: the contribution that wrote it. */
  owner?: string;
}
/** One row of label and value. */
export interface RunningFact {
  label: string;
  value: RunningPhrase;
  attention?: boolean;
}
/** One table row. With `to`, the row is the way to that thing. */
export interface RunningRow {
  cells: RunningPhrase[];
  to?: RunningTarget;
  attention?: boolean;
}
/** One jump row: kind word, name, and how it stands. */
export interface RunningLinkRow {
  to: RunningTarget;
  kind?: string;
  name: string;
  says?: RunningPhrase;
  attention?: boolean;
}
/** A Merv call, or a quiet marker between calls. The shell pins running calls first, collapses repeats and marks silences. */
export type RunningStreamItem =
  | {
      call: string;
      state: 'running' | 'succeeded' | 'failed' | 'interrupted';
      at: string;
      ms: number | null;
    }
  | { mark: RunningPhrase; at: string };

export type RunningSection = RunningSectionFrame &
  (
    | { kind: 'text'; text: string; markdown?: boolean; clamp?: number; truncated?: boolean }
    | { kind: 'facts'; rows: RunningFact[] }
    | { kind: 'table'; columns: string[]; rows: RunningRow[] }
    | { kind: 'links'; rows: RunningLinkRow[] }
    /** The workflow drawn with the record's place in it (UI_DESIGN: workflows are drawn). */
    | { kind: 'ladder'; graph: ProcessGraph }
    | { kind: 'stream'; items: RunningStreamItem[]; total: number }
  );

/** The sidebar's head. The status line uses the node's words. */
export interface RunningHeader {
  kind: string;
  title: string;
  says: RunningPhrase;
  attention?: RunningAttention;
}

/** What one owner answers for a key it draws. */
export interface RunningPanelPart {
  header: RunningHeader;
  sections: RunningSection[];
  actions: RunningAction[];
  /** The record's own page, drawn as 'Open record →'. */
  route?: string;
  /** Read again every 4 s while true, otherwise every 10 s. */
  live: boolean;
  /**
   * Keys this node absorbs, read from the owner's own tables. Their owners' sections follow
   * this node's, and other owners are asked for sections about them too.
   */
  aliases?: RunningKey[];
}

// ─── Tool answers ──────────────────────────────────────────────────────────────────────────

/** ui.running {} → RunningBoard */
export interface RunningBoard {
  observedAt: string;
  lanes: Record<RunningLaneName, RunningLane>;
  /** Only edges with both ends on the board, after absorption. */
  edges: RunningEdge[];
}
export interface RunningLane {
  nodes: RunningNode[];
  summaries: RunningSummary[];
  /** How many of this lane's nodes, and its summaries, need a person. Quiet attention is not counted. */
  needsYou: number;
  /** The oldest cached source behind this lane. Present only when a part came from a cache. */
  asOf?: string;
  /** How long after `asOf` the lane is still current; past it the lane reads stale. */
  freshForMs?: number;
  /** A cache behind this lane has never been filled, so its count is not known yet. */
  pending?: true;
  /** Owners whose part of this lane did not load. The rest of the lane still stands. */
  failed: string[];
  /** Nodes beyond the lane's cap of 200, which are not drawn. */
  more?: number;
}
export interface RunningEdge {
  from: RunningKey;
  to: RunningKey;
  verb: RunningVerb;
  waiting: boolean;
}

/** ui.running_panel { key } → RunningPanel */
export interface RunningPanelInput {
  key: RunningKey;
}
export interface RunningPanel extends RunningPanelPart {
  key: RunningKey;
  observedAt: string;
}

// ─── Two shared readings, so every owner of work draws its relations the same way ─────────

const WORK: Record<string, [kind: string, base: string]> = {
  task: ['Task', '/tasks'],
  experiment: ['Experiment', '/experiments'],
  reflection: ['Reflection', '/reflections'],
  research: ['Research', '/research'],
};

/** The page a work record opens on, chosen by its workflow. Undefined where no page shows that kind. */
export function workRoute(workflow: string, id: string): string | undefined {
  const base = WORK[workflow]?.[1];
  return base && `${base}/${encodeURIComponent(id)}`;
}

/**
 * A record's open relations as rows: what it still waits on (unsettled, or failed and
 * marked red) and the open work that waits on it. A settled prerequisite and an ended
 * dependent are history and are left out.
 */
export function dependencyRows(
  dependsOn: readonly WorkflowDependency[],
  requiredBy: readonly WorkflowDependency[],
): { waitsOn: RunningLinkRow[]; unblocks: RunningLinkRow[] } {
  const row = (dependency: WorkflowDependency): RunningLinkRow => {
    const route = workRoute(dependency.workflow, dependency.id);
    const kind = WORK[dependency.workflow]?.[0];
    return {
      to: { key: runningKey('work', dependency.id), ...(route ? { route } : {}) },
      ...(kind ? { kind } : {}),
      name: dependency.name,
      says: [{ state: dependency.state }],
      ...(dependency.failed ? { attention: true } : {}),
    };
  };
  return {
    waitsOn: dependsOn.filter((d) => !d.settled || d.failed).map(row),
    unblocks: requiredBy.filter((d) => !d.settled && !d.failed).map(row),
  };
}

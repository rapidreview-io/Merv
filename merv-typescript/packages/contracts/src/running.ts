import type { z } from 'zod';
import type * as schema from './running-schema.js';

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
export type RunningKey = string;

/** A lowercase kind, a colon, then an id of URL-safe characters. */
export const runningKeyPattern = /^[a-z][a-z-]{0,23}:[A-Za-z0-9._~:-]{1,200}$/;
export const runningKey = (kind: string, id: string): RunningKey => `${kind}:${id}`;
export const keyKind = (key: RunningKey): string => key.slice(0, key.indexOf(':'));
export const keyId = (key: RunningKey): string => key.slice(key.indexOf(':') + 1);

/**
 * A path on this app's own host, safe to follow or to send a credential to: one leading slash,
 * never `//` or `/\` (a browser reads `\` as `/`, so either names another host), then only
 * the characters a path, query or fragment carries, never whitespace or a control character,
 * which a browser strips, leaving `//host` again. At most 500 characters.
 */
export const sameOriginPath = (value: unknown): value is string =>
  typeof value === 'string' && /^\/(?![/\\])[A-Za-z0-9\-._~%!$&'()*+,;=:@/?#]{0,499}$/.test(value);

// ─── What an owner sends, typed by the schemas that read it (running-schema.ts) ──────────

export type RunningLaneName = z.input<typeof schema.runningLane>;
/** Money as the services send it: a decimal string, so a sub-cent rate is not rounded away. */
export type RunningMoney = z.input<typeof schema.runningMoney>;
export type RunningTarget = z.input<typeof schema.runningTarget>;
export type RunningValue = z.input<typeof schema.runningValue>;
/** Words and facts read in order. The owner writes its own separators (' · '). */
export type RunningPhrase = RunningValue[];
export type RunningAttention = z.input<typeof schema.runningAttention>;
export type RunningMark = z.input<typeof schema.runningMark>;
export type RunningVerb = z.input<typeof schema.runningVerb>;
export type RunningNodeLink = z.input<typeof schema.runningNodeLink>;
export type RunningNode = z.input<typeof schema.runningNode> & {
  /** Stamped by the board: the contribution that drew it. */
  owner?: string;
};
export type RunningAction = z.input<typeof schema.runningAction>;
export type RunningSummary = z.input<typeof schema.runningSummary> & { owner?: string };
export type RunningFact = z.input<typeof schema.runningFact>;
export type RunningRow = z.input<typeof schema.runningRow>;
export type RunningLinkRow = z.input<typeof schema.runningLinkRow>;
export type RunningStreamItem = z.input<typeof schema.runningStreamItem>;
export type RunningSection = z.input<typeof schema.runningSection> & {
  /** Stamped by the panel read: the contribution that wrote it. */
  owner?: string;
};
export type RunningHeader = z.input<typeof schema.runningHeader>;
export type RunningUnitEntry = z.input<typeof schema.runningUnitEntry>;
export type RunningUnitKey = z.input<typeof schema.runningUnitKey>;
export type RunningUnitArtifact = z.input<typeof schema.runningUnitArtifact>;
export type RunningUnit = z.input<typeof schema.runningUnit>;

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
  /**
   * A unit of work's history and its key artifact. With it the sidebar draws the stages, then
   * the history beside the key artifact, and folds every other section under Details.
   */
  unit?: RunningUnit;
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
  /**
   * Owners whose part of this lane did not load, by owner id, including an owner whose ui
   * adapter is configured but not running. The rest of the lane still stands.
   */
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
export interface RunningPanel extends RunningPanelPart {
  key: RunningKey;
  observedAt: string;
}

// ─── A shared reading, so every owner of work links its records the same way ─────────────

/**
 * The page a work record opens on, by its workflow, or undefined where no page shows that
 * workflow's records. The shell answers it from the rows that declare a workflow (UiRow), and
 * hands it to every owner on its read.
 */
export type WorkRoute = (workflow: string, id: string) => string | undefined;

/** A link to a work record: its key, and its page and its kind's word where a page shows it. */
export function workLink(route: WorkRoute, workflow: string, id: string) {
  const page = route(workflow, id);
  return {
    to: { key: runningKey('work', id), ...(page ? { route: page } : {}) },
    ...(page ? { kind: workflow[0]!.toUpperCase() + workflow.slice(1) } : {}),
  };
}

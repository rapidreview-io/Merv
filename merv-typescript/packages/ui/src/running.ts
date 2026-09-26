import {
  check,
  keyKind,
  mapAsync,
  MervError,
  runningKeyPattern,
  visible,
  type Caller,
  type Json,
  type RunningAction,
  type RunningAttention,
  type RunningBoard,
  type RunningEdge,
  type RunningFact,
  type RunningHeader,
  type RunningLane,
  type RunningLaneName,
  type RunningLinkRow,
  type RunningMark,
  type RunningMoney,
  type RunningNode,
  type RunningNodeLink,
  type RunningPanel,
  type RunningPhrase,
  type RunningPlace,
  type RunningRow,
  type RunningSection,
  type RunningStreamItem,
  type RunningSummary,
  type RunningTarget,
  type RunningValue,
  type RunningVerb,
} from '@merv/contracts';
import type { RunningContribution, RunningRead } from './types.js';

/**
 * The Running page's one read. Each plugin that owns something in flight registers a
 * contribution from its own ui adapter; this module asks every contribution for its part,
 * checks each part against the contract, and composes the board and the sidebars. The rules
 * about what a thing is and when it needs a person stay with its owner: here are only the
 * rules about how parts from several owners meet — marks, absorption, the edges between
 * lanes, the order of a lane and of a sidebar — and the refusal of anything malformed.
 *
 * Both reads run inside the read-only tool's PostgreSQL snapshot, so every part reads one
 * consistent project and none may write. Parts are read one at a time, each behind a
 * savepoint of that snapshot, so a statement that fails in one part, a timeout included,
 * costs that part alone. Nothing here waits on a timer or on a service outside this
 * process: an owner whose facts are remote serves them from a cache it fills on its own
 * timer, and says how old they are.
 */

const LANES: readonly RunningLaneName[] = ['work', 'sessions', 'hardware'];
/** The sidebar's reading order. Live facts come before what the record is. */
const PLACES: readonly RunningPlace[] = [
  'progress',
  'activity',
  'review',
  'relations',
  'code',
  'content',
  'machine',
  'details',
];
const VERBS = new Set<RunningVerb>([
  'waits on',
  'works on',
  'reviews',
  'reads',
  'rented for',
  'runs for',
  'checks',
]);
/** The verbs by which a session lends its dot to the work it is on. */
const WORKING = new Set<RunningVerb>(['works on', 'reviews']);
/**
 * Where each owner's part stands, to name it when its adapter is configured but not running:
 * such an adapter registered nothing, and the board must not draw that silence as fact. Marks
 * are held on work, so an owner that marks is missing there too. Reviews only adds sections.
 * An owner that begins to draw on the board adds itself here.
 */
const STANDS = new Map<string, readonly RunningLaneName[]>([
  ['tasks', ['work']],
  ['experiments', ['work', 'hardware']],
  ['reflections', ['work']],
  ['code-research', ['work', 'hardware']],
  ['sessions', ['work', 'sessions']],
  ['fleet', ['sessions']],
  ['sandboxes', ['hardware']],
]);
/** Strongest first. */
const DOTS: readonly NonNullable<RunningNode['dot']>[] = ['moving', 'live', 'starting'];
const LOOKS = new Set(['solid', 'dashed', 'quiet']);
const ACTION_VERBS = new Set(['start', 'pause', 'halt', 'extend', 'release']);
const STREAM_STATES = new Set(['running', 'succeeded', 'failed', 'interrupted']);

/** Nodes drawn per lane; the rest are counted in `more`. */
export const LANE_CAP = 200;
const PHRASE_PARTS = 16;
const PANEL_SECTIONS = 16;
const ALIASES = 16;

const ownerPattern = /^[a-z][a-z0-9-]{0,31}$/;
const kindPattern = /^[a-z][a-z-]{0,23}$/;
const toolPattern = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
/** A page of this app: one leading slash, never two, and only characters a path may carry. */
const routePattern = /^\/(?![/\\])[A-Za-z0-9\-._~%!$&'()*+,;=:@/?#]{0,499}$/;
const moneyPattern = /^-?\d{1,15}(\.\d{1,12})?$/;
/** The shell ends every link with its own arrow, so an owner's trailing one is dropped. */
const trailingArrow = /\s*[→↗]\s*$/u;

// ─── Registry ─────────────────────────────────────────────────────────────────────────────

/** Contributions registered by owner adapters; a disposed one leaves the page at once. */
export class RunningRegistry {
  private readonly entries = new Map<string, { contribution: RunningContribution }>();

  contribute(contribution: RunningContribution): () => void {
    check(
      !!contribution && typeof contribution === 'object',
      'invalid_contribution',
      'Contribution must be an object',
    );
    const { owner, kinds, lanes } = contribution;
    check(
      typeof owner === 'string' && ownerPattern.test(owner),
      'invalid_contribution',
      'Contribution owner must be a lowercase plugin name',
    );
    check(
      kinds === undefined ||
        (Array.isArray(kinds) &&
          kinds.every((kind) => typeof kind === 'string' && kindPattern.test(kind))),
      'invalid_contribution',
      'Contribution kinds must be lowercase key kinds',
    );
    check(
      lanes === undefined || (Array.isArray(lanes) && lanes.every((lane) => LANES.includes(lane))),
      'invalid_contribution',
      'Contribution lanes must be work, sessions or hardware',
    );
    for (const member of ['marks', 'nodes', 'summary', 'panel', 'sections'] as const)
      check(
        contribution[member] === undefined || typeof contribution[member] === 'function',
        'invalid_contribution',
        `Contribution ${member} must be a function`,
      );
    check(
      !this.entries.has(owner),
      'contribution_conflict',
      `A Running contribution is already registered for ${owner}`,
      409,
    );
    const entry = { contribution };
    this.entries.set(owner, entry);
    return () => {
      if (this.entries.get(owner) === entry) this.entries.delete(owner);
    };
  }

  /** By owner id, the tie-break for everything the board orders. */
  contributions(): RunningContribution[] {
    return [...this.entries.values()]
      .map(({ contribution }) => contribution)
      .sort((a, b) => (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0));
  }
}

/** What a Running read draws from. */
export interface RunningSources {
  /** The registered contributions, in owner order. */
  contributions(): readonly RunningContribution[];
  /** The registered tool names, read once per answer: an action for any other tool is not sent. */
  tools(): Promise<Iterable<string>>;
  /**
   * Runs one part alone, so that a statement failing inside it fails only that part: in the
   * application, behind its own savepoint of the read's snapshot. Parts come one at a time.
   */
  isolated?<T>(read: () => Promise<T>): Promise<T>;
  /**
   * Owners whose ui adapter is configured and switched on but is not running: it failed, or
   * waits on a plugin it needs. Each is named as failed in the lanes it would draw in.
   */
  absent?(): readonly string[];
}

// ─── Validation: every part is checked, and what fails is left out ────────────────────────

type Loose = Record<string, unknown>;
const isObject = (value: unknown): value is Loose =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const words = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max && visible(value);
const instant = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 64 && !Number.isNaN(Date.parse(value));
const count = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) <= max;
const seconds = (value: unknown): value is number | undefined =>
  value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
const flag = (value: unknown): value is boolean | undefined =>
  value === undefined || typeof value === 'boolean';
const isKey = (value: unknown): value is string =>
  typeof value === 'string' && runningKeyPattern.test(value);
const route = (value: unknown): value is string =>
  typeof value === 'string' && routePattern.test(value);
function https(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2000 || !/^https:\/\/\S+$/.test(value))
    return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/** A key the board can select, a page of this app, or an https page outside it. */
export function targetOf(value: unknown): RunningTarget | null {
  if (!isObject(value)) return null;
  if ('href' in value) return https(value.href) ? { href: value.href } : null;
  if ('key' in value) {
    if (!isKey(value.key)) return null;
    if (value.route === undefined) return { key: value.key };
    return route(value.route) ? { key: value.key, route: value.route } : null;
  }
  if ('route' in value) return route(value.route) ? { route: value.route } : null;
  return null;
}

/** Undefined when the value is not money; null is money that is not known. */
function moneyOf(value: unknown): RunningMoney | null | undefined {
  if (value === null) return null;
  if (!isObject(value)) return undefined;
  return typeof value.amount === 'string' &&
    moneyPattern.test(value.amount) &&
    typeof value.currency === 'string' &&
    /^[A-Z]{3}$/.test(value.currency)
    ? { amount: value.amount, currency: value.currency }
    : undefined;
}

function valueOf(part: unknown): RunningValue | null {
  if (typeof part === 'string') return part.length <= 1000 ? part : null;
  if (!isObject(part)) return null;
  if ('mono' in part) return words(part.mono, 400) ? { mono: part.mono } : null;
  if ('state' in part) return words(part.state, 64) ? { state: part.state } : null;
  if ('ago' in part) return instant(part.ago) ? { ago: part.ago } : null;
  if ('since' in part || 'until' in part) {
    const at = 'since' in part ? part.since : part.until;
    if (!instant(at) || !seconds(part.of)) return null;
    const of = part.of === undefined ? {} : { of: part.of };
    return 'since' in part ? { since: at, ...of } : { until: at, ...of };
  }
  if ('count' in part)
    return count(part.count) && (part.of === undefined || count(part.of))
      ? { count: part.count, ...(part.of === undefined ? {} : { of: part.of }) }
      : null;
  if ('money' in part) {
    const money = moneyOf(part.money);
    const of = part.of === undefined ? null : moneyOf(part.of);
    const rate = part.rate === undefined ? null : moneyOf(part.rate);
    if (money === undefined || of === undefined || rate === undefined) return null;
    return {
      money,
      ...(part.of === undefined ? {} : { of }),
      ...(part.rate === undefined ? {} : { rate }),
    };
  }
  if ('actor' in part) {
    if (!words(part.actor, 200)) return null;
    if (part.prefix !== undefined && !(typeof part.prefix === 'string' && part.prefix.length <= 40))
      return null;
    if (part.unnamed !== undefined && !words(part.unnamed, 60)) return null;
    return {
      actor: part.actor,
      ...(part.prefix ? { prefix: part.prefix } : {}),
      ...(part.unnamed ? { unnamed: part.unnamed } : {}),
    };
  }
  if ('link' in part) {
    if (!words(part.text, 200)) return null;
    const text = part.text.replace(trailingArrow, '');
    if (!visible(text)) return null;
    // A link that goes nowhere this page may send a reader still says its words.
    const to = targetOf(part.link);
    return to ? { link: to, text } : text;
  }
  return null;
}

/** Words and facts in order, at most sixteen of them; null when any part is not one. */
export function phraseOf(value: unknown): RunningPhrase | null {
  if (!Array.isArray(value) || value.length > PHRASE_PARTS) return null;
  const parts = value.map(valueOf);
  return parts.every((part) => part !== null) ? (parts as RunningPhrase) : null;
}

export function attentionOf(value: unknown): RunningAttention | null {
  if (!isObject(value)) return null;
  const says = phraseOf(value.says);
  if (!says?.length) return null;
  if (value.who !== undefined && !words(value.who, 120)) return null;
  // A way to the move that goes nowhere is left off; the person's need still stands.
  const to = isObject(value.to) && words(value.to.text, 40) ? targetOf(value.to) : null;
  const text = to && (value.to as Loose & { text: string }).text.replace(trailingArrow, '');
  return {
    says,
    ...(value.who === undefined ? {} : { who: value.who }),
    ...(to && text && visible(text) ? { to: { ...to, text } } : {}),
    ...(value.quiet === true ? { quiet: true as const } : {}),
  };
}

export function markOf(value: unknown): RunningMark | null {
  if (!isObject(value) || !isKey(value.key)) return null;
  const attention = attentionOf(value);
  return attention && { key: value.key, ...attention };
}

function linkOf(value: unknown): RunningNodeLink | null {
  if (!isObject(value) || !isKey(value.to) || !VERBS.has(value.verb as RunningVerb)) return null;
  if (!flag(value.waiting)) return null;
  return {
    to: value.to,
    verb: value.verb as RunningVerb,
    ...(value.waiting ? { waiting: true } : {}),
  };
}

/** A card, as its owner drew it, or null when any of it breaks the contract. */
export function nodeOf(value: unknown): RunningNode | null {
  if (!isObject(value)) return null;
  const { key, lane, title, look } = value;
  if (!isKey(key) || !LANES.includes(lane as RunningLaneName) || !words(title, 200)) return null;
  if (!LOOKS.has(look as string)) return null;
  if (value.kind !== undefined && !words(value.kind, 40)) return null;
  if (value.name !== undefined && !words(value.name, 200)) return null;
  if (!Array.isArray(value.lines) || value.lines.length > 2) return null;
  const lines = value.lines.map(phraseOf);
  if (lines.some((line) => !line)) return null;
  if (value.dot !== undefined && !DOTS.includes(value.dot as NonNullable<RunningNode['dot']>))
    return null;
  const attention = value.attention === undefined ? undefined : attentionOf(value.attention);
  if (attention === null) return null;
  const units = value.units;
  if (
    units !== undefined &&
    !(isObject(units) && count(units.count, 64) && typeof units.busy === 'boolean')
  )
    return null;
  if (value.links !== undefined && !(Array.isArray(value.links) && value.links.length <= 64))
    return null;
  const links = ((value.links as unknown[] | undefined) ?? []).map(linkOf);
  if (links.some((link) => !link)) return null;
  if (
    value.aliases !== undefined &&
    !(Array.isArray(value.aliases) && value.aliases.length <= ALIASES && value.aliases.every(isKey))
  )
    return null;
  if (value.rank !== undefined && !(typeof value.rank === 'number' && Number.isFinite(value.rank)))
    return null;
  return {
    key,
    lane: lane as RunningLaneName,
    ...(value.kind === undefined ? {} : { kind: value.kind }),
    title,
    ...(value.name === undefined ? {} : { name: value.name }),
    lines: lines as RunningPhrase[],
    look: look as RunningNode['look'],
    ...(value.dot === undefined ? {} : { dot: value.dot as RunningNode['dot'] }),
    ...(attention ? { attention } : {}),
    ...(isObject(units)
      ? { units: { count: units.count as number, busy: units.busy as boolean } }
      : {}),
    ...(links.length ? { links: links as RunningNodeLink[] } : {}),
    ...((value.aliases as string[] | undefined)?.length
      ? { aliases: [...new Set(value.aliases as string[])] }
      : {}),
    ...(value.rank === undefined ? {} : { rank: value.rank as number }),
  };
}

/**
 * A control this caller may use, or null. The owner decides `allowed`; a tool this server
 * does not have, or input that is not a small JSON object, is not sent either. The input
 * goes to the browser as it came and is sent back as it is.
 */
export function actionOf(value: unknown, tools: ReadonlySet<string>): RunningAction | null {
  if (!isObject(value) || value.allowed !== true) return null;
  const { label, verb, tool, input } = value;
  if (!words(label, 40) || !ACTION_VERBS.has(verb as string)) return null;
  if (typeof tool !== 'string' || !toolPattern.test(tool) || !tools.has(tool)) return null;
  if (!isObject(input)) return null;
  let encoded: string;
  try {
    encoded = JSON.stringify(input);
  } catch {
    return null;
  }
  if (Buffer.byteLength(encoded) > 4096) return null;
  const guard = value.guard;
  if (
    guard !== undefined &&
    !(isObject(guard) && words(guard.title, 80) && words(guard.consequence, 400))
  )
    return null;
  const expect = value.expect;
  if (
    expect !== undefined &&
    !(
      isObject(expect) &&
      typeof expect.field === 'string' &&
      /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(expect.field) &&
      typeof expect.min === 'number' &&
      Number.isFinite(expect.min) &&
      words(expect.nothing, 120)
    )
  )
    return null;
  return {
    label,
    verb: verb as RunningAction['verb'],
    tool,
    input: JSON.parse(encoded) as Record<string, Json>,
    allowed: true,
    // Only a start wears the accent; a pause, a halt or a release never does.
    ...(value.primary === true && verb === 'start' ? { primary: true } : {}),
    ...(isObject(guard)
      ? { guard: { title: guard.title as string, consequence: guard.consequence as string } }
      : {}),
    ...(isObject(expect)
      ? {
          expect: {
            field: expect.field as string,
            min: expect.min as number,
            nothing: expect.nothing as string,
          },
        }
      : {}),
  };
}

const actionsOf = (value: unknown, tools: ReadonlySet<string>): RunningAction[] =>
  Array.isArray(value)
    ? value.map((action) => actionOf(action, tools)).filter((action) => action !== null)
    : [];

export function summaryOf(value: unknown, tools: ReadonlySet<string>): RunningSummary | null {
  if (!isObject(value) || !LANES.includes(value.lane as RunningLaneName)) return null;
  const says = phraseOf(value.says);
  if (!says) return null;
  const attention = value.attention === undefined ? undefined : attentionOf(value.attention);
  if (attention === null) return null;
  if (!Array.isArray(value.actions) || value.actions.length > 4) return null;
  return {
    lane: value.lane as RunningLaneName,
    says,
    ...(attention ? { attention } : {}),
    actions: actionsOf(value.actions, tools),
  };
}

function factOf(value: unknown): RunningFact | null {
  if (!isObject(value) || !words(value.label, 60) || !flag(value.attention)) return null;
  const phrase = phraseOf(value.value);
  return (
    phrase && { label: value.label, value: phrase, ...(value.attention ? { attention: true } : {}) }
  );
}

function rowOf(value: unknown, columns: number): RunningRow | null {
  if (!isObject(value) || !Array.isArray(value.cells) || value.cells.length !== columns)
    return null;
  if (!flag(value.attention)) return null;
  const cells = value.cells.map(phraseOf);
  if (cells.some((cell) => !cell)) return null;
  const to = value.to === undefined ? null : targetOf(value.to);
  return {
    cells: cells as RunningPhrase[],
    ...(to ? { to } : {}),
    ...(value.attention ? { attention: true } : {}),
  };
}

function jumpOf(value: unknown): RunningLinkRow | null {
  if (!isObject(value) || !words(value.name, 200) || !flag(value.attention)) return null;
  const to = targetOf(value.to);
  if (!to) return null;
  if (value.kind !== undefined && !words(value.kind, 40)) return null;
  const says = value.says === undefined ? undefined : phraseOf(value.says);
  if (says === null) return null;
  return {
    to,
    ...(value.kind === undefined ? {} : { kind: value.kind }),
    name: value.name,
    ...(says ? { says } : {}),
    ...(value.attention ? { attention: true } : {}),
  };
}

function itemOf(value: unknown): RunningStreamItem | null {
  if (!isObject(value) || !instant(value.at)) return null;
  if ('mark' in value) {
    const mark = phraseOf(value.mark);
    return mark?.length ? { mark, at: value.at } : null;
  }
  if (!words(value.call, 200) || !STREAM_STATES.has(value.state as string)) return null;
  if (!(value.ms === null || (typeof value.ms === 'number' && Number.isFinite(value.ms))))
    return null;
  return {
    call: value.call,
    state: value.state as 'running' | 'succeeded' | 'failed' | 'interrupted',
    at: value.at,
    ms: value.ms as number | null,
  };
}

const kept = <T>(values: unknown[], of: (value: unknown) => T | null): T[] =>
  values.map(of).filter((value): value is T => value !== null);

/**
 * One sidebar section, or null when it breaks the contract or says nothing. A row that
 * breaks it is left out and the rest of the section stands.
 */
export function sectionOf(value: unknown): RunningSection | null {
  if (!isObject(value) || !words(value.title, 60)) return null;
  if (!PLACES.includes(value.place as RunningPlace)) return null;
  if (!flag(value.attention) || !flag(value.folded)) return null;
  const aside = value.aside === undefined ? undefined : phraseOf(value.aside);
  if (aside === null) return null;
  const frame = {
    title: value.title,
    place: value.place as RunningPlace,
    ...(aside?.length ? { aside } : {}),
    ...(value.attention ? { attention: true } : {}),
    ...(value.folded ? { folded: true } : {}),
  };
  switch (value.kind) {
    case 'text': {
      if (typeof value.text !== 'string' || value.text.length > 16_000 || !visible(value.text))
        return null;
      if (!flag(value.markdown) || !flag(value.truncated)) return null;
      if (value.clamp !== undefined && !(count(value.clamp, 40) && value.clamp > 0)) return null;
      return {
        ...frame,
        kind: 'text',
        text: value.text,
        ...(value.markdown ? { markdown: true } : {}),
        ...(value.clamp === undefined ? {} : { clamp: value.clamp as number }),
        ...(value.truncated ? { truncated: true } : {}),
      };
    }
    case 'facts': {
      if (!Array.isArray(value.rows) || value.rows.length > 24) return null;
      const rows = kept(value.rows, factOf);
      return rows.length ? { ...frame, kind: 'facts', rows } : null;
    }
    case 'table': {
      const columns = value.columns;
      if (!Array.isArray(columns) || !columns.length || columns.length > 6) return null;
      if (!columns.every((column) => words(column, 40))) return null;
      if (!Array.isArray(value.rows) || value.rows.length > 50) return null;
      const rows = kept(value.rows, (row) => rowOf(row, columns.length));
      return rows.length ? { ...frame, kind: 'table', columns: columns as string[], rows } : null;
    }
    case 'links': {
      if (!Array.isArray(value.rows) || value.rows.length > 50) return null;
      const rows = kept(value.rows, jumpOf);
      return rows.length ? { ...frame, kind: 'links', rows } : null;
    }
    case 'ladder': {
      const graph = value.graph;
      if (!isObject(graph) || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges))
        return null;
      if (typeof graph.state !== 'string' || !graph.nodes.length) return null;
      return { ...frame, kind: 'ladder', graph: graph as never };
    }
    case 'stream': {
      if (!Array.isArray(value.items) || value.items.length > 60 || !count(value.total))
        return null;
      const items = kept(value.items, itemOf);
      return items.length || value.total
        ? { ...frame, kind: 'stream', items, total: value.total }
        : null;
    }
    default:
      return null;
  }
}

function headerOf(value: unknown): RunningHeader | null {
  if (!isObject(value) || !words(value.kind, 40) || !words(value.title, 200)) return null;
  const says = phraseOf(value.says);
  const attention = value.attention === undefined ? undefined : attentionOf(value.attention);
  if (!says || attention === null) return null;
  return { kind: value.kind, title: value.title, says, ...(attention ? { attention } : {}) };
}

const keysOf = (value: unknown, except: string): string[] =>
  Array.isArray(value)
    ? [...new Set(value.filter((key): key is string => isKey(key) && key !== except))]
    : [];

// ─── Composition rules, pure so a test can hold each one ──────────────────────────────────

/**
 * Absorption. A node takes in the keys it lists as aliases, and whatever those keys took in
 * comes with them, so a session that absorbs its Fleet VM also absorbs the sandbox the VM
 * absorbed. Nodes are read in contribution order; a key claimed twice stays with its first
 * claimant, and a claim that would close a loop is refused. `alias` maps each absorbed key
 * to the node that draws it now; `absorbed` lists, per drawing node, every key it took in,
 * in claim order.
 */
export function fold(nodes: readonly RunningNode[]): {
  alias: Map<string, string>;
  absorbed: Map<string, string[]>;
} {
  const claim = new Map<string, string>();
  const above = (key: string) => {
    const chain: string[] = [key];
    for (let next = claim.get(key); next !== undefined; next = claim.get(next)) chain.push(next);
    return chain;
  };
  for (const node of nodes)
    for (const key of node.aliases ?? []) {
      if (key === node.key || claim.has(key)) continue;
      if (above(node.key).includes(key)) continue;
      claim.set(key, node.key);
    }
  const alias = new Map<string, string>();
  const absorbed = new Map<string, string[]>();
  for (const key of claim.keys()) {
    const chain = above(key);
    const root = chain[chain.length - 1];
    alias.set(key, root);
    absorbed.set(root, [...(absorbed.get(root) ?? []), key]);
  }
  return { alias, absorbed };
}

/**
 * The edges the board draws: every link of a drawn node, redirected through absorption, to
 * another drawn node. A link to a key nobody draws, such as a done prerequisite, is dropped
 * here, and the panel still names it.
 */
export function edgesOf(
  nodes: readonly RunningNode[],
  alias: ReadonlyMap<string, string>,
): RunningEdge[] {
  const drawn = new Set(nodes.map((node) => node.key));
  const seen = new Set<string>();
  const edges: RunningEdge[] = [];
  for (const node of nodes)
    for (const link of node.links ?? []) {
      const to = alias.get(link.to) ?? link.to;
      const id = `${node.key}|${to}|${link.verb}`;
      if (to === node.key || !drawn.has(to) || seen.has(id)) continue;
      seen.add(id);
      edges.push({ from: node.key, to, verb: link.verb, waiting: !!link.waiting });
    }
  return edges;
}

const needsPerson = (attention: RunningAttention | undefined) => !!attention && !attention.quiet;

/**
 * A lane's order: what needs a person first, then each owner's rank, then contribution
 * order (by owner id), then title.
 */
export function order(nodes: readonly RunningNode[], owners: readonly string[]): RunningNode[] {
  const position = (owner: string | undefined) => {
    const at = owners.indexOf(owner ?? '');
    return at < 0 ? owners.length : at;
  };
  return [...nodes].sort(
    (a, b) =>
      Number(needsPerson(b.attention)) - Number(needsPerson(a.attention)) ||
      (a.rank ?? 0) - (b.rank ?? 0) ||
      position(a.owner) - position(b.owner) ||
      a.title.localeCompare(b.title),
  );
}

/**
 * A sidebar's sections from several owners, read in one order: what needs a person first,
 * then by place, and within a place by who wrote it, the node's owner first, then the owners
 * of what it absorbed, then the others. `parts` comes in that order. A section that breaks
 * the contract or says nothing is left out, and at most sixteen are kept.
 */
export function compose(parts: readonly { owner: string; sections: unknown }[]): RunningSection[] {
  const ranked = parts.flatMap(({ owner, sections }, from) =>
    (Array.isArray(sections) ? sections : [])
      .map(sectionOf)
      .filter((section) => section !== null)
      .map((section) => ({ section: { ...section, owner }, from })),
  );
  return ranked
    .map((entry, at) => ({ ...entry, at }))
    .sort(
      (a, b) =>
        Number(!!b.section.attention) - Number(!!a.section.attention) ||
        PLACES.indexOf(a.section.place) - PLACES.indexOf(b.section.place) ||
        a.from - b.from ||
        a.at - b.at,
    )
    .slice(0, PANEL_SECTIONS)
    .map(({ section }) => section);
}

/** Among a node's own attention and the marks on it, a person's need outranks a quiet line. */
const strongest = (candidates: (RunningAttention | undefined)[]) => {
  const present = candidates.filter((candidate) => candidate !== undefined);
  return present.find(needsPerson) ?? present[0];
};

/**
 * A work node's dot is the board's: the strongest dot among the sessions working on it or
 * reviewing it, leaving out any session that itself needs a person, whose red is the news.
 */
function workDots(nodes: RunningNode[], alias: ReadonlyMap<string, string>): void {
  const best = new Map<string, number>();
  for (const node of nodes) {
    const strength = node.dot ? DOTS.indexOf(node.dot) : -1;
    if (strength < 0 || needsPerson(node.attention)) continue;
    for (const link of node.links ?? []) {
      if (!WORKING.has(link.verb)) continue;
      const to = alias.get(link.to) ?? link.to;
      if (to === node.key) continue;
      best.set(to, Math.min(best.get(to) ?? DOTS.length, strength));
    }
  }
  for (const node of nodes) {
    if (node.lane !== 'work') continue;
    const strength = best.get(node.key);
    if (strength === undefined) delete node.dot;
    else node.dot = DOTS[strength];
  }
}

// ─── The two reads ────────────────────────────────────────────────────────────────────────

/** This is a person's monitor. A leased worker or a managed runner reads its own work elsewhere. */
function refuseWorkers(caller: Caller): void {
  check(
    !caller.session && !caller.managed,
    'running_forbidden',
    'Leased workers and managed runners cannot read the Running page',
    403,
  );
}

type Isolated = <T>(read: () => Promise<T>) => Promise<T>;
/** One part at a time, each alone: behind a savepoint in the application, as it is in a test. */
const isolation =
  (sources: RunningSources): Isolated =>
  async (read) =>
    sources.isolated ? await sources.isolated(read) : await read();

/** A part refused to this caller, or naming nothing, is absent; any other failure is reported. */
type Part<T> = { value: T } | { refused: true } | { failed: true };
async function part<T>(isolated: Isolated, read: () => Promise<T>): Promise<Part<T>> {
  try {
    return { value: await isolated(read) };
  } catch (error) {
    return error instanceof MervError && (error.status === 403 || error.status === 404)
      ? { refused: true }
      : { failed: true };
  }
}

/** Each contribution's read for one answer, with its own `once` memo shared by every member. */
function readers(caller: Caller) {
  const memos = new Map<RunningContribution, Map<string, Promise<unknown>>>();
  return (contribution: RunningContribution, include: Iterable<string> = []): RunningRead => {
    let memo = memos.get(contribution);
    if (!memo) memos.set(contribution, (memo = new Map()));
    const own = memo;
    return {
      caller,
      include: new Set(include),
      once<T>(name: string, read: () => Promise<T>): Promise<T> {
        let value = own.get(name);
        if (!value) own.set(name, (value = Promise.resolve().then(read)));
        return value as Promise<T>;
      },
    };
  };
}

function toolNames(sources: RunningSources): () => Promise<ReadonlySet<string>> {
  let names: Promise<ReadonlySet<string>> | undefined;
  return () =>
    (names ??= sources.tools().then(
      (list) => new Set(list),
      () => new Set<string>(),
    ));
}

/** Where a part stands on the board: the lanes it declares, and any its nodes landed in. */
const lanesOf = (
  contribution: RunningContribution,
  nodes: readonly RunningNode[] = [],
): RunningLaneName[] => {
  const lanes = new Set<RunningLaneName>([
    ...(contribution.lanes ?? []),
    ...nodes.map((node) => node.lane),
  ]);
  return lanes.size ? [...lanes] : ['work'];
};

/**
 * ui.running: everything in flight, in three lanes. Every owner's marks are read first, so a
 * key one owner holds on the board reaches the owner that draws it. Then each owner's nodes
 * and lane summary are read, in owner order, each part alone. A part refused to this caller
 * is absent; a part that fails names its owner in its lanes, as does an owner whose adapter
 * is not running, and the rest of the board stands.
 */
export async function runningBoard(sources: RunningSources, caller: Caller): Promise<RunningBoard> {
  refuseWorkers(caller);
  const contributions = sources.contributions();
  const owners = contributions.map(({ owner }) => owner);
  const read = readers(caller);
  const tools = toolNames(sources);
  const isolated = isolation(sources);
  const failed = new Map<RunningLaneName, Set<string>>(LANES.map((lane) => [lane, new Set()]));
  const fail = (lanes: readonly RunningLaneName[], owner: string) =>
    lanes.forEach((lane) => failed.get(lane)!.add(owner));
  for (const owner of sources.absent?.() ?? []) {
    const lanes = STANDS.get(owner);
    if (lanes && !owners.includes(owner)) fail(lanes, owner);
  }

  const marks: RunningMark[] = [];
  const markParts = await mapAsync(contributions, async (contribution) =>
    contribution.marks
      ? await part(isolated, async () => await contribution.marks!(read(contribution)))
      : null,
  );
  markParts.forEach((answer, at) => {
    if (!answer || 'refused' in answer) return;
    // Marks are held on work: a failure there is where the held work goes missing.
    if ('failed' in answer || !Array.isArray(answer.value)) return fail(['work'], owners[at]);
    marks.push(...kept(answer.value, markOf));
  });
  const include = marks.map(({ key }) => key);

  const parts = await mapAsync(contributions, async (contribution) => {
    const own = read(contribution, include);
    const nodes = contribution.nodes
      ? await part(isolated, async () => await contribution.nodes!(own))
      : null;
    const summary = contribution.summary
      ? await part(isolated, async () => await contribution.summary!(own))
      : null;
    return { contribution, nodes, summary };
  });

  const drawn: RunningNode[] = [];
  const keys = new Set<string>();
  const pending = new Set<RunningLaneName>();
  const cached: { lanes: RunningLaneName[]; asOf: string; freshForMs?: number }[] = [];
  const summaries: RunningSummary[] = [];
  const names = await tools();
  for (const { contribution, nodes, summary } of parts) {
    const { owner } = contribution;
    if (nodes && !('refused' in nodes)) {
      if ('failed' in nodes || !isObject(nodes.value) || !Array.isArray(nodes.value.nodes)) {
        fail(lanesOf(contribution), owner);
      } else {
        const own: RunningNode[] = [];
        for (const node of kept(nodes.value.nodes, nodeOf)) {
          // Two nodes under one key: the first, in contribution order, is the one drawn.
          if (keys.has(node.key)) continue;
          keys.add(node.key);
          own.push(node);
          drawn.push({ ...node, owner });
        }
        const lanes = lanesOf(contribution, own);
        const { asOf, freshForMs } = nodes.value as Loose;
        if (nodes.value.failed === true) fail(lanes, owner);
        if (nodes.value.pending === true) lanes.forEach((lane) => pending.add(lane));
        if (instant(asOf))
          cached.push({
            lanes,
            asOf,
            ...(typeof freshForMs === 'number' && Number.isFinite(freshForMs) && freshForMs > 0
              ? { freshForMs: Math.round(freshForMs) }
              : {}),
          });
      }
    }
    if (summary && !('refused' in summary)) {
      if ('failed' in summary) fail(lanesOf(contribution), owner);
      else if (summary.value !== null && summary.value !== undefined) {
        const clean = summaryOf(summary.value, names);
        if (clean) summaries.push({ ...clean, owner });
      }
    }
  }

  // Absorbed nodes leave their lanes; what they needed a person for becomes a mark on the
  // node that took them in, below that node's own attention and below every owner's mark.
  const { alias, absorbed } = fold(drawn);
  const remaining = drawn.filter(({ key }) => !alias.has(key));
  for (const node of drawn)
    if (alias.has(node.key) && node.attention)
      marks.push({ ...node.attention, key: alias.get(node.key)! });
  const onBoard = new Set(remaining.map(({ key }) => key));
  const marked = new Map<string, RunningAttention[]>();
  for (const { key, ...attention } of marks) {
    const at = alias.get(key) ?? key;
    if (onBoard.has(at)) marked.set(at, [...(marked.get(at) ?? []), attention]);
  }
  for (const node of remaining) {
    const attention = strongest([node.attention, ...(marked.get(node.key) ?? [])]);
    if (attention) node.attention = attention;
    const took = absorbed.get(node.key);
    if (took?.length) node.aliases = took;
    else delete node.aliases;
  }
  workDots(remaining, alias);

  const lanes = {} as Record<RunningLaneName, RunningLane>;
  const shown: RunningNode[] = [];
  for (const lane of LANES) {
    const all = order(
      remaining.filter((node) => node.lane === lane),
      owners,
    );
    const own = summaries.filter((summary) => summary.lane === lane);
    const nodes = all.slice(0, LANE_CAP);
    shown.push(...nodes);
    const caches = cached.filter((entry) => entry.lanes.includes(lane));
    const oldest = caches.reduce<(typeof caches)[number] | undefined>(
      (a, b) => (!a || Date.parse(b.asOf) < Date.parse(a.asOf) ? b : a),
      undefined,
    );
    // The lane goes stale when its first cache does: the earliest of asOf + freshForMs.
    const deadlines = caches
      .filter((entry) => entry.freshForMs !== undefined)
      .map((entry) => Date.parse(entry.asOf) + entry.freshForMs!);
    lanes[lane] = {
      nodes,
      summaries: own,
      needsYou:
        all.filter((node) => needsPerson(node.attention)).length +
        own.filter((summary) => needsPerson(summary.attention)).length,
      ...(oldest ? { asOf: oldest.asOf } : {}),
      ...(oldest && deadlines.length
        ? { freshForMs: Math.max(0, Math.min(...deadlines) - Date.parse(oldest.asOf)) }
        : {}),
      ...(pending.has(lane) ? { pending: true as const } : {}),
      // By owner id, the order of contributions, whether or not the owner registered one.
      failed: [...failed.get(lane)!].sort(),
      ...(all.length > nodes.length ? { more: all.length - nodes.length } : {}),
    };
  }
  return { observedAt: new Date().toISOString(), lanes, edges: edgesOf(shown, alias) };
}

/**
 * ui.running_panel: one key's sidebar. The owner is the first contribution of the key's kind
 * whose panel answers; a 404 or null from a contribution means the key is not its, and any
 * other refusal or failure is the answer. The owners of what the node absorbed add their
 * sections without their head or controls, and every other owner may add sections about the
 * key or anything it absorbed; a part of theirs that fails is left out. Only the owner's
 * controls are sent, and only those allowed. Each part is read alone, as on the board.
 */
export async function runningPanel(
  sources: RunningSources,
  caller: Caller,
  key: string,
): Promise<RunningPanel> {
  refuseWorkers(caller);
  check(
    typeof key === 'string' && runningKeyPattern.test(key),
    'invalid_input',
    'A Running key is a lowercase kind, a colon and an id',
  );
  const contributions = sources.contributions();
  const read = readers(caller);
  const tools = toolNames(sources);
  const isolated = isolation(sources);
  const ownerOf = async (wanted: string, except?: RunningContribution, absorbedBy?: string) => {
    for (const contribution of contributions) {
      if (contribution === except || !contribution.panel) continue;
      if (!contribution.kinds?.includes(keyKind(wanted))) continue;
      try {
        const answer = await isolated(
          async () => await contribution.panel!(read(contribution), wanted, absorbedBy),
        );
        if (answer) return { contribution, part: answer as unknown };
      } catch (error) {
        if (!(error instanceof MervError && error.status === 404)) throw error;
      }
    }
    return null;
  };

  const found = await ownerOf(key);
  check(found, 'running_not_found', 'Nothing on the Running page has this key', 404);
  const { contribution: owner } = found;
  const own = isObject(found.part) ? found.part : {};
  const header = headerOf(own.header);
  if (!header)
    throw new MervError(
      'running_panel_invalid',
      `The ${owner.owner} sidebar for this key does not follow the Running contract`,
      500,
    );

  // What the node absorbed, and what that absorbed in turn, level by level.
  const aliases: string[] = [];
  const absorbed: { contribution: RunningContribution; sections: unknown }[] = [];
  const visited = new Set([key]);
  for (let level = keysOf(own.aliases, key); level.length;) {
    const next = [...new Set(level)]
      .filter((alias) => !visited.has(alias))
      .slice(0, ALIASES - aliases.length);
    next.forEach((alias) => {
      visited.add(alias);
      aliases.push(alias);
    });
    const answers = await mapAsync(
      next,
      async (alias) => await ownerOf(alias, owner, key).catch(() => null),
    );
    level = [];
    for (const answer of answers) {
      if (!answer || !isObject(answer.part)) continue;
      absorbed.push({ contribution: answer.contribution, sections: answer.part.sections });
      level.push(...keysOf(answer.part.aliases, key));
    }
    if (aliases.length >= ALIASES) break;
  }

  const absorbers = new Set(absorbed.map(({ contribution }) => contribution));
  const others = contributions.filter(
    (contribution) =>
      contribution !== owner && !absorbers.has(contribution) && contribution.sections,
  );
  const contributed = await mapAsync(others, async (contribution) => ({
    contribution,
    sections: await isolated(
      async () => await contribution.sections!(read(contribution), [key, ...aliases]),
    ).catch(() => []),
  }));

  const sections = compose(
    [{ contribution: owner, sections: own.sections }, ...absorbed, ...contributed].map(
      ({ contribution, sections }) => ({ owner: contribution.owner, sections }),
    ),
  );
  return {
    key,
    observedAt: new Date().toISOString(),
    header,
    sections,
    actions: actionsOf(own.actions, await tools()),
    ...(route(own.route) ? { route: own.route } : {}),
    live: own.live === true,
    aliases,
  };
}

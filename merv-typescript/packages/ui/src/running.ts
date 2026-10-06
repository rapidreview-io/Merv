import type { z } from 'zod';
import {
  check,
  keyId,
  keyKind,
  mapAsync,
  MervError,
  runningKeyPattern,
  runningSchema,
  sameOriginPath,
  type Caller,
  type RunningAction,
  type RunningAttention,
  type RunningBoard,
  type RunningEdge,
  type RunningLane,
  type RunningLaneName,
  type RunningMark,
  type RunningNode,
  type RunningPanel,
  type RunningSection,
  type RunningSummary,
  type RunningVerb,
  type Workflows,
  type WorkRoute,
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

const { runningAction, runningHeader, runningMark, runningNode, runningSection, runningSummary } =
  runningSchema;
const LANES = runningSchema.runningLane.options;
/** The sidebar's reading order. Live facts come before what the record is. */
const PLACES = runningSchema.runningPlace.options;
/** The verbs by which a session lends its dot to the work it is on. */
const WORKING = new Set<RunningVerb>(['works on', 'reviews']);
/** Strongest first. */
const DOTS: readonly NonNullable<RunningNode['dot']>[] = ['moving', 'live', 'starting'];

/** Nodes drawn per lane; the rest are counted in `more`. */
export const LANE_CAP = 200;
const PANEL_SECTIONS = 16;
const ALIASES = 16;

const ownerPattern = /^[a-z][a-z0-9-]{0,31}$/;
const kindPattern = /^[a-z][a-z-]{0,23}$/;

// ─── Registry ─────────────────────────────────────────────────────────────────────────────

/** Contributions registered by owner adapters; a disposed one leaves the page at once. */
export class RunningRegistry {
  private readonly entries = new Map<string, { contribution: RunningContribution }>();
  /**
   * Where each owner that contributed drew: its lanes, and work wherever it marks, since marks
   * are held on work. Kept after it leaves, so an adapter that stops running is named there
   * rather than drawn as silence.
   */
  readonly stood = new Map<string, readonly RunningLaneName[]>();

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
      contribution.workflows === undefined ||
        (Array.isArray(contribution.workflows) &&
          contribution.workflows.every((name) => typeof name === 'string' && name.length > 0)),
      'invalid_contribution',
      'Contribution workflows must be workflow names',
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
    const stands = new Set(lanes);
    if (contribution.marks) stands.add('work');
    this.stood.set(owner, [...stands]);
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
   * waits on a plugin it needs. Each is named as failed in the lanes it drew in.
   */
  absent?(): readonly { owner: string; lanes: readonly RunningLaneName[] }[];
  /** The page of a work record, by its workflow; without it, no work record has one. */
  route?: WorkRoute;
  /** The workflow of each of these work records this caller's project holds, by instance id. */
  workflows(caller: Caller, ids: readonly string[]): Promise<ReadonlyMap<string, string>>;
}

/** Each work record's workflow, as Workflows reads it; none while Workflows is not running. */
export const workflowsOf =
  (workflows: () => Pick<Workflows, 'revisions'> | undefined) =>
  async (caller: Caller, ids: readonly string[]): Promise<ReadonlyMap<string, string>> =>
    new Map(
      [...((await workflows()?.revisions(caller.projectId, ids)) ?? [])].map(([id, row]) => [
        id,
        row.workflow,
      ]),
    );

// ─── Validation: every part is parsed by the contract's schemas, and what fails is left out ─

type Loose = Record<string, unknown>;
const isObject = (value: unknown): value is Loose =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const instant = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 64 && !Number.isNaN(Date.parse(value));
const isKey = (value: unknown): value is string =>
  typeof value === 'string' && runningKeyPattern.test(value);

/** The part as the contract reads it, or null when it breaks the contract. */
const parsed =
  <T extends z.ZodTypeAny>(schema: T) =>
  (value: unknown): z.output<T> | null => {
    const result = schema.safeParse(value);
    return result.success ? result.data : null;
  };
const kept = <T>(values: unknown[], of: (value: unknown) => T | null): T[] =>
  values.map(of).filter((value): value is T => value !== null);

/** A key the board can select, a page of this app, or an https page outside it. */
export const targetOf = parsed(runningSchema.runningTarget);
/** Words and facts in order, at most sixteen of them; null when any part is not one. */
export const phraseOf = parsed(runningSchema.runningPhrase);
export const attentionOf = parsed(runningSchema.runningAttention);
export const markOf = parsed(runningMark);
/** A card, as its owner drew it, or null when any of it breaks the contract. */
export const nodeOf = parsed(runningNode);
/**
 * One sidebar section, or null when it breaks the contract or says nothing. A row that
 * breaks it is left out and the rest of the section stands.
 */
export const sectionOf = parsed(runningSection);
const headerOf = parsed(runningHeader);

/**
 * A control this caller may use, or null. The owner decides `allowed`; a tool this server
 * does not have, or input that is not a small JSON object, is not sent either. The input
 * goes to the browser as it came and is sent back as it is.
 */
export function actionOf(value: unknown, tools: ReadonlySet<string>): RunningAction | null {
  const action = parsed(runningAction)(value);
  return action && tools.has(action.tool) ? action : null;
}
const actionsOf = (value: unknown, tools: ReadonlySet<string>): RunningAction[] =>
  Array.isArray(value) ? kept(value, (action) => actionOf(action, tools)) : [];

/** Attention whose control is for a tool this server has; any other control is left off. */
function offered<T extends RunningAttention | undefined>(
  attention: T,
  tools: ReadonlySet<string>,
): T {
  if (!attention?.action || tools.has(attention.action.tool)) return attention;
  const { action: _, ...rest } = attention;
  return rest as T;
}

export function summaryOf(value: unknown, tools: ReadonlySet<string>): RunningSummary | null {
  const summary = parsed(runningSummary)(value);
  return (
    summary && {
      ...summary,
      ...(summary.attention ? { attention: offered(summary.attention, tools) } : {}),
      actions: summary.actions.filter(({ tool }) => tools.has(tool)),
    }
  );
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
function readers(caller: Caller, { route = () => undefined }: RunningSources) {
  const memos = new Map<RunningContribution, Map<string, Promise<unknown>>>();
  return (contribution: RunningContribution, include: Iterable<string> = []): RunningRead => {
    let memo = memos.get(contribution);
    if (!memo) memos.set(contribution, (memo = new Map()));
    const own = memo;
    return {
      caller,
      route,
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
  const read = readers(caller, sources);
  const tools = toolNames(sources);
  const isolated = isolation(sources);
  const failed = new Map<RunningLaneName, Set<string>>(LANES.map((lane) => [lane, new Set()]));
  const fail = (lanes: readonly RunningLaneName[], owner: string) =>
    lanes.forEach((lane) => failed.get(lane)!.add(owner));
  for (const { owner, lanes } of sources.absent?.() ?? [])
    if (!owners.includes(owner)) fail(lanes, owner);

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
    if (attention) node.attention = offered(attention, names);
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
 * whose panel answers, and for a work key, of those that declare its record's workflow; a 404 or null from a contribution means the key is not its, and any
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
  const read = readers(caller, sources);
  const tools = toolNames(sources);
  const isolated = isolation(sources);
  // A work key goes to the owners of its record's workflow, read once for every key it needs.
  const workflows = new Map<string, string>();
  const learn = async (keys: readonly string[]) => {
    const ids = keys.filter((key) => keyKind(key) === 'work').map(keyId);
    if (!ids.length) return;
    for (const [id, workflow] of await isolated(async () => await sources.workflows(caller, ids)))
      workflows.set(id, workflow);
  };
  const answers = (contribution: RunningContribution, key: string) =>
    !!contribution.panel &&
    !!contribution.kinds?.includes(keyKind(key)) &&
    (keyKind(key) !== 'work' || !!contribution.workflows?.includes(workflows.get(keyId(key))!));
  const ownerOf = async (wanted: string, except?: RunningContribution, absorbedBy?: string) => {
    for (const contribution of contributions) {
      if (contribution === except || !answers(contribution, wanted)) continue;
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

  await learn([key]);
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
    await learn(next).catch(() => undefined);
    const parts = await mapAsync(
      next,
      async (alias) => await ownerOf(alias, owner, key).catch(() => null),
    );
    level = [];
    for (const answer of parts) {
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
  const names = await tools();
  return {
    key,
    observedAt: new Date().toISOString(),
    header: header.attention ? { ...header, attention: offered(header.attention, names) } : header,
    sections,
    actions: actionsOf(own.actions, names),
    ...(sameOriginPath(own.route) ? { route: own.route } : {}),
    live: own.live === true,
    aliases,
  };
}

import { clip, type Caller, type Data, type Json } from '@merv/contracts';
import type { Tools } from '@merv/api/types';
import type { UiRow } from './types.js';

/** What the home pages draw, and the read-only tool that owns each part. */
const PARTS: [string, string][] = [
  ['project', 'project.get'],
  ['actors', 'actor.list'],
  ['claims', 'claim.list'],
  ['experiments', 'experiment.list'],
  ['tasks', 'task.list'],
  ['reviews', 'review.list'],
  ['cycles', 'research.list'],
  ['files', 'artifact.list'],
  // Without an instance, this one answers for every workflow in the project at once.
  ['workflows', 'workflow.status_and_next'],
];
/** The rows whose own read the page draws, and what each of them is asked for. */
const READS: [string, string, Record<string, unknown>?][] = [
  ['reflections', 'reflections'],
  ['paper', 'paper'],
  ['sessions', 'sessions'],
  ['connections', 'connections'],
  ['archive', 'legacy-history', { action: 'summary' }],
];

/** A part whose tool is absent, or whose answer this caller may not read, is null. */
const answer = async (fn: () => Promise<unknown>): Promise<Json> => {
  try {
    return ((await fn()) ?? null) as Json;
  } catch {
    return null;
  }
};

/**
 * Who is asking, where, and the shape of every deployed program — the states a
 * record can stand in, which a list draws beside its state word. The shell answers
 * all of it with its rows, so opening the app is one read rather than three.
 */
export async function identityOf(tools: Tools, caller: Caller): Promise<Record<string, Json>> {
  const [actor, project, workflows] = await Promise.all([
    tools.call('actor.whoami', caller, {}),
    tools.call('project.get', caller, {}),
    answer(async () => await tools.call('workflow.catalog', caller, {})),
  ]);
  return { actor: actor as Json, project: project as Json, workflows: workflows ?? [] };
}

/**
 * Everything the home pages draw, in one answer. Read-only tools run in one snapshot
 * scope, so this is a single consistent read of the project rather than twenty round
 * trips at a browser's latency. A part whose plugin is not loaded, or whose answer this
 * caller may not read, is null: the page draws what it has and never fails whole.
 */
export async function homeRead(
  tools: Tools,
  rows: UiRow[],
  read: (caller: Caller, rowId: string, params?: Record<string, unknown>) => Promise<Json>,
  caller: Caller,
): Promise<Json> {
  // The parts are independent read-only tools. This tool runs in one snapshot scope, so
  // they share its connection and their queries queue on it in turn; that costs tens of
  // milliseconds, where a scope of their own each would queue on the writer lock.
  const parts = await Promise.all(
    PARTS.map(async ([key, tool]) => [
      key,
      await answer(async () => await tools.call(tool, caller, {})),
    ]),
  );
  const reads = await Promise.all(
    READS.map(async ([key, kind, params]) => {
      const row = rows.find((item) => item.view.kind === kind && item.read);
      return [key, row ? await answer(async () => await read(caller, row.id, params)) : null];
    }),
  );
  return Object.fromEntries(
    [...parts, ...reads].map(([key, value]) => [key, trim(key as string, value as Json)]),
  ) as Json;
}

/**
 * What the map draws of each record, and nothing else: the page polls this answer,
 * and a project's full session history, findings and evidence were most of its weight.
 * An absent key is an answer of null, kept as it is.
 */
const KEEP: Record<string, string[]> = {
  actors: ['id', 'name', 'role', 'kind', 'active', 'sessionId'],
  claims: ['id', 'statement', 'scope', 'status', 'confidence', 'updatedAt'],
  experiments: ['id', 'name', 'intent', 'ownerId', 'testedClaimIds', 'workflow'],
  tasks: [
    'id',
    'title',
    'goal',
    'producerId',
    'acceptanceChecks',
    'deliveryIds',
    'dependencies',
    'workflow',
  ],
  reviews: ['id', 'subjectId', 'status', 'reviewerId', 'claimable', 'verdict', 'createdAt'],
  cycles: ['id', 'name', 'ownerId', 'workflow'],
  files: ['size'],
  reflections: ['id', 'title', 'ownerId', 'experimentIds', 'workflow'],
  connections: ['state'],
};
/** The map shows a summary of each record's prose; the record's page has all of it. */
const brief = (value: Json): Json =>
  typeof value === 'string' && value.length > 400
    ? `${clip(value, 399)}…`
    : Array.isArray(value)
      ? value.map((item) =>
          item && typeof item === 'object' && !Array.isArray(item) && 'text' in item
            ? Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'text'))
            : item,
        )
      : value;
const pick = (record: Json, keys: string[]): Json =>
  record && typeof record === 'object' && !Array.isArray(record)
    ? Object.fromEntries(
        keys.filter((key) => key in record).map((key) => [key, brief(record[key])]),
      )
    : record;
function trim(key: string, value: Json): Json {
  const keys = KEEP[key];
  if (keys && Array.isArray(value)) return value.map((item) => pick(item, keys));
  // The map draws each paper document's sections and whether it is published; the page
  // itself reads the paper, with its citations and proposals and every section in full.
  if (key === 'paper' && value && typeof value === 'object' && !Array.isArray(value)) {
    const documents = (value as { documents?: Record<string, Json> }).documents;
    return {
      documents: Object.fromEntries(
        Object.entries(documents ?? {}).map(([kind, document]) => {
          const { current, published } = document as Record<string, Json>;
          return [
            kind,
            {
              current: {
                ...(pick(current, ['kind', 'revision', 'updatedAt', 'updatedBy']) as Data),
                sections: Array.isArray((current as Record<string, Json>)?.sections)
                  ? ((current as Record<string, Json>).sections as Json[]).map((section) =>
                      pick(section, ['id', 'title', 'content']),
                    )
                  : [],
              },
              published: published ? pick(published as Json, ['publication']) : (published ?? null),
            },
          ];
        }),
      ),
    };
  }
  if (key === 'sessions' && value && typeof value === 'object' && !Array.isArray(value)) {
    const { sessions: _sessions, agents, runners, ...rest } = value as Record<string, Json>;
    return {
      ...rest,
      agents: Array.isArray(agents) ? agents.map((agent) => pick(agent, ['id', 'status'])) : agents,
      runners: Array.isArray(runners)
        ? runners.map((runner) => pick(runner, ['id', 'live']))
        : runners,
    };
  }
  return value;
}

import { clip, type Caller, type Json } from '@merv/contracts';
import type { Tools } from '@merv/api/types';
import type { UiRow } from './types.js';

/**
 * The shell's own parts of what Now and the rail read, the read-only tool that owns each,
 * and the fields of each record the pages read. Every other part is a row's (`UiRow.home`).
 */
const PARTS: [key: string, tool: string, keep?: string[]][] = [
  ['project', 'project.get'],
  ['actors', 'actor.list', ['id', 'name', 'role', 'kind', 'active', 'sessionId']],
  // Without an instance, this one answers for every workflow in the project at once.
  ['workflows', 'workflow.status_and_next'],
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
 * Everything Now and the rail read, in one answer: the shell's parts, and the records of
 * every row that declares a home part, under the row's id. Read-only tools run in one
 * snapshot scope, so this is a single consistent read of the project rather than twenty
 * round trips at a browser's latency. A part whose answer this caller may not read is
 * null: the page draws what it has and never fails whole.
 */
export async function homeRead(tools: Tools, rows: UiRow[], caller: Caller): Promise<Json> {
  const parts = [
    ...PARTS,
    ...rows.flatMap((row) =>
      row.home ? [[row.id, row.home.tool, row.home.keep, row.home.list] as const] : [],
    ),
  ];
  // The parts are independent read-only tools. This tool runs in one snapshot scope, so
  // they share its connection and their queries queue on it in turn; that costs tens of
  // milliseconds, where a scope of their own each would queue on the writer lock.
  return Object.fromEntries(
    await Promise.all(
      parts.map(async ([key, tool, keep, list]) => [
        key,
        trim(
          key,
          await answer(async () => await (list?.(caller) ?? tools.call(tool, caller, {}))),
          keep,
        ),
      ]),
    ),
  ) as Json;
}

/**
 * What the pages read of each record, and nothing else: they poll this answer, and a
 * record's findings and evidence would be most of its weight. A summary of each record's
 * prose is enough here; the record's page has all of it.
 */
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
const pick = (record: Json, keys: readonly string[]): Json =>
  record && typeof record === 'object' && !Array.isArray(record)
    ? Object.fromEntries(
        keys.filter((key) => key in record).map((key) => [key, brief(record[key])]),
      )
    : record;
function trim(key: string, value: Json, keep?: readonly string[]): Json {
  if (keep && Array.isArray(value)) return value.map((item) => pick(item, keep));
  if (key !== 'workflows' || !value || typeof value !== 'object' || Array.isArray(value))
    return value;
  // Of the overview, the gates Now reads: open work's, and ended work's a plugin still holds.
  return {
    workflows: ((value.workflows ?? []) as Gate[]).filter(
      (gate) => !gate.terminal || gate.providerBlockers.length,
    ),
  };
}
type Gate = { terminal: boolean; providerBlockers: Json[] } & Record<string, Json>;

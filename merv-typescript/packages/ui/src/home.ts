import { clip, type Caller, type Json } from '@merv/contracts';
import type { Tools } from '@merv/api/types';
import type { UiRow } from './types.js';

/** Where ui.home reads besides its tools. */
export interface HomeSources {
  tools: Tools;
  /** Runs one part behind a savepoint of its own, so a statement that fails costs that part. */
  isolated<T>(read: () => Promise<T>): Promise<T>;
  /** The gates Needs you reads: open work's, and ended work's a plugin still holds; absent, null. */
  gates?(caller: Caller): Promise<unknown>;
}

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
    tools.call('project.read:whoami', caller, {}),
    tools.call('project.read:get', caller, {}),
    answer(() => tools.call('workflow.read:catalog', caller, {})),
  ]);
  return { actor: actor as Json, project: project as Json, workflows: workflows ?? [] };
}

/**
 * Everything Home and the rail read, in one answer: the shell's parts, the open gates, and the
 * records of every row that declares a home part, under the row's id. Read-only tools run in
 * one snapshot scope, so this is a single consistent read of the project rather than twenty
 * round trips at a browser's latency. The parts run one at a time on that snapshot's
 * connection, each behind its own savepoint: a part that fails, or that this caller may not
 * read, is null, and the page draws what it has and never fails whole.
 */
export async function homeRead(
  { tools, isolated, gates }: HomeSources,
  rows: UiRow[],
  caller: Caller,
): Promise<Json> {
  const home: Record<string, Json> = {};
  const read = async (key: string, fn: () => Promise<unknown>, keep?: readonly string[]) => {
    home[key] = trim(await answer(() => isolated(fn)), keep);
  };
  // The shell's own parts, and the fields of each person they read.
  await read('project', () => tools.call('project.read:get', caller, {}));
  const people = ['id', 'name', 'role', 'kind', 'active', 'sessionId'];
  await read('actors', () => tools.call('project.read:actors', caller, {}), people);
  // A blocker's next move names actions by address, said as this caller calls them.
  await read('workflows', async () => (gates ? tools.guidance(caller, await gates(caller)) : null));
  for (const { id, home: part } of rows)
    if (part)
      await read(
        id,
        () => (part.list ? part.list(caller) : tools.call(part.tool!, caller, {})),
        part.keep,
      );
  return home;
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
      ? value.map(brief)
      : value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, brief(item)]))
        : value;
const pick = (record: Json, keys: readonly string[]): Json =>
  record && typeof record === 'object' && !Array.isArray(record)
    ? Object.fromEntries(
        keys.filter((key) => key in record).map((key) => [key, brief(record[key])]),
      )
    : record;
const trim = (value: Json, keep?: readonly string[]): Json =>
  keep && Array.isArray(value) ? value.map((item) => pick(item, keep)) : value;

import { canonical, check } from '@merv/contracts';
import type {
  Sql,
  WorkflowDefinition,
  WorkflowExecutionPolicy,
  WorkflowPinned,
  WorkflowPolicy,
} from '@merv/contracts';
import { executionFingerprint } from './execution.js';
import { freezeData } from './json.js';

/**
 * A contract as read. It is final once its success row and an execution row for every nonterminal
 * state exist. A version stored before either was pinned lacks them: that reads as their absence,
 * but a later registration of the version still writes the rows.
 */
export interface PinnedRead {
  pinned: WorkflowPinned;
  final: boolean;
}

interface Row {
  name: string;
  version: number;
  definition_json: string;
  success_json: string | null;
  state: string | null;
  manifest_json: string | null;
}

/** Every stored contract, or only the one named, in one query. */
async function load(sql: Sql, only?: { name: string; version: number }): Promise<PinnedRead[]> {
  const rows = await sql.all<Row>(
    `SELECT d.name, d.version, d.definition_json, s.success_json, e.state, e.manifest_json
     FROM wf_definitions d
     LEFT JOIN wf_success_states s ON s.workflow = d.name AND s.version = d.version
     LEFT JOIN wf_execution_policies e ON e.workflow = d.name AND e.version = d.version
     ${only ? 'WHERE d.name = ? AND d.version = ?' : ''}`,
    ...(only ? [only.name, only.version] : []),
  );
  const read = new Map<string, PinnedRead>();
  for (const row of rows) {
    const key = `${row.name}@${Number(row.version)}`;
    let entry = read.get(key);
    if (!entry) {
      entry = {
        pinned: {
          definition: JSON.parse(row.definition_json) as WorkflowDefinition,
          successStates:
            row.success_json === null ? null : (JSON.parse(row.success_json) as string[] | null),
          execution: {},
        },
        final: row.success_json !== null,
      };
      read.set(key, entry);
    }
    if (row.state !== null && row.manifest_json !== null)
      entry.pinned.execution[row.state] = JSON.parse(
        row.manifest_json,
      ) as WorkflowExecutionPolicy | null;
  }
  for (const entry of read.values()) {
    const { definition, execution } = entry.pinned;
    entry.final &&= definition.states.every(
      (state) => definition.terminal.includes(state) || Object.hasOwn(execution, state),
    );
    freezeData(entry.pinned);
  }
  return [...read.values()];
}

/** One stored contract as `sql` sees it, or undefined when the version is not stored. */
export async function readPinned(
  sql: Sql,
  name: string,
  version: number,
): Promise<PinnedRead | undefined> {
  return (await load(sql, { name, version }))[0];
}

/**
 * Pinned contracts by name@version, held in memory. Their rows never change (migration 9 refuses
 * an UPDATE or DELETE), so an entry can be missing but never stale: a miss re-reads, which is
 * how a version another service registered since is found.
 */
export class PinnedContracts {
  private readonly cache = new Map<string, WorkflowPinned>();

  /** Reads every stored version at once; run at initialize. */
  async preload(sql: Sql): Promise<void> {
    for (const entry of await load(sql)) this.keep(entry);
  }

  /** A version's contract, or null when none is stored. */
  async get(sql: Sql, name: string, version: number): Promise<WorkflowPinned | null> {
    const cached = this.cache.get(`${name}@${version}`);
    if (cached) return cached;
    const entry = await readPinned(sql, name, version);
    if (!entry) return null;
    this.keep(entry);
    return entry.pinned;
  }

  /** Remembers a final contract; a registration calls it only after its transaction commits. */
  keep({ pinned, final }: PinnedRead): void {
    if (final) this.cache.set(`${pinned.definition.name}@${pinned.definition.version}`, pinned);
  }
}

/** A version pins its success states on first registration, their absence included. */
export async function persistSuccess(
  sql: Sql,
  definition: WorkflowDefinition,
  success?: string[],
): Promise<void> {
  const encoded = canonical(success === undefined ? null : [...success].sort());
  const existing = await sql.get<{ success_json: string }>(
    'SELECT success_json FROM wf_success_states WHERE workflow=? AND version=?',
    definition.name,
    definition.version,
  );
  check(
    !existing || existing.success_json === encoded,
    'workflow_version_conflict',
    `${definition.name}@${definition.version} success states changed; publish a new version`,
    409,
  );
  if (!existing)
    await sql.run(
      'INSERT INTO wf_success_states (workflow,version,success_json) VALUES (?,?,?)',
      definition.name,
      definition.version,
      encoded,
    );
}

/** Null is a pinned declaration too: omission must never restore dynamic dispatch grants. */
export async function persistExecution(
  sql: Sql,
  definition: WorkflowDefinition,
  policy?: WorkflowPolicy,
): Promise<void> {
  for (const state of definition.states.filter((state) => !definition.terminal.includes(state))) {
    const manifest = policy?.assignments?.find((rule) => rule.state === state)?.execution ?? null;
    const hash = executionFingerprint(manifest);
    const previous = await sql.get<{ fingerprint: string }>(
      'SELECT fingerprint FROM wf_execution_policies WHERE workflow=? AND version=? AND state=?',
      definition.name,
      definition.version,
      state,
    );
    check(
      !previous || previous.fingerprint === hash,
      'workflow_version_conflict',
      `Execution policy for ${definition.name}@${definition.version}/${state} changed; publish a new version`,
      409,
    );
    if (!previous)
      await sql.run(
        'INSERT INTO wf_execution_policies(workflow,version,state,fingerprint,manifest_json) VALUES(?,?,?,?,?)',
        definition.name,
        definition.version,
        state,
        hash,
        canonical(manifest),
      );
  }
}

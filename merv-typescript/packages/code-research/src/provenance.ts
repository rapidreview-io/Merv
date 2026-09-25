import { check, digest, type ReviewProvenance, type Transaction } from '@merv/contracts';
import type { Sessions } from '@merv/sessions/types';
import type { BaseBody } from '@merv/code/units';
import type { CodeBaseService } from './bases.js';

const commitField = "(acceptance_json::jsonb #>> '{code,commit}')";

/** Accepted work must retain its producing actors and the authorities who directed them. */
export async function unitContributors(
  tx: Transaction,
  sessions: Pick<Sessions, 'contributors'>,
  projectId: string,
  units: Map<string, number | null>,
) {
  const sources = [];
  for (const [unitId, revision] of [...units].sort(([a], [b]) => a.localeCompare(b))) {
    const contributors = await sessions.contributors(projectId, unitId, revision, tx);
    check(
      revision === null || contributors.length,
      'code_provenance_unverifiable',
      'An accepted input has no retained producing session',
      409,
    );
    sources.push(...contributors.map((source) => ({ unitId, ...source })));
  }
  return sources;
}

/** Code identifies the contributing units; Sessions owns their retained authorship. */
export async function resolutionProvenance(
  tx: Transaction,
  bases: CodeBaseService,
  sessions: Pick<Sessions, 'contributors'>,
  projectId: string,
  taskId: string,
): Promise<ReviewProvenance> {
  const root = await bases.forTask(tx, projectId, taskId);
  if (!root) return await pinnedProvenance(tx, bases, sessions, projectId, taskId);
  const path = (await bases.path(tx, projectId, root.key)).sort((a, b) =>
    a.key.localeCompare(b.key),
  );
  const units = new Map<string, number | null>();
  const acceptances: { unitId: string; hash: string }[] = [];
  const main: string[] = [];
  for (const commit of root.members) {
    const rows = await tx.all<{
      unit_id: string;
      acceptance_json: string;
      acceptance_hash: string;
    }>(
      `SELECT unit_id,acceptance_json,acceptance_hash FROM code_units WHERE project_id=? AND acceptance_json IS NOT NULL AND ${commitField}=? ORDER BY unit_id`,
      projectId,
      commit,
    );
    // Main, merged in for work that publishes, is admitted code and brings no authors.
    if (
      !rows.length &&
      (await tx.get(
        'SELECT 1 FROM code_edges WHERE project_id=? AND target_ref=?',
        projectId,
        `main:${commit}`,
      ))
    ) {
      main.push(commit);
      continue;
    }
    check(
      rows.length,
      'code_provenance_unverifiable',
      'A frozen member has no retained acceptance',
      409,
    );
    for (const row of rows) {
      const accepted = JSON.parse(row.acceptance_json);
      check(
        digest(accepted) === row.acceptance_hash,
        'code_provenance_unverifiable',
        'An input acceptance no longer matches its hash',
        409,
      );
      units.set(row.unit_id, accepted.terminalRevision);
      acceptances.push({ unitId: row.unit_id, hash: row.acceptance_hash });
    }
  }
  for (const base of path) if (base.resolutionTaskId) units.set(base.resolutionTaskId, null);
  return certificate(root.key, await unitContributors(tx, sessions, projectId, units), {
    projectId,
    taskId,
    plan: path.map(({ key, members, left, right }) => ({ key, members, left, right })),
    acceptances,
    ...(main.length ? { main } : {}),
  });
}

/**
 * A service task that stands on a base rather than resolving one, as a research consolidation
 * does: the accepted work its pin holds, every resolution its merged base needed, and each of
 * its own writers, with the authorities who directed them.
 */
async function pinnedProvenance(
  tx: Transaction,
  bases: CodeBaseService,
  sessions: Pick<Sessions, 'contributors'>,
  projectId: string,
  taskId: string,
): Promise<ReviewProvenance> {
  const row = await tx.get<{ base_json: string | null }>(
    'SELECT base_json FROM code_units WHERE project_id=? AND unit_id=?',
    projectId,
    taskId,
  );
  check(row?.base_json, 'code_provenance_unverifiable', 'No base carries this service task', 409);
  const pin = JSON.parse(row.base_json) as BaseBody;
  const units = new Map<string, number | null>(
    pin.sources.map((source) => [source.unitId, source.terminalRevision]),
  );
  if (pin.kind === 'merged') {
    // A base is named by the commits it merged: its sources' accepted commits and main.
    const commits = pin.main ? [pin.main.oid] : [];
    for (const source of pin.sources)
      commits.push(
        (await tx.get<{ commit: string }>(
          `SELECT ${commitField} AS commit FROM code_units WHERE project_id=? AND unit_id=?`,
          projectId,
          source.unitId,
        ))!.commit,
      );
    const base = await bases.find(tx, projectId, commits);
    check(
      base?.result?.commit === pin.reference,
      'code_provenance_unverifiable',
      'The merged base of this task is not retained',
      409,
    );
    for (const step of await bases.path(tx, projectId, base.key))
      if (step.resolutionTaskId) units.set(step.resolutionTaskId, null);
  }
  units.set(taskId, null);
  return certificate(pin.reference, await unitContributors(tx, sessions, projectId, units), {
    projectId,
    taskId,
    pin,
  });
}

/** Every retained contributor, and each one's directing authority, is excluded from review. */
function certificate(
  reference: string,
  sources: { actorId: string; authorityId: string }[],
  facts: object,
): ReviewProvenance {
  const body = {
    formatVersion: 1 as const,
    provider: 'code',
    reference,
    sourceHash: digest({ ...facts, sources }),
    excludedActorIds: [
      ...new Set(sources.flatMap((source) => [source.actorId, source.authorityId])),
    ].sort(),
  };
  return { ...body, hash: digest(body) };
}

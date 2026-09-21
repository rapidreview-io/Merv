import { check, digest, type ReviewProvenance, type Transaction } from '@merv/contracts';
import type { Sessions } from '@merv/sessions/types';
import type { CodeBaseService } from './bases.js';

/** Code identifies the contributing units; Sessions owns their retained authorship. */
export async function resolutionProvenance(
  tx: Transaction,
  bases: CodeBaseService,
  sessions: Pick<Sessions, 'contributors'>,
  projectId: string,
  taskId: string,
): Promise<ReviewProvenance> {
  const root = await bases.forTask(tx, projectId, taskId);
  check(root, 'code_provenance_unverifiable', 'No frozen base owns this resolution task', 409);
  const path = (await bases.path(tx, projectId, root.key)).sort((a, b) =>
    a.key.localeCompare(b.key),
  );
  const units = new Map<string, number | null>();
  const acceptances: { unitId: string; hash: string }[] = [];
  const commitField =
    tx.dialect === 'postgres'
      ? "(acceptance_json::jsonb #>> '{code,commit}')"
      : "json_extract(acceptance_json,'$.code.commit')";
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
  const body = {
    formatVersion: 1 as const,
    provider: 'code',
    reference: root.key,
    sourceHash: digest({
      projectId,
      taskId,
      plan: path.map(({ key, members, left, right }) => ({ key, members, left, right })),
      acceptances,
      sources,
    }),
    excludedActorIds: [
      ...new Set(sources.flatMap((source) => [source.actorId, source.authorityId])),
    ].sort(),
  };
  return { ...body, hash: digest(body) };
}

import type { State } from '@merv/contracts';
import type { CodeUnitStore } from '@merv/code/units';
import type { AcceptanceBody, BaseBody, UnitRow } from './unit-store.js';
import { backfillWorkHolds } from './repository-holds.js';

/** Project historical work-unit facts once through the generic Code persistence API. */
export async function restoreLegacyCompatibility(state: State, code: CodeUnitStore): Promise<void> {
  await state.transaction(async (tx) => {
    const retain = (
      projectId: string,
      key: string,
      unitId: string,
      commit: string,
      storage: 'code' | 'external',
      receipt: string | null,
      createdAt: string,
    ) =>
      code.retainHistoricalCommit(tx, {
        projectId,
        key,
        unitId,
        commit,
        storage,
        receipt,
        createdAt,
      });
    for (const row of await tx.all<UnitRow & Record<string, unknown>>('SELECT * FROM code_units')) {
      const writer: Record<string, unknown> = {};
      for (const key of [
        'generation',
        'writer_state',
        'writer_session_id',
        'writer_lease_id',
        'writer_changed_at',
        'head_oid',
        'head_operation_id',
        'mirrored_oid',
        'mirrored_at',
        'quarantine_operation_id',
      ])
        if (key in row) writer[key] = row[key];
      await code.restoreWorkspace(tx, {
        ...writer,
        blocked_by: row.quarantine_base_key,
        projectId: row.project_id,
        unitId: row.unit_id,
        declaredAt: row.declared_at,
        reference: row.base_json ? (JSON.parse(row.base_json) as BaseBody).reference : null,
      });
      if (row.base_json)
        await retain(
          row.project_id,
          `pin:${row.unit_id}`,
          row.unit_id,
          (JSON.parse(row.base_json) as BaseBody).reference,
          'external',
          null,
          row.based_at!,
        );
      if (row.acceptance_json) {
        const body = JSON.parse(row.acceptance_json) as AcceptanceBody;
        if (body.code)
          await retain(
            row.project_id,
            `unit:${row.unit_id}`,
            row.unit_id,
            body.code.commit,
            body.storage === 'code' ? 'code' : 'external',
            body.receipt ?? null,
            row.accepted_at!,
          );
      }
    }
    for (const row of await tx.all<{
      project_id: string;
      unit_id: string;
      review_id: string;
      acceptance_json: string;
      accepted_at: string;
    }>('SELECT * FROM code_review_acceptances')) {
      const body = JSON.parse(row.acceptance_json) as AcceptanceBody;
      if (body.code)
        await retain(
          row.project_id,
          `review:${row.unit_id}:${row.review_id}`,
          row.unit_id,
          body.code.commit,
          body.storage === 'code' ? 'code' : 'external',
          body.receipt ?? null,
          row.accepted_at,
        );
    }
    for (const row of await tx.all<{
      project_id: string;
      base_key: string;
      result_json: string | null;
      resolution_commit: string | null;
      updated_at: string;
    }>('SELECT project_id,base_key,result_json,resolution_commit,updated_at FROM code_bases')) {
      if (row.result_json)
        await retain(
          row.project_id,
          `base:${row.base_key}`,
          `base:${row.base_key}`,
          JSON.parse(row.result_json).commit,
          'code',
          null,
          row.updated_at,
        );
      if (row.resolution_commit)
        await retain(
          row.project_id,
          `resolution:${row.base_key}`,
          `base:${row.base_key}`,
          row.resolution_commit,
          'code',
          null,
          row.updated_at,
        );
    }
    await backfillWorkHolds(tx);
    for (const row of await tx.all<{ project_id: string }>('SELECT project_id FROM code_projects'))
      await code.releaseRepository(tx, row.project_id, 'code-storage-upgrade');
  });
}

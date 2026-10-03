import { canonical, digest, type Data, type State } from '@merv/contracts';
import {
  initializeLegacyHistory,
  legacyHistoryTypes,
  type LegacyHistoryFileRetention,
  type LegacyHistoryReceipt,
  type LegacyHistoryType,
} from '../../src/legacy-history.js';

export interface ArchivedFixtureRecord {
  projectId: string;
  type: LegacyHistoryType;
  id: string;
  data: Data;
  fileRetention?: LegacyHistoryFileRetention;
}

/** Trusted synthetic test/demo rows already in archived form. No source import or projection. */
export async function seedLegacyHistory(
  state: State,
  records: ArchivedFixtureRecord[],
  options: {
    sourceId?: string;
    artifactRetention?: LegacyHistoryReceipt['artifactRetention'];
  } = {},
) {
  await initializeLegacyHistory(state);
  const empty = () =>
    Object.fromEntries(
      legacyHistoryTypes.map((type) => [type, 0]),
    ) as LegacyHistoryReceipt['counts'];
  const counts = empty();
  const projectCounts: LegacyHistoryReceipt['projectCounts'] = {};
  for (const record of records) {
    counts[record.type]++;
    (projectCounts[record.projectId] ??= empty())[record.type]++;
  }
  const receipt: LegacyHistoryReceipt = {
    sourceId: options.sourceId ?? 'legacy-history-fixture',
    fingerprint: digest(records),
    capturedAt: '2026-09-16T12:00:00.000Z',
    importedAt: '2026-09-16T13:00:00.000Z',
    historical: true,
    schemaVersion: 81,
    projectionVersion: 2,
    counts,
    projectCounts,
    retention: {
      records: 'immutable-projected-research-history',
      credentials: 'excluded',
      toolLedger: 'excluded',
      nativeWorkflowContinuation: 'not-imported',
      objectBytes: 'not-verified-by-history-import',
      json: 'canonicalized-with-structured-secret-fields-excluded',
    },
    ...(options.artifactRetention ? { artifactRetention: options.artifactRetention } : {}),
  };
  await state.transaction(async (tx) => {
    await tx.run(
      'INSERT INTO legacy_history_imports(source_id,fingerprint,receipt) VALUES(?,?,?)',
      receipt.sourceId,
      receipt.fingerprint,
      canonical(receipt),
    );
    for (const record of records) {
      const hash = digest(record.data),
        json = canonical(record.data);
      const summary = {
        type: record.type,
        id: record.id,
        hash,
        historical: true,
        label: String(record.data.title ?? record.data.name ?? record.id).slice(0, 240),
        ...(typeof record.data.status === 'string' ? { status: record.data.status } : {}),
        ...(typeof record.data.created_at === 'string'
          ? { createdAt: record.data.created_at }
          : {}),
        ...(record.fileRetention ? { fileRetention: record.fileRetention } : {}),
      };
      await tx.run(
        'INSERT INTO legacy_history_records(source_id,project_id,record_type,source_key,content_hash,data_json,summary_json,detail_bytes) VALUES(?,?,?,?,?,?,?,?)',
        receipt.sourceId,
        record.projectId,
        record.type,
        record.id,
        hash,
        json,
        canonical(summary),
        Buffer.byteLength(json),
      );
    }
  });
  return receipt;
}

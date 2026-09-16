import type { Data } from '@merv/contracts';
import {
  legacyHistoryTables,
  type LegacyHistorySnapshot,
  type LegacyHistoryType,
} from '../../src/legacy-history.js';

/** Synthetic tests only. Real exports must provide every selected source column. */
export function legacyHistoryRow(type: LegacyHistoryType, values: Data): Data {
  return {
    ...Object.fromEntries(
      legacyHistoryTables[type].columns.map((column) => [
        column,
        column.endsWith('_json') ? {} : null,
      ]),
    ),
    ...values,
  };
}
export function emptyLegacyHistorySnapshot(
  projectIds: string[],
  sourceId = 'legacy-history-fixture',
): LegacyHistorySnapshot {
  return {
    sourceId,
    schemaVersion: 81,
    projectionVersion: 2,
    capturedAt: '2026-09-16T12:00:00.000Z',
    consistency: 'postgres-repeatable-read-read-only',
    projectIds,
    tables: Object.fromEntries(
      Object.keys(legacyHistoryTables).map((type) => [type, [] as Data[]]),
    ) as LegacyHistorySnapshot['tables'],
  };
}

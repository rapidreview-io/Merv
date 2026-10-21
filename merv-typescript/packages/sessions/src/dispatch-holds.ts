import type { NativeRevisionContinuity } from '@merv/workflows/native-continuity';

export interface HoldRow {
  instance_id: string;
  revision: number;
  attempts: number;
  last_code: string;
  last_message: string;
  last_session_id: string | null;
  first_at: string;
  last_at: string;
  held_at: string | null;
}

/** Keep original counters and their audit history. New failures write the actual revision;
 * scheduling combines both sides of a protocol-only boundary until an ordinary revision. */
export function projectHolds<T extends HoldRow>(
  rows: readonly T[],
  continuity: NativeRevisionContinuity,
): T[] {
  const groups = new Map<string, T>();
  for (const original of rows) {
    const row = {
      ...original,
      revision: continuity.current(original.instance_id, Number(original.revision)),
      attempts: Number(original.attempts),
    };
    const key = `${row.instance_id}:${row.revision}`;
    const previous = groups.get(key);
    groups.set(
      key,
      previous
        ? {
            ...(previous.last_at > row.last_at ? previous : row),
            attempts: previous.attempts + row.attempts,
            first_at: previous.first_at < row.first_at ? previous.first_at : row.first_at,
            held_at:
              [previous.held_at, row.held_at].filter((at): at is string => at !== null).sort()[0] ??
              null,
          }
        : row,
    );
  }
  return [...groups.values()];
}

import { MervError, type Caller } from '@merv/contracts';
import type { CodeUnit } from './models.js';

/**
 * What Code holds for an owner's record, such as a task's or an experiment's unit: its pinned
 * base, where a base stands, its acceptance. Null while Code is unavailable or knows no such
 * unit. A record page shows it beside the record, which keeps it off itself: work contexts embed
 * the record and leases freeze it.
 */
export async function recordUnit(
  code: { unit(caller: Caller, id: string): Promise<CodeUnit> },
  caller: Caller,
  id: string,
): Promise<CodeUnit | null> {
  try {
    return await code.unit(caller, id);
  } catch (error) {
    if (error instanceof MervError && [404, 503].includes(error.status)) return null;
    throw error;
  }
}

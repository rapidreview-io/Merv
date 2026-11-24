/** How this page keeps a file sent to Merv: as any file kept in the project (Files), through the same upload. */
import { call } from '../api';
import { MAX_FILE, refusalOf, storeFile } from '../views/artifacts';

export async function keepFile(file: File): Promise<string> {
  const available =
    file.size <= MAX_FILE ||
    (await call<{ available: boolean }>('artifact.read:storage', {})).available;
  const refusal = refusalOf(file, available);
  if (refusal) throw new Error(refusal);
  const kept = await storeFile(file, {
    live: () => true,
    told: () => {},
    sending: {},
    pending: {},
    requestId: crypto.randomUUID(),
  });
  if (!kept) throw new Error('Nothing was kept');
  return kept.id;
}

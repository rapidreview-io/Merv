import { createHash } from 'node:crypto';

const MAX_BYTES = 2_000_000;
const hash = (content: string) => createHash('sha256').update(content).digest('hex');

export interface WorkerCheckpoint {
  version: 1;
  header: { type: 'session'; id: string; cwd: string; timestamp: string; version?: number };
  entries: { id: string; parentId: string | null; type: string }[];
  leafId: string | null;
}

export function encodeCheckpoint(session: {
  getHeader(): WorkerCheckpoint['header'] | null;
  getEntries(): WorkerCheckpoint['entries'];
  getLeafId(): string | null;
}): { content: string; hash: string } {
  const header = session.getHeader();
  if (!header) throw new Error('Invalid session checkpoint');
  const content = JSON.stringify({
    version: 1,
    header,
    entries: session.getEntries(),
    leafId: session.getLeafId(),
  });
  if (Buffer.byteLength(content) > MAX_BYTES) throw new Error('Checkpoint exceeds limit');
  // Main refuses any checkpoint this would: a turn never ends on one it cannot keep.
  const saved = { content, hash: hash(content) };
  decodeCheckpoint(saved);
  return saved;
}

export function decodeCheckpoint(checkpoint: { content: string; hash: string }): WorkerCheckpoint {
  if (
    Buffer.byteLength(checkpoint.content) > MAX_BYTES ||
    !/^[a-f0-9]{64}$/.test(checkpoint.hash) ||
    hash(checkpoint.content) !== checkpoint.hash
  )
    throw new Error('Invalid checkpoint digest');
  let parsed: unknown;
  try {
    parsed = JSON.parse(checkpoint.content);
  } catch {
    throw new Error('Invalid checkpoint JSON');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid checkpoint');
  const value = parsed as Partial<WorkerCheckpoint>;
  if (
    value.version !== 1 ||
    value.header?.type !== 'session' ||
    typeof value.header.id !== 'string' ||
    !value.header.id ||
    typeof value.header.cwd !== 'string' ||
    !Array.isArray(value.entries) ||
    value.entries.length > 10_000 ||
    (value.leafId !== null && typeof value.leafId !== 'string')
  )
    throw new Error('Invalid checkpoint structure');
  const seen = new Set<string>();
  for (const entry of value.entries) {
    if (
      !entry ||
      typeof entry.id !== 'string' ||
      !entry.id ||
      seen.has(entry.id) ||
      typeof entry.type !== 'string' ||
      (entry.parentId !== null && (typeof entry.parentId !== 'string' || !seen.has(entry.parentId)))
    )
      throw new Error('Invalid checkpoint tree');
    seen.add(entry.id);
  }
  if (value.leafId !== null && !seen.has(value.leafId!)) throw new Error('Invalid checkpoint leaf');
  return value as WorkerCheckpoint;
}

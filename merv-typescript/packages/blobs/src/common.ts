import { check, MervError, sha256Hex } from '@merv/contracts';

export const MAX_BLOB_BYTES = 2_000_000;
export const hashBytes = (bytes: Uint8Array) => sha256Hex(bytes);

export function validateNamespace(namespace: string): void {
  check(
    typeof namespace === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(namespace),
    'invalid_namespace',
    'Invalid blob namespace',
  );
}

export function validateKey(namespace: string, hash: string): void {
  validateNamespace(namespace);
  check(
    typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash),
    'invalid_hash',
    'Invalid content hash',
  );
}

export function copyBytes(bytes: Uint8Array): Buffer {
  check(bytes instanceof Uint8Array, 'invalid_blob', 'Blob content must be bytes');
  check(bytes.byteLength <= MAX_BLOB_BYTES, 'blob_size', 'Blob exceeds the maximum size');
  return Buffer.from(bytes);
}

/** Callers only read hashes they stored, so an oversized stored blob is corruption, not bad input. */
export function storedSize(size: number): void {
  check(size <= MAX_BLOB_BYTES, 'blob_corrupt', 'Stored blob exceeds the maximum size', 500);
}

export function verifyBytes(bytes: Buffer, hash: string): Buffer {
  storedSize(bytes.byteLength);
  check(hashBytes(bytes) === hash, 'blob_corrupt', 'Stored blob failed its integrity check', 500);
  return bytes;
}

/** Our own errors pass through; a `missing` failure is 404; anything else is a storage outage. */
export function storageError(
  error: unknown,
  message: string,
  missing: (error: unknown) => boolean = () => false,
): MervError {
  if (error instanceof MervError) return error;
  if (missing(error)) return new MervError('blob_not_found', 'Blob not found', 404);
  return new MervError('blob_unavailable', message, 503);
}

/** Withdraw admission before draining operations, then release provider resources. */
export class BlobOperations {
  private closing = false;
  private pending = new Set<Promise<unknown>>();
  private completion?: Promise<void>;

  async run<T>(operation: () => Promise<T>): Promise<T> {
    check(!this.closing, 'blobs_closed', 'Blob storage is unavailable', 503);
    const result = Promise.resolve().then(operation);
    this.pending.add(result);
    try {
      return await result;
    } finally {
      this.pending.delete(result);
    }
  }

  close(dispose: () => void = () => {}): Promise<void> {
    this.closing = true;
    return (this.completion ??= Promise.allSettled([...this.pending]).then(() => dispose()));
  }
}

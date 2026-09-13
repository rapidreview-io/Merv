import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, linkSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Context } from 'cordis';
import { check, MervError, type Blobs } from '@merv/contracts';

export class DiskBlobs implements Blobs {
  private root: string;
  constructor(root: string) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }
  private path(namespace: string, hash: string): string {
    check(/^[a-zA-Z0-9_-]{1,100}$/.test(namespace), 'invalid_namespace', 'Invalid blob namespace');
    check(/^[a-f0-9]{64}$/.test(hash), 'invalid_hash', 'Invalid content hash');
    return join(this.root, namespace, hash.slice(0, 2), hash);
  }
  put(namespace: string, bytes: Uint8Array) {
    const hash = createHash('sha256').update(bytes).digest('hex');
    const destination = this.path(namespace, hash);
    const directory = join(this.root, namespace, hash.slice(0, 2));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.${randomUUID()}`);
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600, flush: true });
    try {
      linkSync(temporary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      this.get(namespace, hash);
    } finally {
      unlinkSync(temporary);
    }
    return { hash, size: bytes.byteLength };
  }
  get(namespace: string, hash: string): Buffer {
    let bytes: Buffer;
    try {
      bytes = readFileSync(this.path(namespace, hash));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new MervError('blob_not_found', 'Blob not found', 404);
      throw error;
    }
    check(
      createHash('sha256').update(bytes).digest('hex') === hash,
      'blob_corrupt',
      'Stored blob failed its integrity check',
      500,
    );
    return bytes;
  }
}
export const blobsPlugin = {
  name: 'merv-blobs',
  apply(ctx: Context, config: { root: string }) {
    ctx.provide('blobs', new DiskBlobs(config.root));
  },
};
export default blobsPlugin;

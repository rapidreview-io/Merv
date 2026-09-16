import { randomUUID } from 'node:crypto';
import { mkdir, open, link, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { check, MervError, type Blobs } from '@merv/contracts';
import {
  BlobOperations,
  copyBytes,
  hashBytes,
  MAX_BLOB_BYTES,
  validateKey,
  validateNamespace,
  verifyBytes,
} from './common.js';

export class DiskBlobs implements Blobs {
  private root: string;
  private operations = new BlobOperations();

  constructor(root: string) {
    check(
      typeof root === 'string' && !!root.trim(),
      'invalid_blob_root',
      'Blob root must be nonblank',
    );
    this.root = resolve(root);
  }

  private path(namespace: string, hash: string): string {
    validateKey(namespace, hash);
    return join(this.root, namespace, hash.slice(0, 2), hash);
  }

  async put(namespace: string, bytes: Uint8Array): Promise<{ hash: string; size: number }> {
    validateNamespace(namespace);
    const content = copyBytes(bytes);
    return this.operations.run(async () => {
      const hash = hashBytes(content);
      const destination = this.path(namespace, hash);
      const directory = join(this.root, namespace, hash.slice(0, 2));
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = join(directory, `.${randomUUID()}`);
      const handle = await open(temporary, 'wx', 0o600);
      try {
        try {
          await handle.writeFile(content);
          await handle.sync();
        } finally {
          await handle.close();
        }
        try {
          await link(temporary, destination);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          await this.read(namespace, hash);
        }
        const parent = await open(directory, 'r');
        try {
          await parent.sync();
        } finally {
          await parent.close();
        }
      } finally {
        await unlink(temporary);
      }
      return { hash, size: content.byteLength };
    });
  }

  private async read(namespace: string, hash: string): Promise<Buffer> {
    try {
      const handle = await open(this.path(namespace, hash), 'r');
      try {
        check(
          (await handle.stat()).size <= MAX_BLOB_BYTES,
          'blob_size',
          'Blob exceeds the maximum size',
        );
        const buffer = Buffer.alloc(MAX_BLOB_BYTES + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
          if (!bytesRead) break;
          length += bytesRead;
        }
        return verifyBytes(Buffer.from(buffer.subarray(0, length)), hash);
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new MervError('blob_not_found', 'Blob not found', 404);
      throw error;
    }
  }

  get(namespace: string, hash: string): Promise<Buffer> {
    return this.operations.run(() => this.read(namespace, hash));
  }

  close(): Promise<void> {
    return this.operations.close();
  }
}

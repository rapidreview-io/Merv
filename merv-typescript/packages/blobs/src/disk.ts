import { randomUUID } from 'node:crypto';
import { mkdir, open, link, stat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { check, type Blobs } from '@merv/contracts';
import {
  BlobOperations,
  copyBytes,
  hashBytes,
  storageError,
  storedSize,
  validateKey,
  validateNamespace,
  verifyBytes,
} from './common.js';

const missingFile = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

export class DiskBlobs implements Blobs {
  private root: string;
  private operations = new BlobOperations();

  constructor(root: string) {
    this.root = resolve(root);
  }

  private directory(namespace: string, hash: string): string {
    return join(this.root, namespace, hash.slice(0, 2));
  }

  async put(namespace: string, bytes: Uint8Array): Promise<{ hash: string; size: number }> {
    validateNamespace(namespace);
    const content = copyBytes(bytes);
    return this.operations.run(async () => {
      const hash = hashBytes(content);
      const directory = this.directory(namespace, hash);
      const destination = join(directory, hash);
      try {
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
            // The name is the content's hash, so an existing file of the same size holds it.
            const size = (await stat(destination)).size;
            check(size === content.byteLength, 'blob_corrupt', 'Stored blob size differs', 500);
          }
          const parent = await open(directory, 'r');
          try {
            await parent.sync();
          } finally {
            await parent.close();
          }
        } finally {
          // Never let cleanup replace the error that got us here.
          await unlink(temporary).catch(() => {});
        }
      } catch (error) {
        throw storageError(error, 'Blob upload failed');
      }
      return { hash, size: content.byteLength };
    });
  }

  private async read(namespace: string, hash: string): Promise<Buffer> {
    validateKey(namespace, hash);
    try {
      const handle = await open(join(this.directory(namespace, hash), hash), 'r');
      try {
        storedSize((await handle.stat()).size);
        return verifyBytes(await handle.readFile(), hash);
      } finally {
        await handle.close();
      }
    } catch (error) {
      throw storageError(error, 'Blob read failed', missingFile);
    }
  }

  get(namespace: string, hash: string): Promise<Buffer> {
    return this.operations.run(() => this.read(namespace, hash));
  }

  close(): Promise<void> {
    return this.operations.close();
  }
}

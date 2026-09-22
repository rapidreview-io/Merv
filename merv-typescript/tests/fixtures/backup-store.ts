import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import type { BackupObject, BackupObjectStore } from '@merv/code/store/backup';

export interface FakeBackupStore extends BackupObjectStore {
  /** Every object the bucket holds, so a test can read one, lose one or corrupt one. */
  objects: Map<string, Buffer>;
  calls: string[];
}

/**
 * The bucket, in memory. It keeps the one promise the real store makes and a test depends on:
 * bytes come back exactly as they were written, and a key that was never written is absent.
 */
export function fakeBackupStore(): FakeBackupStore {
  const objects = new Map<string, Buffer>();
  const calls: string[] = [];
  const held = (key: string) => {
    const body = objects.get(key);
    if (!body) throw new Error(`no such object ${key}`);
    return body;
  };
  return {
    objects,
    calls,
    async putFile(key, file, bytes, sha256) {
      const body = await readFile(file);
      if (body.byteLength !== bytes || createHash('sha256').update(body).digest('hex') !== sha256)
        throw new Error(`${key} was not the object it was announced as`);
      calls.push(`put ${key}`);
      objects.set(key, body);
    },
    async putBytes(key, body) {
      calls.push(`put ${key}`);
      objects.set(key, Buffer.from(body));
    },
    async head(key) {
      calls.push(`head ${key}`);
      return objects.get(key)?.byteLength ?? null;
    },
    async getBytes(key) {
      calls.push(`get ${key}`);
      return held(key);
    },
    async getFile(key, file): Promise<BackupObject> {
      calls.push(`get ${key}`);
      const body = held(key);
      await writeFile(file, body, { mode: 0o600 });
      return {
        key,
        bytes: body.byteLength,
        sha256: createHash('sha256').update(body).digest('hex'),
      };
    },
    async list(prefix) {
      calls.push(`list ${prefix}`);
      return [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
    },
    async remove(keys) {
      for (const key of keys) {
        calls.push(`remove ${key}`);
        objects.delete(key);
      }
    },
    async close() {},
  };
}

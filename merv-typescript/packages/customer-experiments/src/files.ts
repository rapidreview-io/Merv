import { check, MervError, type State, type Transaction } from '@merv/contracts';
import type { WorkflowSnapshot } from '@merv/workflows/models';
import type { RequestRecord, RequestStore } from './store.js';
import type { RequestFiles } from './types.js';

/** service_experiment@3: any files the customer brings, in the request's own bucket. */
export const FILES_LIMIT_BYTES = 1_000_000_000_000;
export const MAX_PARTS = 10_000;
const MIB = 1024 * 1024;
const MIN_PART = 8 * MIB;
/** Presigned with the create; the page asks for the rest as it goes. */
export const FIRST_PARTS = 100;
const PAGE = 1000;
const HOUR = 3600_000;
export const DELETE_AFTER_END_MS = 48 * HOUR;
export const ABANDONED_AFTER_MS = 7 * 24 * HOUR;
export const DELETION_POLICY = 'Deleted 48 hours after the experiment ends';
/** No plan accepted: a quiet request has been left. An accepted contract's frozen files stay
 *  until its experiment ends, so a later payment always finds them. */
const UNSTARTED = ['planning'];
/** Plan statuses in which the request's files may change: not while one is verified or fixed. */
const OPEN_PLAN = ['drafting', 'changes_requested'];

export interface StoredFile {
  key: string;
  size: number;
  etag: string;
  uploaded: string;
}
export interface RequestFileStorage {
  provisionFiles(id: string): Promise<void>;
  listFiles(id: string): Promise<StoredFile[]>;
  head(id: string, key: string): Promise<StoredFile | null>;
  createMultipart(id: string, key: string, contentType: string): Promise<string>;
  presignPart(
    id: string,
    key: string,
    uploadId: string,
    partNumber: number,
    length: number,
  ): Promise<string>;
  completeMultipart(
    id: string,
    key: string,
    uploadId: string,
    parts: { partNumber: number; etag: string }[],
  ): Promise<void>;
  abortMultipart(id: string, key: string, uploadId: string): Promise<void>;
  copyFile(id: string, from: StoredFile, to: string): Promise<void>;
  deleteFiles(id: string, keys: string[]): Promise<void>;
  presignDownload(id: string, key: string): Promise<{ url: string; expiresAt: string }>;
  readFile(
    id: string,
    key: string,
    offset: number,
    length: number,
  ): Promise<{ bytes: Uint8Array; size: number; contentType: string | null }>;
  destroy(id: string): Promise<number>;
}
export type FilesLifecycle = Pick<WorkflowSnapshot, 'version' | 'state' | 'updatedAt'> & {
  /** Where the request's plan document stands (service_experiment@3). */
  planStatus?: string;
};

/** A relative path: `\` read as `/`, empty and `.` segments dropped, `..` refused, ≤ 1024 bytes. */
export function normalizeKey(value: string): string {
  const key = segments(value).join('/');
  check(key && !/[\\/]\s*$/.test(value), 'invalid_key', 'Name a file, not a folder');
  return key;
}
/** A folder: '' for the root, otherwise the normalised path with one trailing `/`. */
export function normalizePrefix(value: string): string {
  const path = segments(value).join('/');
  return path ? `${path}/` : '';
}
function segments(value: string): string[] {
  check(typeof value === 'string', 'invalid_key', 'File names are text');
  const parts = value
    .normalize('NFC')
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s && s !== '.');
  check(
    !parts.includes('..') && !/[\u0000-\u001f\u007f]/.test(value),
    'invalid_key',
    'File names cannot contain .. or control characters',
  );
  check(
    Buffer.byteLength(parts.join('/')) <= 1024,
    'invalid_key',
    'File names are at most 1024 bytes',
  );
  return parts;
}
/** The smallest whole-MiB part (≥ 8 MiB) that fits the object in 10,000 parts. */
export function partSize(size: number): number {
  return Math.max(MIN_PART, Math.ceil(size / MAX_PARTS / MIB) * MIB);
}
export function partCount(size: number, part = partSize(size)): number {
  return Math.max(1, Math.ceil(size / part));
}
export function partLength(size: number, part: number, partNumber: number): number {
  return Math.max(0, Math.min(part, size - (partNumber - 1) * part));
}

/** One folder level: its subfolders with their total size, and a page of its files. */
export function folderView(all: StoredFile[], prefix: string, cursor?: string) {
  const folders = new Map<string, { prefix: string; size: number; count: number }>();
  const files: StoredFile[] = [];
  for (const file of all) {
    if (!file.key.startsWith(prefix)) continue;
    const rest = file.key.slice(prefix.length),
      slash = rest.indexOf('/');
    if (slash < 0) {
      files.push(file);
      continue;
    }
    const name = prefix + rest.slice(0, slash + 1);
    const folder = folders.get(name) ?? { prefix: name, size: 0, count: 0 };
    folder.size += file.size;
    folder.count++;
    folders.set(name, folder);
  }
  files.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const after = cursor ? Buffer.from(cursor, 'base64url').toString('utf8') : '';
  const page = files.filter((f) => f.key > after).slice(0, PAGE);
  return {
    folders: [...folders.values()].sort((a, b) => (a.prefix < b.prefix ? -1 : 1)),
    files: page.map(({ key, size, uploaded }) => ({ key, size, uploaded })),
    cursor:
      page.length === PAGE && files.at(-1)!.key > page.at(-1)!.key
        ? Buffer.from(page.at(-1)!.key).toString('base64url')
        : null,
  };
}

interface FilesRow {
  request_id: string;
  provisioned_at: string | null;
  last_activity_at: string | null;
  ended_at: string | null;
  end_reason: string | null;
  delete_at: string | null;
  deleted_at: string | null;
  deleted_objects: number | string | null;
}
interface UploadRow {
  upload_id: string;
  request_id: string;
  key: string;
  size: number | string;
  part_size: number | string;
  created_at: string;
}
export const filesMigrations = {
  1: `
CREATE TABLE customer_experiment_files (
 request_id TEXT PRIMARY KEY, provisioned_at TEXT, last_activity_at TEXT, ended_at TEXT, end_reason TEXT,
 delete_at TEXT, deleted_at TEXT, deleted_objects BIGINT
);
CREATE TABLE customer_experiment_file_uploads (
 upload_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, key TEXT NOT NULL, size BIGINT NOT NULL,
 part_size BIGINT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX customer_experiment_file_uploads_request ON customer_experiment_file_uploads(request_id);
`,
};

/** How much of a file the intake agent reads in one call. */
export const READ_WINDOW = 64 * 1024;
/** An empty bucket made ahead of an upload is removed after this long without activity. */
export const WARM_BUCKET_IDLE_MS = 30 * 60_000;

/** When a request's files are deleted: 48 hours after it ends (complete, failed or abandoned). */
export function deletionSchedule(
  record: Pick<RequestRecord, 'createdAt'>,
  lifecycle: FilesLifecycle,
  lastActivity: string | null,
): { endedAt: string; reason: string; deleteAt: string } | null {
  let end: number | undefined, reason: string | undefined;
  if (['complete', 'failed'].includes(lifecycle.state)) {
    end = Date.parse(lifecycle.updatedAt);
    reason = lifecycle.state;
  } else if (UNSTARTED.includes(lifecycle.state)) {
    const last = Math.max(
      Date.parse(record.createdAt),
      Date.parse(lifecycle.updatedAt),
      lastActivity ? Date.parse(lastActivity) : 0,
    );
    if (Date.now() >= last + ABANDONED_AFTER_MS) {
      end = last + ABANDONED_AFTER_MS;
      reason = 'abandoned';
    }
  }
  if (end === undefined) return null;
  return {
    endedAt: new Date(end).toISOString(),
    reason: reason!,
    deleteAt: new Date(end + DELETE_AFTER_END_MS).toISOString(),
  };
}

export class FilesService implements RequestFiles {
  constructor(
    private state: State,
    private store: RequestStore,
    readonly storage: RequestFileStorage | undefined,
    private lifecycle: (record: RequestRecord) => Promise<FilesLifecycle>,
  ) {}
  async initialize() {
    await this.state.migrate('customer-experiment-files', filesMigrations);
  }
  private row(id: string) {
    return this.state.read((sql) =>
      sql.get<FilesRow>('SELECT * FROM customer_experiment_files WHERE request_id=?', id),
    );
  }
  private async upsert(id: string, fields: Partial<Omit<FilesRow, 'request_id'>>) {
    const names = Object.keys(fields);
    await this.state.transaction((tx) =>
      tx.run(
        `INSERT INTO customer_experiment_files(request_id${names.map((n) => `,${n}`).join('')}) VALUES(?${names.map(() => ',?').join('')})
         ON CONFLICT(request_id) DO UPDATE SET ${names.map((n) => `${n}=excluded.${n}`).join(',') || 'request_id=excluded.request_id'}`,
        id,
        ...Object.values(fields),
      ),
    );
  }
  /** Makes a v3 request's bucket before its first upload: a new bucket's CORS takes a moment. */
  async warm(record: RequestRecord) {
    if (!this.storage) return;
    const lifecycle = await this.lifecycle(record);
    if (lifecycle.version < 3 || lifecycle.state !== 'planning') return;
    const row = await this.row(record.id);
    if (row?.provisioned_at || row?.deleted_at) return;
    await this.storage.provisionFiles(record.id);
    const now = new Date().toISOString();
    await this.upsert(record.id, {
      provisioned_at: now,
      last_activity_at: row?.last_activity_at ?? now,
    });
  }
  /** Customer activity keeps an unaccepted request from being treated as abandoned. */
  async touch(id: string) {
    await this.upsert(id, { last_activity_at: new Date().toISOString() });
  }
  /** v3 only, storage configured; `write` also needs files that are neither frozen nor deleted. */
  private async open(record: RequestRecord, write: boolean) {
    const storage = this.storage;
    check(storage, 'files_unavailable', 'File storage is not configured', 503);
    const lifecycle = await this.lifecycle(record);
    check(lifecycle.version >= 3, 'not_found', 'This request has no file manager', 404);
    const row = await this.row(record.id);
    if (write) {
      check(!row?.deleted_at, 'files_deleted', 'These files were deleted', 410);
      check(
        lifecycle.state === 'planning',
        'files_frozen',
        'Files are fixed by the accepted contract',
        409,
      );
      // The agent verifies the files a submitted plan relies on; they hold still meanwhile.
      check(
        !lifecycle.planStatus || OPEN_PLAN.includes(lifecycle.planStatus),
        'files_frozen',
        'Files are fixed while the plan is verified',
        409,
      );
    }
    return { storage, lifecycle, row };
  }
  /** Bytes reserved by unfinished uploads; one left for a week no longer holds its share. */
  private async pending(id: string, tx?: Transaction) {
    const read = (sql: Pick<Transaction, 'all'>) =>
      sql.all<UploadRow>(
        'SELECT size FROM customer_experiment_file_uploads WHERE request_id=? AND created_at>?',
        id,
        new Date(Date.now() - ABANDONED_AFTER_MS).toISOString(),
      );
    const rows = tx ? await read(tx) : await this.state.read(read);
    return rows.reduce((n, u) => n + Number(u.size), 0);
  }
  async list(record: RequestRecord, prefix = '', cursor?: string) {
    const { storage, lifecycle, row } = await this.open(record, false);
    const folder = normalizePrefix(prefix);
    const all = row?.provisioned_at && !row.deleted_at ? await storage.listFiles(record.id) : [];
    const schedule = row?.deleted_at
      ? { deleteAt: row.delete_at }
      : deletionSchedule(record, lifecycle, row?.last_activity_at ?? null);
    return {
      ...folderView(all, folder, cursor || undefined),
      totalBytes: all.reduce((n, f) => n + f.size, 0),
      limitBytes: FILES_LIMIT_BYTES,
      deleteAt: schedule?.deleteAt ?? null,
      deletedAt: row?.deleted_at ?? null,
      deletionPolicy: DELETION_POLICY,
    };
  }
  async createUpload(
    record: RequestRecord,
    input: { key: string; size: number; contentType?: string },
  ) {
    const { storage, row } = await this.open(record, true);
    const key = normalizeKey(input.key);
    check(
      Number.isSafeInteger(input.size) && input.size >= 0 && input.size <= FILES_LIMIT_BYTES,
      'invalid_size',
      'File size must be between 0 bytes and 1 TB',
    );
    if (!row?.provisioned_at) {
      await storage.provisionFiles(record.id);
      await this.upsert(record.id, { provisioned_at: new Date().toISOString() });
    }
    const listed = await storage.listFiles(record.id);
    const size = partSize(input.size);
    const uploadId = await storage.createMultipart(
      record.id,
      key,
      input.contentType || 'application/octet-stream',
    );
    try {
      await this.state.transaction(async (tx) => {
        // Unfinished uploads count at their declared size, so parallel creates share the cap.
        const total =
          listed.reduce((n, f) => n + f.size, 0) + (await this.pending(record.id, tx)) + input.size;
        check(
          total <= FILES_LIMIT_BYTES,
          'files_limit',
          'Files for one experiment are limited to 1 TB',
          413,
        );
        await tx.run(
          'INSERT INTO customer_experiment_file_uploads(upload_id,request_id,key,size,part_size,created_at) VALUES(?,?,?,?,?,?)',
          uploadId,
          record.id,
          key,
          input.size,
          size,
          new Date().toISOString(),
        );
      });
    } catch (error) {
      await storage.abortMultipart(record.id, key, uploadId).catch(() => {});
      throw error;
    }
    await this.touch(record.id);
    const count = partCount(input.size, size);
    return {
      uploadId,
      key,
      partSize: size,
      partCount: count,
      parts: await this.presign(
        record.id,
        { key, size: input.size, part: size, uploadId },
        Array.from({ length: Math.min(count, FIRST_PARTS) }, (_, i) => i + 1),
      ),
    };
  }
  private async upload(record: RequestRecord, uploadId: string, key: string) {
    const row = await this.state.read((sql) =>
      sql.get<UploadRow>(
        'SELECT * FROM customer_experiment_file_uploads WHERE upload_id=? AND request_id=?',
        uploadId,
        record.id,
      ),
    );
    check(row && row.key === normalizeKey(key), 'not_found', 'Upload not found', 404);
    return { key: row.key, size: Number(row.size), part: Number(row.part_size), uploadId };
  }
  private presign(
    id: string,
    u: { key: string; size: number; part: number; uploadId: string },
    numbers: number[],
  ) {
    const count = partCount(u.size, u.part);
    check(
      numbers.length <= 1000 && numbers.every((n) => Number.isInteger(n) && n >= 1 && n <= count),
      'invalid_part',
      `Part numbers run from 1 to ${count}`,
    );
    return Promise.all(
      numbers.map(async (partNumber) => ({
        partNumber,
        url: await this.storage!.presignPart(
          id,
          u.key,
          u.uploadId,
          partNumber,
          partLength(u.size, u.part, partNumber),
        ),
      })),
    );
  }
  async parts(
    record: RequestRecord,
    uploadId: string,
    input: { key: string; partNumbers: number[] },
  ) {
    await this.open(record, true);
    const u = await this.upload(record, uploadId, input.key);
    return {
      uploadId,
      partSize: u.part,
      parts: await this.presign(record.id, u, input.partNumbers),
    };
  }
  async complete(
    record: RequestRecord,
    uploadId: string,
    input: { key: string; parts: { partNumber: number; etag: string }[] },
  ) {
    const { storage } = await this.open(record, true);
    const u = await this.upload(record, uploadId, input.key);
    const parts = [...input.parts].sort((a, b) => a.partNumber - b.partNumber);
    check(
      parts.length === partCount(u.size, u.part) && parts.every((p, i) => p.partNumber === i + 1),
      'invalid_part',
      'Complete the upload with every part, numbered from 1',
    );
    await storage.completeMultipart(record.id, u.key, uploadId, parts);
    await this.state.transaction((tx) =>
      tx.run('DELETE FROM customer_experiment_file_uploads WHERE upload_id=?', uploadId),
    );
    const stored = await storage.head(record.id, u.key);
    if (stored?.size !== u.size) {
      await storage.deleteFiles(record.id, [u.key]);
      throw new MervError('invalid_upload', 'The uploaded file does not match its declared size');
    }
    await this.touch(record.id);
    return { key: stored.key, size: stored.size, uploaded: stored.uploaded };
  }
  async abort(record: RequestRecord, uploadId: string, key: string) {
    check(this.storage, 'files_unavailable', 'File storage is not configured', 503);
    const u = await this.upload(record, uploadId, key);
    await this.storage.abortMultipart(record.id, u.key, uploadId);
    await this.state.transaction((tx) =>
      tx.run('DELETE FROM customer_experiment_file_uploads WHERE upload_id=?', uploadId),
    );
    return { aborted: true };
  }
  /** Copy then delete. A trailing `/`, or a name with no file but files under it, is a folder. */
  async rename(record: RequestRecord, input: { from: string; to: string }) {
    const { storage } = await this.open(record, true);
    const all = await storage.listFiles(record.id);
    const file = /[\\/]\s*$/.test(input.from)
      ? undefined
      : all.find((f) => f.key === normalizeKey(input.from));
    const moves: [StoredFile, string][] = [];
    if (file) {
      const to = normalizeKey(input.to);
      check(!all.some((f) => f.key === to), 'file_exists', 'A file with that name exists', 409);
      if (to !== file.key) moves.push([file, to]);
    } else {
      const from = normalizePrefix(input.from),
        to = normalizePrefix(input.to);
      check(from && to, 'invalid_key', 'Name the folder to rename and its new name');
      const inside = all.filter((f) => f.key.startsWith(from));
      check(inside.length, 'not_found', 'File or folder not found', 404);
      check(!to.startsWith(from), 'invalid_key', 'A folder cannot move into itself');
      check(
        !all.some((f) => f.key.startsWith(to)),
        'file_exists',
        'A folder with that name exists',
        409,
      );
      // Every new name is checked before the first copy, so a refusal copies nothing.
      for (const f of inside) moves.push([f, normalizeKey(to + f.key.slice(from.length))]);
    }
    check(
      all.reduce((n, f) => n + f.size, 0) + (await this.pending(record.id)) <= FILES_LIMIT_BYTES,
      'files_limit',
      'Files for one experiment are limited to 1 TB',
      413,
    );
    const copied: string[] = [];
    try {
      for (const [f, to] of moves) {
        await storage.copyFile(record.id, f, to);
        copied.push(to);
      }
    } catch (error) {
      // A rename that fails partway leaves the originals as they were and no copies.
      if (copied.length) await storage.deleteFiles(record.id, copied).catch(() => {});
      throw error;
    }
    await storage.deleteFiles(
      record.id,
      moves.map(([f]) => f.key),
    );
    await this.touch(record.id);
    return { renamed: moves.length };
  }
  async remove(record: RequestRecord, target: { key?: string; prefix?: string }) {
    const { storage } = await this.open(record, true);
    let keys: string[];
    if (target.key !== undefined) {
      const key = normalizeKey(target.key);
      check(await storage.head(record.id, key), 'not_found', 'File not found', 404);
      keys = [key];
    } else {
      const prefix = normalizePrefix(target.prefix ?? '');
      check(prefix, 'invalid_key', 'Name the folder to delete');
      keys = (await storage.listFiles(record.id))
        .filter((f) => f.key.startsWith(prefix))
        .map((f) => f.key);
    }
    await storage.deleteFiles(record.id, keys);
    await this.touch(record.id);
    return { deleted: keys.length };
  }
  async download(record: RequestRecord, key: string) {
    const { storage, row } = await this.open(record, false);
    check(!row?.deleted_at, 'files_deleted', 'These files were deleted', 410);
    const name = normalizeKey(key);
    check(
      row?.provisioned_at && (await storage.head(record.id, name)),
      'not_found',
      'File not found',
      404,
    );
    return storage.presignDownload(record.id, name);
  }
  /** A 5-minute download link to one request file, for the intake agent's terminal. */
  async link(id: string, key: string) {
    const row = await this.row(id);
    check(
      this.storage && row?.provisioned_at && !row.deleted_at,
      'not_found',
      'This request has no files',
      404,
    );
    const name = normalizeKey(key);
    check(await this.storage!.head(id, name), 'not_found', `No file ${name}`, 404);
    return { key: name, ...(await this.storage!.presignDownload(id, name)) };
  }
  /** Whether the request's files were deleted, so no contract can rely on them. */
  async deleted(id: string) {
    return !!(await this.row(id))?.deleted_at;
  }
  /** The request's files as they stand: what an accepting contract freezes. */
  /**
   * One request file as the intake agent reads it: a window of its text from `offset`, or, for a
   * binary file, only what it is. The agent pages through a large file with nextOffset.
   */
  async read(id: string, key: string, offset = 0) {
    const row = await this.row(id);
    check(
      this.storage && row?.provisioned_at && !row.deleted_at,
      'not_found',
      'This request has no files',
      404,
    );
    const name = normalizeKey(key);
    const file = await this.storage!.head(id, name);
    check(file, 'not_found', `No file ${name}`, 404);
    const start = Math.max(0, Math.min(Math.floor(offset), file.size));
    if (start === file.size)
      return { key: name, size: file.size, offset: start, text: '', nextOffset: null };
    const { bytes, contentType } = await this.storage!.readFile(id, name, start, READ_WINDOW);
    if (bytes.includes(0))
      return { key: name, size: file.size, contentType, binary: true as const, offset: start };
    // A window ends on a whole character: a cut multi-byte sequence waits for the next one.
    let end = bytes.length;
    while (end > 0 && end < file.size - start && (bytes[end - 1]! & 0xc0) === 0x80) end--;
    if (end > 0 && end < file.size - start && bytes[end - 1]! >= 0xc0) end--;
    const next = start + end;
    return {
      key: name,
      size: file.size,
      contentType,
      offset: start,
      text: new TextDecoder().decode(bytes.subarray(0, end)),
      nextOffset: next < file.size ? next : null,
    };
  }
  async manifest(id: string) {
    const row = await this.row(id);
    if (!this.storage || !row?.provisioned_at || row.deleted_at) return [];
    return (await this.storage.listFiles(id))
      .map(({ key, size, etag }) => ({ key, size, etag }))
      .sort((a, b) => (a.key < b.key ? -1 : 1));
  }
  /** The request of a customer experiment, for its executing worker. */
  async forExperiment(experimentId: string) {
    const record = (await this.store.list()).find((r) => r.experimentId === experimentId);
    check(record, 'not_found', 'Experiment request not found', 404);
    return record;
  }
  /** Deletes every object and the bucket of each ended request once its deleteAt passes. */
  async sweep() {
    const rows = await this.state.read((sql) =>
      sql.all<FilesRow>(
        'SELECT * FROM customer_experiment_files WHERE provisioned_at IS NOT NULL AND deleted_at IS NULL',
      ),
    );
    for (const row of rows) {
      try {
        const record = await this.store.get(row.request_id);
        const lifecycle = await this.lifecycle(record);
        if (lifecycle.version < 3 || !this.storage) continue;
        // A bucket made ahead of a first upload that never came goes after half an hour of quiet;
        // the next upload makes it again.
        const quietSince = Date.parse(row.last_activity_at ?? row.provisioned_at!);
        if (
          lifecycle.state === 'planning' &&
          Date.now() - quietSince > WARM_BUCKET_IDLE_MS &&
          !(await this.pending(record.id)) &&
          !(await this.storage.listFiles(record.id)).length
        ) {
          await this.storage.destroy(record.id);
          await this.upsert(record.id, { provisioned_at: null });
          continue;
        }
        const schedule = deletionSchedule(record, lifecycle, row.last_activity_at);
        await this.upsert(record.id, {
          ended_at: schedule?.endedAt ?? null,
          end_reason: schedule?.reason ?? null,
          delete_at: schedule?.deleteAt ?? null,
        });
        if (!schedule || Date.parse(schedule.deleteAt) > Date.now()) continue;
        const objects = await this.storage.destroy(record.id);
        await this.state.transaction(async (tx) => {
          await tx.run(
            'UPDATE customer_experiment_files SET deleted_at=?, deleted_objects=? WHERE request_id=?',
            new Date().toISOString(),
            objects,
            record.id,
          );
          await tx.run(
            'DELETE FROM customer_experiment_file_uploads WHERE request_id=?',
            record.id,
          );
        });
      } catch (error) {
        process.stderr.write(
          JSON.stringify({
            event: 'customer_experiment.files_sweep_wait',
            requestId: row.request_id,
            code: (error as { code?: string }).code ?? 'unavailable',
          }) + '\n',
        );
      }
    }
  }
}

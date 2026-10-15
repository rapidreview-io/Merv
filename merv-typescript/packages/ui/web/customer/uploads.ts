import { ApiError } from '../api';
import { customerRequest } from './api';

/**
 * Uploads into the request's bucket, as the braziliano file manager
 * (merv-sandboxes/deploy/r2-upload) runs them: a few files at once, a few parts of each, every
 * part retried with backoff, progress per file and in total, cancel and retry. Each file is one
 * multipart upload Merv creates (POST /files/uploads); its parts go from the browser straight to
 * the bucket on the presigned URLs Merv hands out, and Merv completes it with their ETags.
 */

const PARALLEL_FILES = 3;
const PARALLEL_PARTS = 4;
const MAX_REQUESTS = 6;
const RETRIES = 6;
const IGNORED = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
export const LIVE = ['queued', 'starting', 'uploading'] as const;

export type UploadState = 'queued' | 'starting' | 'uploading' | 'done' | 'failed' | 'cancelled';
export interface Upload {
  id: number;
  file: File;
  /** Where it goes in the bucket. */
  key: string;
  state: UploadState;
  loaded: number;
  error: string;
}
interface Running extends Upload {
  uploadId: string | null;
  partLoaded: Map<number, number>;
  aborts: Set<() => void>;
  stopped: boolean;
  cancelRequested: boolean;
}
/** One part sent to its presigned URL: the ETag the bucket answered, or a status to act on. */
export type PutPart = (
  url: string,
  body: Blob,
  onProgress: (loaded: number) => void,
  register: (abort: () => void) => void,
) => Promise<{ status: number; etag: string | null } | null>;

interface Created {
  uploadId: string;
  partSize: number;
  parts: { partNumber: number; url: string }[];
}

class Stopped extends Error {}

/** A part PUT over XHR, so its progress is seen; null where the connection failed. */
export const xhrPut: PutPart = (url, body, onProgress, register) =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.upload.onprogress = (event) => onProgress(event.loaded);
    xhr.onload = () => resolve({ status: xhr.status, etag: xhr.getResponseHeader('ETag') });
    xhr.onerror = () => resolve(null);
    xhr.ontimeout = () => resolve(null);
    xhr.onabort = () => reject(new Stopped());
    register(() => xhr.abort());
    xhr.send(body);
  });

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** What the file manager draws of the uploads, renewed (as a new object) whenever one moves. */
export interface UploadsView {
  items: readonly Upload[];
  total: number;
  loaded: number;
  live: number;
  finished: number;
  failed: number;
}

export class Uploader {
  private items: Running[] = [];
  private running = 0;
  private active = 0;
  private waiting: (() => void)[] = [];
  private next = 1;
  private listeners = new Set<() => void>();
  private view: UploadsView = { items: [], total: 0, loaded: 0, live: 0, finished: 0, failed: 0 };

  constructor(
    private readonly options: {
      /** A file finished: the listing it landed in is read again. */
      onDone?: () => void;
      put?: PutPart;
    } = {},
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  snapshot = () => this.view;

  private changed() {
    let [total, loaded, live, finished, failed] = [0, 0, 0, 0, 0];
    for (const item of this.items) {
      if (item.state === 'cancelled') continue;
      total += item.file.size;
      loaded += Math.min(item.loaded, item.file.size);
      if ((LIVE as readonly string[]).includes(item.state)) live++;
      if (item.state === 'done') finished++;
      if (item.state === 'failed') failed++;
    }
    const items = this.items.map(({ id, file, key, state, loaded, error }) => ({
      id,
      file,
      key,
      state,
      loaded,
      error,
    }));
    this.view = { items, total, loaded, live, finished, failed };
    for (const listener of this.listeners) listener();
  }

  /** Queues files under `prefix`, each at its relative path; a file already on its way stays. */
  add(entries: { file: File; path: string }[], prefix: string) {
    for (const { file, path } of entries) {
      if (IGNORED.has(file.name)) continue;
      const key = prefix + path;
      if (this.items.some((i) => i.key === key && (LIVE as readonly string[]).includes(i.state)))
        continue;
      this.items.push({
        id: this.next++,
        file,
        key,
        state: 'queued',
        loaded: 0,
        error: '',
        uploadId: null,
        partLoaded: new Map(),
        aborts: new Set(),
        stopped: false,
        cancelRequested: false,
      });
    }
    this.pump();
  }

  cancel(id: number) {
    const item = this.items.find((i) => i.id === id);
    if (!item || !(LIVE as readonly string[]).includes(item.state)) return;
    item.cancelRequested = true;
    if (item.state === 'queued') item.state = 'cancelled';
    this.stop(item);
    this.changed();
  }

  retry(id: number) {
    const item = this.items.find((i) => i.id === id);
    if (!item || !['failed', 'cancelled'].includes(item.state)) return;
    Object.assign(item, { cancelRequested: false, error: '', state: 'queued' });
    this.pump();
  }

  /** Forgets every upload that has ended. */
  clear() {
    this.items = this.items.filter((i) => (LIVE as readonly string[]).includes(i.state));
    this.changed();
  }

  /** Whether leaving the page now would lose an upload. */
  busy = () => this.items.some((i) => (LIVE as readonly string[]).includes(i.state));

  private pump() {
    while (this.running < PARALLEL_FILES) {
      const item = this.items.find((i) => i.state === 'queued');
      if (!item) break;
      this.running++;
      item.state = 'starting';
      void this.run(item).finally(() => {
        this.running--;
        this.pump();
      });
    }
    this.changed();
  }

  private stop(item: Running) {
    item.stopped = true;
    for (const abort of [...item.aborts]) abort();
  }

  private async acquire() {
    if (this.active < MAX_REQUESTS) return void this.active++;
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }
  private release() {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }

  private setLoaded(item: Running, part: number, bytes: number) {
    item.loaded += bytes - (item.partLoaded.get(part) ?? 0);
    item.partLoaded.set(part, bytes);
    this.changed();
  }

  private async run(item: Running) {
    Object.assign(item, { state: 'uploading', stopped: false, loaded: 0 });
    item.partLoaded.clear();
    this.changed();
    try {
      await this.upload(item);
      item.state = 'done';
      item.loaded = item.file.size;
      this.options.onDone?.();
    } catch (cause) {
      if (item.cancelRequested) item.state = 'cancelled';
      else {
        item.state = 'failed';
        item.error = cause instanceof Error && cause.message ? cause.message : 'Failed';
      }
      this.abandon(item);
    }
    this.changed();
  }

  /** One of Merv's calls, retried while Merv is away or failing; its refusal is the file's. */
  private async call<T>(item: Running, path: string, method: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      if (item.stopped) throw new Stopped();
      try {
        return await customerRequest<T>(path, { method, body });
      } catch (cause) {
        const lasting = cause instanceof ApiError && cause.status > 0 && cause.status < 500;
        if (lasting || attempt >= RETRIES) throw cause;
      }
      await wait(Math.min(30_000, 1000 * 2 ** attempt));
    }
  }

  private async upload(item: Running) {
    const { file, key } = item;
    const created = await this.call<Created>(item, '/files/uploads', 'POST', {
      key,
      size: file.size,
      contentType: file.type || 'application/octet-stream',
    });
    item.uploadId = created.uploadId;
    const size = created.partSize;
    const count = Math.max(1, Math.ceil(file.size / size));
    const urls = new Map(created.parts.map((part) => [part.partNumber, part.url]));
    const uploads = `/files/uploads/${encodeURIComponent(created.uploadId)}`;
    /** Fresh URLs for these parts: ones never handed out, or ones that expired. */
    const sign = async (partNumbers: number[]) => {
      const more = await this.call<{ parts: { partNumber: number; url: string }[] }>(
        item,
        `${uploads}/parts`,
        'POST',
        { key, partNumbers },
      );
      for (const part of more.parts) urls.set(part.partNumber, part.url);
    };
    const parts: { partNumber: number; etag: string }[] = new Array(count);
    let next = 0;
    const worker = async () => {
      while (next < count) {
        if (item.stopped) throw new Stopped();
        const index = next++;
        const number = index + 1;
        const blob = file.slice(index * size, Math.min(file.size, number * size));
        parts[index] = {
          partNumber: number,
          etag: await this.part(item, number, blob, urls, sign),
        };
        this.setLoaded(item, number, blob.size);
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(PARALLEL_PARTS, count) }, worker));
    } catch (cause) {
      this.stop(item);
      throw cause;
    }
    await this.call(item, `${uploads}/complete`, 'POST', { key, parts });
    item.uploadId = null;
  }

  /** Sends one part, retrying a dropped connection or a failing bucket with backoff and an
   * expired or missing URL with a fresh one; answers the part's ETag. */
  private async part(
    item: Running,
    number: number,
    blob: Blob,
    urls: Map<number, string>,
    sign: (partNumbers: number[]) => Promise<void>,
  ): Promise<string> {
    const put = this.options.put ?? xhrPut;
    for (let attempt = 0; ; attempt++) {
      if (item.stopped) throw new Stopped();
      if (!urls.has(number)) await sign([number]);
      await this.acquire();
      let answer: Awaited<ReturnType<PutPart>>;
      try {
        if (item.stopped) throw new Stopped();
        let abort: (() => void) | undefined;
        answer = await put(
          urls.get(number)!,
          blob,
          (loaded) => this.setLoaded(item, number, loaded),
          (cancel) => item.aborts.add((abort = cancel)),
        ).finally(() => abort && item.aborts.delete(abort));
      } finally {
        this.release();
      }
      if (answer && answer.status >= 200 && answer.status < 300) {
        if (!answer.etag) throw new Error('The bucket hid the part’s ETag');
        return answer.etag;
      }
      if (attempt >= RETRIES) throw new Error(answer ? `HTTP ${answer.status}` : 'Network error');
      this.setLoaded(item, number, 0);
      // A presigned URL the bucket refuses has expired: the part is signed again.
      if (answer && [400, 403].includes(answer.status)) urls.delete(number);
      else await wait(Math.min(30_000, 1000 * 2 ** attempt));
    }
  }

  private abandon(item: Running) {
    if (!item.uploadId) return;
    const id = item.uploadId;
    item.uploadId = null;
    void customerRequest(
      `/files/uploads/${encodeURIComponent(id)}?${new URLSearchParams({ key: item.key })}`,
      { method: 'DELETE' },
    ).catch(() => {});
  }
}

/** The files a drop holds, each at its path inside the folders dropped. */
export async function fromDrop(data: DataTransfer): Promise<{ file: File; path: string }[]> {
  // Entries must be taken before the first await; the drop data expires after the event.
  const entries = [...data.items]
    .map((item) => item.webkitGetAsEntry?.())
    .filter((entry): entry is FileSystemEntry => !!entry);
  if (!entries.length) return [...data.files].map((file) => ({ file, path: file.name }));
  const out: { file: File; path: string }[] = [];
  const walk = async (entry: FileSystemEntry, at: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject),
      );
      out.push({ file, path: at + file.name });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const batch = () =>
        new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      for (let read = await batch(); read.length; read = await batch())
        for (const child of read) await walk(child, `${at}${entry.name}/`);
    }
  };
  for (const entry of entries) await walk(entry, '');
  return out;
}

/** Bytes as the file manager writes them: 1000s, one decimal under ten. */
export function formatBytes(n: number): string {
  if (n < 1000) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n;
  let unit = -1;
  do {
    value /= 1000;
    unit++;
  } while (value >= 1000 && unit < units.length - 1);
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

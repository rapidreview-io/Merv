import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { check, MAX_OBJECT_BYTES, MervError, type Blobs } from '@merv/contracts';
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

export interface S3BlobOptions {
  bucket: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  prefix?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  /** Only for a local protocol fixture; never exposed in plugin configuration. */
  allowHttpLoopbackForTests?: boolean;
}

/** Also the plugin Config defaults, which bound both values; direct callers may omit them. */
export const S3_DEFAULTS = { timeoutMs: 30_000, maxAttempts: 3 } as const;

/** The HTTP status of an S3 SDK failure, when the service answered. */
const statusOf = (error: unknown) =>
  (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;

/** GET names a missing key; a missing bucket or prefix is misconfiguration, not a missing blob. */
const missingKey = (error: unknown) => (error as { name?: string }).name === 'NoSuchKey';
/** HEAD has no error body, so a missing key and a missing bucket are both a bare 404. */
const missingHead = (error: unknown) => statusOf(error) === 404;

const transferSize = (size: number) =>
  check(
    Number.isSafeInteger(size) && size >= 0 && size <= MAX_OBJECT_BYTES,
    'blob_size',
    'Transfer size must be between 0 bytes and 512 MiB',
  );

export class S3Blobs implements Blobs {
  private client: S3Client;
  private bucket: string;
  private prefix: string;
  private timeoutMs: number;
  private maxAttempts: number;
  private operations = new BlobOperations();

  constructor(options: S3BlobOptions) {
    let endpoint: URL;
    try {
      endpoint = new URL(options.endpoint);
    } catch {
      throw new MervError('invalid_blob_config', 'Blob endpoint must be an HTTPS origin');
    }
    const testLoopback =
      options.allowHttpLoopbackForTests === true &&
      endpoint.protocol === 'http:' &&
      ['127.0.0.1', '[::1]'].includes(endpoint.hostname);
    check(
      (endpoint.protocol === 'https:' || testLoopback) &&
        !endpoint.username &&
        !endpoint.password &&
        !endpoint.search &&
        !endpoint.hash &&
        endpoint.pathname === '/',
      'invalid_blob_config',
      'Blob endpoint must be an HTTPS origin',
    );
    check(
      /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket),
      'invalid_blob_config',
      'Invalid blob bucket',
    );
    check(
      !!options.accessKeyId?.trim() && !!options.secretAccessKey?.trim(),
      'invalid_blob_config',
      'Blob credentials must be configured',
    );
    this.prefix = (options.prefix ?? '').replace(/^\/+|\/+$/g, '');
    check(
      !this.prefix ||
        this.prefix
          .split('/')
          .every(
            (part) => !!part && part !== '.' && part !== '..' && /^[a-zA-Z0-9_.-]+$/.test(part),
          ),
      'invalid_blob_config',
      'Invalid blob prefix',
    );
    this.timeoutMs = options.timeoutMs ?? S3_DEFAULTS.timeoutMs;
    this.maxAttempts = options.maxAttempts ?? S3_DEFAULTS.maxAttempts;
    this.bucket = options.bucket;
    this.client = new S3Client({
      endpoint: endpoint.origin,
      region: options.region ?? 'auto',
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
      forcePathStyle: true,
      // Own the retry delay so the operation deadline also interrupts backoff.
      maxAttempts: 1,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  private key(namespace: string, hash: string): string {
    validateKey(namespace, hash);
    return [this.prefix, namespace, hash].filter(Boolean).join('/');
  }

  private async request<T>(signal: AbortSignal, send: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      signal.throwIfAborted();
      try {
        return await send();
      } catch (error) {
        const status = statusOf(error);
        // 409: a conditional write raced another operation on the same key.
        const retryable =
          status === 408 ||
          status === 409 ||
          status === 429 ||
          (status !== undefined && status >= 500) ||
          ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE'].includes(
            (error as { code?: string }).code ?? '',
          );
        if (signal.aborted || attempt >= this.maxAttempts || !retryable) throw error;
        await delay(Math.min(100 * 2 ** (attempt - 1), 1000), undefined, { signal });
      }
    }
  }

  async put(namespace: string, bytes: Uint8Array): Promise<{ hash: string; size: number }> {
    validateNamespace(namespace);
    const content = copyBytes(bytes);
    return this.operations.run(async () => {
      const hash = hashBytes(content);
      const key = this.key(namespace, hash);
      const signal = AbortSignal.timeout(this.timeoutMs);
      try {
        await this.request(signal, () =>
          this.client.send(
            new PutObjectCommand({
              Bucket: this.bucket,
              Key: key,
              Body: content,
              ContentType: 'application/octet-stream',
              ContentMD5: createHash('md5').update(content).digest('base64'),
              IfNoneMatch: '*',
            }),
            { abortSignal: signal },
          ),
        );
      } catch (error) {
        if (statusOf(error) !== 412) throw storageError(error, 'Blob upload failed');
        // The object exists: it must read back intact. Vanishing now is an outage, not a miss.
        await this.read(namespace, hash, signal).catch((failure: unknown) => {
          throw failure instanceof MervError && failure.code === 'blob_not_found'
            ? new MervError('blob_unavailable', 'Blob upload failed', 503)
            : failure;
        });
      }
      return { hash, size: content.byteLength };
    });
  }

  private async read(namespace: string, hash: string, signal: AbortSignal): Promise<Buffer> {
    const key = this.key(namespace, hash);
    let body: Readable | undefined;
    const abort = () => body?.destroy(new Error('Blob download timed out'));
    try {
      const response = await this.request(signal, () =>
        this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
          abortSignal: signal,
        }),
      );
      body = response.Body as Readable | undefined;
      check(
        body && typeof body[Symbol.asyncIterator] === 'function',
        'blob_unavailable',
        'Blob download failed',
        503,
      );
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      if (response.ContentLength !== undefined) storedSize(response.ContentLength);
      const chunks: Uint8Array[] = [];
      let length = 0;
      for await (const chunk of body!) {
        length += (chunk as Uint8Array).byteLength;
        storedSize(length);
        chunks.push(chunk as Uint8Array);
      }
      check(
        response.ContentLength === undefined || response.ContentLength === length,
        'blob_corrupt',
        'Stored blob size does not match its metadata',
        500,
      );
      return verifyBytes(Buffer.concat(chunks, length), hash);
    } catch (error) {
      throw storageError(error, 'Blob download failed', missingKey);
    } finally {
      signal.removeEventListener('abort', abort);
      body?.destroy();
    }
  }

  async download(namespace: string, hash: string, expectedSize: number) {
    const key = this.key(namespace, hash);
    transferSize(expectedSize);
    return this.operations.run(async () => {
      try {
        const signal = AbortSignal.timeout(this.timeoutMs);
        const head = await this.request(signal, () =>
          this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }), {
            abortSignal: signal,
          }),
        );
        check(
          head.ContentLength === expectedSize,
          'blob_corrupt',
          'Stored blob size does not match retained metadata',
          500,
        );
        const signingDate = new Date(Math.floor(Date.now() / 1000) * 1000);
        const url = await getSignedUrl(
          this.client,
          new GetObjectCommand({
            Bucket: this.bucket,
            Key: key,
            ResponseContentDisposition: `attachment; filename="${hash}"`,
            ResponseContentType: 'application/octet-stream',
            ResponseCacheControl: 'private, no-store',
          }),
          { expiresIn: 60, signingDate },
        );
        return { url, expiresAt: new Date(signingDate.getTime() + 60_000).toISOString() };
      } catch (error) {
        throw storageError(error, 'Blob download could not be prepared', missingHead);
      }
    });
  }

  get(namespace: string, hash: string): Promise<Buffer> {
    return this.operations.run(() =>
      this.read(namespace, hash, AbortSignal.timeout(this.timeoutMs)),
    );
  }

  close(): Promise<void> {
    return this.operations.close(() => this.client.destroy());
  }
}

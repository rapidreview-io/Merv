import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import {
  CopyObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { check, MervError, type Blobs } from '@merv/contracts';
import {
  BlobOperations,
  copyBytes,
  hashBytes,
  MAX_BLOB_BYTES,
  validateKey,
  validateNamespace,
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

/** Offline migration and direct downloads only; ordinary get/put remain limited to 2 MB. */
export const MAX_TRANSFER_BYTES = 512 * 1024 * 1024;
const transferSize = (size: number) =>
  check(
    Number.isSafeInteger(size) && size >= 0 && size <= MAX_TRANSFER_BYTES,
    'blob_size',
    'Transfer size must be between 0 bytes and 512 MiB',
  );

export class S3Blobs implements Blobs {
  private client: S3Client;
  private bucket: string;
  private prefix: string;
  private timeoutMs: number;
  private maxAttempts: number;
  private endpoint: string;
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
    this.endpoint = endpoint.origin;
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
        const failure = error as { $metadata?: { httpStatusCode?: number }; code?: string };
        const status = failure.$metadata?.httpStatusCode;
        const retryable =
          status === 408 ||
          status === 429 ||
          (status !== undefined && status >= 500) ||
          ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE'].includes(
            failure.code ?? '',
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
        if (
          (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 412
        )
          await this.read(namespace, hash, signal);
        else throw new MervError('blob_unavailable', 'Blob upload failed', 503);
      }
      return { hash, size: content.byteLength };
    });
  }

  private async consume(
    namespace: string,
    hash: string,
    signal: AbortSignal,
    options: { collect: boolean; expectedSize?: number; ifMatch?: string },
  ) {
    const key = this.key(namespace, hash);
    const limit = options.collect ? MAX_BLOB_BYTES : MAX_TRANSFER_BYTES;
    let body: Readable | undefined;
    const abort = () => body?.destroy(new Error('Blob download timed out'));
    try {
      const response = await this.request(signal, () =>
        this.client.send(
          new GetObjectCommand({ Bucket: this.bucket, Key: key, IfMatch: options.ifMatch }),
          {
            abortSignal: signal,
          },
        ),
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
      check(
        response.ContentLength === undefined || response.ContentLength <= limit,
        'blob_size',
        'Blob exceeds the maximum size',
      );
      const chunks: Buffer[] = [];
      const digest = createHash('sha256');
      let length = 0;
      for await (const chunk of body!) {
        const bytes = Buffer.from(chunk);
        length += bytes.byteLength;
        check(length <= limit, 'blob_size', 'Blob exceeds the maximum size');
        check(
          options.expectedSize === undefined || length <= options.expectedSize,
          'blob_corrupt',
          'Stored blob exceeds its retained size',
          500,
        );
        digest.update(bytes);
        if (options.collect) chunks.push(bytes);
      }
      check(
        response.ContentLength === undefined || response.ContentLength === length,
        'blob_corrupt',
        'Stored blob size does not match its metadata',
        500,
      );
      check(
        options.expectedSize === undefined || length === options.expectedSize,
        'blob_corrupt',
        'Stored blob size does not match retained metadata',
        500,
      );
      check(
        digest.digest('hex') === hash,
        'blob_corrupt',
        'Stored blob failed its integrity check',
        500,
      );
      return {
        size: length,
        etag: response.ETag,
        bytes: options.collect ? Buffer.concat(chunks, length) : undefined,
      };
    } catch (error) {
      if (error instanceof MervError) throw error;
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404)
        throw new MervError('blob_not_found', 'Blob not found', 404);
      throw new MervError('blob_unavailable', 'Blob download failed', 503);
    } finally {
      signal.removeEventListener('abort', abort);
      body?.destroy();
    }
  }

  private async read(namespace: string, hash: string, signal: AbortSignal): Promise<Buffer> {
    return (await this.consume(namespace, hash, signal, { collect: true })).bytes!;
  }

  download(namespace: string, hash: string, expectedSize: number) {
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
        if (error instanceof MervError) throw error;
        throw new MervError('blob_unavailable', 'Blob download could not be prepared', 503);
      }
    });
  }

  private async verifyRetained(
    namespace: string,
    hash: string,
    size: number | undefined,
    signal: AbortSignal,
  ) {
    let head;
    try {
      head = await this.request(signal, () =>
        this.client.send(
          new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(namespace, hash) }),
          { abortSignal: signal },
        ),
      );
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404)
        throw new MervError('blob_not_found', 'Blob not found', 404);
      throw new MervError('blob_unavailable', 'Blob verification failed', 503);
    }
    check(
      size === undefined || head.ContentLength === size,
      'blob_corrupt',
      'Stored blob size does not match retained metadata',
      500,
    );
    transferSize(head.ContentLength!);
    const verifiedSize = head.ContentLength!;
    check(head.ETag, 'blob_copy_unsupported', 'Object must expose a version ETag');
    await this.consume(namespace, hash, signal, {
      collect: false,
      expectedSize: verifiedSize,
      ifMatch: head.ETag,
    });
    return { etag: head.ETag, size: verifiedSize };
  }

  /** Trusted offline import only: namespace/hash derive both keys, never caller-supplied URLs. */
  copyVerifiedFrom(
    source: S3Blobs,
    namespace: string,
    hash: string,
    size?: number,
    options: { timeoutMs?: number; destinationCondition?: 's3' | 'r2' } = {},
  ) {
    const key = this.key(namespace, hash);
    const sourceKey = source.key(namespace, hash);
    if (size !== undefined) transferSize(size);
    check(
      this.endpoint === source.endpoint,
      'blob_copy_unsupported',
      'Server-side copy requires the same storage endpoint',
    );
    const timeoutMs = options.timeoutMs ?? 120_000;
    check(
      Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 900_000,
      'invalid_blob_config',
      'Migration timeout must be between 1 and 900000 milliseconds',
    );
    return this.operations.run(async () => {
      const signal = AbortSignal.timeout(timeoutMs);
      const original = await source.verifyRetained(namespace, hash, size, signal);
      const verifiedSize = original.size;
      check(original.etag, 'blob_copy_unsupported', 'Source object must expose a version ETag');
      if (this.bucket === source.bucket && key === sourceKey) return { hash, size: verifiedSize };
      const r2 =
        options.destinationCondition === 'r2' ||
        (options.destinationCondition === undefined &&
          new URL(this.endpoint).hostname.endsWith('.r2.cloudflarestorage.com'));
      const command = new CopyObjectCommand({
        Bucket: this.bucket,
        Key: key,
        CopySource: `${source.bucket}/${sourceKey}`,
        CopySourceIfMatch: original.etag,
        IfNoneMatch: r2 ? undefined : '*',
      });
      if (r2)
        command.middlewareStack.add(
          (next) => async (args) => {
            (args.request as { headers: Record<string, string> }).headers[
              'cf-copy-destination-if-none-match'
            ] = '*';
            return next(args);
          },
          { step: 'build', name: 'r2ImmutableDestination' },
        );
      try {
        await this.request(signal, () => this.client.send(command, { abortSignal: signal }));
      } catch (error) {
        if (
          (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 412
        )
          throw new MervError('blob_unavailable', 'Verified blob copy failed', 503);
        // Source races and existing destinations both produce 412. Only verified destination
        // bytes prove the intended immutable object is present; an absent/corrupt one fails.
      }
      await this.verifyRetained(namespace, hash, verifiedSize, signal);
      return { hash, size: verifiedSize };
    }, [source.operations]);
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

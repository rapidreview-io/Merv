import { isUtf8 } from 'node:buffer';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  PutBucketCorsCommand,
  PutPublicAccessBlockCommand,
  S3Client,
  UploadPartCommand,
  UploadPartCopyCommand,
  type BucketLocationConstraint,
  type CORSRule,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { S3Blobs, type S3BlobOptions } from '@merv/blobs/s3';
import { check, digest } from '@merv/contracts';
import type { DataRequirement } from './types.js';
import { partLength, partSize, type RequestFileStorage, type StoredFile } from './files.js';

/** Initial offer: bounded UTF-8 tables. Content, not the filename, determines validity. */
export function validateDataset(bytes: Buffer, requirement: DataRequirement) {
  check(
    bytes.length > 0 && bytes.length <= 20 * 1024 * 1024 && isUtf8(bytes) && !bytes.includes(0),
    'invalid_dataset',
    'Upload a UTF-8 CSV or JSONL file of at most 20 MiB',
  );
  const source = bytes.toString('utf8').replace(/^\uFEFF/, '');
  let columns: string[], rows: Record<string, unknown>[];
  if (requirement.format === 'jsonl') {
    const lines = source.split(/\r?\n/).filter((line) => line.trim());
    check(lines.length <= 100000, 'invalid_dataset', 'Dataset exceeds 100,000 rows');
    rows = lines.map((line, i) => {
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        check(false, 'invalid_dataset', `Line ${i + 1} is not valid JSON`);
      }
      check(
        row && typeof row === 'object' && !Array.isArray(row),
        'invalid_dataset',
        `Line ${i + 1} must contain an object`,
      );
      return row as Record<string, unknown>;
    });
    columns = rows.length ? Object.keys(rows[0]!) : [];
    check(
      rows.every(
        (row) =>
          Object.keys(row).length === columns.length && columns.every((c) => Object.hasOwn(row, c)),
      ),
      'invalid_dataset',
      'Every JSONL row must have the same columns',
    );
  } else {
    const table = parseCsv(source);
    columns = table.shift() ?? [];
    check(
      new Set(columns).size === columns.length &&
        columns.every((c) => c.length > 0 && c.length <= 120),
      'invalid_dataset',
      'CSV headers must be distinct, nonempty column names',
    );
    rows = table.map((values, i) => {
      check(
        values.length === columns.length,
        'invalid_dataset',
        `CSV row ${i + 2} has the wrong number of columns`,
      );
      return Object.fromEntries(columns.map((c, j) => [c, values[j]]));
    });
  }
  check(
    columns.length <= 100 && rows.length >= requirement.minRows && rows.length <= 100000,
    'invalid_dataset',
    `Expected at least ${requirement.minRows} rows, at most 100,000 rows and 100 columns`,
  );
  check(
    requirement.columns.every((c) => columns.includes(c)),
    'invalid_dataset',
    'Required columns are missing',
  );
  if (requirement.labelColumn) {
    const label = requirement.labelColumn;
    check(
      columns.includes(label) &&
        rows.every(
          (row) =>
            ['string', 'number', 'boolean'].includes(typeof row[label]) &&
            String(row[label]).trim().length > 0,
        ),
      'invalid_dataset',
      `Every row needs a nonempty scalar ${label} label`,
    );
  }
  return {
    rows: rows.length,
    columns,
    validationId: digest({
      validator: 'tabular-v1',
      sha256: digest(bytes.toString('base64')),
      requirement,
    }),
  };
}

function parseCsv(source: string): string[][] {
  const table: string[][] = [];
  let row: string[] = [],
    cell = '',
    quoted = false,
    ended = false;
  const push = () => {
    row.push(cell);
    cell = '';
    ended = false;
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (quoted) {
      if (c === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          ended = true;
        }
      } else cell += c;
    } else if (c === '"') {
      check(!cell && !ended, 'invalid_dataset', 'Malformed CSV quote');
      quoted = true;
    } else if (c === ',') push();
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && source[i + 1] === '\n') i++;
      push();
      table.push(row);
      row = [];
      check(table.length <= 100001, 'invalid_dataset', 'Dataset exceeds 100,000 rows');
    } else {
      check(!ended, 'invalid_dataset', 'Unexpected text after a quoted CSV field');
      cell += c;
    }
    check(row.length <= 100, 'invalid_dataset', 'Dataset exceeds 100 columns');
  }
  check(!quoted, 'invalid_dataset', 'Unclosed CSV quote');
  if (cell || row.length || ended) {
    push();
    table.push(row);
  }
  return table;
}

export interface DatasetStorage {
  bucket(id: string): string;
  provision(id: string): Promise<void>;
  upload(
    id: string,
    sha256: string,
    size: number,
  ): Promise<{ url: string; headers: Record<string, string>; expiresAt: string }>;
  read(id: string, sha256: string): Promise<Buffer>;
  download(
    id: string,
    sha256: string,
    size: number,
    filename: string,
  ): Promise<{ url: string; expiresAt: string }>;
  close(): Promise<void>;
}
/** One literal bucket per request. Provisioning failures never fall back to shared storage. */
export class RequestBuckets implements DatasetStorage, RequestFileStorage {
  private client: S3Client;
  /** service_experiment@3 files: presigned URLs the browser uses as they are, so the SDK adds no
   *  checksum the browser could not send. */
  private files: S3Client;
  private blobs = new Map<string, S3Blobs>();
  constructor(
    private options: Omit<S3BlobOptions, 'bucket' | 'prefix'> & {
      bucketPrefix: string;
      publicOrigin: string;
    },
  ) {
    check(
      /^[a-z][a-z0-9-]{2,20}$/.test(options.bucketPrefix),
      'customer_configuration',
      'Invalid request bucket prefix',
    );
    const endpoint = new URL(options.endpoint);
    check(
      endpoint.protocol === 'https:' && endpoint.origin === options.endpoint,
      'customer_configuration',
      'Dataset endpoint must be an HTTPS origin',
    );
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region ?? 'us-east-1',
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
      forcePathStyle: true,
      maxAttempts: 3,
    });
    this.files = new S3Client({
      endpoint: options.endpoint,
      region: options.region ?? 'us-east-1',
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
      forcePathStyle: true,
      maxAttempts: 3,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }
  bucket(id: string) {
    check(/^ce_[a-f0-9]{32}$/.test(id), 'invalid_request', 'Invalid request ID');
    return `${this.options.bucketPrefix}-${id.slice(3)}`;
  }
  private storage(id: string) {
    let blob = this.blobs.get(id);
    if (!blob) {
      blob = new S3Blobs({ ...this.options, bucket: this.bucket(id), prefix: 'data' });
      this.blobs.set(id, blob);
    }
    return blob;
  }
  async provision(id: string) {
    await this.create(id);
    await this.cors(id, {
      AllowedOrigins: [this.options.publicOrigin],
      AllowedMethods: ['PUT'],
      AllowedHeaders: ['content-type', 'x-amz-checksum-sha256', 'if-none-match'],
      MaxAgeSeconds: 600,
    });
  }
  private async create(id: string) {
    const Bucket = this.bucket(id),
      region = this.options.region;
    try {
      await this.client.send(
        new CreateBucketCommand({
          Bucket,
          ...(region && !['auto', 'us-east-1'].includes(region)
            ? {
                CreateBucketConfiguration: {
                  LocationConstraint: region as BucketLocationConstraint,
                },
              }
            : {}),
        }),
        { abortSignal: AbortSignal.timeout(30000) },
      );
    } catch (error) {
      if ((error as { name?: string }).name !== 'BucketAlreadyOwnedByYou') throw error;
    }
    // R2 buckets are private by default and have no S3 public ACL/policy surface.
    // PutPublicAccessBlock is AWS-only; never enable an R2 public domain for these buckets.
    if (!/^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(new URL(this.options.endpoint).hostname))
      await this.client.send(
        new PutPublicAccessBlockCommand({
          Bucket,
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            IgnorePublicAcls: true,
            BlockPublicPolicy: true,
            RestrictPublicBuckets: true,
          },
        }),
        { abortSignal: AbortSignal.timeout(30000) },
      );
  }
  private async cors(id: string, rule: CORSRule) {
    await this.client.send(
      new PutBucketCorsCommand({
        Bucket: this.bucket(id),
        CORSConfiguration: { CORSRules: [rule] },
      }),
      { abortSignal: AbortSignal.timeout(30000) },
    );
  }
  upload(id: string, hash: string, size: number) {
    return this.storage(id).upload('dataset', hash, size);
  }
  read(id: string, hash: string) {
    return this.storage(id).get('dataset', hash);
  }
  download(id: string, hash: string, size: number, filename: string) {
    return this.storage(id).download('dataset', hash, size, filename);
  }
  /** A v3 request's bucket: the page's origin uploads parts directly and reads their ETags. */
  async provisionFiles(id: string) {
    await this.create(id);
    await this.cors(id, {
      AllowedOrigins: [this.options.publicOrigin],
      AllowedMethods: ['PUT', 'GET', 'HEAD'],
      AllowedHeaders: ['content-type', 'x-amz-checksum-sha256', 'if-none-match'],
      ExposeHeaders: ['ETag'],
      MaxAgeSeconds: 600,
    });
    await this.corsApplied(id);
  }
  /**
   * A new bucket's CORS rule takes effect seconds after it is set, and a browser upload sent before
   * then is refused as a network error. Wait (at most a minute) until the bucket answers the page's
   * preflight before handing out upload URLs.
   */
  private async corsApplied(id: string, deadline = Date.now() + 60_000) {
    const url = `${this.options.endpoint}/${this.bucket(id)}/cors-check`;
    for (;;) {
      const allowed = await fetch(url, {
        method: 'OPTIONS',
        headers: {
          Origin: this.options.publicOrigin,
          'Access-Control-Request-Method': 'PUT',
          'Access-Control-Request-Headers': 'content-type',
        },
        signal: AbortSignal.timeout(10_000),
      })
        .then((r) => r.headers.get('access-control-allow-origin') === this.options.publicOrigin)
        .catch(() => false);
      if (allowed) return;
      check(
        Date.now() < deadline,
        'files_unavailable',
        'File storage is still being prepared. Try again in a minute.',
        503,
      );
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  private send<T>(command: { input: unknown }): Promise<T> {
    const send = this.files.send.bind(this.files) as (c: unknown, o: unknown) => Promise<unknown>;
    return send(command, { abortSignal: AbortSignal.timeout(60000) }) as Promise<T>;
  }
  async listFiles(id: string): Promise<StoredFile[]> {
    const files: StoredFile[] = [];
    let ContinuationToken: string | undefined;
    do {
      let page: {
        Contents?: { Key?: string; Size?: number; ETag?: string; LastModified?: Date }[];
        IsTruncated?: boolean;
        NextContinuationToken?: string;
      };
      try {
        page = await this.send(
          new ListObjectsV2Command({ Bucket: this.bucket(id), ContinuationToken }),
        );
      } catch (error) {
        if ((error as { name?: string }).name === 'NoSuchBucket') return [];
        throw error;
      }
      for (const o of page.Contents ?? [])
        if (o.Key)
          files.push({
            key: o.Key,
            size: o.Size ?? 0,
            etag: o.ETag ?? '',
            uploaded: (o.LastModified ?? new Date(0)).toISOString(),
          });
      ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (ContinuationToken);
    return files;
  }
  async head(id: string, key: string): Promise<StoredFile | null> {
    try {
      const o = await this.send<{ ContentLength?: number; ETag?: string; LastModified?: Date }>(
        new HeadObjectCommand({ Bucket: this.bucket(id), Key: key }),
      );
      return {
        key,
        size: o.ContentLength ?? 0,
        etag: o.ETag ?? '',
        uploaded: (o.LastModified ?? new Date(0)).toISOString(),
      };
    } catch (error) {
      const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e.name === 'NotFound' || e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404)
        return null;
      throw error;
    }
  }
  async createMultipart(id: string, key: string, contentType: string) {
    const out = await this.send<{ UploadId?: string }>(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket(id),
        Key: key,
        ContentType: contentType,
      }),
    );
    check(out.UploadId, 'storage_unavailable', 'Storage did not start the upload', 502);
    return out.UploadId;
  }
  /** Signs the part's exact length, so a part cannot carry more than its upload declared. */
  async presignPart(id: string, key: string, uploadId: string, partNumber: number, length: number) {
    return getSignedUrl(
      this.files,
      new UploadPartCommand({
        Bucket: this.bucket(id),
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
        ContentLength: length,
      }),
      { expiresIn: 3600 },
    );
  }
  async completeMultipart(
    id: string,
    key: string,
    uploadId: string,
    parts: { partNumber: number; etag: string }[],
  ) {
    await this.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket(id),
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
        },
      }),
    );
  }
  async abortMultipart(id: string, key: string, uploadId: string) {
    try {
      await this.send(
        new AbortMultipartUploadCommand({ Bucket: this.bucket(id), Key: key, UploadId: uploadId }),
      );
    } catch (error) {
      if ((error as { name?: string }).name !== 'NoSuchUpload') throw error;
    }
  }
  /** CopyObject stops at 5 GiB; larger objects are copied part by part on the server. */
  async copyFile(id: string, from: StoredFile, to: string) {
    const Bucket = this.bucket(id),
      CopySource = `${Bucket}/${from.key.split('/').map(encodeURIComponent).join('/')}`;
    if (from.size <= 5 * 1024 ** 3) {
      await this.send(new CopyObjectCommand({ Bucket, Key: to, CopySource }));
      return;
    }
    const UploadId = await this.createMultipart(id, to, 'application/octet-stream');
    try {
      const size = partSize(from.size),
        parts: { partNumber: number; etag: string }[] = [];
      for (let n = 1, start = 0; start < from.size; n++, start += size) {
        const out = await this.send<{ CopyPartResult?: { ETag?: string } }>(
          new UploadPartCopyCommand({
            Bucket,
            Key: to,
            UploadId,
            PartNumber: n,
            CopySource,
            CopySourceRange: `bytes=${start}-${start + partLength(from.size, size, n) - 1}`,
          }),
        );
        parts.push({ partNumber: n, etag: out.CopyPartResult?.ETag ?? '' });
      }
      await this.completeMultipart(id, to, UploadId, parts);
    } catch (error) {
      await this.abortMultipart(id, to, UploadId).catch(() => {});
      throw error;
    }
  }
  async deleteFiles(id: string, keys: string[]) {
    for (let i = 0; i < keys.length; i += 1000) {
      const out = await this.send<{ Errors?: { Key?: string; Code?: string }[] }>(
        new DeleteObjectsCommand({
          Bucket: this.bucket(id),
          Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true },
        }),
      );
      check(!out.Errors?.length, 'storage_unavailable', 'Storage could not delete every file', 502);
    }
  }
  async presignDownload(id: string, key: string) {
    const name = key.slice(key.lastIndexOf('/') + 1);
    const signingDate = new Date(Math.floor(Date.now() / 1000) * 1000);
    const url = await getSignedUrl(
      this.files,
      new GetObjectCommand({
        Bucket: this.bucket(id),
        Key: key,
        ResponseContentDisposition: `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        ResponseContentType: 'application/octet-stream',
        ResponseCacheControl: 'private, no-store',
      }),
      { expiresIn: 300, signingDate },
    );
    return { url, expiresAt: new Date(signingDate.getTime() + 300_000).toISOString() };
  }
  /** Every object, every unfinished upload, then the bucket itself. Returns the objects removed. */
  async destroy(id: string): Promise<number> {
    const Bucket = this.bucket(id);
    const objects = await this.listFiles(id);
    await this.deleteFiles(
      id,
      objects.map((o) => o.key),
    );
    try {
      let KeyMarker: string | undefined, UploadIdMarker: string | undefined;
      do {
        const page = await this.send<{
          Uploads?: { Key?: string; UploadId?: string }[];
          IsTruncated?: boolean;
          NextKeyMarker?: string;
          NextUploadIdMarker?: string;
        }>(new ListMultipartUploadsCommand({ Bucket, KeyMarker, UploadIdMarker }));
        for (const u of page.Uploads ?? [])
          if (u.Key && u.UploadId) await this.abortMultipart(id, u.Key, u.UploadId);
        [KeyMarker, UploadIdMarker] = page.IsTruncated
          ? [page.NextKeyMarker, page.NextUploadIdMarker]
          : [undefined, undefined];
      } while (KeyMarker);
      await this.send(new DeleteBucketCommand({ Bucket }));
    } catch (error) {
      if ((error as { name?: string }).name !== 'NoSuchBucket') throw error;
    }
    return objects.length;
  }
  async close() {
    await Promise.all([...this.blobs.values()].map((b) => b.close()));
    this.client.destroy();
    this.files.destroy();
  }
}

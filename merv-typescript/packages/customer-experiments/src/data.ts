import { isUtf8 } from 'node:buffer';
import {
  CreateBucketCommand,
  PutBucketCorsCommand,
  PutPublicAccessBlockCommand,
  S3Client,
  type BucketLocationConstraint,
} from '@aws-sdk/client-s3';
import { S3Blobs, type S3BlobOptions } from '@merv/blobs/s3';
import { check, digest } from '@merv/contracts';
import type { DataRequirement } from './types.js';

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
export class RequestBuckets implements DatasetStorage {
  private client: S3Client;
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
    await this.client.send(
      new PutBucketCorsCommand({
        Bucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: [this.options.publicOrigin],
              AllowedMethods: ['PUT'],
              AllowedHeaders: ['content-type', 'x-amz-checksum-sha256', 'if-none-match'],
              MaxAgeSeconds: 600,
            },
          ],
        },
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
  async close() {
    await Promise.all([...this.blobs.values()].map((b) => b.close()));
    this.client.destroy();
  }
}

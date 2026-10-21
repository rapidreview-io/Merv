/** Exact-object transfer. Source credentials are used only for GET, never copied to staging.
 * Destination credentials must already be scoped to the dedicated staging-only bucket.
 * Every upload is followed by a full GET and digest check, not an ETag/count comparison.
 */
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';
import {
  readFileSync,
  openSync,
  fsyncSync,
  closeSync,
  writeFileSync,
  renameSync,
  mkdirSync,
} from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';
import { exportHistory, need, hash, durable } from './history.mjs';
export async function download(client, bucket, key, expected) {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const bytes = Buffer.from(await response.Body.transformToByteArray());
  need(
    bytes.length === Number(expected.size_bytes ?? expected.size) &&
      hash(bytes) === expected.sha256,
    'object download digest/size mismatch',
  );
  return bytes;
}
export async function verifyBucketBoundary(client, bucket, sourceBuckets) {
  need(
    sourceBuckets.length > 0 && sourceBuckets.every((b) => b && b !== bucket),
    'dedicated staging-only bucket required',
  );
  await client.send(new HeadBucketCommand({ Bucket: bucket }));
  const denied = [];
  for (const sourceBucket of [...new Set(sourceBuckets)]) {
    let forbidden = false;
    try {
      await client.send(new HeadBucketCommand({ Bucket: sourceBucket }));
    } catch (error) {
      if (error.$metadata?.httpStatusCode === 403) forbidden = true;
      else throw error;
    }
    need(forbidden, 'target credential can access a source/customer bucket');
    denied.push(sourceBucket);
  }
  return { bucket, sourceBucketsDenied: denied };
}
export async function stageObjects(client, bucket, bundle, dir) {
  const { sha256, ...body } = bundle;
  need(hash(body) === sha256, 'bundle changed');
  const receipts = [];
  for (const f of bundle.files) {
    need(
      f.objectKey === `staging-native/history/${f.namespace}/${f.id}/${f.sha256}`,
      'destination object key escaped staging prefix',
    );
    const bytes = readFileSync(`${dir}/${f.sha256}`);
    need(hash(bytes) === f.sha256 && bytes.length === Number(f.size), 'local object changed');
    try {
      await download(client, bucket, f.objectKey, f);
    } catch (e) {
      // Only an explicit absence permits a write. AccessDenied, timeouts and mismatches fail closed.
      if (e.name !== 'NoSuchKey' && e.$metadata?.httpStatusCode !== 404) throw e;
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: f.objectKey, Body: bytes, IfNoneMatch: '*' }),
      );
      await download(client, bucket, f.objectKey, f);
    }
    receipts.push({
      id: f.id,
      namespace: f.namespace,
      key: f.objectKey,
      sha256: f.sha256,
      size: f.size,
      downloadVerified: true,
    });
  }
  return { bundle: sha256, bucket, objects: receipts };
}
const clientFrom = (config) =>
  new S3Client({
    endpoint: config.endpoint,
    region: config.region ?? 'auto',
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
      ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
    },
  });
if (process.argv[1]?.endsWith('/blobs.mjs')) {
  let db, client;
  try {
    const [action, input, dir, output] = process.argv.slice(2),
      config = JSON.parse(readFileSync(process.env.STAGING_OBJECT_CREDENTIAL_FILE));
    client = clientFrom(config);
    if (action === 'export') {
      db = new pg.Client({ connectionString: process.env.STAGING_HISTORY_DATABASE_URL });
      await db.connect();
      const selection = JSON.parse(readFileSync(input));
      const bundle = await exportHistory(db, selection, dir, async (object, path) => {
        let bucket = config.bucket,
          key = object.object_key;
        if (key.startsWith('s3://')) {
          const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(key);
          need(match && config.adoptedBuckets?.includes(match[1]), 'unreviewed adopted bucket');
          [, bucket, key] = match;
        }
        const bytes = await download(client, bucket, key, object);
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        const fd = openSync(path + '.tmp', 'w', 0o600);
        try {
          writeFileSync(fd, bytes);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(path + '.tmp', path);
        const parent = openSync(dirname(path), 'r');
        try {
          fsyncSync(parent);
        } finally {
          closeSync(parent);
        }
      });
      const { sha256: _, ...body } = bundle;
      const withStorage = {
        ...body,
        sourceStorage: { endpoint: config.endpoint, bucket: config.bucket },
      };
      durable(output, { ...withStorage, sha256: hash(withStorage) });
    } else {
      need(action === 'stage', 'export or stage required');
      need(
        config.allowedWritePrefix === 'staging-native/' &&
          config.scopeEvidenceSha256?.match(/^[a-f0-9]{64}$/) &&
          !config.sessionToken,
        'reviewed durable bucket-scoped credential required',
      );
      const bundle = JSON.parse(readFileSync(input));
      need(bundle.sourceStorage?.bucket, 'source storage identity required');
      const buckets = [
        bundle.sourceStorage.bucket,
        ...bundle.files
          .filter((f) => f.sourceObjectKey?.startsWith('s3://'))
          .map((f) => f.sourceObjectKey.slice(5).split('/')[0]),
      ];
      const boundary = await verifyBucketBoundary(client, config.bucket, buckets);
      durable(output, { ...(await stageObjects(client, config.bucket, bundle, dir)), boundary });
    }
  } catch {
    console.error(
      'Selected-object transfer refused; inspect private inputs, object scope and availability.',
    );
    process.exitCode = 1;
  } finally {
    await db?.end();
    client?.destroy();
  }
}

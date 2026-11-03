// Makes the board's bucket and moves in what the app kept on disk before it had storage. Run inside
// the app container; safe to run again. The disk keeps <namespace>/<first two>/<hash>, S3 <namespace>/<hash>.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CreateBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const client = new S3Client({
  endpoint: process.env.MERV_BLOB_ENDPOINT_URL,
  region: process.env.MERV_BLOB_REGION,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.MERV_BLOB_ACCESS_KEY_ID,
    secretAccessKey: process.env.MERV_BLOB_SECRET_ACCESS_KEY,
  },
});
const Bucket = process.env.MERV_BLOB_BUCKET;
await client.send(new CreateBucketCommand({ Bucket })).catch((error) => {
  if (!/BucketAlready/.test(error.name)) throw error;
});
const root = '/data/blobs';
let moved = 0;
for (const namespace of readdirSync(root))
  for (const part of readdirSync(join(root, namespace)))
    for (const hash of readdirSync(join(root, namespace, part))) {
      const file = join(root, namespace, part, hash);
      if (hash.startsWith('.') || !statSync(file).isFile()) continue;
      const Key = `${namespace}/${hash}`;
      await client.send(new PutObjectCommand({ Bucket, Key, Body: readFileSync(file) }));
      moved++;
    }
console.log(`bucket ${Bucket} ready, ${moved} files moved`);

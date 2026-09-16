import type { Context } from 'cordis';
import { z } from 'zod';
import { check } from '@merv/contracts';
import { DiskBlobs } from './disk.js';
import { S3Blobs } from './s3.js';

export { DiskBlobs } from './disk.js';
export { S3Blobs, MAX_TRANSFER_BYTES, type S3BlobOptions } from './s3.js';

const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const configuration = z.union([
  z
    .object({
      backend: z.literal('disk').optional(),
      root: z.string().refine((root) => !!root.trim(), 'Blob root must be nonblank'),
    })
    .strict(),
  z
    .object({
      backend: z.literal('s3'),
      bucketEnv: envName.default('MERV_BLOB_BUCKET'),
      endpointEnv: envName.default('MERV_BLOB_ENDPOINT_URL'),
      accessKeyIdEnv: envName.default('MERV_BLOB_ACCESS_KEY_ID'),
      secretAccessKeyEnv: envName.default('MERV_BLOB_SECRET_ACCESS_KEY'),
      regionEnv: envName.default('MERV_BLOB_REGION'),
      prefixEnv: envName.default('MERV_BLOB_PREFIX'),
      timeoutMs: z.number().int().min(1).max(120_000).default(30_000),
      maxAttempts: z.number().int().min(1).max(5).default(3),
    })
    .strict(),
]);

export const blobsPlugin = {
  name: 'merv-blobs',
  Config: configuration,
  apply(ctx: Context, config: z.infer<typeof configuration>) {
    const required = (name: string) => {
      const value = process.env[name];
      check(
        !!value?.trim(),
        'invalid_blob_config',
        `Missing blob configuration environment variable: ${name}`,
      );
      return value!;
    };
    const service =
      config.backend === 's3'
        ? new S3Blobs({
            bucket: required(config.bucketEnv),
            endpoint: required(config.endpointEnv),
            accessKeyId: required(config.accessKeyIdEnv),
            secretAccessKey: required(config.secretAccessKeyEnv),
            region: process.env[config.regionEnv]?.trim() || 'auto',
            prefix: process.env[config.prefixEnv]?.trim() || '',
            timeoutMs: config.timeoutMs,
            maxAttempts: config.maxAttempts,
          })
        : new DiskBlobs(config.root);
    ctx.effect(function* () {
      yield () => service.close();
      yield ctx.provide('blobs', service);
    });
  },
};
export default blobsPlugin;

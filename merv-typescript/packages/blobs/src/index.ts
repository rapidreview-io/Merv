import type { Context } from 'cordis';
import { z } from 'zod';
import { envName, requiredEnv } from '@merv/contracts';
import { DiskBlobs } from './disk.js';
import { S3_DEFAULTS, S3Blobs } from './s3.js';

export { DiskBlobs } from './disk.js';
export { S3Blobs, type S3BlobOptions } from './s3.js';

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
      timeoutMs: z.number().int().min(1).max(120_000).default(S3_DEFAULTS.timeoutMs),
      maxAttempts: z.number().int().min(1).max(5).default(S3_DEFAULTS.maxAttempts),
    })
    .strict(),
]);

export const blobsPlugin = {
  name: 'merv-blobs',
  Config: configuration,
  apply(ctx: Context, config: z.infer<typeof configuration>) {
    const required = (name: string) =>
      requiredEnv(
        name,
        'invalid_blob_config',
        `Missing blob configuration environment variable: ${name}`,
      );
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

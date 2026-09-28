import type { TestContext } from 'node:test';
import type { Context } from 'cordis';
import { S3Blobs } from '@merv/blobs';
import type { ArtifactUploadStatus } from '@merv/contracts';
import { s3Server } from './s3-server.js';

/** Blobs over the S3 protocol fixture. Plugin configuration cannot enable HTTP, so tests use this. */
export default {
  name: 'merv-blobs',
  apply(ctx: Context, config: { endpoint: string; prefix: string }) {
    const blobs = new S3Blobs({
      bucket: 'merv-artifacts',
      endpoint: config.endpoint,
      accessKeyId: 'fixture-access-key',
      secretAccessKey: 'fixture-secret-key',
      prefix: config.prefix,
      allowHttpLoopbackForTests: true,
      timeoutMs: 5000,
      maxAttempts: 1,
    });
    ctx.effect(function* () {
      yield () => blobs.close();
      yield ctx.provide('blobs', blobs);
    });
  },
};

/** A running S3 fixture, the blobs plugin entry over it, and where it keeps a project's file. */
export async function s3Blobs(t: TestContext, prefix = 'test') {
  const server = await s3Server();
  t.after(() => server.close());
  return {
    server,
    entry: {
      id: 'blobs',
      name: import.meta.url,
      config: { endpoint: server.endpoint, prefix },
    },
    key: (projectId: string, hash: string) => `${prefix}/${projectId}/${hash}`,
  };
}

/** The PUT an upload plan asks for, as a browser or curl sends it. */
export const send = (plan: ArtifactUploadStatus, bytes: Buffer) =>
  fetch(plan.parts[0]!.url, {
    method: 'PUT',
    headers: plan.parts[0]!.headers,
    body: new Uint8Array(bytes),
  });

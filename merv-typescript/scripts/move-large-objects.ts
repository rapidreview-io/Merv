/**
 * Temporary, until large artifacts live in blobs and the sandbox copies are retired: copies every
 * artifact whose bytes are only in merv-sandboxes storage into blobs at (projectId, sha256), after
 * probing that the bucket enforces the signed upload. Reads the database only and is idempotent;
 * any failure exits non-zero. Run it in a one-off container of the current image:
 *   node deploy/render-config.mjs /tmp/c.json && node dist/scripts/move-large-objects.js /tmp/c.json
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { blobsPlugin, S3Blobs } from '@merv/blobs';
import { sha256Hex, type LargeArtifactStorage } from '@merv/contracts';
import { SandboxArtifactStorage } from '@merv/sandboxes/artifact-storage';

export type Row = { project_id: string; object_id: string; hash: string; size: number | string };
const put = (url: string, body: Buffer, headers: Record<string, string>) =>
  fetch(url, { method: 'PUT', body: new Uint8Array(body), headers });
const report = (line: object) => console.log(JSON.stringify(line));

/** Whether the store refuses every upload its signature does not allow (G1). Leaves tiny objects. */
export async function probe(blobs: S3Blobs): Promise<boolean> {
  const [a, b, c] = [randomBytes(16), randomBytes(16), randomBytes(16)];
  const [hashA, hashC] = [sha256Hex(a), sha256Hex(c)];
  const signed = await blobs.upload('_probe', hashA, 16);
  const { 'x-amz-checksum-sha256': checksum } = signed.headers;
  // `stored` gives only a size, so the stored object's ETag is read through a signed GET.
  const tag = async () => {
    const response = await fetch((await blobs.download('_probe', hashA, 16)).url);
    await response.body?.cancel();
    return response.headers.get('etag');
  };
  let ok = true;
  // A check that throws fails and the probe carries on, so every line is reported.
  const check = async (name: string, test: () => Promise<boolean>) => {
    try {
      const passed = await test();
      ok &&= passed;
      report({ probe: name, passed });
    } catch (error) {
      ok = false;
      report({ probe: name, passed: false, error: String(error) });
    }
  };
  const status = async (
    body: Buffer,
    headers: Record<string, string> = signed.headers,
    url = signed.url,
  ) => (await put(url, body, headers)).status;
  const refused = (code: number) => code >= 400;
  await check(
    'P1 other bytes',
    async () => refused(await status(b)) && (await blobs.stored('_probe', hashA)) === null,
  );
  await check('P2 no checksum', async () => (await status(a, { 'if-none-match': '*' })) === 403);
  await check(
    'P3 no if-none-match',
    async () => (await status(a, { 'x-amz-checksum-sha256': checksum })) === 403,
  );
  const longer = await blobs.upload('_probe', hashA, 17);
  await check('P4 other length', async () => refused(await status(a, longer.headers, longer.url)));
  await check('P5 unsigned encoding', async () => {
    const encoded = await status(a, { ...signed.headers, 'content-encoding': 'gzip' });
    // A store that refuses the encoding still gets A, so P6-P8 check a stored object.
    if (refused(encoded)) await status(a);
    return encoded === 200 && (await blobs.stored('_probe', hashA)) === 16;
  });
  await check('P6 identity', async () => {
    const response = await fetch((await blobs.download('_probe', hashA, 16)).url);
    const encoding = response.headers.get('content-encoding');
    const served = Buffer.from(await response.arrayBuffer());
    const got = await blobs.get('_probe', hashA);
    return [null, 'identity'].includes(encoding) && served.equals(a) && got.equals(a);
  });
  let etag: string | null = null;
  await check('P7 write once', async () => {
    etag = await tag();
    return (await status(a)) === 412 && (await tag()) === etag;
  });
  await check('P8 no overwrite', async () => refused(await status(b)) && (await tag()) === etag);
  const other = await blobs.upload('_probe', hashC, 16);
  const storageClass = { ...other.headers, 'x-amz-storage-class': 'STANDARD_IA' };
  const stored = await status(c, storageClass, other.url).catch(String);
  report({ probe: 'unsigned storage class', status: stored });
  return ok;
}

/** Copies each row's bytes into blobs unless they are there; whether every row is now stored. */
export async function copy(
  blobs: S3Blobs,
  storage: () => Pick<LargeArtifactStorage, 'read'>,
  rows: Row[],
) {
  let ok = true;
  for (const { project_id: projectId, object_id: objectId, hash, size } of rows) {
    const line = { projectId, objectId, hash, size: Number(size) };
    try {
      if ((await blobs.stored(projectId, hash)) === line.size) {
        report({ ...line, result: 'skipped' });
        continue;
      }
      const bytes = await storage().read(projectId, objectId, line.size);
      if (bytes.length !== line.size || sha256Hex(bytes) !== hash)
        throw new Error('Stored object differs from its artifact');
      const signed = await blobs.upload(projectId, hash, line.size);
      const { status } = await put(signed.url, bytes, signed.headers);
      if (!(status < 300 || status === 412)) throw new Error(`Upload refused with HTTP ${status}`);
      if ((await blobs.stored(projectId, hash)) !== line.size)
        throw new Error('Blobs holds another size');
      report({ ...line, result: 'copied' });
    } catch (error) {
      ok = false;
      report({ ...line, result: 'failed', error: String(error) });
    }
  }
  return ok;
}

async function main(configPath: string) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const plugin = (id: string) => config.plugins.find((entry: { id: string }) => entry.id === id);
  const env = (name: string) => process.env[name]?.trim() ?? '';
  const settings = blobsPlugin.Config.parse(plugin('blobs')?.config);
  if (settings.backend !== 's3') throw new Error('Blobs is not S3');
  const blobs = new S3Blobs({
    bucket: env(settings.bucketEnv),
    endpoint: env(settings.endpointEnv),
    accessKeyId: env(settings.accessKeyIdEnv),
    secretAccessKey: env(settings.secretAccessKeyEnv),
    region: env(settings.regionEnv) || 'auto',
    prefix: env(settings.prefixEnv),
  });
  const sandboxes = plugin('sandboxes')?.config;
  let built: LargeArtifactStorage | undefined;
  const storage = () => {
    if (!sandboxes?.ml) throw new Error('No sandbox storage is configured');
    const timeoutMs = sandboxes.timeoutMs ?? 15_000;
    return (built ??= new SandboxArtifactStorage(env(sandboxes.urlEnv), timeoutMs, sandboxes.ml));
  };
  const state = plugin('state').config;
  const client = new pg.Client({
    connectionString: env(state.connectionStringEnv),
    options: '-c default_transaction_read_only=on',
  });
  await client.connect();
  try {
    let ok = await probe(blobs);
    const { rows } = await client.query<Row>(
      `SELECT project_id, object_id, hash, size FROM ${client.escapeIdentifier(state.schema)}.artifacts WHERE object_id IS NOT NULL AND content IS NULL`,
    );
    ok = (await copy(blobs, storage, rows)) && ok;
    process.exitCode = ok ? 0 : 1;
  } finally {
    await client.end();
    await blobs.close();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await main(process.argv[2]!);

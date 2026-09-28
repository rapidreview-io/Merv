import {
  check,
  MervError,
  type ArtifactUploadPlan,
  type LargeArtifactStorage,
} from '@merv/contracts';
import { SandboxClient, sandboxRoute } from './client.js';
import type { SandboxConnection } from './types.js';

type Row = Record<string, any>;
const row = (value: unknown): Row =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};

/** The slowest link an object read is still given time to finish on: one megabit a second. */
const MIN_READ_BYTES_PER_SECOND = 131_072;

/** A missing object and an outage speak the blobs vocabulary; other refusals pass through. */
function stored(error: unknown): never {
  if (error instanceof MervError && error.code === 'sandbox_not_found')
    throw new MervError('blob_not_found', 'Stored object not found', 404);
  if (error instanceof MervError && error.code === 'sandbox_unavailable')
    throw new MervError('blob_unavailable', error.message, 503);
  throw error;
}

/** The ML application grant selects the project's subject for every storage request. */
export class SandboxArtifactStorage implements LargeArtifactStorage {
  private readonly client: SandboxClient;
  constructor(
    origin: string,
    private readonly timeoutMs: number,
    private readonly config: { namespace: string; tokenEnv: string; storageOrigins: string[] },
  ) {
    this.client = new SandboxClient(origin, timeoutMs, config.storageOrigins);
  }
  private entry(projectId: string): SandboxConnection {
    return {
      projectId,
      namespace: this.config.namespace,
      tokenEnv: this.config.tokenEnv,
      subject: projectId,
    };
  }
  private signed(value: unknown): string {
    let url: URL | undefined;
    try {
      url = new URL(String(value));
    } catch {
      /* invalid URL */
    }
    check(
      url &&
        !url.username &&
        !url.password &&
        (url.protocol === 'https:' ||
          (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) &&
        this.config.storageOrigins.includes(url.origin),
      'sandbox_origin_refused',
      'Sandboxes returned a link outside the configured storage origin',
      502,
    );
    return url.href;
  }
  private plan(response: unknown): ArtifactUploadPlan {
    const value = row(response);
    check(
      Number.isSafeInteger(value.part_size) &&
        Number.isSafeInteger(value.part_count) &&
        Array.isArray(value.parts),
      'sandbox_unavailable',
      'Sandboxes returned an invalid upload plan',
      502,
    );
    return {
      partSize: value.part_size,
      partCount: value.part_count,
      parts: value.parts.map((part: unknown) => {
        const item = row(part);
        check(
          Number.isSafeInteger(item.part_number) &&
            Number.isSafeInteger(item.size_bytes) &&
            row(item.headers),
          'sandbox_unavailable',
          'Sandboxes returned an invalid upload part',
          502,
        );
        return {
          partNumber: item.part_number,
          size: item.size_bytes,
          url: this.signed(item.url),
          headers: item.headers as Record<string, string>,
        };
      }),
      completedParts: Array.isArray(value.completed_parts) ? value.completed_parts : [],
      nextPart: Number.isSafeInteger(value.next_part) ? value.next_part : null,
    };
  }
  async begin(projectId: string, key: string, expect: { size: number; sha256: string }) {
    const response = row(
      await this.client.write(this.entry(projectId), 'POST', '/v1/storage/objects', {
        name: `artifacts/${key}`,
        idempotency_key: key,
        sha256: expect.sha256,
        size_bytes: expect.size,
        // The media type is artifact metadata; the stored object is opaque bytes.
        content_type: 'application/octet-stream',
        retain_until_deleted: true,
      }),
    );
    const objectId = row(response.object).id;
    check(
      typeof objectId === 'string',
      'sandbox_unavailable',
      'Sandboxes returned no object ID',
      502,
    );
    return { objectId, plan: this.plan(response) };
  }
  async resume(projectId: string, objectId: string, startPart: number) {
    return this.plan(
      await this.client.read(
        this.entry(projectId),
        sandboxRoute('/v1/storage/objects/{id}/upload', objectId),
        { start_part: startPart },
      ),
    );
  }
  async complete(projectId: string, objectId: string) {
    const response = row(
      await this.client.write(
        this.entry(projectId),
        'POST',
        sandboxRoute('/v1/storage/objects/{id}/complete', objectId),
        {},
        3_600_000,
      ),
    );
    check(
      typeof response.id === 'string' &&
        Number.isSafeInteger(response.size_bytes) &&
        typeof response.sha256 === 'string' &&
        typeof response.state === 'string',
      'sandbox_unavailable',
      'Sandboxes returned an invalid completed object',
      502,
    );
    return {
      objectId: response.id as string,
      size: response.size_bytes as number,
      sha256: response.sha256 as string,
      state: response.state as string,
    };
  }
  async download(projectId: string, objectId: string) {
    const response = row(
      await this.client
        .read(
          this.entry(projectId),
          sandboxRoute('/v1/storage/objects/{id}/download-short', objectId),
        )
        .catch(stored),
    );
    const expires = typeof response.expires_at === 'string' ? Date.parse(response.expires_at) : NaN;
    return {
      url: this.signed(response.url),
      expiresAt: new Date(Number.isFinite(expires) ? expires : Date.now() + 50_000).toISOString(),
    };
  }
  async read(projectId: string, objectId: string, maxBytes: number): Promise<Buffer> {
    // The link has passed signed(): https, or loopback http, on a configured storage origin.
    const { url } = await this.download(projectId, objectId);
    return await this.#fetch(url, maxBytes);
  }
  /**
   * GET a signed object link, reading at most maxBytes + 1 bytes: one byte more than asked is
   * enough for the caller to see the object is not what its metadata says.
   */
  async #fetch(url: string, maxBytes: number): Promise<Buffer> {
    let response: Response;
    try {
      response = await fetch(url, {
        // Never follow a redirect off the configured storage origin.
        redirect: 'manual',
        signal: AbortSignal.timeout(
          this.timeoutMs + Math.ceil((maxBytes / MIN_READ_BYTES_PER_SECOND) * 1000),
        ),
      });
    } catch {
      throw new MervError('blob_unavailable', 'Stored object is unreachable', 503);
    }
    const reader = response.body?.getReader();
    try {
      check(response.status !== 404, 'blob_not_found', 'Stored object not found', 404);
      check(
        response.ok && reader,
        'blob_unavailable',
        `Stored object could not be read (HTTP ${response.status})`,
        503,
      );
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (size <= maxBytes) {
        const part = await reader.read();
        if (part.done) break;
        chunks.push(part.value);
        size += part.value.byteLength;
      }
      return Buffer.concat(chunks, Math.min(size, maxBytes + 1));
    } catch (error) {
      if (error instanceof MervError) throw error;
      throw new MervError('blob_unavailable', 'Stored object read failed', 503);
    } finally {
      // Stopping early, a refusal and a failure all leave no body occupying a connection.
      await (reader ? reader.cancel() : response.body?.cancel())?.catch(() => {});
    }
  }
}

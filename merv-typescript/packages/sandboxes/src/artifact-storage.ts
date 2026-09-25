import {
  check,
  type ArtifactUploadInput,
  type ArtifactUploadStatus,
  type LargeArtifactStorage,
} from '@merv/contracts';
import { SandboxClient, sandboxRoute } from './client.js';
import type { SandboxConnection } from './types.js';

type Row = Record<string, any>;
const row = (value: unknown): Row =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};

/** The ML application grant selects the project's subject for every storage request. */
export class SandboxArtifactStorage implements LargeArtifactStorage {
  private readonly client: SandboxClient;
  constructor(
    origin: string,
    timeoutMs: number,
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
  private status(uploadId: string, response: unknown): ArtifactUploadStatus {
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
      uploadId,
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
  async begin(projectId: string, uploadId: string, input: ArtifactUploadInput) {
    const response = row(
      await this.client.write(this.entry(projectId), 'POST', '/v1/storage/objects', {
        name: `artifacts/${uploadId}`,
        idempotency_key: uploadId,
        sha256: input.sha256,
        size_bytes: input.size,
        content_type: input.mediaType,
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
    return { objectId, status: this.status(uploadId, response) };
  }
  async resume(
    projectId: string,
    objectId: string,
    startPart: number,
  ): Promise<ArtifactUploadStatus> {
    const response = await this.client.read(
      this.entry(projectId),
      sandboxRoute('/v1/storage/objects/{id}/upload', objectId),
      { start_part: startPart },
    );
    // The public upload identifier is added by ArtifactStore, never selected by Sandboxes.
    return this.status('', response);
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
    return {
      objectId: String(response.id),
      size: Number(response.size_bytes),
      sha256: String(response.sha256),
      state: String(response.state),
    };
  }
  async download(projectId: string, objectId: string) {
    const response = row(
      await this.client.read(
        this.entry(projectId),
        sandboxRoute('/v1/storage/objects/{id}/download-short', objectId),
      ),
    );
    return {
      url: this.signed(response.url),
      expiresAt: new Date(Date.now() + 50_000).toISOString(),
    };
  }
}

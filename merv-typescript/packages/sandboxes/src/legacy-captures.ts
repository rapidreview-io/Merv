import { check, record } from '@merv/contracts';
import { SandboxClient, sandboxRoute } from './client.js';
import type { LegacyCapturesConfig } from './types.js';

const object = (value: unknown): Record<string, any> => record(value) ?? {};

/**
 * Downloads of the files the retired Merv-side compute path captured. Their artifact collections
 * name the `sandboxes` file provider and the objects stay in Sandboxes storage under the ML
 * grant, so retained evidence stays readable after the path that wrote it is gone. Read-only.
 */
export function legacyCaptureDownloads(
  origin: unknown,
  timeoutMs: number,
  config: LegacyCapturesConfig,
): (projectId: string, objectId: string) => Promise<{ url: string; expiresAt: string }> {
  const client = new SandboxClient(origin, timeoutMs, config.storageOrigins);
  return async (projectId, objectId) => {
    const response = object(
      await client.read(
        { projectId, namespace: config.namespace, tokenEnv: config.tokenEnv, subject: projectId },
        `${sandboxRoute('/v1/storage/objects/{id}', objectId)}/download`,
      ),
    );
    const record = object(response.object);
    check(
      record.id === objectId && record.kind === 'file' && record.state === 'available',
      'sandbox_unavailable',
      'Captured file is no longer available',
      502,
    );
    let url: URL | undefined;
    try {
      url = new URL(response.url);
    } catch {
      /* Refuse malformed provider output. */
    }
    check(
      url &&
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        config.storageOrigins.some((entry) => new URL(entry).origin === url.origin),
      'sandbox_unavailable',
      'Captured output download is outside configured storage origins',
      502,
    );
    // The provider's own link lifetime (one hour in production) when the signature states it.
    const issued = url.searchParams
      .get('X-Amz-Date')
      ?.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
    const seconds = Number(url.searchParams.get('X-Amz-Expires'));
    const time = issued
      ? Date.parse(`${issued[1]}-${issued[2]}-${issued[3]}T${issued[4]}:${issued[5]}:${issued[6]}Z`)
      : NaN;
    return {
      url: url.href,
      expiresAt:
        Number.isFinite(time) && seconds > 0 && seconds <= 86400
          ? new Date(time + seconds * 1000).toISOString()
          : new Date(Date.now() + 60_000).toISOString(),
    };
  };
}

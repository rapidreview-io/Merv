import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { z } from 'zod';
import { ListToolsResultSchema, type ListToolsResult } from '@modelcontextprotocol/sdk/types.js';
import { check, MervError } from '@merv/contracts';
import type { RemoteToolDescription } from '@merv/api/types';

// Validate protocol structure while retaining the original JSON, including extension metadata
// that the SDK's ordinary object parsing can strip from nested content blocks.
const losslessListResult = z.custom<ListToolsResult>(
  (value) => ListToolsResultSchema.safeParse(value).success,
  'Remote tools/list returned an invalid MCP catalog',
);

/** A connected client supplied by the caller; transport and credentials remain outside catalog ownership. */
export type RemoteCatalogClient = Pick<Client, 'request'>;
export interface RemoteCatalogOptions {
  maxPages?: number;
  maxTools?: number;
  /** Bounds a whole catalog collection. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Read a complete bounded catalog before handing any of it to the registry. Descriptions carry no
 * handler: the caller attaches the one that selects each call's own authority.
 */
export async function collectRemoteCatalog(
  client: RemoteCatalogClient,
  options: RemoteCatalogOptions = {},
): Promise<RemoteToolDescription[]> {
  const maxPages = options.maxPages ?? 20,
    maxTools = options.maxTools ?? 1000,
    timeoutMs = options.timeoutMs ?? 5000;
  check(
    Number.isSafeInteger(maxPages) && maxPages > 0,
    'invalid_remote_catalog_config',
    'maxPages must be a positive integer',
  );
  check(
    Number.isSafeInteger(maxTools) && maxTools > 0,
    'invalid_remote_catalog_config',
    'maxTools must be a positive integer',
  );
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const result: RemoteToolDescription[] = [],
    names = new Set<string>(),
    cursors = new Set<string>();
  let cursor: string | undefined;
  try {
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
      signal.throwIfAborted();
      // Client.listTools replaces its metadata cache on each page. Raw requests
      // avoid altering validation for calls using an already installed snapshot.
      const page = await client.request(
        { method: 'tools/list', ...(cursor === undefined ? {} : { params: { cursor } }) },
        losslessListResult,
        { signal, timeout: timeoutMs, maxTotalTimeout: timeoutMs },
      );
      for (const description of page.tools) {
        check(
          !names.has(description.name),
          'remote_catalog_duplicate',
          `Remote catalog repeated tool ${description.name}`,
          502,
        );
        check(
          result.length < maxTools,
          'remote_catalog_limit',
          'Remote catalog exceeds maxTools',
          502,
        );
        names.add(description.name);
        result.push(structuredClone(description));
      }
      if (page.nextCursor === undefined) return result;
      check(
        !cursors.has(page.nextCursor),
        'remote_catalog_cursor',
        'Remote catalog repeated a pagination cursor',
        502,
      );
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw new MervError('remote_catalog_limit', 'Remote catalog exceeds maxPages', 502);
  } catch (error) {
    // The SDK wraps cancellation reasons in McpError. Preserve the caller's
    // explicit cancellation so shutdown has a stable, distinguishable outcome.
    if (options.signal?.aborted) throw options.signal.reason ?? error;
    if (deadline.aborted)
      throw new MervError('remote_catalog_timeout', 'Remote catalog collection timed out', 504);
    throw error;
  }
}

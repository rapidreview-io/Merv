import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { z } from 'zod';
import { ListToolsResultSchema, type ListToolsResult } from '@modelcontextprotocol/sdk/types.js';
import { check, MervError } from '@merv/contracts';
import type { ToolDescription } from '@merv/api/types';

// Validate protocol structure while retaining the original JSON, including extension metadata
// that the SDK's ordinary object parsing can strip from nested content blocks.
const losslessListResult = z.custom<ListToolsResult>(
  (value) => ListToolsResultSchema.safeParse(value).success,
  'Remote tools/list returned an invalid MCP catalog',
);
const MAX_PAGES = 20;

/**
 * Selected upstream descriptions by name, without handlers; stops once every wanted name is found.
 * `options` go to every page request: the SDK `timeout` bounds each page, and `signal` is only the
 * round's stop. Never a timer signal: its abort would send a stray notifications/cancelled.
 */
export async function collectRemoteCatalog(
  client: Pick<Client, 'request'>,
  wanted: ReadonlySet<string>,
  options: { signal?: AbortSignal; timeout: number },
): Promise<Map<string, ToolDescription>> {
  const found = new Map<string, ToolDescription>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    // Client.listTools replaces its metadata cache on each page; a raw request leaves it alone.
    const result = await client.request(
      { method: 'tools/list', ...(cursor === undefined ? {} : { params: { cursor } }) },
      losslessListResult,
      options,
    );
    for (const tool of result.tools) {
      if (!wanted.has(tool.name)) continue;
      check(
        !found.has(tool.name),
        'remote_catalog_duplicate',
        `Remote catalog repeated tool ${tool.name}`,
        502,
      );
      found.set(tool.name, tool);
    }
    if (result.nextCursor === undefined || found.size === wanted.size) return found;
    cursor = result.nextCursor;
  }
  throw new MervError('remote_catalog_limit', `Remote catalog exceeds ${MAX_PAGES} pages`, 502);
}

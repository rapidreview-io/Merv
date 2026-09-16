import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { z } from 'zod';
import {
  CallToolResultSchema,
  ListToolsResultSchema,
  ToolListChangedNotificationSchema,
  type CallToolResult,
  type ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js';
import { check, MervError } from '@merv/contracts';
import type { RemoteToolDefinition, ToolCatalog } from '@merv/api/types';

// Validate protocol structure while retaining the original JSON, including extension metadata
// that the SDK's ordinary object parsing can strip from nested content blocks.
const losslessListResult = z.custom<ListToolsResult>(
  (value) => ListToolsResultSchema.safeParse(value).success,
  'Remote tools/list returned an invalid MCP catalog',
);
const losslessCallResult = z.custom<CallToolResult>(
  (value) => CallToolResultSchema.safeParse(value).success,
  'Remote tools/call returned an invalid MCP result',
);

/** A connected client supplied by the caller; transport and credentials remain outside catalog ownership. */
export type RemoteCatalogClient = Pick<
  Client,
  'request' | 'setNotificationHandler' | 'removeNotificationHandler'
>;
const controllers = new WeakMap<RemoteCatalogClient, RemoteCatalog>();
export interface RemoteCatalogOptions {
  maxPages?: number;
  maxTools?: number;
  /** Bounds a whole catalog collection, and each later tool call separately. */
  timeoutMs?: number;
  signal?: AbortSignal;
  onRefresh?: () => void;
  onError?: (error: unknown) => void;
}

/** Read a complete bounded catalog before handing any of it to the registry. */
export async function collectRemoteCatalog(
  client: RemoteCatalogClient,
  options: RemoteCatalogOptions = {},
): Promise<RemoteToolDefinition[]> {
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
  check(
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 2_147_483_647,
    'invalid_remote_catalog_config',
    'timeoutMs must be a positive supported timeout',
  );
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const result: RemoteToolDefinition[] = [],
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
        const snapshot = structuredClone(description);
        result.push({
          ...snapshot,
          kind: 'mcp',
          handler: (_caller, input) =>
            client.request(
              { method: 'tools/call', params: { name: snapshot.name, arguments: input } },
              losslessCallResult,
              { timeout: timeoutMs, maxTotalTimeout: timeoutMs },
            ),
        });
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
    // explicit cancellation so close has a stable, distinguishable outcome.
    if (options.signal?.aborted) throw options.signal.reason ?? error;
    if (deadline.aborted)
      throw new MervError('remote_catalog_timeout', 'Remote catalog collection timed out', 504);
    throw error;
  }
}

/** Owns the client's tools/list_changed handler and serializes explicit and notified refreshes. */
export class RemoteCatalog {
  private tail: Promise<void> = Promise.resolve();
  private stopping = false;
  private closing?: Promise<void>;
  private current?: AbortController;
  lastError: unknown;

  constructor(
    private readonly client: RemoteCatalogClient,
    private readonly catalog: ToolCatalog,
    private readonly options: RemoteCatalogOptions = {},
  ) {
    check(
      !controllers.has(client),
      'remote_catalog_client_owned',
      'This client already has a remote catalog controller',
      409,
    );
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      if (!this.stopping) void this.refresh().catch(() => undefined);
    });
    controllers.set(client, this);
  }

  refresh(): Promise<void> {
    if (this.stopping)
      return Promise.reject(
        new MervError('remote_catalog_closed', 'Remote catalog is closed', 503),
      );
    const operation = this.tail.then(async () => {
      check(!this.stopping, 'remote_catalog_closed', 'Remote catalog is closed', 503);
      const controller = new AbortController();
      this.current = controller;
      try {
        const signal = this.options.signal
          ? AbortSignal.any([this.options.signal, controller.signal])
          : controller.signal;
        const definitions = await collectRemoteCatalog(this.client, { ...this.options, signal });
        check(!this.stopping, 'remote_catalog_closed', 'Remote catalog is closed', 503);
        // replace validates every entry before changing admission, then drains the old snapshot.
        await this.catalog.replace(definitions);
        this.lastError = undefined;
        this.options.onRefresh?.();
      } catch (error) {
        this.lastError = error;
        this.options.onError?.(error);
        throw error;
      } finally {
        if (this.current === controller) this.current = undefined;
      }
    });
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  /** Waits for refreshes already queued; notifications arriving afterward start another operation. */
  whenIdle(): Promise<void> {
    return this.tail;
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopping = true;
    this.client.removeNotificationHandler('notifications/tools/list_changed');
    controllers.delete(this.client);
    this.current?.abort(new MervError('remote_catalog_closed', 'Remote catalog is closed', 503));
    // Withdrawal starts before waiting for an in-flight collection or old calls.
    const draining = this.catalog.dispose();
    this.closing = Promise.all([this.tail, draining]).then(() => undefined);
    return this.closing;
  }
}

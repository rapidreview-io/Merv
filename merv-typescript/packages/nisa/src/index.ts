import { isIP } from 'node:net';
import type { Context } from 'cordis';
import { z } from 'zod';
import { check, MervError, type Caller } from '@merv/contracts';
import type { AccessPolicy } from '@merv/access/types';
import type { CredentialProvider } from '@merv/credentials/types';
import type { RemoteToolDefinition, ToolCatalog, Tools } from '@merv/api/types';
import type { Nisa, NisaConfig, NisaStatus } from './types.js';

export type { Nisa, NisaConfig, NisaStatus } from './types.js';

const modernId = /^\d{2}(?:0[1-9]|1[0-2])\.\d{4,5}$/;
const citedId =
  /^(?:\d{2}(?:0[1-9]|1[0-2])\.\d{4,5}|[a-z][a-z.-]*[\/_]\d{2}(?:0[1-9]|1[0-2])\d{3})(?:v[1-9]\d*)?$/i;
const nonblank = (value: string) => value.trim().length > 0;
const searchInput = z
  .object({
    query: z.string().min(1).max(1000).refine(nonblank),
    max_results: z.number().int().min(1).max(20).default(5),
    offset: z.number().int().min(0).max(10000).default(0),
  })
  .strict();
const paperInput = z.object({ arxiv_id: z.string().regex(modernId) }).strict();
const citation = z
  .object({
    arxiv_id: z.string().max(200).regex(citedId),
    title: z.string().refine(nonblank),
  })
  .passthrough();
const paperResponse = z
  .object({
    arxiv_id: z.string().regex(modernId),
    title: z.string().refine(nonblank),
  })
  .passthrough();

function allowedOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.origin !== value || url.username || url.password || url.search || url.hash)
      return false;
    return (
      url.protocol === 'https:' ||
      (url.protocol === 'http:' &&
        (url.hostname === 'localhost' ||
          url.hostname === '[::1]' ||
          (isIP(url.hostname) === 4 && url.hostname.startsWith('127.'))))
    );
  } catch {
    return false;
  }
}
const configuration = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
      .default('nisa'),
    apiOrigin: z
      .string()
      .refine(allowedOrigin, 'Expected an HTTPS origin or loopback HTTP origin')
      .default('https://api.rapidreview.io'),
    timeoutMs: z.number().int().min(25).max(60000).default(10000),
    maxResponseBytes: z
      .number()
      .int()
      .min(1)
      .max(8 * 1024 * 1024)
      .default(2 * 1024 * 1024),
  })
  .strict()
  .default({});
type Settings = z.infer<typeof configuration>;
type SearchInput = z.infer<typeof searchInput>;
type PaperInput = z.infer<typeof paperInput>;

const responseSchema = {
  type: 'object' as const,
  required: ['data', 'sources'],
  additionalProperties: false,
  properties: {
    data: { type: 'object', additionalProperties: true },
    sources: {
      type: 'array',
      items: {
        type: 'object',
        required: ['arxivId', 'title', 'url'],
        additionalProperties: false,
        properties: {
          arxivId: { type: 'string' },
          title: { type: 'string' },
          url: { type: 'string', format: 'uri' },
        },
      },
    },
  },
};
const failure = (code: string, message: string, status = 502) =>
  new MervError(code, message, status);

/** Stateless Nisa REST access; the registry owns admission and draining for the selected catalog. */
export class NisaService implements Nisa {
  private readonly config: Settings;
  private readonly catalog: ToolCatalog;
  private state: NisaStatus['state'] = 'configured';
  private starting?: Promise<void>;
  private closing?: Promise<void>;

  constructor(
    tools: Tools,
    private readonly credentials: CredentialProvider,
    private readonly access: AccessPolicy,
    config: NisaConfig = {},
  ) {
    const parsed = configuration.safeParse(config);
    check(parsed.success, 'invalid_nisa_config', 'Nisa configuration is invalid');
    this.config = parsed.data;
    this.catalog = tools.createCatalog(this.config.id);
  }

  status(): NisaStatus {
    return { id: this.config.id, origin: this.config.apiOrigin, state: this.state };
  }

  start(): Promise<void> {
    if (this.state === 'stopped')
      return Promise.reject(failure('nisa_stopped', 'Nisa is stopped', 503));
    return (this.starting ??= (async () => {
      try {
        await this.catalog.replace(this.definitions());
        if (this.state !== 'stopped') this.state = 'ready';
      } catch {
        await this.close();
        throw failure('nisa_initialization_failed', 'Nisa tool registration failed', 503);
      }
    })());
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.state = 'stopped';
    // Dispose withdraws both tool names synchronously, then drains their admitted handlers.
    return (this.closing = this.catalog.dispose());
  }

  private definitions(): RemoteToolDefinition[] {
    const annotations = {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    };
    return [
      {
        kind: 'mcp',
        name: 'search',
        description: 'Search Nisa papers and return complete records with arXiv source links.',
        inputSchema: {
          type: 'object',
          required: ['query'],
          additionalProperties: false,
          properties: {
            query: { type: 'string', minLength: 1, maxLength: 1000 },
            max_results: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
            offset: { type: 'integer', minimum: 0, maximum: 10000, default: 0 },
          },
        },
        outputSchema: responseSchema,
        annotations,
        handler: (caller, input) => {
          const parsed = searchInput.safeParse(input);
          check(parsed.success, 'invalid_input', 'Nisa search arguments are invalid');
          return this.search(caller, parsed.data);
        },
      },
      {
        kind: 'mcp',
        name: 'paper',
        description:
          'Read a Nisa paper by its unversioned modern arXiv ID, with an arXiv source link.',
        inputSchema: {
          type: 'object',
          required: ['arxiv_id'],
          additionalProperties: false,
          properties: { arxiv_id: { type: 'string', pattern: modernId.source } },
        },
        outputSchema: responseSchema,
        annotations,
        handler: (caller, input) => {
          const parsed = paperInput.safeParse(input);
          check(parsed.success, 'invalid_input', 'Nisa paper arguments are invalid');
          return this.paper(caller, parsed.data);
        },
      },
    ];
  }

  private async search(caller: Caller, input: SearchInput) {
    const data = await this.request(caller, 'search', '/api/sdk/search', {
      query: input.query,
      max_results: input.max_results,
      offset: input.offset,
      // Enrichment can launch background agents; it is never configurable through this adapter.
      enrich: false,
    });
    const valid = z
      .object({ papers: z.array(citation).max(input.max_results) })
      .passthrough()
      .safeParse(data);
    check(valid.success, 'nisa_invalid_response', 'Nisa returned invalid paper search data', 502);
    return this.result(data, valid.data.papers);
  }

  private async paper(caller: Caller, input: PaperInput) {
    const data = await this.request(caller, 'paper', `/api/sdk/paper/${input.arxiv_id}`);
    const valid = paperResponse.safeParse(data);
    check(
      valid.success && valid.data.arxiv_id === input.arxiv_id,
      'nisa_invalid_response',
      'Nisa returned invalid paper data',
      502,
    );
    return this.result(data, [valid.data]);
  }

  private result(data: Record<string, unknown>, papers: { arxiv_id: string; title: string }[]) {
    const value = {
      data,
      sources: papers.map((paper) => ({
        arxivId: paper.arxiv_id,
        title: paper.title,
        // Nisa stores some legacy IDs with an underscore; arXiv links use a slash.
        url: `https://arxiv.org/abs/${paper.arxiv_id.replace('_', '/')}`,
      })),
    };
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(value) }],
      structuredContent: value,
    };
  }

  private async request(
    caller: Caller,
    name: 'search' | 'paper',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    // Every actual dispatch uses the current local actor and separately resolved upstream authority.
    this.access.require(caller, this.config.id, name);
    const credential = this.credentials.resolve(caller, this.config.id);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(failure('nisa_timeout', 'Nisa request timed out', 504));
      }, this.config.timeoutMs);
    });
    try {
      const operation = (async () => {
        const response = await fetch(this.config.apiOrigin + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            ...credential.headers(),
            accept: 'application/json',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: 'error',
          signal: controller.signal,
        });
        if (!response.ok) {
          void response.body?.cancel().catch(() => undefined);
          throw failure('nisa_upstream_error', 'Nisa request failed');
        }
        const mediaType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
        if (!(mediaType === 'application/json' || mediaType?.endsWith('+json'))) {
          void response.body?.cancel().catch(() => undefined);
          throw failure('nisa_invalid_response', 'Nisa returned an invalid response');
        }
        const length = Number(response.headers.get('content-length'));
        if (Number.isFinite(length) && length > this.config.maxResponseBytes) {
          void response.body?.cancel().catch(() => undefined);
          throw failure(
            'nisa_response_too_large',
            'Nisa response exceeds the configured byte limit',
          );
        }
        if (!response.body)
          throw failure('nisa_invalid_response', 'Nisa returned an empty response');
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          for (;;) {
            const item = await reader.read();
            if (item.done) break;
            bytes += item.value.length;
            if (bytes > this.config.maxResponseBytes)
              throw failure(
                'nisa_response_too_large',
                'Nisa response exceeds the configured byte limit',
              );
            chunks.push(item.value);
          }
        } catch (error) {
          void reader.cancel().catch(() => undefined);
          throw error;
        } finally {
          reader.releaseLock();
        }
        let data: unknown;
        try {
          data = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
          );
        } catch {
          throw failure('nisa_invalid_response', 'Nisa returned invalid JSON');
        }
        check(
          data !== null &&
            typeof data === 'object' &&
            !Array.isArray(data) &&
            !Object.hasOwn(data, 'error') &&
            !Object.hasOwn(data, 'isError'),
          'nisa_invalid_response',
          'Nisa returned an invalid response object',
          502,
        );
        return data as Record<string, unknown>;
      })();
      return await Promise.race([operation, deadline]);
    } catch (error) {
      controller.abort();
      if (timedOut) throw failure('nisa_timeout', 'Nisa request timed out', 504);
      if (error instanceof MervError && error.code.startsWith('nisa_')) throw error;
      throw failure('nisa_upstream_error', 'Nisa request failed');
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export const nisaPlugin = {
  name: 'merv-nisa',
  Config: configuration,
  inject: ['tools', 'credentials', 'access'],
  async apply(ctx: Context, config: NisaConfig = {}) {
    const service = new NisaService(ctx.tools, ctx.credentials, ctx.access, config);
    ctx.effect(() => () => service.close());
    await service.start();
    ctx.provide('nisa', service);
  },
};
export default nisaPlugin;

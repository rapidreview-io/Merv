import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createApp } from '../src/app.js';
import type { ApplicationConfig } from '../src/config.js';

const origin = 'https://api.rapidreview.io';
const sandboxOrigin = 'https://sandboxes.rapidreview.io';
const variable = 'MERV_NISA_LIVE_UPSTREAM_TOKEN';
const search = { query: 'flash attention', max_results: 3, offset: 0, enrich: false };
type Mode = '--check' | '--use-env-nisa-key' | '--use-saved-nisa-token';
function requireValue(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

/** Pure selection: no file access, refresh, key creation, logging, or network. */
export function freshSavedToken(saved: unknown, nowSeconds = Date.now() / 1000): string {
  requireValue(saved && typeof saved === 'object', 'nisa_credentials_invalid');
  const value = saved as Record<string, unknown>;
  requireValue(
    typeof value.expires_at === 'number' && value.expires_at > nowSeconds + 300,
    'nisa_saved_token_expired',
  );
  requireValue(
    typeof value.access_token === 'string' && /^[A-Za-z0-9\-._~+/]+=*$/.test(value.access_token),
    'nisa_credentials_invalid',
  );
  return value.access_token;
}

function credential(mode: Exclude<Mode, '--check'>): string {
  const directory = join(homedir(), '.nisa');
  const configPath = join(directory, 'config.json');
  const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
  const configuredOrigin =
    process.env.NISA_API_URL ?? process.env.PAPYRUS_API_URL ?? config.api_url ?? origin;
  requireValue(configuredOrigin === origin, 'nisa_configured_origin_mismatch');
  if (mode === '--use-env-nisa-key') {
    const key = process.env.RAPIDREVIEW_KEY;
    requireValue(
      typeof key === 'string' && /^rr_sk_[A-Za-z0-9_-]+$/.test(key),
      'nisa_api_key_unavailable',
    );
    return key;
  }
  const path = join(directory, 'credentials.json');
  const file = lstatSync(path);
  // Nisa's supported CLI uses fs::write and does not promise a 0600 mode.
  // Require an owned regular file, but do not modify or reinterpret its permissions.
  requireValue(
    file.isFile() && file.uid === process.getuid?.() && file.size < 65536,
    'nisa_saved_file_permissions',
  );
  return freshSavedToken(JSON.parse(readFileSync(path, 'utf8')));
}

export async function runLiveNisa(mode: Mode) {
  requireValue(
    ['--check', '--use-env-nisa-key', '--use-saved-nisa-token'].includes(mode),
    'explicit_nisa_mode_required',
  );
  if (mode === '--check')
    return {
      status: 'prepared',
      credentialRead: false,
      networkRequests: 0,
      origin,
      tools: ['mount__nisa__search', 'mount__nisa__paper'],
      search,
      limits: { searchCalls: 1, paperCalls: 1, sandboxToolCalls: 0 },
    };
  const token = credential(mode);
  const previous = process.env[variable];
  const directory = mkdtempSync(join(tmpdir(), 'merv-live-nisa-'));
  const originalFetch = globalThis.fetch;
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  let client: Client | undefined;
  let paperId: string | undefined;
  let searchCalls = 0,
    paperCalls = 0,
    sandboxToolCalls = 0;
  let report: Record<string, unknown> | undefined;
  process.env[variable] = token;
  try {
    globalThis.fetch = async (input, init) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      if (url.origin === origin) {
        requireValue(init?.redirect === 'error', 'nisa_redirects_not_disabled');
        if (method === 'POST' && url.pathname === '/api/sdk/search' && !url.search) {
          requireValue(searchCalls === 0 && typeof init?.body === 'string', 'nisa_search_limit');
          assert.deepEqual(JSON.parse(init.body), search);
          searchCalls++;
        } else {
          requireValue(
            method === 'GET' &&
              paperId &&
              url.pathname === `/api/sdk/paper/${paperId}` &&
              !url.search &&
              paperCalls === 0,
            'nisa_paper_limit',
          );
          paperCalls++;
        }
      } else if (url.origin === sandboxOrigin) {
        const headers = new Headers(
          init?.headers ?? (input instanceof Request ? input.headers : undefined),
        );
        requireValue(!headers.has('authorization'), 'sandbox_credential_not_authorized');
        if (method === 'POST' && typeof init?.body === 'string') {
          const body = JSON.parse(init.body);
          if (body.method === 'tools/call') sandboxToolCalls++;
          requireValue(
            ['initialize', 'notifications/initialized', 'tools/list', 'ping'].includes(body.method),
            'sandbox_tool_not_authorized',
          );
        }
      } else requireValue(url.hostname === '127.0.0.1', 'unexpected_live_origin');
      return originalFetch(input, init);
    };
    const config: ApplicationConfig = JSON.parse(
      readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
    );
    config.plugins.unshift({ id: 'literature', name: '@merv/nisa', config: { timeoutMs: 15000 } });
    config.plugins.unshift({
      id: 'sandbox-mount',
      name: '@merv/mounts',
      config: {
        mounts: [
          {
            id: 'sandbox',
            url: sandboxOrigin + '/mcp',
            tools: ['usage_report'],
            timeoutMs: 15000,
            reconnectMs: 60000,
          },
        ],
      },
    });
    app = await createApp({ directory, config, port: 0 });
    const identity = app.ctx.scope.bootstrap({
      projectName: 'Nisa live verification',
      actorName: 'Nisa verifier',
    });
    const caller = { actorId: identity.actor.id, projectId: identity.project.id };
    app.ctx.access.replace([{ ...caller, mountId: 'nisa', tools: ['search', 'paper'] }]);
    app.ctx.credentials.replace([
      { ...caller, id: 'nisa-live', mountId: 'nisa', secretRef: `env:${variable}` },
    ]);
    assert.equal(app.ctx.mounts.status()[0].state, 'ready');
    const mount = app.ctx.mounts;
    client = new Client({ name: 'merv-live-nisa', version: '1' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(app.ctx.api.url! + '/mcp'), {
        requestInit: { headers: { authorization: `Bearer ${identity.token}` } },
      }),
    );
    const result = await client.request(
      {
        method: 'tools/call',
        params: {
          name: 'mount__nisa__search',
          arguments: {
            query: search.query,
            max_results: search.max_results,
            offset: search.offset,
          },
        },
      },
      CallToolResultSchema,
    );
    assert.equal(result.isError, undefined);
    const structured = result.structuredContent as {
      data: { papers: { arxiv_id: string; url?: string; title: string }[] };
      sources: { arxivId: string; url: string }[];
    };
    assert.deepEqual(JSON.parse((result.content as { text: string }[])[0].text), structured);
    assert.ok(structured.data.papers.length > 0);
    assert.equal(structured.sources.length, structured.data.papers.length);
    for (const [index, paper] of structured.data.papers.entries()) {
      assert.equal(structured.sources[index].arxivId, paper.arxiv_id);
      assert.equal(
        structured.sources[index].url,
        `https://arxiv.org/abs/${paper.arxiv_id.replace('_', '/')}`,
      );
      assert.ok(typeof paper.url === 'string' && paper.url.length > 0);
    }
    paperId = structured.data.papers.find((paper) =>
      /^\d{2}(?:0[1-9]|1[0-2])\.\d{4,5}$/.test(paper.arxiv_id),
    )?.arxiv_id;
    requireValue(paperId, 'nisa_search_has_no_retrievable_id');
    const paperResult = await client.request(
      {
        method: 'tools/call',
        params: { name: 'mount__nisa__paper', arguments: { arxiv_id: paperId } },
      },
      CallToolResultSchema,
    );
    assert.equal(paperResult.isError, undefined);
    assert.equal((paperResult.structuredContent?.data as { arxiv_id: string }).arxiv_id, paperId);
    const before = app.ctx.tools.list().length;
    await app.setEnabled('literature', false);
    assert.equal(app.ctx.tools.list().length, before - 2);
    assert.equal(app.ctx.mounts, mount);
    assert.equal(mount.status()[0].state, 'ready');
    assert.equal(
      (await client.callTool({ name: 'project.get', arguments: {} })).isError,
      undefined,
    );
    const denied = await client.callTool({
      name: 'mount__nisa__search',
      arguments: { query: search.query },
    });
    assert.equal(denied.isError, true);
    await app.setEnabled('literature', true);
    assert.equal(app.ctx.tools.list().length, before);
    assert.equal(searchCalls, 1);
    assert.equal(paperCalls, 1);
    assert.equal(sandboxToolCalls, 0);
    report = {
      status: 'passed',
      origin,
      mode,
      query: search.query,
      searchCalls,
      paperCalls,
      sandboxToolCalls,
      returnedPapers: structured.data.papers.length,
      paperId,
      sources: structured.sources,
      sourceReferencesPreserved: true,
      backgroundEnrichment: false,
      nativeWorkContinued: true,
      sandboxPublicConnectionContinued: true,
      sandboxAuthenticatedCallRepeated: false,
      toolCounts: [before, before - 2, before],
      transport: 'actual local MCP client and configured Cordis application',
      completedAt: new Date().toISOString(),
    };
  } finally {
    try {
      await client?.close();
    } finally {
      try {
        await app?.stop();
      } finally {
        globalThis.fetch = originalFetch;
        if (previous === undefined) delete process.env[variable];
        else process.env[variable] = previous;
        rmSync(directory, { recursive: true, force: true });
      }
    }
  }
  requireValue(report, 'nisa_live_report_missing');
  return {
    ...report,
    cleanup: {
      applicationStopped: true,
      clientClosed: true,
      environmentRestored: true,
      temporaryStateRemoved: !existsSync(directory),
    },
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const mode = process.argv[2] as Mode;
  try {
    requireValue(process.argv.length === 3, 'choose_one_nisa_mode');
    const report = await runLiveNisa(mode);
    if (mode === '--check') console.log(JSON.stringify(report));
    else {
      const output = resolve('live-runs', `nisa-${new Date().toISOString().replaceAll(':', '-')}`);
      mkdirSync(output, { recursive: true, mode: 0o700 });
      writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
        mode: 0o600,
      });
      console.log(JSON.stringify({ status: 'passed', report: join(output, 'report.json') }));
    }
  } catch (error) {
    // Never print request/response payloads, auth values, assertions, or raw upstream errors.
    const code =
      error instanceof Error && /^nisa_[a-z_]+$/.test(error.message)
        ? error.message
        : 'nisa_live_failed';
    console.error(JSON.stringify({ status: 'failed', code }));
    process.exitCode = 1;
  }
}

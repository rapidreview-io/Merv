import { posix } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage } from 'node:http';
import type { MountHandler } from '@merv/api/types';
import { check } from '@merv/contracts';
import { Tokens, type Token } from './tokens.js';

const reads = new Set(
  `get_runs_for_project get_run_configs get_metrics_for_run get_metric_values get_project_summary get_run_summary get_system_metrics_for_run get_system_logs get_system_logs_batch get_snapshot get_logs get_logs_batch get_alerts get_project_files get_tab_availability get_traces get_trace_steps query_project get_run_artifact_counts get_artifacts list_artifacts`.split(
    ' ',
  ),
);
const writes = new Map([
  ['log', ''],
  ['bulk_log', 'logs'],
  ['bulk_log_system', 'logs'],
  ['bulk_alert', 'alerts'],
  ['bulk_upload_media', 'uploads'],
]);
const local = new Set(['get_all_projects', 'get_run_mutation_status', 'get_settings']);
const object = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
/** One path segment. Trackio joins media runs and paths into files unchecked (media/utils.py). */
const segment = (value: unknown) =>
  typeof value === 'string' && value !== '.' && value !== '..' && /^[^/\\\0%]+$/.test(value);
const mediaTarget = (entry: Record<string, any>) =>
  entry.run
    ? segment(entry.run) && (entry.step == null || Number.isSafeInteger(entry.step))
    : entry.relative_path == null ||
      (typeof entry.relative_path === 'string' && entry.relative_path.split('/').every(segment));
export function kwargs(value: unknown): Record<string, any> {
  check(object(value) && !('data' in value), 'invalid_input', 'Use named arguments', 400);
  if ('kwargs' in value || 'args' in value) {
    check(
      object(value.kwargs) &&
        (!('args' in value) || (Array.isArray(value.args) && value.args.length === 0)) &&
        Object.keys(value).every((k) => k === 'kwargs' || k === 'args'),
      'invalid_input',
      'Use named arguments',
      400,
    );
    return value.kwargs;
  }
  return value;
}
async function body(req: IncomingMessage, limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    check(size <= limit, 'body_too_large', 'Request body is too large', 413);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
export interface ProxyConfig {
  upstream: string;
  writeToken: string;
  mediaDir: string;
}
export function metricsProxy(
  config: ProxyConfig,
  tokens: Tokens,
  mayRead: (token: Extract<Token, { k: 'v' }>) => Promise<boolean>,
): MountHandler {
  // Trackio's staged uploads are one global set: each handle stays with the project that staged it.
  const staged = new Map<string, { project: string; at: number }>();
  /** Which experiment attempt each run of a project was first logged by, and runs by name. */
  const owners = async (project: string) => {
    const read = async (name: string) => {
      const response = await fetch(`${config.upstream}/trackio/api/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kwargs: { project } }),
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
      });
      check(response.ok, 'upstream_error', 'Trackio did not answer', 502);
      return ((await response.json()) as { data: unknown }).data;
    };
    const [runs, configs] = (await Promise.all([
      read('get_runs_for_project'),
      read('get_run_configs'),
    ])) as [{ id: string; name: string }[], Record<string, Record<string, unknown> | null>];
    const names = new Map<string, string[]>();
    for (const run of runs) names.set(run.name, [...(names.get(run.name) ?? []), run.id]);
    const tags = new Map<string, { e: unknown; a: unknown }>();
    for (const [id, tagged] of Object.entries(configs))
      if (tagged && '_merv_experiment' in tagged)
        tags.set(id, { e: tagged._merv_experiment, a: tagged._merv_attempt });
    return { names, tags };
  };
  return async (req, res) => {
    const raw = req.url ?? '';
    const url = new URL(raw, 'http://localhost');
    const path = url.pathname;
    check(
      raw.startsWith('/trackio/') && path === raw.split('?')[0] && !/[\\\s#%]/.test(path),
      'not_found',
      'Unknown endpoint',
      404,
    );
    const api = /^\/trackio\/api\/([a-z_]+)$/.exec(path)?.[1];
    if (api) res.setHeader('cache-control', 'no-store');
    const upload = api === 'upload' && req.method === 'POST';
    const data =
      api && req.method === 'POST' && (reads.has(api) || writes.has(api) || local.has(api));
    const file = path === '/trackio/file' && req.method === 'GET';
    const blob = /^\/trackio\/artifact_blob\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/.exec(path);
    const staticPath =
      !/^\/trackio\/(api|file|artifact_blob|oauth|gradio_api|mcp)/.test(path) &&
      (path.startsWith('/trackio/assets/') ||
        path.startsWith('/trackio/static/trackio/') ||
        !path.includes('.'));
    const staticRead = staticPath && (req.method === 'GET' || req.method === 'HEAD');
    check(
      upload || data || file || (blob && req.method === 'GET') || staticRead,
      'not_found',
      'Unknown endpoint',
      404,
    );
    let held: Token[] = [];
    const header = req.headers['x-trackio-write-token'];
    if (header !== undefined) {
      const token = typeof header === 'string' ? tokens.verify(header) : undefined;
      check(token?.k === 'w', 'unauthorized', 'Invalid metrics token', 401);
      held = [token];
    } else {
      for (const cookie of (req.headers.cookie ?? '').split(';')) {
        const [name, ...parts] = cookie.trim().split('=');
        const token = tokens.verify(parts.join('='));
        if (token?.k === 'v' && name === `merv_trackio_${token.p}`) held.push(token);
      }
    }
    check(held.length, 'unauthorized', 'Metrics token required', 401);
    if (!staticRead) {
      const valid: Token[] = [];
      for (const token of held) if (token.k === 'w' || (await mayRead(token))) valid.push(token);
      held = valid;
      check(held.length, 'forbidden', 'Project access was revoked', 403);
    }
    const allows = (project: unknown) => held.some((t) => t.p === project);
    const writer = held.find((t) => t.k === 'w');
    let bytes: Buffer | undefined;
    let writing = false;
    if (upload) {
      check(writer, 'forbidden', 'Write token required', 403);
      check(
        /^multipart\/form-data;/.test(req.headers['content-type'] ?? ''),
        'invalid_input',
        'Multipart upload required',
        415,
      );
      bytes = await body(req, 64 * 1024 * 1024);
      writing = true;
    } else if (data && api) {
      let value: unknown;
      const rawBody = await body(req, 8 * 1024 * 1024);
      try {
        value = JSON.parse(rawBody.toString());
      } catch {
        check(false, 'invalid_json', 'Invalid JSON', 400);
      }
      const args = kwargs(value);
      if (local.has(api)) {
        if (api === 'get_all_projects') return { data: [...new Set(held.map((t) => t.p))] };
        if (api === 'get_run_mutation_status')
          return { data: { spaces: false, allowed: false, auth: 'none' } };
        bytes = Buffer.from(JSON.stringify({ kwargs: {} }));
      } else if (reads.has(api)) {
        check(allows(args.project), 'forbidden', 'Project does not match token', 403);
        if (api.endsWith('_batch')) {
          check(Array.isArray(args.runs), 'invalid_input', 'Runs required', 400);
          for (const entry of args.runs)
            check(
              object(entry) && (!('project' in entry) || entry.project === args.project),
              'forbidden',
              'Project does not match token',
              403,
            );
        }
      } else {
        check(writer?.k === 'w', 'forbidden', 'Write token required', 403);
        writing = true;
        const key = writes.get(api)!;
        const entries = key ? args[key] : [args];
        check(Array.isArray(entries), 'invalid_input', 'Entries required', 400);
        for (const entry of entries)
          check(
            object(entry) && entry.project === writer.p,
            'forbidden',
            'Project does not match token',
            403,
          );
        // A run belongs to the experiment attempt that first logged it: Trackio replaces a run's
        // config wherever a write carries one, so another attempt must not write to it at all.
        const runs = await owners(writer.p);
        const stamped = new Set<string>();
        for (const entry of entries) {
          const ids =
            typeof entry.run_id === 'string' ? [entry.run_id] : (runs.names.get(entry.run) ?? []);
          for (const id of ids) {
            const owner = runs.tags.get(id);
            check(
              !owner || (owner.e === writer.e && owner.a === writer.a),
              'forbidden',
              'The run belongs to another experiment attempt',
              403,
            );
          }
          if (api === 'bulk_upload_media') {
            check(mediaTarget(entry), 'forbidden', 'Invalid media path', 403);
            const handle = entry.uploaded_file?.path;
            check(
              typeof handle === 'string' && staged.get(handle)?.project === writer.p,
              'forbidden',
              'Upload was staged for another project',
              403,
            );
            staged.delete(handle);
          }
          // A run's first entry carries its config and later ones send null; a run that reaches
          // Merv untagged without one is stamped on its first entry.
          const run = `${entry.run_id ?? ''}/${entry.run}`;
          if (
            api === 'bulk_log' &&
            entry.config == null &&
            !ids.some((id: string) => runs.tags.has(id)) &&
            !stamped.has(run)
          )
            entry.config = {};
          if (api === 'bulk_log' && entry.config != null) {
            check(object(entry.config), 'invalid_input', 'Config must be an object', 400);
            entry.config._merv_experiment = writer.e;
            entry.config._merv_attempt = writer.a;
            entry.config._Group = writer.g;
            stamped.add(run);
          }
        }
        args.hf_token = null;
      }
      bytes ??= Buffer.from(JSON.stringify({ kwargs: args }));
    } else if (file) {
      const requested = url.searchParams.get('path');
      check(
        // Trackio unquotes the path again, so an escape here would be a second encoding.
        requested && !/[\0\\%]/.test(requested) && !requested.split('/').includes('..'),
        'forbidden',
        'Invalid media path',
        403,
      );
      const normalized = posix.normalize(requested);
      check(
        held.some(
          (t) =>
            t.k === 'v' &&
            normalized.startsWith(`${posix.normalize(config.mediaDir).replace(/\/$/, '')}/${t.p}/`),
        ),
        'forbidden',
        'Media project does not match token',
        403,
      );
      url.searchParams.set('path', normalized);
    } else if (blob) check(allows(blob[1]), 'forbidden', 'Project does not match token', 403);
    url.searchParams.delete('write_token');
    const response = await fetch(`${config.upstream}${url.pathname}${url.search}`, {
      method: req.method,
      redirect: 'manual',
      headers: {
        ...(bytes
          ? { 'content-type': upload ? req.headers['content-type']! : 'application/json' }
          : {}),
        ...(writing ? { 'x-trackio-write-token': config.writeToken } : {}),
        ...((file || blob) && typeof req.headers.range === 'string'
          ? { range: req.headers.range }
          : {}),
      },
      ...(bytes ? { body: new Uint8Array(bytes) } : {}),
      signal: AbortSignal.timeout(60000),
    });
    check(
      response.status < 300 || response.status >= 400,
      'upstream_error',
      'Unexpected Trackio redirect',
      502,
    );
    if (upload && response.ok) {
      const answer = (await response.json()) as { paths?: unknown };
      const now = Date.now();
      for (const [handle, { at }] of staged)
        if (now - at > 3600000 || staged.size > 10000) staged.delete(handle);
        else break;
      for (const path of Array.isArray(answer.paths) ? answer.paths : [])
        if (typeof path === 'string') staged.set(path, { project: writer!.p, at: now });
      return answer;
    }
    res.statusCode = response.status;
    for (const name of ['content-type', 'content-disposition', 'accept-ranges', 'content-range']) {
      const value = response.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    res.setHeader('x-content-type-options', 'nosniff');
    // Media and blobs are uploaded by training code and served from Merv's origin. An HTML
    // figure (Plotly, an animation) may run its script, but in an opaque origin, never as Merv.
    if (file || blob)
      res.setHeader('content-security-policy', 'sandbox allow-scripts allow-downloads');
    if (response.body && req.method !== 'HEAD')
      await pipeline(Readable.fromWeb(response.body as never), res);
    else res.end();
  };
}

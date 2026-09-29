import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from 'cordis';
import {
  check,
  CODE_PART_MAX_BYTES,
  codePublicationMergeSchema,
  githubAutomationSchema,
  githubRepositoryInputSchema,
  githubRevisionSchema,
  MervError,
  type CodeGitHub,
} from '@merv/contracts';
import type { Api, ApiRequest, MountHandler } from '@merv/api/types';
import type { Code } from './types.js';

/** What Code's HTTP routes use of Code. */
export type CodeRoutes = Pick<
  Code,
  | 'github'
  | 'transportGrant'
  | 'verifyTransport'
  | 'nextCommand'
  | 'completeCommand'
  | 'publications'
  | 'syncPublications'
  | 'publicationDetails'
  | 'mergePublication'
  | 'v2'
>;

const unknownEndpoint = () => new MervError('not_found', 'Unknown endpoint', 404);
const emptyObject = (body: unknown) =>
  !!body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0;

function githubCookie(req: IncomingMessage): string {
  const cookies = (req.headers.cookie ?? '')
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('merv_github_flow='));
  return cookies.length === 1 ? cookies[0]!.slice('merv_github_flow='.length) : '';
}

/** Transport only. The public callback has no authority to bind a Merv account. */
async function githubCallback(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  github: CodeGitHub,
) {
  // Its URL carries GitHub's code, so no answer, a refusal included, may pass it on.
  res.setHeader('referrer-policy', 'no-referrer');
  check(
    [...url.searchParams.keys()].every(
      (key) =>
        ['state', 'code', 'iss', 'error', 'error_description', 'error_uri'].includes(key) &&
        url.searchParams.getAll(key).length === 1,
    ),
    'invalid_input',
    'Invalid GitHub callback',
  );
  check(
    !url.searchParams.has('iss') ||
      url.searchParams.get('iss') === 'https://github.com/login/oauth',
    'invalid_input',
    'Invalid GitHub callback issuer',
  );
  const redirect = await github.callback({
    state: url.searchParams.get('state') ?? '',
    code: url.searchParams.get('code') ?? undefined,
    error: url.searchParams.get('error') ?? undefined,
    cookie: githubCookie(req),
  });
  res.writeHead(303, { location: redirect, 'cache-control': 'no-store' });
  res.end();
}

async function githubRequest(
  req: IncomingMessage,
  res: ServerResponse,
  r: ApiRequest,
  github: CodeGitHub,
): Promise<unknown> {
  const caller = await r.caller();
  check(!r.url.search, 'invalid_input', 'GitHub controls do not accept query parameters');
  const action = r.url.pathname.slice('/code/github'.length);
  if (req.method === 'GET' && action === '') return await github.status(caller);
  if (req.method === 'GET' && action === '/repositories')
    return { repositories: await github.repositories(caller) };
  if (req.method === 'GET' && action === '/branches')
    return { branches: await github.branches(caller) };
  if (req.method === 'GET' && action === '/pulls') return { pulls: await github.pulls(caller) };
  if (req.method === 'GET' && /^\/pulls\/[1-9][0-9]*$/.test(action))
    return await github.pullDetails(caller, Number(action.split('/')[2]));
  if (req.method === 'POST') {
    const body = await r.json(undefined, 8192);
    if (action === '/automation') {
      const parsed = githubAutomationSchema.safeParse(body);
      check(
        parsed.success,
        'invalid_input',
        'A valid automation mode, base branch and expectedRevision are required',
      );
      return await github.configureAutomation(caller, parsed.data);
    }
    if (action === '/begin' || action === '/disconnect') {
      const parsed = githubRevisionSchema.safeParse(body);
      check(parsed.success, 'invalid_input', 'A valid expectedRevision is required');
      if (action === '/disconnect') return await github.disconnect(caller, parsed.data);
      const result = await github.begin(caller, parsed.data);
      res.setHeader('set-cookie', result.cookie);
      return { url: result.url };
    }
    if (action === '/finish') {
      check(emptyObject(body), 'invalid_input', 'GitHub finish expects an empty object');
      return await github.finish(caller, githubCookie(req));
    }
    if (action === '/repository') {
      const parsed = githubRepositoryInputSchema.safeParse(body);
      check(
        parsed.success,
        'invalid_input',
        'A repository, installation and expectedRevision are required',
      );
      return await github.link(caller, parsed.data);
    }
  }
  throw new MervError('not_found', 'Unknown GitHub route or method', 404);
}

async function publicationRequest(req: IncomingMessage, r: ApiRequest, code: CodeRoutes) {
  const caller = await r.caller();
  check(!r.url.search, 'invalid_input', 'Publication controls do not accept query parameters');
  const action = r.url.pathname.slice('/code/publications'.length);
  if (req.method === 'GET' && !action) return { publications: await code.publications(caller) };
  if (req.method === 'GET' && /^\/codeprop_[A-Za-z0-9_-]+$/.test(action))
    return await code.publicationDetails(caller, action.slice(1));
  if (req.method === 'POST') {
    const body = await r.json(undefined, 8192);
    if (action === '/sync') {
      check(emptyObject(body), 'invalid_input', 'Sync expects an empty object');
      return { publications: await code.syncPublications(caller) };
    }
    if (action === '/merge') {
      const parsed = codePublicationMergeSchema.safeParse(body);
      check(
        parsed.success,
        'invalid_input',
        'An exact proposal, head, base and merge request identifier are required',
      );
      return { publication: await code.mergePublication(caller, parsed.data) };
    }
  }
  throw new MervError('not_found', 'Unknown publication route or method', 404);
}

/**
 * `/code`: GitHub's OAuth callback (public), then the authenticated GitHub, publication, Git
 * transport, workspace (`/code/v2/`) and command controls. Each decides its caller once before
 * its body; Code parses every body it is handed and authorizes each effect itself. A managed
 * runner's credential already confines it to the routes its protocol uses.
 */
function codeRoutes(code: CodeRoutes): MountHandler {
  return async (req, res, r) => {
    const path = r.url.pathname;
    if (!r.principal) {
      if (path !== '/code/github/callback' || req.method !== 'GET') throw unknownEndpoint();
      return await githubCallback(req, res, r.url, code.github);
    }
    if (path === '/code/publications' || path.startsWith('/code/publications/'))
      return await publicationRequest(req, r, code);
    if (path === '/code/github' || path.startsWith('/code/github/'))
      return await githubRequest(req, res, r, code.github);
    if (path === '/code/transport/grant' || path === '/code/transport/verify') {
      if (req.method !== 'POST' || r.url.search)
        throw new MervError('invalid_input', 'Use POST without query parameters');
      const caller = await r.caller();
      const input = await r.json(undefined, 8192);
      return path.endsWith('/grant')
        ? await code.transportGrant(caller, input)
        : await code.verifyTransport(caller, input);
    }
    if (path.startsWith('/code/v2/')) {
      if (r.url.search)
        throw new MervError('invalid_input', 'Code routes do not accept query parameters');
      const caller = await r.caller();
      const route = path.slice('/code/v2/'.length);
      const part = /^uploads\/([A-Za-z0-9_]{1,80})\/parts\/(0|[1-9][0-9]{0,14})$/.exec(route);
      const read = /^downloads\/([A-Za-z0-9_]{1,80})\/read$/.exec(route);
      if (req.method !== (part ? 'PUT' : 'POST')) {
        res.setHeader('allow', part ? 'PUT' : 'POST');
        throw new MervError('method_not_allowed', 'Use PUT for a part and POST otherwise', 405);
      }
      const body = part
        ? await r.bytes(CODE_PART_MAX_BYTES, 'application/octet-stream')
        : await r.json(undefined, 65536);
      const v2 = code.v2;
      if (!v2)
        throw new MervError(
          'code_store_unavailable',
          'This server keeps no Code repositories',
          503,
        );
      if (part) return await v2.putPart(caller, part[1]!, Number(part[2]), body as Buffer);
      if (read) return await v2.readPart(caller, read[1]!, body);
      return await v2.call(caller, route, body);
    }
    if (path === '/code/commands/next' || path === '/code/commands/complete') {
      if ([...r.url.searchParams].length)
        throw new MervError('invalid_input', 'Code routes do not accept query parameters');
      const caller = await r.caller();
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST');
        throw new MervError('method_not_allowed', 'Use POST for Code controls', 405);
      }
      const input = await r.json();
      return path.endsWith('/next')
        ? { command: await code.nextCommand(caller, input) }
        : { operation: await code.completeCommand(caller, input) };
    }
    throw unknownEndpoint();
  };
}

/** Mounts `/code` for `code`, GitHub's callback public; the disposer withdraws it. */
export const mountCode = (api: Pick<Api, 'mount'>, code: CodeRoutes) =>
  api.mount('/code', codeRoutes(code), { public: ['/code/github/callback'] });

export const codeResearchApiPlugin = {
  name: 'merv-code-research-api',
  inject: ['codeResearch', 'api'],
  apply(ctx: Context) {
    ctx.effect(() => mountCode(ctx.api, ctx.codeResearch));
  },
};
export default codeResearchApiPlugin;

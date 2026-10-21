import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from 'cordis';
import { check, MervError } from '@merv/contracts';
import type { Api, ApiRequest, MountHandler } from '@merv/api/types';
import type { Code } from './types.js';
import { unknownEndpoint } from '@merv/api/errors';

/** What Code's HTTP routes use of Code. */
export type CodeRoutes = Pick<Code, 'v2' | 'raw' | 'gitRemote'>;

function codeRoutes(code: CodeRoutes): MountHandler {
  return async (req, res, r) => {
    const path = r.url.pathname;
    if (path.startsWith('/code/v2/')) {
      if (r.url.search)
        throw new MervError('invalid_input', 'Code routes do not accept query parameters');
      const cleanup =
        r.principal && 'caller' in r.principal && r.principal.caller.managed?.cleanup
          ? r.principal.caller
          : undefined;
      if (cleanup)
        check(
          req.headers['x-merv-project-id'] === undefined ||
            req.headers['x-merv-project-id'] === cleanup.projectId,
          'invalid_input',
          'Conflicting Merv project selections',
        );
      const caller = cleanup ?? (await r.caller());
      const route = path.slice('/code/v2/'.length);
      if (
        ![
          'workspace',
          'git-credential',
          'pushed',
          'submission-status',
          'submissions',
          'end',
          'capture-credential',
          'shutdown-credential',
        ].includes(route)
      )
        throw unknownEndpoint();
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST');
        throw new MervError('method_not_allowed', 'Use POST for workspace metadata', 405);
      }
      const body = await r.json(undefined, 65536);
      const v2 = code.v2;
      if (!v2)
        throw new MervError(
          'code_store_unavailable',
          'Code repositories are unavailable while Code closes',
          503,
        );
      return await v2.call(caller, route, body);
    }
    if (path === '/code/raw') {
      // The page's read of a file whole, a PDF or a picture: bytes, never a page of their own.
      const caller = await r.caller();
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST');
        throw new MervError('method_not_allowed', 'Use POST for a file', 405);
      }
      const input = (await r.json(undefined, 8192)) as { ref?: unknown; path?: unknown };
      check(
        typeof input?.path === 'string' &&
          (input.ref === undefined || typeof input.ref === 'string'),
        'invalid_input',
        'A file is its path and, optionally, its ref',
      );
      const bytes = await code.raw(caller, {
        ref: input.ref as string | undefined,
        path: input.path,
      });
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': bytes.length,
        'content-disposition': 'attachment',
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      });
      res.end(bytes);
      return;
    }
    throw unknownEndpoint();
  };
}

/** Mounts authenticated Code controls; the disposer withdraws them. */
export const mountCode = (api: Pick<Api, 'mount'>, code: CodeRoutes) => {
  const controls = api.mount('/code', codeRoutes(code));
  // Git authenticates Basic credentials against the project in its ordinary remote URL.
  const git = api.mount('/git', (req, res, r) => code.gitRemote.handle(req, res, r.url), {
    public: true,
  });
  return () => {
    git();
    controls();
  };
};

export const codeWorkApiPlugin = {
  name: 'merv-code-work-api',
  inject: ['codeWork', 'api'],
  apply(ctx: Context) {
    ctx.effect(() => mountCode(ctx.api, ctx.codeWork));
  },
};
export default codeWorkApiPlugin;

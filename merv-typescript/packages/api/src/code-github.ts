import type { IncomingMessage, ServerResponse } from 'node:http';
import { check, MervError, type Caller } from '@merv/contracts';
import {
  githubRepositoryInputSchema,
  githubRevisionSchema,
  type CodeGitHub,
} from '@merv/contracts';

export function githubCookie(req: IncomingMessage): string {
  const cookies = (req.headers.cookie ?? '')
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('merv_github_flow='));
  return cookies.length === 1 ? cookies[0].slice('merv_github_flow='.length) : '';
}
/** Transport only. The public callback has no authority to bind a Merv account. */
export async function githubCallback(
  req: IncomingMessage,
  res: ServerResponse,
  provider: CodeGitHub,
) {
  const url = new URL(req.url!, 'http://localhost');
  check(
    [...url.searchParams.keys()].every(
      (key) =>
        ['state', 'code', 'error', 'error_description', 'error_uri'].includes(key) &&
        url.searchParams.getAll(key).length === 1,
    ),
    'invalid_input',
    'Invalid GitHub callback',
  );
  const redirect = await provider.callback({
    state: url.searchParams.get('state') ?? '',
    code: url.searchParams.get('code') ?? undefined,
    error: url.searchParams.get('error') ?? undefined,
    cookie: githubCookie(req),
  });
  res.writeHead(303, {
    location: redirect,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  res.end();
}
export async function githubRequest(
  req: IncomingMessage,
  res: ServerResponse,
  caller: Caller,
  provider: CodeGitHub,
  read: () => Promise<unknown>,
): Promise<unknown> {
  const url = new URL(req.url!, 'http://localhost');
  check(url.search === '', 'invalid_input', 'GitHub controls do not accept query parameters');
  const action = url.pathname.slice('/code/github'.length);
  if (req.method === 'GET' && action === '') return provider.status(caller);
  if (req.method === 'GET' && action === '/repositories')
    return { repositories: await provider.repositories(caller) };
  if (req.method === 'POST') {
    const body = await read();
    if (action === '/begin' || action === '/disconnect') {
      const parsed = githubRevisionSchema.safeParse(body);
      check(parsed.success, 'invalid_input', 'A valid expectedRevision is required');
      if (action === '/disconnect') return provider.disconnect(caller, parsed.data);
      const result = await provider.begin(caller, parsed.data);
      res.setHeader('set-cookie', result.cookie);
      return { url: result.url };
    }
    if (action === '/finish') {
      check(
        body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0,
        'invalid_input',
        'GitHub finish expects an empty object',
      );
      return provider.finish(caller, githubCookie(req));
    }
    if (action === '/repository') {
      const parsed = githubRepositoryInputSchema.safeParse(body);
      check(
        parsed.success,
        'invalid_input',
        'A repository, installation and expectedRevision are required',
      );
      return provider.link(caller, parsed.data);
    }
  }
  throw new MervError('not_found', 'Unknown GitHub route or method', 404);
}

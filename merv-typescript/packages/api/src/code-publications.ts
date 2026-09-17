import { check, MervError, codePublicationMergeSchema, type Caller } from '@merv/contracts';
import type { IncomingMessage } from 'node:http';
import type { CodeApiProvider } from './types.js';

export async function publicationRequest(
  req: IncomingMessage,
  caller: Caller,
  provider: CodeApiProvider,
  read: () => Promise<unknown>,
) {
  check(
    !caller.session,
    'session_forbidden',
    'Worker credentials cannot control GitHub publications',
    403,
  );
  const url = new URL(req.url!, 'http://localhost');
  check(!url.search, 'invalid_input', 'Publication controls do not accept query parameters');
  check(
    provider.publications &&
      provider.syncPublications &&
      provider.publicationDetails &&
      provider.mergePublication,
    'code_unavailable',
    'Code publications are unavailable',
    503,
  );
  const action = url.pathname.slice('/code/publications'.length);
  if (req.method === 'GET' && !action) return { publications: await provider.publications(caller) };
  if (req.method === 'GET' && /^\/codeprop_[A-Za-z0-9_-]+$/.test(action))
    return provider.publicationDetails(caller, action.slice(1));
  if (req.method === 'POST') {
    const body = await read();
    if (action === '/sync') {
      check(
        body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0,
        'invalid_input',
        'Sync expects an empty object',
      );
      return { publications: await provider.syncPublications(caller) };
    }
    if (action === '/merge') {
      const parsed = codePublicationMergeSchema.safeParse(body);
      check(
        parsed.success,
        'invalid_input',
        'An exact proposal, head, base and merge request identifier are required',
      );
      return { publication: await provider.mergePublication(caller, parsed.data) };
    }
  }
  throw new MervError('not_found', 'Unknown publication route or method', 404);
}

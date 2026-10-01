import type { Context } from 'cordis';
import { z } from 'zod';
import { check, MervError } from '@merv/contracts';
import type { MountHandler } from '@merv/api/types';
import type { Secrets } from './types.js';
import { huggingFaceToken } from './index.js';

const input = z.object({ token: huggingFaceToken }).strict();
export function secretsRoutes(secrets: Secrets): MountHandler {
  return async (req, res, request) => {
    res.setHeader('Cache-Control', 'no-store');
    if (request.url.pathname !== '/secrets/huggingface')
      throw new MervError('not_found', 'Unknown endpoint', 404);
    const principal = request.principal;
    // Only transport-verified humans: no actor, key, managed worker or conversation caller.
    check(
      principal && !('caller' in principal) && principal.kind === 'user',
      'forbidden',
      'Sign in with an account to manage Hugging Face access',
      403,
    );
    check(!request.url.search, 'invalid_input', 'This endpoint accepts no query parameters');
    if (req.method === 'GET') return secrets.huggingFaceStatus(principal);
    if (req.method === 'PUT')
      return secrets.saveHuggingFace(principal, (await request.json(input, 8192)).token);
    if (req.method === 'DELETE') return secrets.removeHuggingFace(principal);
    throw new MervError('not_found', 'Unknown endpoint', 404);
  };
}
export const secretsApiPlugin = {
  name: 'merv-secrets-api',
  inject: ['secrets', 'api'],
  apply(ctx: Context) {
    ctx.effect(() => ctx.api.mount('/secrets', secretsRoutes(ctx.secrets)));
  },
};
export default secretsApiPlugin;

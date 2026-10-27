import type { Context } from 'cordis';
import { z } from 'zod';
import { check } from '@merv/contracts';
import type {} from '@merv/api/types';
import { MetricsService, type MetricsConfig } from './service.js';
import { metricsProxy } from './proxy.js';
export { MetricsService } from './service.js';
const origin = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.origin === value;
  }, 'Expected an HTTP origin');
export const metricsPlugin = {
  name: 'merv-metrics',
  inject: ['api', 'scope', 'experiments', 'sessions', 'artifacts'],
  Config: z
    .object({
      upstream: origin,
      writeToken: z.string().min(1),
      secret: z.string().min(32),
      publicOrigin: origin.optional(),
      mediaDir: z.string().startsWith('/').default('/data/trackio/media'),
    })
    .strict(),
  apply(ctx: Context, config: MetricsConfig) {
    const metrics = new MetricsService(
      config,
      ctx.scope,
      ctx.experiments,
      ctx.sessions,
      ctx.artifacts,
      () => ctx.api.publicOrigin,
    );
    ctx.effect(() => ctx.provide('metrics', metrics));
    ctx.effect(() =>
      ctx.api.mount(
        '/trackio',
        metricsProxy(config, metrics.tokens, (token) =>
          ctx.scope.eligible(token.p, token.u, 'read'),
        ),
        { public: true },
      ),
    );
    ctx.effect(() =>
      ctx.api.mount('/metrics', async (req, res, r) => {
        check(
          req.method === 'POST' && r.url.pathname === '/metrics/session',
          'not_found',
          'Unknown endpoint',
          404,
        );
        const caller = await r.caller();
        const { experimentId } = await r.json(
          z.object({ experimentId: z.string().min(1).optional() }).strict(),
        );
        const result = await metrics.panel(caller, experimentId);
        const view = metrics.view(caller);
        const host = new URL(`http://${req.headers.host ?? 'invalid'}`).hostname;
        const local =
          ['localhost', '127.0.0.1', '[::1]'].includes(host) &&
          !('encrypted' in req.socket) &&
          (!req.headers['x-forwarded-proto'] || req.headers['x-forwarded-proto'] === 'http');
        res.setHeader(
          'set-cookie',
          `${view.name}=${view.value}; Path=/trackio; HttpOnly; SameSite=Strict; Max-Age=1800${local ? '' : '; Secure'}`,
        );
        res.setHeader('cache-control', 'no-store');
        return result;
      }),
    );
  },
};
export default metricsPlugin;

import type { Context } from 'cordis';
import { z } from 'zod';
import { check } from '@merv/contracts';
import type {} from '@sandboxes/merv-host/types';
import type {} from '@merv/api/types';
import { sandboxesProxy } from './sandboxes-proxy.js';
import { sandboxesRunning } from './sandboxes-running.js';

export const sandboxesUiPlugin = {
  name: 'merv-sandboxes-console',
  inject: ['api', 'ui', 'scope', 'sbxMerv', 'sbxRegistry', 'sbxDb', 'sbxClock', 'sbxSettings'],
  Config: z.object({ upstream: z.string().url() }).strict(),
  apply(ctx: Context, config: { upstream: string }) {
    const proxy = sandboxesProxy(config.upstream);
    ctx.effect(() => ctx.ui.contribute(sandboxesRunning(ctx)));
    ctx.effect(() =>
      ctx.api.mount('/sbx', proxy.handler, { public: true, upgrade: proxy.upgrade }),
    );
    ctx.effect(() =>
      ctx.api.mount('/sandboxes', async (req, res, r) => {
        res.setHeader('cache-control', 'no-store');
        check(
          req.method === 'POST' && r.url.pathname === '/sandboxes/console-session',
          'not_found',
          'Unknown endpoint',
          404,
        );
        const caller = await r.caller();
        const { path } = await r.json(z.object({ path: z.string() }).strict());
        const route = path.split('?')[0]!;
        const session = await ctx.sbxMerv.consoleSession(caller, {
          ...(route === '/ui/' ? {} : { path: route }),
          accessToken: r.bearer(),
        });
        return { url: `/sbx/ui/${new URL(session.url).hash}` };
      }),
    );
  },
};
export default sandboxesUiPlugin;

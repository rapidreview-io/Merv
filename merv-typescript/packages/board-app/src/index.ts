import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from 'cordis';
import { z } from 'zod';
import { check } from '@merv/contracts';
import type {} from '@merv/api/types';
import { FleetService } from '@merv/fleet';
import piPlugin from '@merv/pi';
import piApiPlugin from '@merv/pi/api';
import piToolsPlugin from '@merv/pi/tools';
import piUiPlugin from '@merv/pi/ui';
import { HereMachines, profiles } from './machines.js';
import { surface } from './words.js';

const config = z.strictObject({
  /** Where this app keeps what it issued itself: the host's and a lone person's credentials. */
  directory: z.string().min(1),
  /** One person on their own computer: no sign-in, and the page is given their credential. */
  solo: z.boolean().default(false),
  /** A person's model dollars in a UTC day; nothing else limits what a public app spends. */
  dailyUsdPerPerson: z.number().positive().default(20),
});
type Config = z.input<typeof config>;

const openai = [
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', effort: 'medium' },
  { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra', effort: 'low' },
  { id: 'gpt-6-luna', label: 'GPT-6 Luna', effort: 'none' },
] as const;
const claude = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', effort: 'low' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', effort: 'medium' },
] as const;

declare module 'cordis' {
  interface Context {
    boardApp: { machines: HereMachines; solo?: { projectId: string; token: string } };
  }
}

type Issued = { projectId: string; token: string };
const fromLocal = (host: string | undefined) =>
  /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host ?? '');

/**
 * The board as a product of its own: Pi on the board with nothing else of Merv's. Pi rents from
 * Fleet, so Fleet is here, renting machines that are this process (machines.ts); that is all it
 * does, and no person sees it. What Pi is told and offered is this app's (words.ts).
 */
export const boardAppPlugin = {
  name: 'merv-board-app',
  Config: config,
  inject: ['state', 'scope', 'tools', 'blobs', 'api'],
  async apply(ctx: Context, input: Config) {
    const { directory, solo, dailyUsdPerPerson } = config.parse(input);
    // What this app issued, kept beside its files: a credential is only ever shown once.
    const file = join(directory, 'board-app.json');
    const kept = (await readFile(file, 'utf8').then(JSON.parse, () => ({}))) as {
      host?: Issued;
      solo?: Issued;
      secret?: string;
    };
    const issued = async (key: 'host' | 'solo', name: string) => {
      const known = kept[key];
      const live =
        known && (await ctx.scope.authenticate(known.token).catch(() => null))?.projectId;
      if (known && live === known.projectId) return known;
      const made = await ctx.scope.credentials.bootstrap({ projectName: name, actorName: 'You' });
      return (kept[key] = { projectId: made.project.id, token: made.token });
    };
    const host = await issued('host', 'Pi host');
    const person = solo ? await issued('solo', 'Boards') : undefined;
    kept.secret ??= randomBytes(32).toString('base64url');
    await writeFile(file, JSON.stringify(kept), { mode: 0o600 });
    process.env.MERV_PI_SECRET ??= kept.secret;
    process.env.MERV_BOARD_HOST_KEY = host.token;

    const machines = new HereMachines();
    const fleet = new FleetService(ctx.state, ctx.scope, machines, {
      profiles,
      pollIntervalMs: 1000,
      globalLimit: 64,
      hostProjectId: host.projectId,
    });
    await fleet.initialize();
    ctx.effect(() => () => {
      machines.close();
      return fleet.close();
    });
    ctx.provide('fleet', fleet);
    ctx.provide('boardApp', { machines, ...(person && { solo: person }) });
    fleet.start();

    const url = new URL(ctx.api.url!);
    if (url.hostname === '0.0.0.0') url.hostname = '127.0.0.1';
    const pi = ctx.plugin(piPlugin, {
      baseUrl: url.origin,
      surface,
      dailyUsdPerPerson,
      models: [...openai, ...(process.env.MERV_PI_ANTHROPIC_API_KEY ? claude : [])],
      host: { projectId: host.projectId, credentialEnv: 'MERV_BOARD_HOST_KEY' },
      machines: [{ key: 'standard', label: 'Standard', slots: 8, agent: false }],
    });
    await pi.await();
    await Promise.all(
      [piToolsPlugin, piApiPlugin, piUiPlugin].map((plugin) => ctx.plugin(plugin).await()),
    );

    if (person)
      ctx.effect(() =>
        ctx.api.mount(
          '/board-solo',
          async (req) => {
            // Only a page on this computer, and only by its own address, is handed the credential.
            check(fromLocal(req.headers.host), 'not_found', 'Unknown endpoint', 404);
            return { token: person.token, projectId: person.projectId };
          },
          { public: true },
        ),
      );
  },
};
export default boardAppPlugin;

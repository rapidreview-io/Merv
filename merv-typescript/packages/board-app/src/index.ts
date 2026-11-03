import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from 'cordis';
import { z } from 'zod';
import { check } from '@merv/contracts';
import type {} from '@merv/api/types';
import { FleetService, fleetConfig } from '@merv/fleet';
import piPlugin from '@merv/pi';
import piApiPlugin from '@merv/pi/api';
import piToolsPlugin from '@merv/pi/tools';
import piUiPlugin from '@merv/pi/ui';
import { computeConfig, computePlugin } from './compute.js';
import { HereMachines, profiles } from './machines.js';
import { DEMOS } from './demos.js';
import { surface } from './words.js';

const config = z.strictObject({
  /** Where this app keeps what it issued itself: the host's and a lone person's credentials. */
  directory: z.string().min(1),
  /** One person on their own computer: no sign-in, and the page is given their credential. */
  solo: z.boolean().default(false),
  /** A person's model dollars in a UTC day; nothing else limits what a public app spends. */
  dailyUsdPerPerson: z.number().positive().default(20),
  /** Where machines reach this server, where it is not where it listens. */
  publicUrl: z.string().url().optional(),
  /** Real machines, rented through Sandboxes (`@merv/sandboxes/host`, its first plugin) from these
   * profiles; the host project must be linked there. Without it a worker runs in this process. */
  rent: z
    .strictObject({
      profiles: z.array(z.record(z.unknown())).min(1),
      dailyUsdPerPerson: z.number().positive().default(20),
      globalLimit: z.number().int().min(1).max(64).default(50),
      slots: z.number().int().min(1).max(8).default(3),
    })
    .optional(),
  /** Computers a person's agent rents to run code on; the agent itself stays where `rent` says. */
  compute: computeConfig.partial().optional(),
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
    boardApp: { machines?: HereMachines; solo?: { projectId: string; token: string } };
  }
}

type Issued = { projectId: string; token: string };
const fromLocal = (host: string | undefined) =>
  /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host ?? '');

/**
 * The board as a product of its own: Pi on the board with nothing else of Merv's. Pi rents from
 * Fleet: real machines through Sandboxes where `rent` says so, else machines that are this process
 * (machines.ts). No person sees it. What Pi is told and offered is this app's (words.ts).
 */
export const boardAppPlugin = {
  name: 'merv-board-app',
  Config: config,
  inject: ['state', 'scope', 'tools', 'blobs', 'api', 'board'],
  async apply(ctx: Context, input: Config) {
    const { directory, solo, dailyUsdPerPerson, rent, compute, publicUrl } = config.parse(input);
    // What this app issued, kept beside its files: a credential is only ever shown once.
    const file = join(directory, 'board-app.json');
    const kept = (await readFile(file, 'utf8').then(JSON.parse, () => ({}))) as {
      host?: Issued;
      solo?: Issued;
      secret?: string;
      demos?: { of: string; tokens: string[] };
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

    const machines = rent ? undefined : new HereMachines();
    const sandboxes = rent && ctx.get('sbxMerv');
    if (rent && !sandboxes) throw new Error('Renting machines needs @merv/sandboxes/host');
    const fleet = new FleetService(
      ctx.state,
      ctx.scope,
      (sandboxes || machines)!,
      fleetConfig.parse({
        ...(rent
          ? { profiles: rent.profiles, globalLimit: rent.globalLimit }
          : { profiles, pollIntervalMs: 1000, globalLimit: 64 }),
        ...(rent && { dailyUsdPerPerson: rent.dailyUsdPerPerson }),
        hostProjectId: host.projectId,
      }),
    );
    await fleet.initialize();
    ctx.effect(() => () => {
      machines?.close();
      return fleet.close();
    });
    ctx.provide('fleet', fleet);
    ctx.provide('boardApp', { ...(machines && { machines }), ...(person && { solo: person }) });
    fleet.start();

    const url = new URL(ctx.api.url!);
    if (url.hostname === '0.0.0.0') url.hostname = '127.0.0.1';
    const pi = ctx.plugin(piPlugin, {
      baseUrl: publicUrl ?? url.origin,
      surface,
      dailyUsdPerPerson,
      models: [...openai, ...(process.env.MERV_PI_ANTHROPIC_API_KEY ? claude : [])],
      host: { projectId: host.projectId, credentialEnv: 'MERV_BOARD_HOST_KEY' },
      machines: [{ key: 'standard', label: 'Standard', slots: rent?.slots ?? 8, agent: false }],
    });
    await pi.await();
    if (compute) await ctx.plugin(computePlugin, compute).await();
    await Promise.all(
      [piToolsPlugin, piApiPlugin, piUiPlugin].map((plugin) => ctx.plugin(plugin).await()),
    );

    // The landing page's boards, in the host project, each read through a share. Drawn once, and
    // again only when what they say has changed; it is public, so it reaches for nothing else.
    const of = createHash('sha256').update(JSON.stringify(DEMOS)).digest('hex');
    if (kept.demos?.of !== of) {
      const caller = {
        actorId: (await ctx.scope.authenticate(host.token)).id,
        projectId: host.projectId,
      };
      const tokens: string[] = [];
      const files = new Map<string, string>();
      // A demo's image names a file in ../assets; a board takes it as a file of the project.
      const asFile = async (op: object) => {
        if (!('asset' in op)) return op;
        const { asset, ...rest } = op as { asset: string };
        if (!files.has(asset)) {
          const { id } = (await ctx.tools.call('artifact.write:create', caller as never, {
            title: asset,
            encoding: 'base64',
            mediaType: 'image/png',
            requestId: `demo-${of.slice(0, 16)}-${asset}`,
            content: await readFile(new URL(`../assets/${asset}`, import.meta.url), 'base64'),
          })) as { id: string };
          files.set(asset, id);
        }
        return { ...rest, artifactId: files.get(asset) };
      };
      for (const { title, calls } of DEMOS) {
        let id: string | undefined;
        for (const ops of calls) {
          const drawn = (await ctx.tools.call('board.write:draw', caller as never, {
            ...(id ? { board: id } : { title }),
            ops: await Promise.all(ops.map(asFile)),
          })) as { board: { id: string } };
          id = drawn.board.id;
        }
        tokens.push((await ctx.board.share(caller as never, id!)).token!);
      }
      kept.demos = { of, tokens };
      await writeFile(file, JSON.stringify(kept), { mode: 0o600 });
    }
    const { tokens } = kept.demos!;
    ctx.effect(() => ctx.api.mount('/board-demos', async () => ({ tokens }), { public: true }));

    // What went wrong on the landing page in a visitor's browser, bounded, for the log alone.
    ctx.effect(() =>
      ctx.api.mount(
        '/board-report',
        async (req) => {
          const url = new URL(req.url ?? '', 'http://here');
          console.error(
            JSON.stringify({
              event: 'landing_error',
              message: url.searchParams.get('m')?.slice(0, 600),
              agent: String(req.headers['user-agent'] ?? '').slice(0, 160),
            }),
          );
          return {};
        },
        { public: true },
      ),
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

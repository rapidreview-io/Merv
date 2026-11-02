import { readFileSync } from 'node:fs';
import { createApp } from '../src/app.js';
import type { ApplicationConfig } from '../src/config.js';

/**
 * The board app on a server (deploy/board). It takes the hosted composition and what the server's
 * environment gives it: sign-in where BOARD_SUPABASE_URL is set, and real machines where
 * SANDBOXES_DATABASE_URL and BOARD_RENT are, and large files where MERV_BLOB_BUCKET is. Without them it still serves the landing page, and any
 * model turn runs in this process.
 */
const { BOARD_SUPABASE_URL, BOARD_RENT, SANDBOXES_DATABASE_URL, PORT = '3090' } = process.env;
const { plugins } = JSON.parse(
  readFileSync(new URL('../config/board.hosted.example.json', import.meta.url), 'utf8'),
) as ApplicationConfig;
/** Where people reach it, the one machines use first: BOARD_ORIGINS, comma separated. */
const origins = (process.env.BOARD_ORIGINS ?? '').split(',').filter(Boolean);
const renting = SANDBOXES_DATABASE_URL && BOARD_RENT;
const app = await createApp({
  directory: process.env.BOARD_DATA ?? '/data',
  host: '0.0.0.0',
  port: Number(PORT),
  config: {
    plugins: plugins
      .filter((plugin) => renting || plugin.id !== 'sandboxes-host')
      .map((plugin) => {
        const config = plugin.config as Record<string, unknown> | undefined;
        if (plugin.id === 'sandboxes-host')
          return {
            ...plugin,
            config: {
              ...config,
              dataDir: process.env.SANDBOXES_DATA_DIR,
              publicOrigin: process.env.SANDBOXES_PUBLIC_API_URL,
            },
          };
        if (plugin.id === 'api')
          return { ...plugin, config: { ...config, allowedOrigins: origins } };
        if (plugin.id === 'blobs' && process.env.MERV_BLOB_BUCKET)
          return { ...plugin, config: { backend: 's3' } };
        if (plugin.id === 'identity')
          return {
            ...plugin,
            config: BOARD_SUPABASE_URL ? { ...config, supabaseUrl: BOARD_SUPABASE_URL } : {},
          };
        if (plugin.id === 'board-app') {
          const { rent: _, ...rest } = config!;
          return {
            ...plugin,
            config: {
              ...rest,
              publicUrl: origins[0],
              ...(renting && { rent: JSON.parse(BOARD_RENT!) }),
            },
          };
        }
        return plugin;
      }),
  },
});
console.log(`Listening at ${app.ctx.api.url}`);
const stop = () => void app.stop().then(() => process.exit(0));
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

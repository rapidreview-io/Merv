/**
 * createApp as tests call it: the composition the options select, with the committed default
 * state entry pointed at this data directory's own PostgreSQL schema (tests/fixtures/state.ts).
 * `feed: true` switches on Feed, its tools and its page, which the committed configuration keeps
 * but switches off. Any other state entry, and every other plugin entry, is passed through exactly
 * as written.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createApp as create } from '../../src/app.js';
import {
  defaultConfigFile,
  loadConfiguration,
  type ApplicationConfig,
  type ConfigurationOptions,
  type ConfiguredPlugin,
} from '../../src/config.js';
import { stateConfig } from './state.js';

export * from '../../src/app.js';

const committed = loadConfiguration({ directory: '.', configFile: defaultConfigFile }).entries.find(
  (entry) => entry.id === 'state',
)?.config;

// Reports renders in a browser; apps in tests take report artifacts as rendered (legacy-reports.ts).
const legacyReports = fileURLToPath(new URL('./legacy-reports.ts', import.meta.url));
const local = (directory: string, feed?: boolean) => (entry: ConfiguredPlugin) =>
  entry.name === '@merv/state' && isDeepStrictEqual(entry.config ?? {}, committed ?? {})
    ? { ...entry, config: stateConfig(directory) }
    : feed && /^feed(-|$)/.test(entry.id)
      ? { ...entry, disabled: false }
      : entry.name === '@merv/reports'
        ? { ...entry, name: legacyReports }
        : entry;

/**
 * The committed composition with its API and no browser layer, as `api: true` selects it, with
 * Sessions' background pass held off: its upkeep checks every live lease, which a test counting
 * the lease checks of one call would count as that call's.
 */
export function quietApiConfig(): ApplicationConfig {
  const config = JSON.parse(
    readFileSync(new URL('../../config/default.json', import.meta.url), 'utf8'),
  ) as ApplicationConfig;
  config.plugins = config.plugins.flatMap((plugin) =>
    plugin.id === 'ui' || plugin.id.endsWith('-ui')
      ? []
      : plugin.id === 'sessions'
        ? [{ ...plugin, config: { sweepIntervalMs: 60_000 } }]
        : [plugin],
  );
  return config;
}

export async function createApp({ feed, ...options }: ConfigurationOptions & { feed?: boolean }) {
  const adapt = local(options.directory, feed);
  // Programmatic config keeps its own module resolution; only its default state entry moves.
  if (options.config)
    return await create({ ...options, config: { plugins: options.config.plugins.map(adapt) } });
  // Default composition or a config file: resolve it once, then pass it on programmatically,
  // with relative module names made absolute against the file they were written in.
  const { entries, baseUrl } = loadConfiguration(options);
  const plugins = entries.map((entry) =>
    adapt({
      ...entry,
      name: entry.name.startsWith('.') ? fileURLToPath(new URL(entry.name, baseUrl)) : entry.name,
    }),
  );
  return await create({
    directory: options.directory,
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.port === undefined ? {} : { port: options.port }),
    config: { plugins },
  });
}

/**
 * The committed composition over HTTP in a new temporary directory: the API on a port of its own,
 * the browser layer with no bundle, and `extra` entries after them. It stops and is removed after
 * the test unless `cleanup` is false. `tool` POSTs one tool call with a bearer token.
 */
export async function httpApp(
  t: TestContext,
  prefix: string,
  { cleanup = true, extra = [] }: { cleanup?: boolean; extra?: object[] } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const { plugins } = JSON.parse(
    readFileSync(new URL('../../config/default.json', import.meta.url), 'utf8'),
  ) as { plugins: { id: string; config?: unknown }[] };
  const app = await createApp({
    directory: join(directory, 'data'),
    config: {
      plugins: plugins
        .map((entry) =>
          entry.id === 'api'
            ? { ...entry, config: { host: '127.0.0.1', port: 0 } }
            : entry.id === 'ui'
              ? { ...entry, config: { assets: join(directory, 'nowhere') } }
              : entry,
        )
        .concat(extra as never[]) as never,
    },
  });
  if (cleanup)
    t.after(async () => {
      await app.stop();
      rmSync(directory, { recursive: true, force: true });
    });
  const tool = async (name: string, token: string, input: unknown = {}) => {
    const response = await fetch(`${app.ctx.api.url}/tools/${name}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  return { app, directory, tool };
}

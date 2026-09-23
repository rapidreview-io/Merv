/**
 * createApp as tests call it: the composition the options select, with the committed default
 * state entry pointed at this data directory's own PostgreSQL schema (tests/fixtures/state.ts).
 * Any other state entry, and every other plugin entry, is passed through exactly as written.
 */
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createApp as create, type AppOptions } from '../../src/app.js';
import { defaultConfigFile, loadConfiguration, type ConfiguredPlugin } from '../../src/config.js';
import { stateConfig } from './state.js';

export * from '../../src/app.js';

const committed = loadConfiguration({ directory: '.', configFile: defaultConfigFile }).entries.find(
  (entry) => entry.id === 'state',
)?.config;

const local = (directory: string) => (entry: ConfiguredPlugin) =>
  entry.name === '@merv/state' && isDeepStrictEqual(entry.config ?? {}, committed ?? {})
    ? { ...entry, config: stateConfig(directory) }
    : entry;

export async function createApp(options: AppOptions) {
  // Programmatic config keeps its own module resolution; only its default state entry moves.
  if (options.config)
    return await create({
      ...options,
      config: { plugins: options.config.plugins.map(local(options.directory)) },
    });
  // Default composition or a config file: resolve it once, then pass it on programmatically,
  // with relative module names made absolute against the file they were written in.
  const { entries, baseUrl } = loadConfiguration(options);
  const plugins = entries.map((entry) =>
    local(options.directory)({
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

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, MervError } from '@merv/contracts';

export interface ConfiguredPlugin {
  id: string;
  name: string;
  config?: Record<string, unknown>;
  disabled?: boolean;
  required?: boolean;
}

export interface ApplicationConfig {
  plugins: ConfiguredPlugin[];
}

export interface ConfigurationOptions {
  directory: string;
  /** Relative module names resolve beside this JSON file. */
  configFile?: string;
  /** Relative module names resolve from the merv-typescript workspace root. */
  config?: ApplicationConfig;
  components?: string[];
  api?: boolean;
  host?: string;
  port?: number;
}

const defaultUrl = new URL('../config/default.json', import.meta.url);
const programmaticUrl = new URL('../package.json', import.meta.url);
const entryKeys = new Set(['id', 'name', 'config', 'disabled', 'required']);
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalid(condition: unknown, message: string): asserts condition {
  check(condition, 'invalid_config', message);
}

function readConfiguration(url: URL): unknown {
  let text: string;
  try {
    text = readFileSync(url, 'utf8');
  } catch {
    throw new MervError('invalid_config', 'Configuration file could not be read');
  }
  try {
    return JSON.parse(text);
  } catch {
    // Parser excerpts can include plugin credentials; report no configuration contents.
    throw new MervError('invalid_config', 'Configuration file must contain valid JSON');
  }
}

function entries(value: unknown): ConfiguredPlugin[] {
  invalid(record(value), 'Application configuration must be an object');
  invalid(
    Object.keys(value).every((key) => key === 'plugins'),
    'Unknown application configuration key',
  );
  invalid(Array.isArray(value.plugins), 'Application configuration requires a plugins array');
  const used = new Set<string>();
  return value.plugins.map((entry: unknown) => {
    invalid(record(entry), 'Each plugin entry must be an object');
    invalid(
      Object.keys(entry).every((key) => entryKeys.has(key)),
      'Unknown plugin entry key',
    );
    invalid(
      typeof entry.id === 'string' && idPattern.test(entry.id),
      'Plugin IDs must contain 1–128 letters, digits, dots, underscores or hyphens, beginning with a letter or digit',
    );
    invalid(!used.has(entry.id), `Duplicate plugin ID: ${entry.id}`);
    used.add(entry.id);
    invalid(
      typeof entry.name === 'string' &&
        entry.name.trim().length > 0 &&
        entry.name === entry.name.trim(),
      'Each plugin requires a nonblank module name without surrounding whitespace',
    );
    invalid(entry.config === undefined || record(entry.config), 'Plugin config must be an object');
    invalid(
      entry.disabled === undefined || typeof entry.disabled === 'boolean',
      'Plugin disabled must be boolean',
    );
    invalid(
      entry.required === undefined || typeof entry.required === 'boolean',
      'Plugin required must be boolean',
    );
    return {
      id: entry.id,
      name: entry.name,
      ...(entry.config === undefined ? {} : { config: entry.config }),
      disabled: entry.disabled ?? false,
      required: entry.required ?? true,
    };
  });
}

function substitute(
  value: unknown,
  values: { directory: string; host: string; port: number },
  ancestors = new Set<object>(),
): unknown {
  if (typeof value === 'string') {
    const token = /\$\{([^}]*)\}/g;
    invalid(!value.replace(token, '').includes('${'), 'Malformed configuration substitution');
    if (value === '${port}') return values.port;
    return value.replace(token, (_match, name: string) => {
      invalid(
        name === 'directory' || name === 'host' || name === 'port',
        'Only directory, host, and port substitutions are supported',
      );
      return String(values[name]);
    });
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    invalid(Number.isFinite(value), 'Plugin config numbers must be finite');
    return value;
  }
  invalid(Array.isArray(value) || record(value), 'Plugin config values must be JSON values');
  invalid(!ancestors.has(value), 'Plugin config cannot contain cycles');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((child) => substitute(child, values, ancestors));
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, substitute(child, values, ancestors)]),
    );
  } finally {
    ancestors.delete(value);
  }
}

/** Validate declarations only; upstream Cordis Loader resolves and activates their modules. */
export function loadConfiguration(options: ConfigurationOptions): {
  entries: ConfiguredPlugin[];
  baseUrl: string;
} {
  invalid(
    typeof options.directory === 'string' && options.directory.trim().length > 0,
    'A data directory is required',
  );
  const explicit = options.config !== undefined || options.configFile !== undefined;
  invalid(
    !(options.config !== undefined && options.configFile !== undefined),
    'Use either config or configFile',
  );
  invalid(
    !explicit || (options.components === undefined && options.api === undefined),
    'Explicit configuration cannot be combined with components or api',
  );
  invalid(options.api === undefined || typeof options.api === 'boolean', 'api must be boolean');
  const values = {
    directory: resolve(options.directory),
    host: options.host ?? '127.0.0.1',
    port: options.port ?? 3081,
  };
  invalid(
    typeof values.host === 'string' && values.host.trim().length > 0,
    'host must be a nonblank string',
  );
  invalid(
    Number.isSafeInteger(values.port) && values.port >= 0 && values.port <= 65535,
    'port must be an integer from 0 to 65535',
  );
  let baseUrl = defaultUrl;
  let configured: ConfiguredPlugin[];
  if (options.configFile !== undefined) {
    invalid(
      typeof options.configFile === 'string' && options.configFile.trim().length > 0,
      'configFile must be a nonblank path',
    );
    baseUrl = pathToFileURL(resolve(options.configFile));
    configured = entries(readConfiguration(baseUrl));
  } else if (options.config !== undefined) {
    baseUrl = programmaticUrl;
    configured = entries(options.config);
  } else {
    configured = entries(readConfiguration(defaultUrl));
    const providerIds = configured
      .filter((entry) => entry.id !== 'api' && entry.id !== 'tools' && !entry.id.endsWith('-tools'))
      .map((entry) => entry.id);
    invalid(
      options.components === undefined ||
        (Array.isArray(options.components) &&
          options.components.every(
            (name) => typeof name === 'string' && providerIds.includes(name),
          )),
      'components must contain known default provider IDs',
    );
    const apiSupport = ['access', 'credentials'];
    const selected = new Set(
      options.components ?? providerIds.filter((id) => !apiSupport.includes(id)),
    );
    if (options.api) for (const id of apiSupport) selected.add(id);
    configured = configured.filter((entry) => {
      if (entry.id === 'api' || entry.id === 'tools') return options.api === true;
      if (entry.id.endsWith('-tools'))
        return options.api === true && selected.has(entry.id.slice(0, -'-tools'.length));
      return selected.has(entry.id);
    });
  }
  return {
    entries: configured.map((entry) => ({
      ...entry,
      ...(entry.config === undefined
        ? {}
        : { config: substitute(entry.config, values) as Record<string, unknown> }),
    })),
    baseUrl: baseUrl.href,
  };
}

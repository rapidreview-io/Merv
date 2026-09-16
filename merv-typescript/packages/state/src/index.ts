import type { Context } from 'cordis';
import { z } from 'zod';
import { check } from '@merv/contracts';
import { SqliteState } from './sqlite.js';
import { PostgresState } from './postgres.js';

export { SqliteState } from './sqlite.js';
export { PostgresState, type PostgresConfig } from './postgres.js';

const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const Config = z.union([
  z
    .object({
      backend: z.literal('sqlite').optional(),
      path: z.string().refine((path) => path.trim().length > 0, 'State path must be nonblank'),
    })
    .strict(),
  z
    .object({
      backend: z.literal('postgres'),
      connectionStringEnv: envName.default('MERV_DB_URL'),
      schema: z
        .string()
        .regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/)
        .default('merv'),
      maxConnections: z.number().int().positive().max(100).default(10),
      connectionTimeoutMs: z.number().int().positive().default(5000),
      statementTimeoutMs: z.number().int().positive().default(30000),
      lockTimeoutMs: z.number().int().positive().default(5000),
      ssl: z
        .object({ rejectUnauthorized: z.literal(true).default(true), caEnv: envName.optional() })
        .strict()
        .optional(),
    })
    .strict(),
]);

function secret(name: string): string {
  const value = process.env[name];
  check(
    value !== undefined && value.trim(),
    'invalid_config',
    `Required environment variable ${name} is missing`,
  );
  return value;
}

export const statePlugin = {
  name: 'merv-state',
  Config,
  async apply(ctx: Context, config: z.infer<typeof Config>) {
    await ctx.effect(async function* () {
      const state =
        config.backend === 'postgres'
          ? await PostgresState.open({
              ...config,
              connectionString: secret(config.connectionStringEnv),
              ssl: config.ssl && {
                rejectUnauthorized: true,
                ca: config.ssl.caEnv ? secret(config.ssl.caEnv) : undefined,
              },
            })
          : new SqliteState(config.path);
      yield () => state.close();
      yield ctx.provide('state', state);
    });
  },
};
export default statePlugin;

import type { Context } from 'cordis';
import { z } from 'zod';
import { check } from '@merv/contracts';
import { PostgresState } from './postgres.js';

export { PostgresState, type PostgresConfig } from './postgres.js';

const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const schemaName = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/);
const Config = z
  .object({
    backend: z.literal('postgres').optional(),
    connectionStringEnv: envName.default('MERV_DB_URL'),
    schema: schemaName.default('merv'),
    /** When this variable is set and nonblank, its value replaces `schema` (local instances, tests). */
    schemaEnv: envName.optional(),
    maxConnections: z.number().int().positive().max(100).default(10),
    readConnections: z.number().int().positive().max(100).default(6),
    connectionTimeoutMs: z.number().int().positive().default(10000),
    statementTimeoutMs: z.number().int().positive().default(30000),
    lockTimeoutMs: z.number().int().positive().default(5000),
    ssl: z
      .object({ rejectUnauthorized: z.literal(true).default(true), caEnv: envName.optional() })
      .strict()
      .optional(),
  })
  .strict();

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
      const { schemaEnv, ...rest } = config;
      const override = schemaEnv ? process.env[schemaEnv]?.trim() : undefined;
      check(
        !override || schemaName.safeParse(override).success,
        'invalid_config',
        `${schemaEnv} must name a PostgreSQL schema`,
      );
      const state = await PostgresState.open({
        ...rest,
        schema: override || config.schema,
        connectionString: secret(config.connectionStringEnv),
        ssl: config.ssl && {
          rejectUnauthorized: true,
          ca: config.ssl.caEnv ? secret(config.ssl.caEnv) : undefined,
        },
      });
      yield () => state.close();
      yield ctx.provide('state', state);
    });
  },
};
export default statePlugin;

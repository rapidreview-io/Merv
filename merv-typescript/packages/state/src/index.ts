import type { Context } from 'cordis';
import { z } from 'zod';
import { check, envName, requiredEnv } from '@merv/contracts';
import { PostgresState, POSTGRES_DEFAULTS, POSTGRES_SCHEMA } from './postgres.js';

export { PostgresState, type PostgresConfig } from './postgres.js';

const schemaName = z.string().regex(POSTGRES_SCHEMA);
const positive = z.number().int().positive();
const Config = z
  .object({
    backend: z.literal('postgres').optional(),
    connectionStringEnv: envName.default('MERV_DB_URL'),
    schema: schemaName.default(POSTGRES_DEFAULTS.schema),
    /** When this variable is set and nonblank, its value replaces `schema` (local instances, tests). */
    schemaEnv: envName.optional(),
    maxConnections: positive.max(100).default(POSTGRES_DEFAULTS.maxConnections),
    readConnections: positive.max(100).default(POSTGRES_DEFAULTS.readConnections),
    connectionTimeoutMs: positive.default(POSTGRES_DEFAULTS.connectionTimeoutMs),
    statementTimeoutMs: positive.default(POSTGRES_DEFAULTS.statementTimeoutMs),
    lockTimeoutMs: positive.default(POSTGRES_DEFAULTS.lockTimeoutMs),
    ssl: z
      .object({ rejectUnauthorized: z.literal(true).default(true), caEnv: envName.optional() })
      .strict()
      .optional(),
  })
  .strict();

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
        connectionString: requiredEnv(config.connectionStringEnv, 'invalid_config'),
        ssl: config.ssl && {
          rejectUnauthorized: true,
          ca: config.ssl.caEnv ? requiredEnv(config.ssl.caEnv, 'invalid_config') : undefined,
        },
      });
      yield () => state.close();
      yield ctx.provide('state', state);
    });
  },
};
export default statePlugin;
